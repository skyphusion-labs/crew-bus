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

export interface WebhookEndpointRow {
  consumer: string;
  url: string;
  secret: string;
  auth_env: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface WebhookDeliveryRow {
  message_id: string;
  consumer: string;
  delivered_at: string | null;
  attempts: number;
  last_status: number | null;
}

export interface FakeD1State {
  messages: MessageRow[];
  cursors: CursorRow[];
  acks: { message_id: string; from_consumer: string; body: string | null; created_at: string }[];
  consumers: { name: string; last_poll_at: string }[];
  webhook_endpoints?: WebhookEndpointRow[];
  webhook_deliveries?: WebhookDeliveryRow[];
}

export function makeFakeD1(
  state: FakeD1State = { messages: [], cursors: [], acks: [], consumers: [] },
): D1Database {
  // #26: normalize the new tables so callers passing a partial state literal
  // (every pre-#26 test) still work.
  const endpoints: WebhookEndpointRow[] = (state.webhook_endpoints ??= []);
  const deliveries: WebhookDeliveryRow[] = (state.webhook_deliveries ??= []);

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
          // #22: ON CONFLICT DO NOTHING -- a duplicate ack keeps the first row.
          const row = { message_id, from_consumer, body, created_at };
          if (idx === -1) {
            state.acks.push(row);
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 0 } };
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
        // #26: webhook_endpoints upsert (created_at preserved on conflict).
        if (/INSERT INTO webhook_endpoints/i.test(sql)) {
          const [consumer, url, secret, auth_env, enabled, created_at, updated_at] = bound as [
            string,
            string,
            string,
            string | null,
            number,
            string,
            string,
          ];
          const idx = endpoints.findIndex((e) => e.consumer === consumer);
          if (idx === -1) {
            endpoints.push({ consumer, url, secret, auth_env, enabled, created_at, updated_at });
          } else {
            endpoints[idx] = {
              ...endpoints[idx]!,
              url,
              secret,
              auth_env,
              enabled,
              updated_at,
            };
          }
          return { meta: { changes: 1 } };
        }
        // #26: webhook_deliveries upsert keyed by (message_id, consumer).
        if (/INSERT INTO webhook_deliveries/i.test(sql)) {
          const [message_id, consumer, delivered_at, attempts, last_status] = bound as [
            string,
            string,
            string | null,
            number,
            number | null,
          ];
          const idx = deliveries.findIndex(
            (d) => d.message_id === message_id && d.consumer === consumer,
          );
          const row = { message_id, consumer, delivered_at, attempts, last_status };
          if (idx === -1) deliveries.push(row);
          else deliveries[idx] = row;
          return { meta: { changes: 1 } };
        }
        if (/DELETE FROM webhook_endpoints/i.test(sql)) {
          const [consumer] = bound as [string];
          const before = endpoints.length;
          const kept = endpoints.filter((e) => e.consumer !== consumer);
          endpoints.length = 0;
          endpoints.push(...kept);
          return { meta: { changes: before - endpoints.length } };
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
        // #22 idempotent-ack lookup: the first ack this consumer made on a message.
        if (/SELECT \* FROM messages WHERE ack_of = \? AND from_consumer = \?/i.test(sql)) {
          const [ackOf, fromConsumer] = bound as [string, string];
          const rows = state.messages
            .filter((m) => m.ack_of === ackOf && m.from_consumer === fromConsumer && m.type === "ack")
            .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
          return (rows[0] ?? null) as T | null;
        }
        if (/SELECT \* FROM messages WHERE id = \?/i.test(sql)) {
          const id = bound[0] as string;
          return (state.messages.find((m) => m.id === id) ?? null) as T | null;
        }
        if (/SELECT last_seen_at FROM cursors/i.test(sql)) {
          const [consumer, channel] = bound as [string, string];
          const row = state.cursors.find((c) => c.consumer === consumer && c.channel === channel);
          return (row ? { last_seen_at: row.last_seen_at } : null) as T | null;
        }
        // #26: fetch one webhook endpoint row by consumer.
        if (/SELECT consumer, url, secret, auth_env, enabled, created_at, updated_at FROM webhook_endpoints WHERE consumer = \?/i.test(sql)) {
          const consumer = bound[0] as string;
          const row = endpoints.find((e) => e.consumer === consumer);
          return (row ? { ...row } : null) as T | null;
        }
        return null as T | null;
      },
      async all<T>() {
        // #21 pending_acks: requires_ack, not from self, not yet acked, optional channel.
        if (/SELECT \* FROM messages WHERE requires_ack = 1 AND from_consumer != \?/i.test(sql)) {
          const hasChannel = /channel = \?/i.test(sql);
          const consumer = bound[0] as string;
          const channel = hasChannel ? (bound[2] as string) : undefined;
          const ackedIds = new Set(
            state.acks.filter((a) => a.from_consumer === consumer).map((a) => a.message_id),
          );
          const rows = state.messages
            .filter(
              (m) =>
                m.requires_ack === 1 &&
                m.from_consumer !== consumer &&
                !ackedIds.has(m.id) &&
                (!channel || m.channel === channel),
            )
            .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
          return { results: rows as T[] };
        }
        // #21 acked ids for a consumer.
        if (/SELECT message_id FROM acks WHERE from_consumer = \?/i.test(sql)) {
          const consumer = bound[0] as string;
          const rows = state.acks
            .filter((a) => a.from_consumer === consumer)
            .map((a) => ({ message_id: a.message_id }));
          return { results: rows as T[] };
        }
        // #21 per-channel pending-ack candidates.
        if (/SELECT id, from_consumer, to_json FROM messages WHERE channel = \? AND requires_ack = 1/i.test(sql)) {
          const channel = bound[0] as string;
          const rows = state.messages
            .filter((m) => m.channel === channel && m.requires_ack === 1)
            .map((m) => ({ id: m.id, from_consumer: m.from_consumer, to_json: m.to_json }));
          return { results: rows as T[] };
        }
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
        // #26: webhook delivery accounting for a message, keyed by recipient.
        if (/SELECT consumer, delivered_at, attempts FROM webhook_deliveries WHERE message_id = \?/i.test(sql)) {
          const messageId = bound[0] as string;
          const rows = deliveries
            .filter((d) => d.message_id === messageId)
            .map((d) => ({ consumer: d.consumer, delivered_at: d.delivered_at, attempts: d.attempts }));
          return { results: rows as T[] };
        }
        // #26: consumers with an enabled endpoint (bus_consumers webhook flag).
        if (/SELECT consumer FROM webhook_endpoints WHERE enabled = 1/i.test(sql)) {
          const rows = endpoints.filter((e) => e.enabled === 1).map((e) => ({ consumer: e.consumer }));
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
        // #37: a consumer's per-channel poll cursors.
        if (/SELECT channel, last_seen_at FROM cursors WHERE consumer = \?/i.test(sql)) {
          const consumer = bound[0] as string;
          const rows = state.cursors
            .filter((c) => c.consumer === consumer)
            .map((c) => ({ channel: c.channel, last_seen_at: c.last_seen_at }));
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
