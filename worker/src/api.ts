import type { Env } from "./env";
import { bearerToken, json, matchConsumer, requireConsumer } from "./auth";
import { BusError, clientErrorMessage } from "./bus-error";
import { CHANNELS } from "./bus-types";
import {
  ackMessage,
  getThread,
  listChannels,
  markChannelSeen,
  pollMessages,
  sendMessage,
} from "./store";

async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    return (await request.json()) as Record<string, unknown>;
  } catch {
    throw new BusError("invalid JSON body");
  }
}

export async function handleApi(request: Request, env: Env, pathname: string): Promise<Response> {
  const consumerOrResp = requireConsumer(request, env);
  if (consumerOrResp instanceof Response) return consumerOrResp;
  const consumer = consumerOrResp;

  try {
    if (pathname === "/api/send" && request.method === "POST") {
      const body = await readJson(request);
      const message = await sendMessage(env.DB, consumer, {
        channel: String(body.channel ?? ""),
        thread_id: body.thread_id ? String(body.thread_id) : undefined,
        to: body.to as string[],
        type: String(body.type ?? ""),
        priority: body.priority ? String(body.priority) : undefined,
        body: String(body.body ?? ""),
        refs: (body.refs as Record<string, unknown> | null | undefined) ?? null,
        requires_ack: Boolean(body.requires_ack),
        ack_of: body.ack_of ? String(body.ack_of) : null,
      });
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
      const messages = await getThread(env.DB, threadId, consumer);
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
