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
// #40: a Workers VPC binding NAME is a short identifier, never a URL.
export const MAX_VPC_BINDING_CHARS = 128;

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
  // #47 doorbell reader health. `webhook: true` only ever meant "the HTTP hop
  // returned 2xx"; these four fields answer the question every caller actually
  // asks, which is whether rings are reaching a READER.
  //
  // Most recent ring this consumer had a 2xx delivery for (null: never).
  last_ring_delivered_at: string | null;
  // Most recent evidence this consumer READ the bus: its poll watermark, or its
  // newest ack, whichever is later (null: no evidence ever).
  last_message_consumed_at: string | null;
  // Rings delivered STRICTLY AFTER last_message_consumed_at, i.e. rung at a
  // reader that has not read anything since. 0 for a quiet channel.
  undelivered_to_reader: number;
  // Oldest of those unconsumed rings; null when undelivered_to_reader is 0.
  // Surfaced so `doorbell_stale` is self-evidencing (it is the age term).
  oldest_undelivered_ring_at: string | null;
  // Derived: see DOORBELL_STALE_MIN_RINGS / DOORBELL_STALE_MIN_AGE_MS.
  doorbell_stale: boolean;
}

// #47 staleness predicate thresholds. `doorbell_stale` is true only when ALL of:
//   1. the consumer has a registered AND enabled doorbell (webhook === true),
//   2. undelivered_to_reader >= DOORBELL_STALE_MIN_RINGS, and
//   3. oldest_undelivered_ring_at is at least DOORBELL_STALE_MIN_AGE_MS old.
// (1) keeps a poll-only consumer from ever reading stale (it has no doorbell to
// be broken). (2) keeps a single in-flight ring the session has not reached yet
// from firing. (3) keeps a burst of three rings inside one turn from firing.
// A quiet channel delivers no rings, so it can never trip the predicate.
export const DOORBELL_STALE_MIN_RINGS = 3;
export const DOORBELL_STALE_MIN_AGE_MS = 15 * 60 * 1000;

/** Doorbell target kind (#40): a public https url, or a private Workers VPC binding. */
export type WebhookTargetKind = "url" | "vpc";

/** A registered webhook endpoint row (secret is internal; never returned raw). */
export interface WebhookEndpoint {
  consumer: string;
  // #40 dual-path target. "url" rings a public https origin (the v0.4.0 shape);
  // "vpc" rings through a Workers VPC binding to a per-box doorbell mux.
  target_kind: WebhookTargetKind;
  /** Public https target. The real value for a "url" row; empty string for a "vpc" row. */
  url: string;
  /** Workers VPC binding NAME to ring through. Set for a "vpc" row; null for a "url" row. */
  vpc_binding: string | null;
  secret: string;
  auth_env: string | null;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

/** Caller-safe view of a webhook endpoint: the secret value is never exposed. */
export interface WebhookEndpointView {
  consumer: string;
  // #40: additive. "url" endpoints keep a populated `url` (existing readers unaffected);
  // "vpc" endpoints carry `vpc_binding` and a null `url`.
  target_kind: WebhookTargetKind;
  url: string | null;
  vpc_binding: string | null;
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
