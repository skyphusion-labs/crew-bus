import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CrewBusClient, CrewBusError } from "./client.js";

const CHANNELS = ["vivijure", "postern", "common-thread", "fleet", "general"] as const;
const MESSAGE_TYPES = ["question", "ruling", "handoff", "status", "ack", "ping"] as const;
const PRIORITIES = ["normal", "blocking"] as const;

type TextResult = { content: { type: "text"; text: string }[]; isError?: boolean };

function ok(value: unknown): TextResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function fail(err: unknown): TextResult {
  const msg = err instanceof CrewBusError ? err.message : err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
}

const REFS = z
  .object({
    repo: z.string().optional(),
    issue: z.string().optional(),
    branch: z.string().optional(),
    pr: z.string().nullable().optional(),
  })
  .optional();

const sendSchema = {
  channel: z.enum(CHANNELS),
  thread_id: z.string().optional(),
  to: z.array(z.string().min(1)).min(1),
  type: z.enum(MESSAGE_TYPES),
  priority: z.enum(PRIORITIES).optional(),
  body: z.string().min(1),
  refs: REFS,
  requires_ack: z.boolean().optional(),
  ack_of: z.string().optional(),
};

const pollSchema = {
  channel: z.enum(CHANNELS).optional(),
  since: z.string().optional(),
  limit: z.number().int().positive().max(200).optional(),
  mark_seen: z.boolean().optional(),
};

const threadSchema = {
  thread_id: z.string().min(1),
};

const ackSchema = {
  message_id: z.string().min(1),
  body: z.string().optional(),
};

const markSeenSchema = {
  channel: z.enum(CHANNELS),
  last_seen_at: z.string().optional(),
};

const webhookSetSchema = {
  // #40 dual-path: provide EXACTLY ONE of url (public https) or vpc (private binding).
  url: z.string().min(1).optional(),
  vpc: z
    .object({ binding: z.string().min(1), consumer: z.string().optional() })
    .optional(),
  secret: z.string().min(1),
  auth_env: z.string().optional(),
  enabled: z.boolean().optional(),
};

interface ToolDef {
  name: string;
  description: string;
  inputSchema: z.ZodRawShape;
  handler: (client: CrewBusClient, args: Record<string, unknown>) => Promise<unknown>;
}

export const TOOLS: ToolDef[] = [
  {
    name: "bus_send",
    description:
      "Post a structured message to a crew-bus channel. Use to: [\"*\"] to broadcast. " +
      "Recipients are validated against the registered roster (bus_consumers); a send to an " +
      "unknown/retired name fails loudly. type=ruling and type=handoff default requires_ack=true " +
      "(pass false to opt out): that flag is a DELIVERY RECEIPT for the sender, not a cue for the " +
      "recipient to idle until a human confirms. Recipients of handoff/ruling should ack then begin " +
      "work the same turn. type=question + requires_ack is the blocking gate (sender ends turn and " +
      "waits). A BROADCAST handoff (to: [\"*\"]) is a race: recipients must bus_claim it before " +
      "executing (first claim wins server-side). refs.issue and refs.pr are canonical BARE numbers " +
      "(\"42\", not \"#42\"; a leading # is stripped on write).",
    inputSchema: sendSchema,
    handler: (client, a) => client.send(a),
  },
  {
    name: "bus_poll",
    description:
      "Fetch messages. Omit since to resume from your stored server-side cursor (advanced by " +
      "each poll and by bus_mark_seen, so bare polls page forward through a backlog); pass since " +
      "(ISO, exclusive) to re-read history without moving it. " +
      "Ordered oldest-first; check the priority field for blocking messages. Own sends are not " +
      "echoed back. Poll at turn open; use mark_seen on channel poll to clear unread. The response also " +
      "carries pending_acks: requires_ack messages addressed to you that you have not acked, ALWAYS " +
      "included regardless of the cursor (each marked pending_ack:true) until you bus_ack them. " +
      "pending_acks on type=handoff/ruling are WORK ORDERS: ack then continue executing in the same " +
      "turn; they are not a stop signal to wait for a human. A pending BROADCAST handoff must be " +
      "bus_claim'd before executing; its claim field (when present) shows who already won it.",
    inputSchema: pollSchema,
    handler: (client, a) =>
      client.poll({
        channel: a.channel as string | undefined,
        since: a.since as string | undefined,
        limit: a.limit as number | undefined,
        mark_seen: a.mark_seen as boolean | undefined,
      }),
  },
  {
    name: "bus_thread",
    description:
      "Fetch every message in a thread, ordered oldest-first. Messages YOU sent carry a per-recipient " +
      "delivery report (acked_at, polled_after, plus webhook_delivered_at + webhook_attempts) so you can " +
      "confirm a handoff landed without a human relay.",
    inputSchema: threadSchema,
    handler: (client, a) => client.thread(String(a.thread_id)),
  },
  {
    name: "bus_ack",
    description:
      "Acknowledge a message (records ack + posts ack-type reply to sender). For type=handoff or " +
      "type=ruling, ack then CONTINUE WORK in the same turn (ack is a delivery receipt, not the " +
      "job). For a BROADCAST handoff (to includes \"*\"), use bus_claim instead: a plain ack does " +
      "NOT reserve the work. End-turn-and-wait only after YOU sent a type=question with requires_ack.",
    inputSchema: ackSchema,
    handler: (client, a) => client.ack(String(a.message_id), a.body as string | undefined),
  },
  {
    name: "bus_claim",
    description:
      "Claim a type=handoff message BEFORE starting the work (mandatory for broadcast handoffs). " +
      "Server-arbitrated: the FIRST claim wins atomically; a late claim returns claimed:false with " +
      "the winner's identity. claimed:true = you own the work order, continue executing the same " +
      "turn. claimed:false = STAND DOWN, do not start the work. Either outcome records your ack " +
      "(delivery receipt), so a lost claim also clears your pending_ack obligation. Idempotent; " +
      "claims are never released or transferred (the sender posts a new handoff to reassign).",
    inputSchema: ackSchema,
    handler: (client, a) => client.claim(String(a.message_id), a.body as string | undefined),
  },
  {
    name: "bus_channels",
    description:
      "List channels with unread counts and pending_ack counts (outstanding requires_ack messages " +
      "addressed to you and not yet acked).",
    inputSchema: {},
    handler: (client) => client.channels(),
  },
  {
    name: "bus_consumers",
    description:
      "List the registered consumer roster (valid recipients) with each consumer's last_poll_at " +
      "(null if never polled) and webhook (true when a doorbell endpoint is registered and enabled). " +
      "Use to discover who is addressable.",
    inputSchema: {},
    handler: (client) => client.consumers(),
  },
  {
    name: "bus_webhook_set",
    description:
      "Register or replace YOUR OWN doorbell webhook. On a successful send addressed to you, the bus " +
      "rings a body-less doorbell ({message_id, channel, thread_id, sent_at}) signed with your secret " +
      "(X-Bus-Signature: sha256=hmac); react by polling. Provide EXACTLY ONE target: url (public https) " +
      "OR vpc ({ binding } naming a Workers VPC doorbell mux for a fleet seat, no public tunnel needed). " +
      "secret is the HMAC key. auth_env optionally names a Worker secret sent as the Authorization header " +
      "(name only is stored). A lost doorbell degrades to polling; never a correctness dependency.",
    inputSchema: webhookSetSchema,
    handler: (client, a) => client.webhookSet(a),
  },
  {
    name: "bus_webhook_get",
    description:
      "Fetch YOUR OWN doorbell webhook config. The secret VALUE is never returned (secret_set: true " +
      "indicates one is set). Returns null when no endpoint is registered.",
    inputSchema: {},
    handler: (client) => client.webhookGet(),
  },
  {
    name: "bus_webhook_clear",
    description: "Unregister YOUR OWN doorbell webhook endpoint (deletes the row).",
    inputSchema: {},
    handler: (client) => client.webhookClear(),
  },
  {
    name: "bus_mark_seen",
    description:
      "Mark a channel read (clears unread, advances your poll cursor). Omit last_seen_at to mark " +
      "through latest visible message.",
    inputSchema: markSeenSchema,
    handler: (client, a) =>
      client.markSeen(String(a.channel), a.last_seen_at as string | undefined),
  },
];

export function registerTools(server: McpServer, client: CrewBusClient): string[] {
  const registered: string[] = [];
  for (const t of TOOLS) {
    server.registerTool(
      t.name,
      { description: t.description, inputSchema: t.inputSchema },
      async (args: unknown) => {
        try {
          return ok(await t.handler(client, (args ?? {}) as Record<string, unknown>)) as TextResult;
        } catch (err) {
          return fail(err) as TextResult;
        }
      },
    );
    registered.push(t.name);
  }
  return registered;
}

export { TOOLS as BUS_TOOLS };
