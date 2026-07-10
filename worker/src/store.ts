import { BusError } from "./bus-error";
import type { Env } from "./env";
import {
  type BusMessage,
  type Channel,
  type ChannelSummary,
  type ConsumerStatus,
  type MessageRefs,
  type MessageType,
  type Priority,
  type RecipientDelivery,
  type ThreadMessage,
  CHANNELS,
  MAX_BODY_BYTES,
  MAX_REF_CHARS,
  MAX_THREAD_ID_CHARS,
  MAX_TO_ENTRIES,
  MAX_TO_ENTRY_CHARS,
  isChannel,
  isMessageType,
  isPriority,
  isVisibleTo,
  newId,
  nowIso,
  retentionCutoff,
  utf8Bytes,
} from "./bus-types";

interface MessageRow {
  id: string;
  channel: string;
  thread_id: string;
  from_consumer: string;
  to_json: string;
  type: string;
  priority: string;
  body: string;
  refs_json: string | null;
  requires_ack: number;
  ack_of: string | null;
  created_at: string;
}

function rowToMessage(row: MessageRow): BusMessage {
  return {
    id: row.id,
    channel: row.channel as Channel,
    thread_id: row.thread_id,
    from: row.from_consumer,
    to: JSON.parse(row.to_json) as string[],
    type: row.type as MessageType,
    priority: row.priority as Priority,
    body: row.body,
    refs: row.refs_json ? (JSON.parse(row.refs_json) as MessageRefs) : null,
    requires_ack: row.requires_ack === 1,
    ack_of: row.ack_of,
    created_at: row.created_at,
  };
}

// #21: bounds the redelivery list. A dropped ack-gated message re-appears on
// every poll (regardless of the cursor) until acked; cap it to the oldest few.
export const PENDING_ACK_CAP = 20;

/** A redelivered, still-unacked message. pending_ack distinguishes it from new traffic. */
export type PendingAckMessage = BusMessage & { pending_ack: true };

function parseTo(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new BusError("to must be a non-empty array");
  }
  if (value.length > MAX_TO_ENTRIES) {
    throw new BusError(`to accepts at most ${MAX_TO_ENTRIES} recipients`);
  }
  for (const item of value) {
    if (typeof item !== "string" || !item.trim()) {
      throw new BusError("to entries must be non-empty strings");
    }
    if (item.length > MAX_TO_ENTRY_CHARS) {
      throw new BusError(`to entries are capped at ${MAX_TO_ENTRY_CHARS} chars`);
    }
  }
  return value as string[];
}

// Root-defect fix (#17.1): a send to an unknown/retired name must fail LOUDLY
// at send time, not succeed into a void. `known` is the registered roster
// (NAMES only, never tokens). "*" is always valid. When `known` is undefined
// (internal calls, e.g. ack replies) validation is skipped.
function validateRecipients(to: string[], known: string[] | undefined): void {
  if (!known) return;
  const unknown = to.filter((t) => t !== "*" && !known.includes(t));
  if (unknown.length) {
    throw new BusError(
      `unknown recipient(s): ${unknown.join(", ")}. valid consumers: ${
        known.join(", ") || "(none registered)"
      } (or "*" to broadcast)`,
    );
  }
}

function validateRefs(refs: MessageRefs | null | undefined): void {
  if (!refs) return;
  for (const [key, value] of Object.entries(refs)) {
    if (typeof value === "string" && value.length > MAX_REF_CHARS) {
      throw new BusError(`refs.${key} is capped at ${MAX_REF_CHARS} chars`);
    }
  }
}

// refs normalization (#17.4): issue / pr are canonical BARE numbers. Strip a
// leading "#" at write time so refs.issue "#42" and "42" store identically.
function normalizeRefs(refs: MessageRefs | null | undefined): MessageRefs | null {
  if (!refs) return refs ?? null;
  const out: MessageRefs = { ...refs };
  if (typeof out.issue === "string") out.issue = out.issue.replace(/^#/, "");
  if (typeof out.pr === "string") out.pr = out.pr.replace(/^#/, "");
  return out;
}

export interface SendInput {
  channel: string;
  thread_id?: string;
  to: string[];
  type: string;
  priority?: string;
  body: string;
  refs?: MessageRefs | null;
  requires_ack?: boolean;
  ack_of?: string | null;
}

export async function sendMessage(
  db: D1Database,
  from: string,
  input: SendInput,
  knownConsumers?: string[],
): Promise<BusMessage> {
  if (!isChannel(input.channel)) {
    throw new BusError(`invalid channel: ${input.channel}`);
  }
  if (!isMessageType(input.type)) {
    throw new BusError(`invalid type: ${input.type}`);
  }
  const priority = input.priority ?? "normal";
  if (!isPriority(priority)) {
    throw new BusError(`invalid priority: ${priority}`);
  }
  const to = parseTo(input.to);
  validateRecipients(to, knownConsumers);
  const body = String(input.body ?? "").trim();
  if (!body) throw new BusError("body is required");
  if (utf8Bytes(body) > MAX_BODY_BYTES) {
    throw new BusError(`body is capped at ${MAX_BODY_BYTES} bytes; link a gist/issue/PR for anything larger`);
  }
  validateRefs(input.refs);
  const refs = normalizeRefs(input.refs);

  if (input.type === "ack" && !input.ack_of) {
    throw new BusError("ack messages require ack_of");
  }

  const id = newId("msg");
  const thread_id = input.thread_id?.trim() || newId("thr");
  if (thread_id.length > MAX_THREAD_ID_CHARS) {
    throw new BusError(`thread_id is capped at ${MAX_THREAD_ID_CHARS} chars`);
  }
  const created_at = nowIso();
  // #21: rulings and handoffs are exactly the messages whose silent loss stalls
  // a lane, so require an ack by default when the field is unspecified; an
  // explicit false is still honored.
  const requiresAckDefault = input.type === "ruling" || input.type === "handoff";
  const requires_ack = (input.requires_ack ?? requiresAckDefault) ? 1 : 0;

  await db
    .prepare(
      `INSERT INTO messages
        (id, channel, thread_id, from_consumer, to_json, type, priority, body, refs_json, requires_ack, ack_of, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      input.channel,
      thread_id,
      from,
      JSON.stringify(to),
      input.type,
      priority,
      body,
      refs ? JSON.stringify(refs) : null,
      requires_ack,
      input.ack_of ?? null,
      created_at,
    )
    .run();

  if (input.type === "ack" && input.ack_of) {
    await db
      .prepare(
        `INSERT INTO acks (message_id, from_consumer, body, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(message_id, from_consumer) DO UPDATE SET body = excluded.body, created_at = excluded.created_at`,
      )
      .bind(input.ack_of, from, body, created_at)
      .run();
  }

  return {
    id,
    channel: input.channel,
    thread_id,
    from,
    to,
    type: input.type,
    priority,
    body,
    refs,
    requires_ack: Boolean(requires_ack),
    ack_of: input.ack_of ?? null,
    created_at,
  };
}

// Sender-side delivery visibility (#17.3): for messages the CALLER sent, attach
// a per-recipient delivery report so a parked handoff is self-diagnosable in one
// call, with no human in the loop. Broadcasts report against the full roster.
export async function getThread(
  db: D1Database,
  threadId: string,
  consumer: string,
  knownConsumers: string[] = [],
): Promise<ThreadMessage[]> {
  const { results } = await db
    .prepare(`SELECT * FROM messages WHERE thread_id = ? ORDER BY created_at ASC`)
    .bind(threadId)
    .all<MessageRow>();

  // Senders see their own messages: a thread must reconstruct for the agent
  // that started it, not just for the recipients.
  const visible = (results ?? [])
    .map(rowToMessage)
    .filter((m) => isVisibleTo(m.to, consumer) || m.from === consumer);

  const own = visible.filter((m) => m.from === consumer && m.type !== "ack");
  if (own.length === 0) return visible;

  // last_poll_at per registered consumer (single read for the whole thread).
  const { results: pollRows } = await db
    .prepare(`SELECT name, last_poll_at FROM consumers`)
    .all<{ name: string; last_poll_at: string | null }>();
  const pollMap = new Map((pollRows ?? []).map((r) => [r.name, r.last_poll_at] as const));

  const out: ThreadMessage[] = [];
  for (const m of visible) {
    if (m.from !== consumer || m.type === "ack") {
      out.push(m);
      continue;
    }
    const recipients = (m.to.includes("*") ? knownConsumers : m.to).filter((r) => r !== consumer);
    const { results: ackRows } = await db
      .prepare(`SELECT from_consumer, created_at FROM acks WHERE message_id = ?`)
      .bind(m.id)
      .all<{ from_consumer: string; created_at: string }>();
    const ackMap = new Map((ackRows ?? []).map((r) => [r.from_consumer, r.created_at] as const));

    const delivery: RecipientDelivery[] = recipients.map((r) => {
      const lastPoll = pollMap.get(r) ?? null;
      return {
        recipient: r,
        acked_at: ackMap.get(r) ?? null,
        polled_after: lastPoll !== null && lastPoll >= m.created_at,
      };
    });
    out.push({ ...m, delivery });
  }
  return out;
}

// Upserted on each authenticated poll so bus_consumers + delivery reports have a
// last_poll_at watermark. One cheap write per poll at our volume.
export async function recordPoll(db: D1Database, consumer: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO consumers (name, last_poll_at)
       VALUES (?, ?)
       ON CONFLICT(name) DO UPDATE SET last_poll_at = excluded.last_poll_at`,
    )
    .bind(consumer, nowIso())
    .run();
}

// Consumer discovery (#17.2): the registered roster (from the token map) joined
// with each consumer's last_poll_at. Names with no poll row yet return null.
export async function listConsumers(db: D1Database, names: string[]): Promise<ConsumerStatus[]> {
  const { results } = await db
    .prepare(`SELECT name, last_poll_at FROM consumers`)
    .all<{ name: string; last_poll_at: string | null }>();
  const pollMap = new Map((results ?? []).map((r) => [r.name, r.last_poll_at] as const));
  return names.map((name) => ({ name, last_poll_at: pollMap.get(name) ?? null }));
}

export async function pollMessages(
  db: D1Database,
  consumer: string,
  opts: { channel?: string; since?: string; limit?: number },
): Promise<{ messages: BusMessage[]; cursor: string | null; pending_acks: PendingAckMessage[] }> {
  await recordPoll(db, consumer);
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  // Exclusive since: pass the prior poll's cursor as `since` to avoid duplicates.
  const sinceClause = opts.since
    ? "created_at > ?"
    : "created_at >= COALESCE(?, '1970-01-01T00:00:00.000Z')";
  let query = `SELECT * FROM messages WHERE ${sinceClause}`;
  const binds: unknown[] = [opts.since ?? null];

  if (opts.channel) {
    if (!isChannel(opts.channel)) throw new BusError(`invalid channel: ${opts.channel}`);
    query += ` AND channel = ?`;
    binds.push(opts.channel);
  }

  // Scan strictly in created_at order: the cursor is a time watermark, and any
  // ordering that is not the watermark's own order (e.g. blocking-first) lets
  // the cursor advance past rows that were never returned = silent message
  // loss. Blocking priority stays visible as a field; callers scan for it.
  const scanLimit = limit + 200;
  query += ` ORDER BY created_at ASC, id ASC LIMIT ?`;
  binds.push(scanLimit);

  const { results } = await db.prepare(query).bind(...binds).all<MessageRow>();
  const raw = (results ?? []).map(rowToMessage);
  // Own sends are excluded from poll results (bus_send already returned them)
  // but still advance the cursor below via the raw scan window.
  const visible = raw.filter((m) => isVisibleTo(m.to, consumer) && m.from !== consumer);
  const messages = visible.slice(0, limit);

  // Lossless cursor: if the page truncated, stop at the last RETURNED message;
  // otherwise every visible row in the scanned window was returned, so advance
  // past the whole window (including invisible rows -- otherwise a flood of
  // messages for other consumers would pin the cursor forever).
  let cursor: string | null = null;
  if (visible.length > limit) {
    cursor = messages[messages.length - 1]!.created_at;
  } else if (raw.length) {
    cursor = raw[raw.length - 1]!.created_at;
  }
  const pending_acks = await pendingAcksFor(db, consumer, opts.channel);
  return { messages, cursor, pending_acks };
}

// #21: a consumer's outstanding ack obligations -- messages addressed to them
// (direct or broadcast) with requires_ack=1 and no ack row yet -- ALWAYS surfaced
// regardless of the poll cursor, so an ack-gated message dropped mid-turn
// re-surfaces on the next auto-poll instead of vanishing behind the watermark.
// Capped at the oldest PENDING_ACK_CAP; honors the poll's channel filter.
async function pendingAcksFor(
  db: D1Database,
  consumer: string,
  channel?: string,
): Promise<PendingAckMessage[]> {
  let query =
    `SELECT * FROM messages WHERE requires_ack = 1 AND from_consumer != ? ` +
    `AND id NOT IN (SELECT message_id FROM acks WHERE from_consumer = ?)`;
  const binds: unknown[] = [consumer, consumer];
  if (channel) {
    query += ` AND channel = ?`;
    binds.push(channel);
  }
  query += ` ORDER BY created_at ASC, id ASC`;
  const { results } = await db.prepare(query).bind(...binds).all<MessageRow>();
  return (results ?? [])
    .map(rowToMessage)
    .filter((m) => isVisibleTo(m.to, consumer))
    .slice(0, PENDING_ACK_CAP)
    .map((m) => ({ ...m, pending_ack: true as const }));
}

async function ackedMessageIds(db: D1Database, consumer: string): Promise<Set<string>> {
  const { results } = await db
    .prepare(`SELECT message_id FROM acks WHERE from_consumer = ?`)
    .bind(consumer)
    .all<{ message_id: string }>();
  return new Set((results ?? []).map((r) => r.message_id));
}

// #21: outstanding ack obligations in one channel, for the bus_channels summary.
async function pendingAckForChannel(
  db: D1Database,
  consumer: string,
  channel: Channel,
  acked: Set<string>,
): Promise<number> {
  const { results } = await db
    .prepare(`SELECT id, from_consumer, to_json FROM messages WHERE channel = ? AND requires_ack = 1`)
    .bind(channel)
    .all<{ id: string; from_consumer: string; to_json: string }>();
  let count = 0;
  for (const row of results ?? []) {
    if (row.from_consumer === consumer) continue; // own sends are not self-obligations
    if (acked.has(row.id)) continue;
    const to = JSON.parse(row.to_json) as string[];
    if (isVisibleTo(to, consumer)) count++;
  }
  return count;
}

async function unreadForChannel(db: D1Database, consumer: string, channel: Channel): Promise<number> {
  const cursorRow = await db
    .prepare(`SELECT last_seen_at FROM cursors WHERE consumer = ? AND channel = ?`)
    .bind(consumer, channel)
    .first<{ last_seen_at: string | null }>();

  const since = cursorRow?.last_seen_at ?? "1970-01-01T00:00:00.000Z";
  const { results } = await db
    .prepare(`SELECT from_consumer, to_json, created_at FROM messages WHERE channel = ? AND created_at > ?`)
    .bind(channel, since)
    .all<{ from_consumer: string; to_json: string; created_at: string }>();

  let count = 0;
  for (const row of results ?? []) {
    if (row.from_consumer === consumer) continue; // own sends are implicitly seen
    const to = JSON.parse(row.to_json) as string[];
    if (isVisibleTo(to, consumer)) count++;
  }
  return count;
}

export async function listChannels(db: D1Database, consumer: string): Promise<ChannelSummary[]> {
  const acked = await ackedMessageIds(db, consumer);
  const out: ChannelSummary[] = [];
  for (const channel of CHANNELS) {
    out.push({
      channel,
      unread: await unreadForChannel(db, consumer, channel),
      pending_ack: await pendingAckForChannel(db, consumer, channel, acked),
    });
  }
  return out;
}

export async function ackMessage(
  db: D1Database,
  from: string,
  messageId: string,
  body?: string,
): Promise<BusMessage> {
  const row = await db
    .prepare(`SELECT * FROM messages WHERE id = ?`)
    .bind(messageId)
    .first<MessageRow>();
  if (!row) throw new BusError(`message not found: ${messageId}`);

  const original = rowToMessage(row);
  if (!isVisibleTo(original.to, from) && original.from !== from) {
    throw new BusError("not authorized to ack this message");
  }

  // Ack replies address the original sender (a prior participant by definition),
  // so recipient validation is intentionally skipped here.
  return sendMessage(db, from, {
    channel: original.channel,
    thread_id: original.thread_id,
    to: [original.from],
    type: "ack",
    body: body?.trim() || `ack ${messageId}`,
    ack_of: messageId,
    refs: original.refs,
  });
}

export async function markChannelSeen(
  db: D1Database,
  consumer: string,
  channel: Channel,
  lastSeenAt: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO cursors (consumer, channel, last_seen_at)
       VALUES (?, ?, ?)
       ON CONFLICT(consumer, channel) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
    )
    .bind(consumer, channel, lastSeenAt)
    .run();
}

/** Mark a channel read up to the latest message visible to this consumer. */
export async function markChannelSeenLatest(
  db: D1Database,
  consumer: string,
  channel: Channel,
): Promise<{ channel: Channel; last_seen_at: string }> {
  if (!isChannel(channel)) throw new BusError(`invalid channel: ${channel}`);

  const { results } = await db
    .prepare(`SELECT from_consumer, to_json, created_at FROM messages WHERE channel = ? ORDER BY created_at DESC`)
    .bind(channel)
    .all<{ from_consumer: string; to_json: string; created_at: string }>();

  let lastSeenAt = nowIso();
  for (const row of results ?? []) {
    const to = JSON.parse(row.to_json) as string[];
    if (isVisibleTo(to, consumer) || row.from_consumer === consumer) {
      lastSeenAt = row.created_at;
      break;
    }
  }

  await markChannelSeen(db, consumer, channel, lastSeenAt);
  return { channel, last_seen_at: lastSeenAt };
}

export async function purgeExpired(db: D1Database, env: Env): Promise<number> {
  const cutoff = retentionCutoff(env);
  const acks = await db
    .prepare(`DELETE FROM acks WHERE message_id IN (SELECT id FROM messages WHERE created_at < ?)`)
    .bind(cutoff)
    .run();
  const msgs = await db.prepare(`DELETE FROM messages WHERE created_at < ?`).bind(cutoff).run();
  void acks;
  return msgs.meta.changes ?? 0;
}

export async function getMessage(db: D1Database, id: string): Promise<BusMessage | null> {
  const row = await db.prepare(`SELECT * FROM messages WHERE id = ?`).bind(id).first<MessageRow>();
  return row ? rowToMessage(row) : null;
}
