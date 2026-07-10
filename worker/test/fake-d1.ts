/** Minimal in-memory D1 fake for store unit tests. */

export interface MessageRow {
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

export interface CursorRow {
  consumer: string;
  channel: string;
  last_seen_at: string;
}

export interface FakeD1State {
  messages: MessageRow[];
  cursors: CursorRow[];
  acks: { message_id: string; from_consumer: string; body: string | null; created_at: string }[];
  consumers: { name: string; last_poll_at: string }[];
}

export function makeFakeD1(
  state: FakeD1State = { messages: [], cursors: [], acks: [], consumers: [] },
): D1Database {
  function makeStmt(sql: string) {
    let bound: unknown[] = [];
    return {
      bind(...args: unknown[]) {
        bound = args;
        return this;
      },
      async run() {
        if (/INSERT INTO messages/i.test(sql)) {
          const [
            id,
            channel,
            thread_id,
            from_consumer,
            to_json,
            type,
            priority,
            body,
            refs_json,
            requires_ack,
            ack_of,
            created_at,
          ] = bound as [
            string,
            string,
            string,
            string,
            string,
            string,
            string,
            string,
            string | null,
            number,
            string | null,
            string,
          ];
          state.messages.push({
            id,
            channel,
            thread_id,
            from_consumer,
            to_json,
            type,
            priority,
            body,
            refs_json,
            requires_ack,
            ack_of,
            created_at,
          });
          return { meta: { changes: 1 } };
        }
        if (/INSERT INTO acks/i.test(sql)) {
          const [message_id, from_consumer, body, created_at] = bound as [
            string,
            string,
            string,
            string,
          ];
          const idx = state.acks.findIndex(
            (a) => a.message_id === message_id && a.from_consumer === from_consumer,
          );
          const row = { message_id, from_consumer, body, created_at };
          if (idx === -1) state.acks.push(row);
          else state.acks[idx] = row;
          return { meta: { changes: 1 } };
        }
        if (/INSERT INTO consumers/i.test(sql)) {
          const [name, last_poll_at] = bound as [string, string];
          const idx = state.consumers.findIndex((c) => c.name === name);
          const row = { name, last_poll_at };
          if (idx === -1) state.consumers.push(row);
          else state.consumers[idx] = row;
          return { meta: { changes: 1 } };
        }
        if (/INSERT INTO cursors/i.test(sql)) {
          const [consumer, channel, last_seen_at] = bound as [string, string, string];
          const idx = state.cursors.findIndex((c) => c.consumer === consumer && c.channel === channel);
          const row = { consumer, channel, last_seen_at };
          if (idx === -1) state.cursors.push(row);
          else state.cursors[idx] = row;
          return { meta: { changes: 1 } };
        }
        if (/DELETE FROM acks/i.test(sql)) return { meta: { changes: 0 } };
        if (/DELETE FROM messages/i.test(sql)) {
          const [cutoff] = bound as [string];
          const before = state.messages.length;
          state.messages = state.messages.filter((m) => m.created_at >= cutoff);
          return { meta: { changes: before - state.messages.length } };
        }
        return { meta: { changes: 0 } };
      },
      async first<T>() {
        if (/SELECT \* FROM messages WHERE id = \?/i.test(sql)) {
          const id = bound[0] as string;
          return (state.messages.find((m) => m.id === id) ?? null) as T | null;
        }
        if (/SELECT last_seen_at FROM cursors/i.test(sql)) {
          const [consumer, channel] = bound as [string, string];
          const row = state.cursors.find((c) => c.consumer === consumer && c.channel === channel);
          return (row ? { last_seen_at: row.last_seen_at } : null) as T | null;
        }
        return null as T | null;
      },
      async all<T>() {
        if (/SELECT name, last_poll_at FROM consumers/i.test(sql)) {
          return { results: state.consumers.map((c) => ({ ...c })) as T[] };
        }
        if (/SELECT from_consumer, created_at FROM acks WHERE message_id = \?/i.test(sql)) {
          const messageId = bound[0] as string;
          const rows = state.acks
            .filter((a) => a.message_id === messageId)
            .map((a) => ({ from_consumer: a.from_consumer, created_at: a.created_at }));
          return { results: rows as T[] };
        }
        if (/SELECT \* FROM messages WHERE thread_id = \?/i.test(sql)) {
          const threadId = bound[0] as string;
          const rows = state.messages
            .filter((m) => m.thread_id === threadId)
            .sort((a, b) => a.created_at.localeCompare(b.created_at));
          return { results: rows as T[] };
        }
        if (/SELECT from_consumer, to_json, created_at FROM messages WHERE channel = \? ORDER BY created_at DESC/i.test(sql)) {
          const channel = bound[0] as string;
          const rows = state.messages
            .filter((m) => m.channel === channel)
            .sort((a, b) => b.created_at.localeCompare(a.created_at))
            .map((m) => ({ from_consumer: m.from_consumer, to_json: m.to_json, created_at: m.created_at }));
          return { results: rows as T[] };
        }
        if (/SELECT from_consumer, to_json, created_at FROM messages WHERE channel = \? AND created_at > \?/i.test(sql)) {
          const [channel, since] = bound as [string, string];
          const rows = state.messages
            .filter((m) => m.channel === channel && m.created_at > since)
            .map((m) => ({ from_consumer: m.from_consumer, to_json: m.to_json, created_at: m.created_at }));
          return { results: rows as T[] };
        }
        if (/SELECT \* FROM messages WHERE created_at > \?/i.test(sql) && /channel = \?/i.test(sql)) {
          const [since, channel, limit] = bound as [string, string, number];
          const rows = filterPollRows(state.messages, since, channel, true, limit);
          return { results: rows as T[] };
        }
        if (/SELECT \* FROM messages WHERE created_at >= COALESCE/i.test(sql) && /channel = \?/i.test(sql)) {
          const [since, channel, limit] = bound as [string | null, string, number];
          const rows = filterPollRows(state.messages, since ?? "1970-01-01T00:00:00.000Z", channel, false, limit);
          return { results: rows as T[] };
        }
        if (/SELECT \* FROM messages WHERE created_at > \?/i.test(sql)) {
          const [since, limit] = bound as [string, number];
          const rows = filterPollRows(state.messages, since, undefined, true, limit);
          return { results: rows as T[] };
        }
        if (/SELECT \* FROM messages WHERE created_at >= COALESCE/i.test(sql)) {
          const [since, limit] = bound as [string | null, number];
          const rows = filterPollRows(state.messages, since ?? "1970-01-01T00:00:00.000Z", undefined, false, limit);
          return { results: rows as T[] };
        }
        return { results: [] as T[] };
      },
    };
  }

  return {
    prepare(sql: string) {
      return makeStmt(sql);
    },
  } as unknown as D1Database;
}

// Mirrors the store's poll SQL: pure (created_at, id) ordering with the scan
// LIMIT applied, so cursor-loss regressions are testable here.
function filterPollRows(
  messages: MessageRow[],
  since: string,
  channel: string | undefined,
  exclusive: boolean,
  limit?: number,
): MessageRow[] {
  let rows = messages.filter((m) =>
    exclusive ? m.created_at > since : m.created_at >= since,
  );
  if (channel) rows = rows.filter((m) => m.channel === channel);
  rows.sort(
    (a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id),
  );
  return typeof limit === "number" ? rows.slice(0, limit) : rows;
}
