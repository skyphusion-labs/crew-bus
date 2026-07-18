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
  /** #21: outstanding requires_ack messages addressed to the consumer, not yet acked. */
  pending_ack: number;
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
// #26: caps for webhook registration input.
export const MAX_WEBHOOK_URL_CHARS = 2048;
export const MAX_WEBHOOK_SECRET_CHARS = 512;
export const MAX_AUTH_ENV_CHARS = 128;

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

/** Per-recipient delivery signal for a message the caller sent (bus_thread). */
export interface RecipientDelivery {
  recipient: string;
  /** Exact ack time from the acks table, or null if not yet acked. */
  acked_at: string | null;
  /** True when the recipient ran a poll at or after this message was created. */
  polled_after: boolean;
  // #26 doorbell webhooks: latency-optimization visibility, never a correctness
  // signal (a null webhook_delivered_at with polled_after/acked_at set is a
  // healthy poll-only path).
  /** Time a webhook doorbell for this recipient landed a 2xx, or null. */
  webhook_delivered_at: string | null;
  /** Webhook delivery attempts made for this recipient (0 if none fired). */
  webhook_attempts: number;
}

/** Server-arbitrated claim on a handoff (#41). First claim wins; rows are immutable. */
export interface Claim {
  message_id: string;
  claimed_by: string;
  created_at: string;
}

/** A thread message; `delivery` is present only for messages the caller sent. */
export interface ThreadMessage extends BusMessage {
  delivery?: RecipientDelivery[];
  /** #41: present on type=handoff rows -- the winning claim, or null if unclaimed. */
  claim?: Claim | null;
}

/** Registered consumer + last poll time (null if never polled). bus_consumers. */
export interface ConsumerStatus {
  name: string;
  last_poll_at: string | null;
  // #26: true when the consumer has a registered AND enabled webhook endpoint.
  // No url/secret is ever exposed here.
  webhook: boolean;
}

/** A registered webhook endpoint row (secret is internal; never returned raw). */
export interface WebhookEndpoint {
  consumer: string;
  url: string;
  secret: string;
  auth_env: string | null;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

/** Caller-safe view of a webhook endpoint: the secret value is never exposed. */
export interface WebhookEndpointView {
  consumer: string;
  url: string;
  auth_env: string | null;
  enabled: boolean;
  secret_set: true;
  created_at: string;
  updated_at: string;
}

/** True only for an https:// URL. Doorbell endpoints must be TLS. */
export function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}
