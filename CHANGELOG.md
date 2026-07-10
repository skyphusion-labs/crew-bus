# Changelog

## Unreleased

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
