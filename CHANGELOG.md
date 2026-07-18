# Changelog

## 0.6.0

### #40 -- dual-path doorbell delivery (Workers VPC targets), Worker side

Phase 1 of retiring the per-seat public `hooks-*` cloudflared tunnels for fleet seats (feasibility
memo: QUALIFIED GO, one VPC service per BOX fronting a doorbell mux).

- `webhook_endpoints` gains an additive target type: `target_kind` (`url` | `vpc`) + `vpc_binding`.
  A `url` row is the v0.4.0 public-https shape, unchanged; a `vpc` row rings through a declared
  Workers VPC binding to a per-box doorbell mux, so a fleet seat needs no public tunnel.
- `bus_webhook_set` / `PUT /api/webhook` accept EXACTLY ONE target: `url` (https) or
  `vpc: { binding, consumer? }`. The binding must be on the Worker allowlist (`VPC_DOORBELL_BINDINGS`),
  so a typo cannot register an unroutable doorbell; `vpc.consumer`, if given, must be your own.
- Delivery maps the binding NAME to a `[[vpc_services]]` binding and rings via
  `env.<BINDING>.fetch("https://doorbell.local/ring/<consumer>", ...)`. The v0.4.0 contract is
  preserved EXACTLY on both paths: body-less ring, `X-Bus-Signature` HMAC over `<ts>.<body>`,
  `waitUntil` off the send critical path, 3-attempt retry, lost ring == poll. A registered-but-
  unprovisioned binding logs `webhook_vpc_binding_missing` and degrades to poll.
- Schema is additive: existing DBs apply `worker/migrations/0001_webhook_vpc_target.sql`
  (ADD COLUMN, O(1)); every existing public-https doorbell keeps working untouched.
- Not yet wired end-to-end: the dischord doorbell mux + VPC service (fleet-chezmoi, CR fc#808) and
  the production row cutover follow once the mux is live and a failover drill passes.

## 0.5.0

### #41 -- claim/lease primitive for broadcast handoffs

Incident driver (2026-07-17): a `to: ["*"]` handoff with `requires_ack` drew three independent
claims (one duplicate PR authored + closed). An ack WAS the claim, but nothing made claims
mutually exclusive or visible at claim time; webhook lag widened the race.

- New `bus_claim` tool (Worker `/mcp` + stdio client) and `POST /api/claim`: server-arbitrated
  claim on a `type=handoff` message. The `claims` table's PRIMARY KEY on `message_id` is the
  arbitration -- the first `INSERT` lands, later claims hit `ON CONFLICT DO NOTHING` and read
  back the winner, so racing claimers converge regardless of doorbell latency.
- Outcome shape: `claimed: true` (you own the work order; continue same turn) or
  `claimed: false` plus the winner's identity and claim time (stand down). Both outcomes record
  the caller's ack (delivery receipt) -- a winner's as the claim, a loser's as a stand-down
  receipt naming the winner -- so a lost claim also clears the `pending_ack` obligation.
  Idempotent: re-claiming returns the same outcome (rides the #22 idempotent ack).
- Claim visibility: `bus_thread` and `pending_acks` annotate `type=handoff` rows with a `claim`
  field (`{message_id, claimed_by, created_at}` or null), so late arrivals see who owns the
  work before executing.
- Guard rails: only `type=handoff` is claimable; not your own message; visibility enforced.
  Claims are immutable -- never released or transferred; the sender posts a new handoff to
  reassign.
- Schema is ADDITIVE ONLY (new `claims` table, no ALTER). Tool descriptions on `bus_send` /
  `bus_poll` / `bus_ack` now steer broadcast handoffs through `bus_claim`; this replaces the
  interim "poll the thread once after ack-claiming" convention.

## 0.4.3

### #37 -- bus_poll pagination blindness

- Root cause: `pollMessages` never consulted the `cursors` table. A no-`since` poll always
  scanned from epoch, so a consumer with a >limit backlog re-read the oldest page forever and
  went blind to new traffic (live: fc#660 rancid drill, 2026-07-17); `bus_mark_seen` wrote a
  cursor that poll never read.
- Fix: the `cursors` table IS the consumer poll cursor. A poll without `since` resumes from the
  stored watermark (channel poll: that channel's; bare poll: the MIN across channels, with
  per-channel suppression of already-seen rows) and every poll advances it FORWARD-ONLY, so
  successive bare polls page through the backlog. `bus_mark_seen` therefore advances the poll
  cursor too. An explicit `since` stays a caller-driven history re-read and never rewinds the
  stored cursor.
- No schema or tool/API shape change: same tables (no ALTER), same request/response shapes.
  Tool descriptions updated to document the server-side cursor. `pending_acks` still bypass the
  cursor (#21), so an ack-gated message cannot be lost behind an advanced watermark.

## 0.4.2

Behavioral clarity for recipients of `handoff`/`ruling` (no runtime API change):

- MCP tool descriptions (`bus_send`, `bus_poll`, `bus_ack`) on stdio client and Worker remote
  `/mcp`: `requires_ack` on handoff/ruling is a delivery receipt; recipients ack then continue
  work the same turn. End-and-wait only after your own `type=question`.
- docs: rewrite agent-discipline authority section (authenticated lead tasking is authority;
  only relayed operator claims need verify for spend/downtime/irreversible).

## 0.4.1

Maintenance release. No Worker runtime or API change; cut so the deployed Worker is
re-shipped from current `main` (the only deploy path is a `v*` tag) and to validate the
toolchain bump deploys cleanly.

- chore(deps): bump `wrangler` devDep 4.108.0 -> 4.111.0 (#31).
- ci: dispatch corpus-sync to search-mcp on merge to `main`.

## 0.4.0

### #26 -- doorbell webhooks

- Optional per-consumer webhook endpoints: on every successful send, each resolved recipient (roster-expanded `*`, minus the sender) with an enabled registered endpoint is rung with a body-less doorbell (`{message_id, channel, thread_id, sent_at}`). The receiver's only correct reaction is to poll the bus; the bus stays the single source of truth.
- Signed + attributed: headers `X-Bus-Timestamp` (unix seconds), `X-Bus-Consumer`, and `X-Bus-Signature: sha256=<hmac_sha256(secret, timestamp + "." + rawBody)>`. An optional `Authorization` header is sent from the wrangler secret NAMED in the row's `auth_env` (D1 stores only the name; a missing binding logs and skips the header but still fires).
- DEGRADATION GUARANTEE: firing happens in `ctx.waitUntil`, off the send's critical path. A lost, failing, or throwing webhook NEVER fails or delays the send response; it degrades to exactly the v0.3.0 polling + `pending_acks` behavior. Retry is 3 attempts total (~1s/5s backoff), all inside the one `waitUntil`.
- NO message body ever leaves the bus via webhook, which is what keeps receiver endpoints low-trust: a leaked webhook secret only lets an attacker ring a doorbell (cause a poll), never read message content.
- API (bearer-authed, a consumer manages ONLY its own row): `PUT /api/webhook` (register/replace, https-only, returns the row with the secret masked), `GET /api/webhook` (`secret_set: true`, never the value), `DELETE /api/webhook`. MCP tools `bus_webhook_set` / `bus_webhook_get` / `bus_webhook_clear` map 1:1 (both the stdio `@skyphusion/crew-bus` client and the Worker's remote `/mcp` surface).
- Delivery visibility: `bus_thread` per-recipient delivery reports gain `webhook_delivered_at` (nullable) and `webhook_attempts` alongside `acked_at` / `polled_after`; `bus_consumers` gains a `webhook: true|false` flag per consumer (registered AND enabled; no url/secret exposed).
- Schema is ADDITIVE ONLY: new `webhook_endpoints` and `webhook_deliveries` tables, no ALTER of existing tables.

## 0.3.0

### #21 -- pending_acks redelivery

- Poll responses carry a `pending_acks` list: an unacked `requires_ack` message re-surfaces on every poll (even past the cursor, the dropped-ack case) until it is acked, so a dropped ack can no longer silently stall a lane.
- `requires_ack` now defaults **true** for `type=ruling` and `type=handoff` (an explicit `requires_ack: false` is still honored); `type=status` stays false.
- `bus_channels` / `/api/channels` reports a per-channel `pending_ack` count, cleared on ack; the sender carries no obligation on their own message.
- BEHAVIOR CHANGE: a broadcast ruling/handoff (`to: ["*"]`) now creates a standing ack obligation for EVERY consumer on the roster (minus the sender). Senders of broadcast rulings/handoffs should expect an ack from each recipient, and each recipient will keep seeing the message in `pending_acks` until they ack.

### #22 -- idempotent acks

- Acking the same message more than once is now a true no-op: repeat acks keep a single ack row, preserve the first `acked_at`, and return the original ack unchanged, so the delivery report shows exactly one ack.
- Client-side dedupe in the stdio MCP client, killing the 3x/8x duplicate-ack storm a re-poll/retry used to generate.

## 0.2.0

- `bus_send` validates recipients against the registered roster; a send to an unknown/retired consumer fails loudly at send time instead of vanishing (#17.1).
- `bus_consumers` tool + `/api/consumers`: registered roster with per-consumer `last_poll_at` (new `consumers` table, upserted on each authenticated poll) (#17.2).
- `bus_thread` attaches a per-recipient `delivery` report (`acked_at`, `polled_after`) to messages the caller sent; broadcasts report against the full roster (#17.3).
- refs.issue / refs.pr normalized to bare numbers (leading `#` stripped) at write time (#17.4).
- Acceptance bar: #19 (do not close) -- closes on the live two-crew handoff drill.

## 0.1.2

- Prepare public release: `@skyphusion/crew-bus` npm package, publish workflow, public docs
- Add `docs/agent-discipline.md` and `docs/PUBLIC-RELEASE.md`

## 0.1.1

- Remove erroneous `corpus-notify` workflow (search-mcp copy-paste)
- Exclusive poll cursor (`since` is lower bound, not inclusive)
- `bus_mark_seen` tool + `/api/mark_seen` route
- Store integration tests + `scripts/smoke.sh`
- Agent discipline docs (fc runbook)

## 0.1.0

- MVP scaffold: Worker + D1, REST + MCP, stdio client, tests, CI.
