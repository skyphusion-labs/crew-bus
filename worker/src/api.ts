import type { Env } from "./env";
import { bearerToken, consumerNames, json, matchConsumer, requireConsumer } from "./auth";
import { BusError, clientErrorMessage } from "./bus-error";
import { CHANNELS, isChannel } from "./bus-types";
import {
  ackMessage,
  deleteWebhook,
  fireWebhooks,
  getThread,
  getWebhookView,
  listChannels,
  listConsumers,
  markChannelSeen,
  markChannelSeenLatest,
  pollMessages,
  sendMessage,
  setWebhook,
} from "./store";

async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    return (await request.json()) as Record<string, unknown>;
  } catch {
    throw new BusError("invalid JSON body");
  }
}

export async function handleApi(
  request: Request,
  env: Env,
  pathname: string,
  ctx: ExecutionContext,
): Promise<Response> {
  const consumerOrResp = requireConsumer(request, env);
  if (consumerOrResp instanceof Response) return consumerOrResp;
  const consumer = consumerOrResp;

  try {
    if (pathname === "/api/send" && request.method === "POST") {
      const body = await readJson(request);
      const roster = consumerNames(env.MCP_TOKEN);
      const message = await sendMessage(
        env.DB,
        consumer,
        {
          channel: String(body.channel ?? ""),
          thread_id: body.thread_id ? String(body.thread_id) : undefined,
          to: body.to as string[],
          type: String(body.type ?? ""),
          priority: body.priority ? String(body.priority) : undefined,
          body: String(body.body ?? ""),
          refs: (body.refs as Record<string, unknown> | null | undefined) ?? null,
          requires_ack: body.requires_ack === undefined ? undefined : Boolean(body.requires_ack),
          ack_of: body.ack_of ? String(body.ack_of) : null,
        },
        roster,
      );
      // #26: ring the doorbell off the critical path. A webhook failure never
      // fails or delays this response; it degrades to polling.
      ctx.waitUntil(fireWebhooks(env, message, roster));
      return json({ ok: true, message });
    }

    if (pathname === "/api/poll" && request.method === "GET") {
      const url = new URL(request.url);
      const channel = url.searchParams.get("channel") ?? undefined;
      const since = url.searchParams.get("since") ?? undefined;
      const limit = url.searchParams.get("limit");
      const markSeen = url.searchParams.get("mark_seen") === "1";
      const page = await pollMessages(env.DB, consumer, {
        channel,
        since,
        limit: limit ? Number(limit) : undefined,
      });
      if (markSeen && channel && page.cursor) {
        await markChannelSeen(env.DB, consumer, channel as (typeof CHANNELS)[number], page.cursor);
      }
      return json({ ok: true, consumer, ...page });
    }

    if (pathname.startsWith("/api/thread/") && request.method === "GET") {
      const threadId = decodeURIComponent(pathname.slice("/api/thread/".length));
      const messages = await getThread(env.DB, threadId, consumer, consumerNames(env.MCP_TOKEN));
      return json({ ok: true, thread_id: threadId, count: messages.length, messages });
    }

    if (pathname === "/api/ack" && request.method === "POST") {
      const body = await readJson(request);
      const messageId = String(body.message_id ?? "").trim();
      if (!messageId) throw new BusError("message_id is required");
      const message = await ackMessage(env.DB, consumer, messageId, body.body ? String(body.body) : undefined);
      return json({ ok: true, message });
    }

    if (pathname === "/api/channels" && request.method === "GET") {
      const channels = await listChannels(env.DB, consumer);
      return json({ ok: true, consumer, channels });
    }

    if (pathname === "/api/consumers" && request.method === "GET") {
      const consumers = await listConsumers(env.DB, consumerNames(env.MCP_TOKEN));
      return json({ ok: true, consumers });
    }

    // #26 doorbell webhooks: a consumer manages ONLY its own row (keyed by the
    // authenticated `consumer`). No cross-consumer read or write is possible.
    if (pathname === "/api/webhook" && request.method === "PUT") {
      const body = await readJson(request);
      const webhook = await setWebhook(env.DB, consumer, {
        url: String(body.url ?? ""),
        secret: String(body.secret ?? ""),
        auth_env: body.auth_env != null ? String(body.auth_env) : null,
        enabled: body.enabled === undefined ? undefined : Boolean(body.enabled),
      });
      return json({ ok: true, webhook });
    }

    if (pathname === "/api/webhook" && request.method === "GET") {
      const webhook = await getWebhookView(env.DB, consumer);
      return json({ ok: true, webhook });
    }

    if (pathname === "/api/webhook" && request.method === "DELETE") {
      await deleteWebhook(env.DB, consumer);
      return json({ ok: true, deleted: true });
    }

    if (pathname === "/api/mark_seen" && request.method === "POST") {
      const body = await readJson(request);
      const channel = String(body.channel ?? "").trim();
      if (!isChannel(channel)) throw new BusError(`invalid channel: ${channel}`);
      const at = body.last_seen_at ? String(body.last_seen_at) : undefined;
      if (at) {
        await markChannelSeen(env.DB, consumer, channel, at);
        return json({ ok: true, channel, last_seen_at: at });
      }
      const marked = await markChannelSeenLatest(env.DB, consumer, channel);
      return json({ ok: true, ...marked });
    }

    return json({ error: "not_found" }, 404);
  } catch (err) {
    const message = clientErrorMessage(err);
    if (message) {
      return json({ ok: false, error: message }, 400);
    }
    console.error(
      JSON.stringify({
        event: "api_error",
        detail: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      }),
    );
    return json({ ok: false, error: "bad request" }, 400);
  }
}

export function logAuth(request: Request, env: Env): void {
  const consumer = matchConsumer(env.MCP_TOKEN, bearerToken(request));
  if (consumer) {
    console.log(JSON.stringify({ event: "auth", consumer }));
  }
}
