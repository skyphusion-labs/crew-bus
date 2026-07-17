import type { Env } from "./env";
import { BusError, clientErrorMessage } from "./bus-error";
import { json, matchConsumer, bearerToken, consumerNames } from "./auth";
import { CHANNELS, MESSAGE_TYPES, PRIORITIES, isChannel } from "./bus-types";
import { VERSION } from "./version";
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

const SERVER_INFO = { name: "crew-bus", version: VERSION };
const PROTOCOL_VERSION = "2025-06-18";

const TOOLS = [
  {
    name: "bus_send",
    description:
      "Post a structured message to a crew-bus channel. Use to: [\"*\"] to broadcast. " +
      "Recipients are validated against the registered roster (bus_consumers): a send to an " +
      "unknown/retired name fails loudly rather than vanishing. type=ruling and type=handoff " +
      "default requires_ack=true (pass false to opt out): that flag is a DELIVERY RECEIPT for the " +
      "sender, not a cue for the recipient to idle until a human confirms. Recipients of " +
      "handoff/ruling should ack then begin work the same turn. type=question + requires_ack is " +
      "the blocking gate (sender ends turn and waits). Include refs (repo, issue, branch, pr) when " +
      "relevant; refs.issue and refs.pr are canonical BARE numbers (\"42\", not \"#42\"; a leading " +
      "# is stripped on write).",
    inputSchema: {
      type: "object",
      properties: {
        channel: { type: "string", enum: [...CHANNELS] },
        thread_id: { type: "string", description: "Existing thread id; omit to start a new thread" },
        to: {
          type: "array",
          items: { type: "string" },
          description: 'Recipients (registered consumer names) or ["*"] for broadcast',
        },
        type: { type: "string", enum: [...MESSAGE_TYPES] },
        priority: { type: "string", enum: [...PRIORITIES] },
        body: { type: "string" },
        refs: {
          type: "object",
          properties: {
            repo: { type: "string" },
            issue: { type: "string", description: "Bare issue number, e.g. \"42\" (a leading # is stripped)" },
            branch: { type: "string" },
            pr: { type: "string", nullable: true, description: "Bare PR number, e.g. \"17\" (a leading # is stripped)" },
          },
        },
        requires_ack: { type: "boolean" },
        ack_of: { type: "string", description: "Required when type is ack" },
      },
      required: ["channel", "to", "type", "body"],
    },
  },
  {
    name: "bus_poll",
    description:
      "Fetch messages visible to the authenticated consumer. Omit since to resume from your " +
      "stored server-side cursor: each poll advances it (forward-only), so bare polls page forward " +
      "through a backlog; bus_mark_seen also advances it. Pass an explicit since (ISO, exclusive; " +
      "e.g. a prior cursor) to re-read history without moving the stored cursor. Ordered " +
      "oldest-first; check the priority field for blocking " +
      "messages. Own sends are not echoed back. Poll at turn open and after asking blocking questions. " +
      "The response also carries pending_acks: messages addressed to you with requires_ack that you " +
      "have not acked, ALWAYS included regardless of the cursor (each marked pending_ack:true) until " +
      "you bus_ack them, so a dropped ack-gated message re-surfaces instead of vanishing. " +
      "pending_acks on type=handoff/ruling are WORK ORDERS: ack then continue executing in the same " +
      "turn; they are not a stop signal to wait for a human.",
    inputSchema: {
      type: "object",
      properties: {
        channel: { type: "string", enum: [...CHANNELS] },
        since: {
          type: "string",
          description: "ISO-8601 timestamp (exclusive lower bound); use cursor from prior poll",
        },
        limit: { type: "number", description: "Max messages (1-200, default 50)" },
        mark_seen: {
          type: "boolean",
          description: "When channel is set, mark channel read up to cursor after poll",
        },
      },
    },
  },
  {
    name: "bus_mark_seen",
    description:
      "Mark a channel read for the authenticated consumer (clears unread count and advances your " +
      "poll cursor past the marked point). Defaults to latest visible message in the channel.",
    inputSchema: {
      type: "object",
      properties: {
        channel: { type: "string", enum: [...CHANNELS] },
        last_seen_at: {
          type: "string",
          description: "Optional ISO timestamp; omit to mark through latest visible message",
        },
      },
      required: ["channel"],
    },
  },
  {
    name: "bus_thread",
    description:
      "Fetch every message in a thread, ordered oldest-first. For messages YOU sent, each carries a " +
      "per-recipient delivery report: acked_at (exact ack time or null), polled_after (true if the " +
      "recipient polled at/after the message was sent), plus webhook_delivered_at and webhook_attempts " +
      "(doorbell delivery accounting; a null webhook_delivered_at with polled_after set is a healthy " +
      "poll-only path). Broadcasts report against the full roster. Use this to confirm a handoff landed " +
      "without asking a human.",
    inputSchema: {
      type: "object",
      properties: {
        thread_id: { type: "string" },
      },
      required: ["thread_id"],
    },
  },
  {
    name: "bus_ack",
    description:
      "Acknowledge a message (records ack + posts ack-type reply to sender). For type=handoff or " +
      "type=ruling, ack then CONTINUE WORK in the same turn (ack is a delivery receipt, not the " +
      "job). End-turn-and-wait only after YOU sent a type=question with requires_ack.",
    inputSchema: {
      type: "object",
      properties: {
        message_id: { type: "string" },
        body: { type: "string", description: "Optional ack body (default: ack <id>)" },
      },
      required: ["message_id"],
    },
  },
  {
    name: "bus_channels",
    description:
      "List channels for the authenticated consumer with unread counts and pending_ack counts " +
      "(outstanding requires_ack messages addressed to you and not yet acked).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "bus_consumers",
    description:
      "List the registered consumer roster (valid bus_send recipients) with each consumer's " +
      "last_poll_at (null if never polled) and webhook (true when a doorbell endpoint is registered " +
      "and enabled; no url/secret exposed). Use to discover who is addressable and roughly when they " +
      "last checked the bus.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "bus_webhook_set",
    description:
      "Register or replace YOUR OWN doorbell webhook endpoint. On a successful send addressed to you, " +
      "the bus POSTs a body-less doorbell ({message_id, channel, thread_id, sent_at}) signed with your " +
      "secret (X-Bus-Signature: sha256=hmac); react by polling the bus. url must be https. secret is " +
      "the HMAC key (store it as a fixture, never a real credential). auth_env optionally names a " +
      "Worker secret whose value is sent as the Authorization header (the name only is stored). A lost " +
      "doorbell degrades to polling; it is never a correctness dependency.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "https endpoint to POST doorbells to" },
        secret: { type: "string", description: "HMAC signing key (protects your receiver from spoofed doorbells)" },
        auth_env: {
          type: "string",
          description: "Optional NAME of a Worker secret sent as the Authorization header",
        },
        enabled: { type: "boolean", description: "Default true; set false to keep the row but stop firing" },
      },
      required: ["url", "secret"],
    },
  },
  {
    name: "bus_webhook_get",
    description:
      "Fetch YOUR OWN registered doorbell webhook config. The secret VALUE is never returned " +
      "(secret_set: true indicates one is set). Returns null when no endpoint is registered.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "bus_webhook_clear",
    description: "Unregister YOUR OWN doorbell webhook endpoint (deletes the row).",
    inputSchema: { type: "object", properties: {} },
  },
] as const;

interface RpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

function rpcResult(id: unknown, result: unknown) {
  return { jsonrpc: "2.0", id, result };
}
function rpcError(id: unknown, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function toolText(value: unknown): { content: { type: "text"; text: string }[]; isError?: boolean } {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function toolFail(err: unknown) {
  const message = clientErrorMessage(err);
  if (message === null) {
    console.error(
      JSON.stringify({
        event: "mcp_tool_error",
        detail: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      }),
    );
  }
  return { content: [{ type: "text", text: `Error: ${message ?? "bad request"}` }], isError: true };
}

async function callTool(
  env: Env,
  ctx: ExecutionContext,
  consumer: string,
  name: string,
  args: Record<string, unknown>,
): Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }> {
  switch (name) {
    case "bus_send": {
      const roster = consumerNames(env.MCP_TOKEN);
      const message = await sendMessage(
        env.DB,
        consumer,
        {
          channel: String(args.channel ?? ""),
          thread_id: args.thread_id ? String(args.thread_id) : undefined,
          to: args.to as string[],
          type: String(args.type ?? ""),
          priority: args.priority ? String(args.priority) : undefined,
          body: String(args.body ?? ""),
          refs: (args.refs as Record<string, unknown> | null | undefined) ?? null,
          requires_ack: args.requires_ack === undefined ? undefined : Boolean(args.requires_ack),
          ack_of: args.ack_of ? String(args.ack_of) : null,
        },
        roster,
      );
      // #26: ring the doorbell off the critical path (never fails/delays send).
      ctx.waitUntil(fireWebhooks(env, message, roster));
      return toolText({ ok: true, message });
    }
    case "bus_poll": {
      const channel = args.channel ? String(args.channel) : undefined;
      const page = await pollMessages(env.DB, consumer, {
        channel,
        since: args.since ? String(args.since) : undefined,
        limit: args.limit !== undefined ? Number(args.limit) : undefined,
      });
      if (args.mark_seen && channel && page.cursor && isChannel(channel)) {
        await markChannelSeen(env.DB, consumer, channel, page.cursor);
      }
      return toolText({ ok: true, consumer, ...page });
    }
    case "bus_thread": {
      const threadId = String(args.thread_id ?? "").trim();
      if (!threadId) throw new BusError("thread_id is required");
      const messages = await getThread(env.DB, threadId, consumer, consumerNames(env.MCP_TOKEN));
      return toolText({ ok: true, thread_id: threadId, count: messages.length, messages });
    }
    case "bus_ack": {
      const messageId = String(args.message_id ?? "").trim();
      if (!messageId) throw new BusError("message_id is required");
      const message = await ackMessage(
        env.DB,
        consumer,
        messageId,
        args.body ? String(args.body) : undefined,
      );
      return toolText({ ok: true, message });
    }
    case "bus_channels": {
      const channels = await listChannels(env.DB, consumer);
      return toolText({ ok: true, consumer, channels });
    }
    case "bus_consumers": {
      const consumers = await listConsumers(env.DB, consumerNames(env.MCP_TOKEN));
      return toolText({ ok: true, consumers });
    }
    case "bus_webhook_set": {
      const webhook = await setWebhook(env.DB, consumer, {
        url: String(args.url ?? ""),
        secret: String(args.secret ?? ""),
        auth_env: args.auth_env != null ? String(args.auth_env) : null,
        enabled: args.enabled === undefined ? undefined : Boolean(args.enabled),
      });
      return toolText({ ok: true, webhook });
    }
    case "bus_webhook_get": {
      const webhook = await getWebhookView(env.DB, consumer);
      return toolText({ ok: true, webhook });
    }
    case "bus_webhook_clear": {
      await deleteWebhook(env.DB, consumer);
      return toolText({ ok: true, deleted: true });
    }
    case "bus_mark_seen": {
      const channel = String(args.channel ?? "").trim();
      if (!isChannel(channel)) throw new BusError(`invalid channel: ${channel}`);
      if (args.last_seen_at) {
        const at = String(args.last_seen_at);
        await markChannelSeen(env.DB, consumer, channel, at);
        return toolText({ ok: true, channel, last_seen_at: at });
      }
      const marked = await markChannelSeenLatest(env.DB, consumer, channel);
      return toolText({ ok: true, ...marked });
    }
    default:
      throw new BusError(`Unknown tool: ${name}`);
  }
}

async function handleRpc(
  msg: RpcMessage,
  env: Env,
  ctx: ExecutionContext,
  consumer: string,
): Promise<unknown> {
  const { id, method, params } = msg;
  switch (method) {
    case "initialize":
      return rpcResult(id, {
        protocolVersion: (params?.protocolVersion as string | undefined) || PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, { tools: TOOLS });
    case "tools/call": {
      const name = params?.name as string | undefined;
      const args = (params?.arguments as Record<string, unknown>) || {};
      if (!name || !TOOLS.some((t) => t.name === name)) {
        return rpcError(id, -32602, `Unknown tool: ${String(name)}`);
      }
      try {
        const result = await callTool(env, ctx, consumer, name, args);
        return rpcResult(id, result);
      } catch (err) {
        return rpcResult(id, toolFail(err));
      }
    }
    default:
      return rpcError(id, -32601, `Method not found: ${String(method)}`);
  }
}

export async function handleMcp(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const consumer = matchConsumer(env.MCP_TOKEN, bearerToken(request));
  if (!consumer) {
    return json({ error: "unauthorized" }, 401, { "WWW-Authenticate": "Bearer" });
  }
  console.log(JSON.stringify({ event: "mcp_auth", consumer }));

  if (request.method !== "POST") {
    return new Response(null, { status: 405, headers: { Allow: "POST" } });
  }

  let payload: RpcMessage | RpcMessage[];
  try {
    payload = (await request.json()) as RpcMessage | RpcMessage[];
  } catch {
    return json(rpcError(null, -32700, "Parse error"));
  }

  const hasId = (m: RpcMessage) => m.id !== undefined && m.id !== null;

  if (Array.isArray(payload)) {
    const responses: unknown[] = [];
    for (const m of payload) {
      if (hasId(m)) responses.push(await handleRpc(m, env, ctx, consumer));
    }
    return responses.length ? json(responses) : json(null, 202);
  }

  if (!hasId(payload)) return json(null, 202);
  return json(await handleRpc(payload, env, ctx, consumer));
}

export { TOOLS };
