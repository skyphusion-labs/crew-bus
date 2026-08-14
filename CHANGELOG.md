## v0.7.2

PATCH: Cloudflare toolchain, @types/node, and undici override on main since v0.7.1. Worker-only tag; MCP stays on its own crew-bus-v* train.

## v0.7.1

PATCH: dependency updates on main since v0.7.0. Tag `v0.7.1` deploys the Worker; npm uses separate `crew-bus-v*` tags if needed.

## Unreleased (mcp client)

### Fix -- the stdio client advertised a version it never had (`0.1.0`)

Incident driver: `mcp/src/index.ts` passed a hardcoded `version: "0.1.0"` to `McpServer`, so every
MCP host that asked the client who it was got an answer that was wrong by six minor versions. It was
never even a released number: npm has `0.1.2, 0.2.0, 0.3.0, 0.4.0, 0.6.1`, and no `0.1.0`. Any host
logging client versions to reason about capability was reading fiction.

This is the **same defect, with the same literal**, that `worker/src/version.ts` was created to kill.
That file's own comment says so: *"so /health and MCP serverInfo cannot drift from the released code
the way the hardcoded 0.1.0 did."* The Worker got the fix and the guard; the client kept the bug.

- `mcp/src/version.ts` added, mirroring `worker/src/version.ts`, and `serverInfo` now reads it.
- `mcp/test/version.test.ts` asserts it equals `mcp/package.json`, plus a regression pin that it is
  not `"0.1.0"`. Both were watched failing against the reintroduced literal before being made green.
- A guarded literal rather than `import pkg from "../package.json"`: `mcp/tsconfig.json` sets
  `rootDir: "src"`, so importing above it breaks the build. The copy is acceptable only because the
  test makes a drifted copy impossible to ship.

**Version deliberately NOT bumped, held at `0.6.5`.** Publishing is what claims a number, and
`0.6.5` has never been published, so it is unclaimed and this fix ships inside it.

**Related finding, worth knowing before the next `crew-bus-v*` tag.** npm's latest is **`0.6.1`**
while `mcp/package.json` says `0.6.5`: `0.6.2` through `0.6.5` were bumped and never published,
because past Worker releases moved the client version in lockstep even when no client file changed.
The two are separate release trains by design (`v*` deploys the Worker, `crew-bus-v*` publishes the
client), so that lockstep was the drift. The unpublished delta since `0.6.1` is small and safe: one
`bus_consumers` tool-description update (doorbell reader health, #47) and dependency bumps. A
`crew-bus-v0.6.5` tag therefore publishes that delta plus this fix, not this fix alone.

## 0.7.0

MINOR, not a patch: `MCP_TOKEN_EXTRA` is a new optional secret binding on the hand-authored
`Env`, which is new capability rather than a fix to existing behaviour. Ships two changes that
had both been sitting unreleased against a live `0.6.6`.

**Deploy ordering, read before tagging.** This is the first release carrying the
`RANCID_DOORBELL_VPC` retirement below. That entry records that the live binding is NOT removed
by code: the production `wrangler.toml` is gitignored and materialized in CI from the
`SKYPHUSION_WRANGLER_TOML` secret. If that blob still declares a `[[vpc_services]]` stanza whose
CF VPC service has already been deleted, `wrangler deploy` fails against a dead `service_id`.
Confirm blob and service agree before pushing the tag. Nothing in this release requires a schema
change; the D1 migrations step is a no-op (`0001` only, already applied, and the step is
idempotent).

### Fix -- additive roster secret `MCP_TOKEN_EXTRA` (fleet-chezmoi fc#1070)

Incident driver: two parallel Claude contexts both authenticate to the bus as consumer
`mackaye`, so each context's sends are filtered from the other as "own sends", self-addressed
messages get no delivery row, and the two share one server-side cursor that advances past what
the other never read. Conrad had been hand-relaying between contexts for an entire sprint. The
fix is per-context consumer identities, which means growing the roster.

Growing it by rewriting `MCP_TOKEN` is rejected: Workers secrets are write-only, so that is a
full-roster rewrite in which one missing or mistyped entry silently locks that consumer off the
bus with a flat 401, indistinguishable from a bad client config.

- **New optional secret `MCP_TOKEN_EXTRA`**, same comma-separated `consumer=token` format, added
  to the hand-authored `Env`. `wrangler secret put MCP_TOKEN_EXTRA`.
- **`rosterSecret(env)`** in `auth.ts` joins `MCP_TOKEN` and `MCP_TOKEN_EXTRA` into one roster.
  `parseConsumers` is unchanged: two comma-separated secrets concatenate into one valid secret,
  which is the point of joining rather than parsing twice. All nine consumer-lookup call sites in
  `auth.ts`, `api.ts` and `mcp.ts` now read the joined roster. The implementation ruling
  enumerated six and missed three in `mcp.ts`, including `handleMcp`, where every MCP request
  authenticates: left unconverted it would have 401'd every new per-context identity on the MCP
  transport while REST accepted them, and a flat 401 reads as a bad client config. Found by a
  tree-wide grep carrying a positive control, not by re-reading the edited lines.
- **`MCP_TOKEN` is never touched, so existing consumers cannot break** whatever
  `MCP_TOKEN_EXTRA` contains. That is the whole reason for this shape.
- **Duplicate-name guard.** `matchConsumer` returns the FIRST match, so a name present in both
  secrets would let two different tokens authenticate as one identity: the exact identity
  collapse this change exists to remove, reintroduced one layer down. `rosterSecret` joins
  `MCP_TOKEN` first and `dedupeByName` keeps the first entry per name, so the ambiguous later
  token authenticates as nobody and the collision is logged as `consumer_name_collision` by NAME
  (never a token value). Fail mode is log-and-prefer-`MCP_TOKEN` rather than a global refusal: a
  global fail-closed would 401 the entire bus on one typo in the additive secret, and dropping
  both copies of a colliding name would break a live consumer. This is still fail-closed on the
  ambiguity, scoped to the misconfigured entry.
- `MCP_TOKEN_EXTRA` added to `AUTH_ENV_DENYLIST` alongside `MCP_TOKEN`, so a webhook `auth_env`
  can never name it. The `*_AUTH` regex already rejected it; the denylist entry is free and keeps
  the two roster secrets symmetric.
- Not in this change, by ruling: no token is minted or placed, and the own-send filter, the
  delivery-recipient filter and the cursor advance in `store.ts` are untouched. All three are
  correct for one-consumer-one-context and only misbehave because two contexts share an identity.

### Chore -- retire `RANCID_DOORBELL_VPC` (fleet-chezmoi fc#1162; refs fc#1068, fc#1069)

Incident driver: reverses the 0.6.3 wiring. The Cursor lane on rancid is retired, the `rancid-doorbell-mux` unit
and stack are gone, nothing listens on that box's `:9870`, and rancid is now the crew's
no-sessions warm standby, so it has no seat listener to ring.

- `RANCID_DOORBELL_VPC` removed from `VPC_DOORBELL_BINDINGS` and from the hand-authored `Env`
  interface (`worker-configuration.d.ts` stays ungenerated, per the standing Workers convention),
  from the `bus_webhook_set` tool description, and from `wrangler.toml.example`.
- Kept in `AUTH_ENV_DENYLIST`: a denylist entry for a name that no longer exists is free, and
  dropping it would be a loosening for no benefit.
- The test that asserted the binding was accepted is inverted rather than deleted: a retired
  binding must now be rejected at registration.
- **Live binding is NOT removed by this PR.** The production `wrangler.toml` is gitignored and
  materialized in CI from an encrypted Actions secret, so the deployed `[[vpc_services]]` stanza
  has to be dropped there and the Worker redeployed. Order: binding out of the Worker first, then
  delete the CF VPC service, or the next deploy fails against a dead `service_id`.
- **Open, not fixed here:** the `webhook_endpoints` row for `albini` still targets
  `RANCID_DOORBELL_VPC` and is enabled, so that seat's doorbell currently rings a service with no
  origin and silently degrades to poll. It should be re-pointed at `DISCHORD_DOORBELL_VPC` by a
  holder of albini's own bus token. Tracked on fleet-chezmoi fc#1162.

## 0.6.6

### Fix (#984 K3)

- Poll cursor uses composite `(created_at, id)` so same-millisecond messages are not dropped.

## 0.6.5

### Security (#61)

- Reject `auth_env` values that name core Worker secrets (e.g. `MCP_TOKEN`). Only dedicated
  webhook Authorization bindings matching `*_AUTH` are accepted at registration time.

## 0.6.4

Release sync bump (2026-07-21). No functional changes in this tag.

# Changelog

## 0.6.3

### fc#853 -- RANCID doorbell VPC mux (slice 3 live cutover)

- Production `[[vpc_services]]` adds `RANCID_DOORBELL_VPC` bound to CF service
  `rancid-doorbell-mux` (`019f8582-a6b0-78d3-b481-881789231bcd`) on tunnel `rancid-local`
  -> mux `127.0.0.1:9870` on rancid. Sibling of `DISCHORD_DOORBELL_VPC` (fc#808).
- Code allowlist for `RANCID_DOORBELL_VPC` shipped in v0.6.2 prep (crew-bus#54); this release
  wires the live binding so rancid Cursor seats can flip webhook rows off public hooks.

## 0.6.2

### #48 -- doorbell reader health (`doorbell_stale`, `undelivered_to_reader`)

Incident driver: a doorbell ring returning 2xx proves the ring was **written** to the seat's log.
It does **not** prove anything is **reading** it. `webhook: true` means ONLY that the ring hop
returned 2xx; it is NOT evidence a reader was woken. Offline and broken are indistinguishable to
the sender; the correct reaction is identical (do not assume that consumer was woken; reach it
another way).

- Every `bus_consumers` row gains additive fields: `last_ring_delivered_at`,
  `last_message_consumed_at`, `undelivered_to_reader`, `oldest_undelivered_ring_at`, and
  `doorbell_stale`.
- `doorbell_stale` is true only when all three hold: webhook registered+enabled,
  `undelivered_to_reader >= 3`, and the oldest unconsumed ring is at least 15 minutes old.
- Read-side only over existing tables; no schema change, no change to the #40 wire contract.

### #50 -- universal "monitoring your channel correctly" discipline

- `docs/agent-discipline.md` gains the arm / prove-armed / poll-own-channel rule set both crews
  read. Documents that `webhook: true` is not a wake proof, and that a legitimate offline seat
  reading `doorbell_stale: true` is a true positive, not an incident.

## 0.6.1

### Release mechanics

- `deploy.yml` now applies **D1 migrations from CI** before deploying. The #43 migration was
  documented as a manual step and the workflow had no migrations stage, so v0.6.0 shipped code
  whose webhook reads referenced columns that did not exist yet: every doorbell read threw and
  delivery silently degraded to poll until the ALTERs were applied by hand. A migration that
  only a human remembers is a migration that eventually does not run.
- The stdio MCP client `@skyphusion/crew-bus` is released at **0.6.1**, matching the deployed
  Worker, and carries the #43 `vpc` target in its `bus_webhook_set` tool schema. Published on a
  `crew-bus-v0.6.1` tag; the client is deliberately released AFTER the server capability it
  references was proven live end to end (fc#808 ring proof).

### #45 -- doorbell ring uses http, and a failed attempt now says why

Backend-only fix. The v0.6.0 dual-path doorbell could not ring a VPC target at all; the end-to-end
ring proof found why.

- **The ring URL scheme was wrong.** Delivery built `https://doorbell.local/ring/<consumer>`, but
  the Workers VPC service for the doorbell defines `http_port 9870` with `https_port` NULL: the mux
  listens plaintext on loopback behind the tunnel, so there is no TLS on it to handshake with. The
  edge resolves the URL SCHEME to the service port config **before** any transport, so the request
  failed at the edge with `port_not_open ... failed to build target strategy: https` and never
  reached the tunnel. Now `http://`. (This corrects the URL shown in the 0.6.0 entry above, which
  documented the scheme as shipped.) If the service ever gains an `https_port`, both change together.
- **The per-attempt `catch {}` swallowed the exception.** A hard, permanent, edge-level
  misconfiguration recorded identically to a transient network blip -- `attempts=3`,
  `last_status=0`, nothing else -- so the delivery record could not distinguish "unreachable
  forever" from "try again later". Failed attempts now log a structured
  `webhook_attempt_error` line with the consumer, attempt number, and exception **message**. Message
  only: never headers (HMAC signature, and the `Authorization` value for an `auth_env` endpoint) and
  never the body.
- No schema change, no API change, no behavior change on the `url` (public https) path.

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