# Changelog

## Unreleased

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
