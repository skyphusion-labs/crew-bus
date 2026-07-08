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
      "Set requires_ack for coordination gates.",
    inputSchema: sendSchema,
    handler: (client, a) => client.send(a),
  },
  {
    name: "bus_poll",
    description:
      "Fetch messages since an ISO timestamp (exclusive: use prior cursor as since). " +
      "Blocking messages sort first. Poll at turn open; use mark_seen on channel poll to clear unread.",
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
    description: "Fetch every message in a thread, ordered oldest-first.",
    inputSchema: threadSchema,
    handler: (client, a) => client.thread(String(a.thread_id)),
  },
  {
    name: "bus_ack",
    description: "Acknowledge a message.",
    inputSchema: ackSchema,
    handler: (client, a) => client.ack(String(a.message_id), a.body as string | undefined),
  },
  {
    name: "bus_channels",
    description: "List channels with unread counts.",
    inputSchema: {},
    handler: (client) => client.channels(),
  },
  {
    name: "bus_mark_seen",
    description:
      "Mark a channel read (clears unread). Omit last_seen_at to mark through latest visible message.",
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
