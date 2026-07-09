export const CHANNELS = ["vivijure", "postern", "common-thread", "fleet", "general"] as const;
export type Channel = (typeof CHANNELS)[number];

export const MESSAGE_TYPES = ["question", "ruling", "handoff", "status", "ack", "ping"] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number];

export const PRIORITIES = ["normal", "blocking"] as const;
export type Priority = (typeof PRIORITIES)[number];

export interface MessageRefs {
  repo?: string;
  issue?: string;
  branch?: string;
  pr?: string | null;
}

export interface BusMessage {
  id: string;
  channel: Channel;
  thread_id: string;
  from: string;
  to: string[];
  type: MessageType;
  priority: Priority;
  body: string;
  refs: MessageRefs | null;
  requires_ack: boolean;
  ack_of: string | null;
  created_at: string;
}

export interface ChannelSummary {
  channel: Channel;
  unread: number;
}

export function isChannel(value: string): value is Channel {
  return (CHANNELS as readonly string[]).includes(value);
}

export function isMessageType(value: string): value is MessageType {
  return (MESSAGE_TYPES as readonly string[]).includes(value);
}

export function isPriority(value: string): value is Priority {
  return (PRIORITIES as readonly string[]).includes(value);
}

/** Visible when broadcast (*) or explicitly addressed. */
export function isVisibleTo(to: string[], consumer: string): boolean {
  return to.includes("*") || to.includes(consumer);
}

// Input caps: both crews are LLM agents, so an oversized message lands in a
// model context on poll. Bound the write side rather than truncating reads.
export const MAX_BODY_BYTES = 16384;
export const MAX_TO_ENTRIES = 16;
export const MAX_TO_ENTRY_CHARS = 64;
export const MAX_THREAD_ID_CHARS = 128;
export const MAX_REF_CHARS = 512;

export function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function retentionDays(env: { RETENTION_DAYS?: string }): number {
  const n = Number(env.RETENTION_DAYS ?? "30");
  return Number.isFinite(n) && n > 0 ? n : 30;
}

export function retentionCutoff(env: { RETENTION_DAYS?: string }): string {
  const days = retentionDays(env);
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString();
}
