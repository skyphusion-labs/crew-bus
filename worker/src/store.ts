import type { Env } from "./env";
import {
  type BusMessage,
  type Channel,
  type ChannelSummary,
  type MessageRefs,
  type MessageType,
  type Priority,
  CHANNELS,
  isChannel,
  isMessageType,
  isPriority,
  isVisibleTo,
  newId,
  nowIso,
  retentionCutoff,
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

function parseTo(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("to must be a non-empty array");
  }
  for (const item of value) {
    if (typeof item !== "string" || !item.trim()) {
      throw new Error("to entries must be non-empty strings");
    }
  }
  return value as string[];
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
): Promise<BusMessage> {
  if (!isChannel(input.channel)) {
    throw new Error(`invalid channel: ${input.channel}`);
  }
  if (!isMessageType(input.type)) {
    throw new Error(`invalid type: ${input.type}`);
  }
  const priority = input.priority ?? "normal";
  if (!isPriority(priority)) {
    throw new Error(`invalid priority: ${priority}`);
  }
  const to = parseTo(input.to);
  const body = String(input.body ?? "").trim();
  if (!body) throw new Error("body is required");

  if (input.type === "ack" && !input.ack_of) {
    throw new Error("ack messages require ack_of");
  }

  const id = newId("msg");
  const thread_id = input.thread_id?.trim() || newId("thr");
  const created_at = nowIso();
  const requires_ack = input.requires_ack ? 1 : 0;

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
      input.refs ? JSON.stringify(input.refs) : null,
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
    refs: input.refs ?? null,
    requires_ack: Boolean(requires_ack),
    ack_of: input.ack_of ?? null,
    created_at,
  };
}

export async function getThread(db: D1Database, threadId: string, consumer: string): Promise<BusMessage[]> {
  const { results } = await db
    .prepare(`SELECT * FROM messages WHERE thread_id = ? ORDER BY created_at ASC`)
    .bind(threadId)
    .all<MessageRow>();

  return (results ?? [])
    .map(rowToMessage)
    .filter((m) => isVisibleTo(m.to, consumer));
}

export async function pollMessages(
  db: D1Database,
  consumer: string,
  opts: { channel?: string; since?: string; limit?: number },
): Promise<{ messages: BusMessage[]; cursor: string | null }> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  let query = `SELECT * FROM messages WHERE created_at >= COALESCE(?, '1970-01-01T00:00:00.000Z')`;
  const binds: unknown[] = [opts.since ?? null];

  if (opts.channel) {
    if (!isChannel(opts.channel)) throw new Error(`invalid channel: ${opts.channel}`);
    query += ` AND channel = ?`;
    binds.push(opts.channel);
  }

  query += ` ORDER BY CASE priority WHEN 'blocking' THEN 0 ELSE 1 END, created_at ASC LIMIT ?`;
  binds.push(limit + 50);

  const { results } = await db.prepare(query).bind(...binds).all<MessageRow>();
  const visible = (results ?? [])
    .map(rowToMessage)
    .filter((m) => isVisibleTo(m.to, consumer))
    .slice(0, limit);

  const cursor = visible.length ? visible[visible.length - 1]!.created_at : null;
  return { messages: visible, cursor };
}

async function unreadForChannel(db: D1Database, consumer: string, channel: Channel): Promise<number> {
  const cursorRow = await db
    .prepare(`SELECT last_seen_at FROM cursors WHERE consumer = ? AND channel = ?`)
    .bind(consumer, channel)
    .first<{ last_seen_at: string | null }>();

  const since = cursorRow?.last_seen_at ?? "1970-01-01T00:00:00.000Z";
  const { results } = await db
    .prepare(`SELECT to_json, created_at FROM messages WHERE channel = ? AND created_at > ?`)
    .bind(channel, since)
    .all<{ to_json: string; created_at: string }>();

  let count = 0;
  for (const row of results ?? []) {
    const to = JSON.parse(row.to_json) as string[];
    if (isVisibleTo(to, consumer)) count++;
  }
  return count;
}

export async function listChannels(db: D1Database, consumer: string): Promise<ChannelSummary[]> {
  const out: ChannelSummary[] = [];
  for (const channel of CHANNELS) {
    out.push({ channel, unread: await unreadForChannel(db, consumer, channel) });
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
  if (!row) throw new Error(`message not found: ${messageId}`);

  const original = rowToMessage(row);
  if (!isVisibleTo(original.to, from) && original.from !== from) {
    throw new Error("not authorized to ack this message");
  }

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
