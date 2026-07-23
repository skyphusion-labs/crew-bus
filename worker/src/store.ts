import { BusError } from "./bus-error";
import { isVpcDoorbellBinding } from "./env";
import type { Env } from "./env";
import {
  type BusMessage,
  type Channel,
  type ChannelSummary,
  type Claim,
  type ConsumerStatus,
  type MessageRefs,
  type MessageType,
  type Priority,
  type RecipientDelivery,
  type ThreadMessage,
  type WebhookEndpoint,
  type WebhookEndpointView,
  CHANNELS,
  DOORBELL_STALE_MIN_AGE_MS,
  DOORBELL_STALE_MIN_RINGS,
  MAX_AUTH_ENV_CHARS,
  MAX_BODY_BYTES,
  MAX_REF_CHARS,
  MAX_THREAD_ID_CHARS,
  MAX_TO_ENTRIES,
  MAX_TO_ENTRY_CHARS,
  MAX_WEBHOOK_SECRET_CHARS,
  MAX_VPC_BINDING_CHARS,
  MAX_WEBHOOK_URL_CHARS,
  isAllowedAuthEnv,
  isChannel,
  isHttpsUrl,
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

/** Composite poll cursor: created_at + id, so same-ms messages are not dropped. */
export const POLL_CURSOR_SEP = "\x1f";

export function formatPollCursor(createdAt: string, id: string): string {
  return `${createdAt}${POLL_CURSOR_SEP}${id}`;
}

export function parsePollCursor(raw: string): { createdAt: string; id: string | null } {
  const i = raw.indexOf(POLL_CURSOR_SEP);
  if (i === -1) return { createdAt: raw, id: null };
  return { createdAt: raw.slice(0, i), id: raw.slice(i + 1) || null };
}

export function comparePollCursors(a: string, b: string): number {
  const pa = parsePollCursor(a);
  const pb = parsePollCursor(b);
  const byTime = pa.createdAt.localeCompare(pb.createdAt);
  if (byTime !== 0) return byTime;
  return (pa.id ?? "").localeCompare(pb.id ?? "");
}

function pollSinceClause(since: string | null): { clause: string; binds: unknown[] } {
  if (since === null) {
    return { clause: "created_at >= COALESCE(?, '1970-01-01T00:00:00.000Z')", binds: [since] };
  }
  const { createdAt, id } = parsePollCursor(since);
  if (id) {
    return {
      clause: "(created_at > ? OR (created_at = ? AND id > ?))",
      binds: [createdAt, createdAt, id],
    };
  }
  return { clause: "created_at > ?", binds: [createdAt] };
}

function messageAtOrBeforeWatermark(m: BusMessage, watermark: string): boolean {
  const wm = parsePollCursor(watermark);
  if (m.created_at !== wm.createdAt) return m.created_at <= wm.createdAt;
  if (!wm.id) return true;
  return m.id <= wm.id;
}

function minPollCursor(cursors: Iterable<string>): string {
  let min: string | null = null;
  for (const c of cursors) {
    if (min === null || comparePollCursors(c, min) < 0) min = c;
  }
  return min!;
}

/** A redelivered, still-unacked message. pending_ack distinguishes it from new traffic. */
export type PendingAckMessage = BusMessage & { pending_ack: true; claim?: Claim | null };

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
         ON CONFLICT(message_id, from_consumer) DO NOTHING`,
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
// #26: each report also carries webhook_delivered_at / webhook_attempts.
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
  const raw = (results ?? [])
    .map(rowToMessage)
    .filter((m) => isVisibleTo(m.to, consumer) || m.from === consumer);

  // #41: handoff rows carry their claim state for every thread reader, so a
  // late arriver sees who owns the work without a delivery report.
  const visible: ThreadMessage[] = [];
  for (const m of raw) {
    const claim = m.type === "handoff" ? await getClaim(db, m.id) : undefined;
    visible.push(claim === undefined ? m : { ...m, claim });
  }

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

    // #26: webhook delivery accounting for this message, keyed by recipient.
    const { results: whRows } = await db
      .prepare(`SELECT consumer, delivered_at, attempts FROM webhook_deliveries WHERE message_id = ?`)
      .bind(m.id)
      .all<{ consumer: string; delivered_at: string | null; attempts: number }>();
    const whMap = new Map((whRows ?? []).map((r) => [r.consumer, r] as const));

    const delivery: RecipientDelivery[] = recipients.map((r) => {
      const lastPoll = pollMap.get(r) ?? null;
      const wh = whMap.get(r);
      return {
        recipient: r,
        acked_at: ackMap.get(r) ?? null,
        polled_after: lastPoll !== null && lastPoll >= m.created_at,
        webhook_delivered_at: wh?.delivered_at ?? null,
        webhook_attempts: wh?.attempts ?? 0,
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

// #47 doorbell reader health, computed per consumer from data the bus already
// holds. The failure this exists to catch: rings are delivered (2xx from the
// seat listener) and land in a log file that NOTHING IS READING, because the
// consuming session tail died on /compact. Delivered-but-never-consumed is the
// exact signature, and it is entirely server-side computable.
//
// The consumption watermark is max(last_poll_at, newest ack). Both are
// monotonic per consumer, so "did it read anything after this ring landed?"
// reduces to a string compare against that single watermark (all timestamps are
// Date#toISOString, so lexical order IS chronological order).
interface DoorbellHealth {
  last_ring_delivered_at: string | null;
  last_message_consumed_at: string | null;
  undelivered_to_reader: number;
  oldest_undelivered_ring_at: string | null;
  doorbell_stale: boolean;
}

async function doorbellHealth(
  db: D1Database,
  names: string[],
  pollMap: Map<string, string | null>,
  webhookNames: Set<string>,
): Promise<Map<string, DoorbellHealth>> {
  // Two roster-wide reads (not per consumer): every successful ring, and every
  // ack. Both tables are bounded by the retention sweep.
  const { results: ringRows } = await db
    .prepare(
      `SELECT consumer, delivered_at FROM webhook_deliveries
       WHERE delivered_at IS NOT NULL ORDER BY delivered_at`,
    )
    .all<{ consumer: string; delivered_at: string }>();
  const { results: ackRows } = await db
    .prepare(`SELECT from_consumer, created_at FROM acks ORDER BY created_at`)
    .all<{ from_consumer: string; created_at: string }>();

  const ringsBy = new Map<string, string[]>();
  for (const r of ringRows ?? []) {
    const list = ringsBy.get(r.consumer);
    if (list) list.push(r.delivered_at);
    else ringsBy.set(r.consumer, [r.delivered_at]);
  }
  const lastAck = new Map<string, string>();
  for (const a of ackRows ?? []) {
    const prev = lastAck.get(a.from_consumer);
    if (prev === undefined || a.created_at > prev) lastAck.set(a.from_consumer, a.created_at);
  }

  const staleBefore = new Date(Date.now() - DOORBELL_STALE_MIN_AGE_MS).toISOString();
  const out = new Map<string, DoorbellHealth>();
  for (const name of names) {
    const rings = ringsBy.get(name) ?? [];
    const poll = pollMap.get(name) ?? null;
    const ack = lastAck.get(name) ?? null;
    // Newest evidence the consumer read anything at all.
    const consumed = poll === null ? ack : ack === null ? poll : poll > ack ? poll : ack;

    let lastRing: string | null = null;
    let oldestUnconsumed: string | null = null;
    let unconsumed = 0;
    for (const at of rings) {
      if (lastRing === null || at > lastRing) lastRing = at;
      if (consumed !== null && at <= consumed) continue;
      unconsumed++;
      if (oldestUnconsumed === null || at < oldestUnconsumed) oldestUnconsumed = at;
    }

    const stale =
      webhookNames.has(name) &&
      unconsumed >= DOORBELL_STALE_MIN_RINGS &&
      oldestUnconsumed !== null &&
      oldestUnconsumed <= staleBefore;

    out.set(name, {
      last_ring_delivered_at: lastRing,
      last_message_consumed_at: consumed,
      undelivered_to_reader: unconsumed,
      oldest_undelivered_ring_at: oldestUnconsumed,
      doorbell_stale: stale,
    });
  }
  return out;
}

// Consumer discovery (#17.2): the registered roster (from the token map) joined
// with each consumer's last_poll_at. Names with no poll row yet return null.
// #26: also reports a webhook flag (registered AND enabled), no url/secret.
// #47: also reports doorbell reader health, so `webhook: true` is no longer the
// only thing a caller can check (it never meant rings reach a reader).
export async function listConsumers(db: D1Database, names: string[]): Promise<ConsumerStatus[]> {
  const { results } = await db
    .prepare(`SELECT name, last_poll_at FROM consumers`)
    .all<{ name: string; last_poll_at: string | null }>();
  const pollMap = new Map((results ?? []).map((r) => [r.name, r.last_poll_at] as const));
  const webhookNames = await enabledWebhookConsumers(db);
  const health = await doorbellHealth(db, names, pollMap, webhookNames);
  return names.map((name) => ({
    name,
    last_poll_at: pollMap.get(name) ?? null,
    webhook: webhookNames.has(name),
    ...(health.get(name) ?? {
      last_ring_delivered_at: null,
      last_message_consumed_at: null,
      undelivered_to_reader: 0,
      oldest_undelivered_ring_at: null,
      doorbell_stale: false,
    }),
  }));
}

// #37: the cursors table IS the consumer poll cursor. Load this consumer's
// per-channel watermarks (rows with a null last_seen_at count as absent).
async function loadCursors(db: D1Database, consumer: string): Promise<Map<Channel, string>> {
  const { results } = await db
    .prepare(`SELECT channel, last_seen_at FROM cursors WHERE consumer = ?`)
    .bind(consumer)
    .all<{ channel: string; last_seen_at: string | null }>();
  const map = new Map<Channel, string>();
  for (const row of results ?? []) {
    if (isChannel(row.channel) && row.last_seen_at) map.set(row.channel, row.last_seen_at);
  }
  return map;
}

export async function pollMessages(
  db: D1Database,
  consumer: string,
  opts: { channel?: string; since?: string; limit?: number },
): Promise<{ messages: BusMessage[]; cursor: string | null; pending_acks: PendingAckMessage[] }> {
  await recordPoll(db, consumer);
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  if (opts.channel && !isChannel(opts.channel)) {
    throw new BusError(`invalid channel: ${opts.channel}`);
  }
  const channel = opts.channel as Channel | undefined;
  const explicitSince = opts.since ? opts.since : undefined;

  // #37 (fc#660 drill): a poll WITHOUT since resumes from the stored consumer
  // cursor, so successive bare polls page FORWARD through a backlog instead of
  // re-reading the oldest page forever. A channel poll resumes from that
  // channel's watermark; a bare poll resumes from the MIN across all channels
  // (any channel without a watermark yet means scan from epoch). An explicit
  // since stays a caller-driven override (history re-read), honored verbatim.
  const stored = await loadCursors(db, consumer);
  let since: string | null;
  if (explicitSince !== undefined) {
    since = explicitSince;
  } else if (channel) {
    since = stored.get(channel) ?? null;
  } else {
    since = CHANNELS.every((c) => stored.has(c)) ? minPollCursor(stored.values()) : null;
  }

  const { clause: sinceClause, binds: sinceBinds } = pollSinceClause(since);
  let query = `SELECT * FROM messages WHERE ${sinceClause}`;
  const binds: unknown[] = [...sinceBinds];

  if (channel) {
    query += ` AND channel = ?`;
    binds.push(channel);
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
  // #37: on a bare no-since poll the MIN lower bound re-scans channels whose
  // own watermark sits ahead of it; rows at or before their channel watermark
  // were already delivered or marked seen, so suppress the re-delivery. Never
  // applied when the caller passed an explicit since (history re-read).
  const seenBefore = (m: BusMessage): boolean => {
    if (explicitSince !== undefined) return false;
    const watermark = stored.get(m.channel);
    return watermark !== undefined && messageAtOrBeforeWatermark(m, watermark);
  };
  // Own sends are excluded from poll results (bus_send already returned them)
  // but still advance the cursor below via the raw scan window.
  const visible = raw.filter(
    (m) => isVisibleTo(m.to, consumer) && m.from !== consumer && !seenBefore(m),
  );
  const messages = visible.slice(0, limit);

  // Lossless cursor: if the page truncated, stop at the last RETURNED message;
  // otherwise every visible row in the scanned window was returned, so advance
  // past the whole window (including invisible rows -- otherwise a flood of
  // messages for other consumers would pin the cursor forever).
  let cursor: string | null = null;
  if (visible.length > limit) {
    const last = messages[messages.length - 1]!;
    cursor = formatPollCursor(last.created_at, last.id);
  } else if (raw.length) {
    const last = raw[raw.length - 1]!;
    cursor = formatPollCursor(last.created_at, last.id);
  }

  // #37: persist the watermark FORWARD-ONLY so the next bare poll resumes
  // where this one stopped, and an explicit-since history re-read never
  // rewinds it. A bare poll scanned every channel up to the cursor, so every
  // channel watermark advances; a dropped page cannot lose an ack-gated
  // message because pending_acks bypass the cursor entirely (#21).
  if (cursor !== null) {
    const advanceTo = cursor;
    const touched: readonly Channel[] = channel ? [channel] : CHANNELS;
    for (const ch of touched) {
      const prev = stored.get(ch);
      if (prev === undefined || comparePollCursors(advanceTo, prev) > 0) {
        await markChannelSeen(db, consumer, ch, advanceTo);
      }
    }
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
  const pending = (results ?? [])
    .map(rowToMessage)
    .filter((m) => isVisibleTo(m.to, consumer))
    .slice(0, PENDING_ACK_CAP)
    .map((m) => ({ ...m, pending_ack: true as const }) as PendingAckMessage);
  // #41: annotate pending handoffs with their claim state, so a poller seeing a
  // broadcast handoff already claimed by someone else knows to bus_claim (which
  // records the losing receipt-ack) rather than start the work.
  for (const m of pending) {
    if (m.type === "handoff") m.claim = await getClaim(db, m.id);
  }
  return pending;
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
  const { clause, binds } = pollSinceClause(since);
  const { results } = await db
    .prepare(`SELECT from_consumer, to_json, created_at FROM messages WHERE channel = ? AND ${clause}`)
    .bind(channel, ...binds)
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

  // #22: idempotent. A retried/duplicated ack must not create a second ack row
  // or a second ack-type message; return the FIRST ack unchanged. The acks PK
  // (message_id, from_consumer) is the durable guard (DO NOTHING above); this
  // makes the whole operation a no-op on repeat so thread history and delivery
  // reports stay clean.
  const existing = await db
    .prepare(
      `SELECT * FROM messages WHERE ack_of = ? AND from_consumer = ? AND type = 'ack' ORDER BY created_at ASC, id ASC LIMIT 1`,
    )
    .bind(messageId, from)
    .first<MessageRow>();
  if (existing) return rowToMessage(existing);

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

// ---------------------------------------------------------------------------
// #41 claim arbitration (triple-claim incident 2026-07-17)
// ---------------------------------------------------------------------------

/** The winning claim on a message, or null if unclaimed. */
export async function getClaim(db: D1Database, messageId: string): Promise<Claim | null> {
  const row = await db
    .prepare(`SELECT message_id, claimed_by, created_at FROM claims WHERE message_id = ?`)
    .bind(messageId)
    .first<Claim>();
  return row ?? null;
}

export interface ClaimOutcome {
  /** True when the caller owns the work order; false = stand down. */
  claimed: boolean;
  claim: Claim;
  message: BusMessage;
  /** The receipt ack recorded for the caller (win or lose), clearing pending_acks. */
  ack: BusMessage;
}

// First claim wins, arbitrated by the claims PK: INSERT ... ON CONFLICT DO
// NOTHING then read back the row, so two racing claimers converge on one
// winner no matter how late a doorbell fired. Both outcomes record the
// caller's ack (delivery receipt): the winner's as the claim, the loser's as
// a stand-down receipt, so a lost claim also clears the pending_ack
// obligation. Idempotent: re-claiming returns the same outcome (ackMessage is
// already idempotent per #22).
export async function claimMessage(
  db: D1Database,
  from: string,
  messageId: string,
  body?: string,
): Promise<ClaimOutcome> {
  const row = await db
    .prepare(`SELECT * FROM messages WHERE id = ?`)
    .bind(messageId)
    .first<MessageRow>();
  if (!row) throw new BusError(`message not found: ${messageId}`);
  const message = rowToMessage(row);
  if (message.from === from) throw new BusError("cannot claim your own message");
  if (!isVisibleTo(message.to, from)) {
    throw new BusError("not authorized to claim this message");
  }
  if (message.type !== "handoff") {
    throw new BusError(`claim applies to type=handoff messages (got type=${message.type})`);
  }

  await db
    .prepare(
      `INSERT INTO claims (message_id, claimed_by, created_at)
       VALUES (?, ?, ?)
       ON CONFLICT(message_id) DO NOTHING`,
    )
    .bind(messageId, from, nowIso())
    .run();

  const claim = await getClaim(db, messageId);
  if (!claim) throw new BusError("failed to persist claim");
  const claimed = claim.claimed_by === from;

  // A loser's caller-supplied body was written as a claim ("starting now") and
  // would mislead the thread; the stand-down receipt always states the winner.
  const ackBody = claimed
    ? body?.trim() || `claim ${messageId}`
    : `ack ${messageId} (claim lost to ${claim.claimed_by})`;
  const ack = await ackMessage(db, from, messageId, ackBody);

  return { claimed, claim, message, ack };
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
    .prepare(
      `SELECT from_consumer, to_json, created_at, id FROM messages WHERE channel = ? ORDER BY created_at DESC, id DESC`,
    )
    .bind(channel)
    .all<{ from_consumer: string; to_json: string; created_at: string; id: string }>();

  let lastSeenAt = formatPollCursor(nowIso(), newId("seen"));
  for (const row of results ?? []) {
    const to = JSON.parse(row.to_json) as string[];
    if (isVisibleTo(to, consumer) || row.from_consumer === consumer) {
      lastSeenAt = formatPollCursor(row.created_at, row.id);
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

// ---------------------------------------------------------------------------
// #26 doorbell webhooks
// ---------------------------------------------------------------------------

interface WebhookEndpointRow {
  consumer: string;
  target_kind: string;
  url: string;
  vpc_binding: string | null;
  secret: string;
  auth_env: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}

function rowToEndpoint(row: WebhookEndpointRow): WebhookEndpoint {
  return {
    consumer: row.consumer,
    target_kind: row.target_kind === "vpc" ? "vpc" : "url",
    url: row.url,
    vpc_binding: row.vpc_binding,
    secret: row.secret,
    auth_env: row.auth_env,
    enabled: row.enabled === 1,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** Caller-safe view: the secret VALUE is never surfaced, only secret_set: true. */
function toView(ep: WebhookEndpoint): WebhookEndpointView {
  return {
    consumer: ep.consumer,
    target_kind: ep.target_kind,
    // #40: a url endpoint keeps its populated url (existing readers unaffected);
    // a vpc endpoint reports null url + its binding name.
    url: ep.target_kind === "vpc" ? null : ep.url,
    vpc_binding: ep.target_kind === "vpc" ? ep.vpc_binding : null,
    auth_env: ep.auth_env,
    enabled: ep.enabled,
    secret_set: true,
    created_at: ep.created_at,
    updated_at: ep.updated_at,
  };
}

/** The registered endpoint for a consumer, or null. Internal (carries secret). */
export async function getWebhook(db: D1Database, consumer: string): Promise<WebhookEndpoint | null> {
  const row = await db
    .prepare(
      `SELECT consumer, target_kind, url, vpc_binding, secret, auth_env, enabled, created_at, updated_at FROM webhook_endpoints WHERE consumer = ?`,
    )
    .bind(consumer)
    .first<WebhookEndpointRow>();
  return row ? rowToEndpoint(row) : null;
}

/** Caller-safe endpoint view for a consumer, or null when unregistered. */
export async function getWebhookView(
  db: D1Database,
  consumer: string,
): Promise<WebhookEndpointView | null> {
  const ep = await getWebhook(db, consumer);
  return ep ? toView(ep) : null;
}

/** #40: a private Workers VPC doorbell target. `binding` names a declared VPC
 * binding (allowlisted); `consumer`, if given, must match the registering consumer. */
export interface WebhookVpcInput {
  binding: string;
  consumer?: string | null;
}

export interface WebhookInput {
  // #40 dual-path: provide EXACTLY ONE of `url` (public https) or `vpc` (private binding).
  url?: string | null;
  vpc?: WebhookVpcInput | null;
  secret: string;
  auth_env?: string | null;
  enabled?: boolean;
}

/**
 * Register or replace a consumer's own endpoint. Exactly one target: a public
 * https `url`, or a private `vpc` binding (#40). Returns the masked view.
 */
export async function setWebhook(
  db: D1Database,
  consumer: string,
  input: WebhookInput,
): Promise<WebhookEndpointView> {
  const rawUrl = input.url != null ? String(input.url).trim() : "";
  const hasUrl = rawUrl !== "";
  const hasVpc = input.vpc != null;
  if (hasUrl && hasVpc) {
    throw new BusError("provide exactly one target: url OR vpc, not both");
  }
  if (!hasUrl && !hasVpc) {
    throw new BusError("a target is required: url (https) or vpc { binding }");
  }

  let targetKind: "url" | "vpc";
  let url: string;
  let vpcBinding: string | null;
  if (hasVpc) {
    targetKind = "vpc";
    url = "";
    const binding = String(input.vpc?.binding ?? "").trim();
    if (!binding) throw new BusError("vpc.binding is required");
    if (binding.length > MAX_VPC_BINDING_CHARS) {
      throw new BusError(`vpc.binding is capped at ${MAX_VPC_BINDING_CHARS} chars`);
    }
    // Allowlist: only a binding actually declared on the Worker is registerable, so
    // a typo cannot silently register an unroutable doorbell (it would just poll).
    if (!isVpcDoorbellBinding(binding)) {
      throw new BusError(`unknown vpc binding: ${binding}`);
    }
    // A consumer registers only its OWN row; a vpc.consumer, if supplied, must be self.
    const vpcConsumer = input.vpc?.consumer != null ? String(input.vpc.consumer).trim() : consumer;
    if (vpcConsumer !== consumer) {
      throw new BusError("vpc.consumer must match your own consumer");
    }
    vpcBinding = binding;
  } else {
    targetKind = "url";
    if (rawUrl.length > MAX_WEBHOOK_URL_CHARS) {
      throw new BusError(`url is capped at ${MAX_WEBHOOK_URL_CHARS} chars`);
    }
    if (!isHttpsUrl(rawUrl)) throw new BusError("url must be https");
    url = rawUrl;
    vpcBinding = null;
  }

  const secret = String(input.secret ?? "");
  if (!secret) throw new BusError("secret is required");
  if (secret.length > MAX_WEBHOOK_SECRET_CHARS) {
    throw new BusError(`secret is capped at ${MAX_WEBHOOK_SECRET_CHARS} chars`);
  }
  const authEnv = input.auth_env != null ? String(input.auth_env).trim() : null;
  if (authEnv && authEnv.length > MAX_AUTH_ENV_CHARS) {
    throw new BusError(`auth_env is capped at ${MAX_AUTH_ENV_CHARS} chars`);
  }
  if (authEnv && !isAllowedAuthEnv(authEnv)) {
    throw new BusError(
      "auth_env must name a dedicated webhook Authorization secret (pattern: NAME_AUTH); core Worker bindings are rejected",
    );
  }
  const enabled = input.enabled === undefined ? 1 : input.enabled ? 1 : 0;
  const now = nowIso();

  await db
    .prepare(
      `INSERT INTO webhook_endpoints (consumer, target_kind, url, vpc_binding, secret, auth_env, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(consumer) DO UPDATE SET
         target_kind = excluded.target_kind,
         url = excluded.url,
         vpc_binding = excluded.vpc_binding,
         secret = excluded.secret,
         auth_env = excluded.auth_env,
         enabled = excluded.enabled,
         updated_at = excluded.updated_at`,
    )
    .bind(consumer, targetKind, url, vpcBinding, secret, authEnv || null, enabled, now, now)
    .run();

  const ep = await getWebhook(db, consumer);
  if (!ep) throw new BusError("failed to persist webhook endpoint");
  return toView(ep);
}

export async function deleteWebhook(db: D1Database, consumer: string): Promise<void> {
  await db.prepare(`DELETE FROM webhook_endpoints WHERE consumer = ?`).bind(consumer).run();
}

/** Consumers with a registered AND enabled endpoint (bus_consumers webhook flag). */
async function enabledWebhookConsumers(db: D1Database): Promise<Set<string>> {
  const { results } = await db
    .prepare(`SELECT consumer FROM webhook_endpoints WHERE enabled = 1`)
    .all<{ consumer: string }>();
  return new Set((results ?? []).map((r) => r.consumer));
}

/** Upsert the delivery accounting row for one (message, recipient) pair. */
async function recordDelivery(
  db: D1Database,
  messageId: string,
  consumer: string,
  deliveredAt: string | null,
  attempts: number,
  lastStatus: number,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO webhook_deliveries (message_id, consumer, delivered_at, attempts, last_status)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(message_id, consumer) DO UPDATE SET
         delivered_at = excluded.delivered_at,
         attempts = excluded.attempts,
         last_status = excluded.last_status`,
    )
    .bind(messageId, consumer, deliveredAt, attempts, lastStatus)
    .run();
}

async function hmacSha256Hex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Backoff before retry attempts 2 and 3 (~1s then ~5s). Injectable in tests.
const WEBHOOK_BACKOFF_MS = [1000, 5000] as const;
const WEBHOOK_MAX_ATTEMPTS = 3;

export interface FireOptions {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

async function deliverOne(
  db: D1Database,
  env: Env,
  message: BusMessage,
  ep: WebhookEndpoint,
  fetchImpl: typeof fetch,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  const consumer = ep.consumer;
  // Doorbell payload: NO message body, ever. The receiver's only correct
  // reaction is to poll the bus.
  const rawBody = JSON.stringify({
    message_id: message.id,
    channel: message.channel,
    thread_id: message.thread_id,
    sent_at: message.created_at,
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = `sha256=${await hmacSha256Hex(ep.secret, `${timestamp}.${rawBody}`)}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Bus-Timestamp": timestamp,
    "X-Bus-Consumer": consumer,
    "X-Bus-Signature": signature,
  };
  if (ep.auth_env) {
    const authVal = env[ep.auth_env];
    if (typeof authVal === "string" && authVal) {
      headers["Authorization"] = authVal;
    } else {
      // Missing binding: log and skip the auth header, still fire the doorbell.
      console.log(
        JSON.stringify({ event: "webhook_auth_env_missing", consumer, auth_env: ep.auth_env }),
      );
    }
  }

  // #40 dual-path transport. A "url" endpoint POSTs to a public https origin
  // (the v0.4.0 path, unchanged). A "vpc" endpoint rings through a Workers VPC
  // binding to the box doorbell mux; the mux routes by the /ring/<consumer> path
  // (X-Bus-Consumer header carries it too). Headers, HMAC, body, and retry are
  // IDENTICAL across both paths -- only the transport differs.
  let ring: (init: RequestInit) => Promise<Response>;
  if (ep.target_kind === "vpc") {
    const binding = ep.vpc_binding ?? "";
    const svc = binding ? (env[binding] as Fetcher | undefined) : undefined;
    if (!svc || typeof svc.fetch !== "function") {
      // Registered but the binding is not provisioned on this deploy: log and
      // degrade to poll (record attempts 0 so the thread report shows it tried).
      console.log(
        JSON.stringify({ event: "webhook_vpc_binding_missing", consumer, vpc_binding: binding }),
      );
      await recordDelivery(db, message.id, consumer, null, 0, 0);
      return;
    }
    // http, NOT https -- deliberate, and it is the transport contract, not a downgrade.
    // The Workers VPC service for the doorbell defines http_port 9870 with https_port NULL:
    // the mux listens plaintext on loopback behind the tunnel, so there is no TLS on it to
    // handshake with. The edge maps the URL SCHEME to the service port config BEFORE any
    // transport happens, so an https:// URL against an http-only service fails at the edge
    // with `port_not_open ... failed to build target strategy: https` -- it never reaches the
    // tunnel, and no amount of tunnel/routing debugging can see it. Proven end to end by the
    // #45 ring proof: the identical request over http:// rang edge -> tunnel -> mux -> seat.
    // If the service ever gains an https_port, change BOTH together, never just this line.
    const ringUrl = `http://doorbell.local/ring/${encodeURIComponent(consumer)}`;
    ring = (init) => svc.fetch(ringUrl, init);
  } else {
    ring = (init) => fetchImpl(ep.url, init);
  }

  let attempts = 0;
  let lastStatus = 0;
  let deliveredAt: string | null = null;
  for (let i = 0; i < WEBHOOK_MAX_ATTEMPTS; i++) {
    if (i > 0) await sleep(WEBHOOK_BACKOFF_MS[i - 1] ?? 5000);
    attempts = i + 1;
    try {
      const res = await ring({ method: "POST", headers, body: rawBody });
      lastStatus = res.status;
      if (res.status >= 200 && res.status < 300) {
        deliveredAt = nowIso();
        break;
      }
    } catch (err) {
      // Network error: status 0, keep retrying within the attempt budget.
      lastStatus = 0;
      // LOG THE MESSAGE. This catch used to swallow the exception entirely, so a hard,
      // permanent, edge-level misconfiguration (the https-vs-http scheme bug above) recorded
      // identically to a transient network blip: attempts=3, last_status=0, and nothing else.
      // That is a check reporting fine while the thing it checks is broken -- the failure was
      // fully diagnosed only by binding a throwaway probe Worker to the same service to
      // extract the string this line now prints. An hour of work to recover one message.
      // MESSAGE ONLY: never the headers or body. `headers` carries the HMAC signature and,
      // for an auth_env endpoint, the Authorization value; the body is the doorbell payload.
      // A fetch exception message carries neither, so this is safe to emit -- keep it that way.
      console.log(
        JSON.stringify({
          event: "webhook_attempt_error",
          consumer,
          attempt: attempts,
          message: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }
  await recordDelivery(db, message.id, consumer, deliveredAt, attempts, lastStatus);
}

// Fire doorbell webhooks for a successful send. MUST NOT throw: it runs inside
// ctx.waitUntil, off the send's critical path, and a webhook failure degrades to
// exactly the poll-only behavior. Resolves the recipient set (roster-expanded
// "*", minus the sender), fires only enabled endpoints, and records every path.
export async function fireWebhooks(
  env: Env,
  message: BusMessage,
  knownConsumers: string[],
  opts: FireOptions = {},
): Promise<void> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  try {
    const recipients = (message.to.includes("*") ? knownConsumers : message.to).filter(
      (r) => r !== message.from,
    );
    for (const consumer of recipients) {
      try {
        const ep = await getWebhook(env.DB, consumer);
        if (!ep || !ep.enabled) continue;
        await deliverOne(env.DB, env, message, ep, fetchImpl, sleep);
      } catch (err) {
        // One bad recipient must not stop the others or fail the send path.
        console.error(
          JSON.stringify({
            event: "webhook_deliver_error",
            consumer,
            message_id: message.id,
            detail: err instanceof Error ? err.message : String(err),
          }),
        );
      }
    }
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "webhook_fire_error",
        message_id: message.id,
        detail: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}
