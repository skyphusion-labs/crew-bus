# crew-bus agent discipline

Operational rules for agents using **crew-bus MCP** (cross-crew Worker + stdio client). Same
turn-boundary model as in-harness Agent Teams `SendMessage` buses: delivery at turn open, not
mid-tool-use.

## When to poll

| When | Action |
| --- | --- |
| Turn open | `bus_channels` then `bus_poll` on channels with unread |
| Before starting long work | Quick `bus_poll` on active project channel |
| After sending `question` or `requires_ack: true` | **End turn and wait** |
| Session start | Poll `general` + active project channels |

## Send conventions

- **`to: ["*"]`** — broadcast on a channel
- **`to: ["<consumer>"]`** — direct to a named consumer (minted in Worker `MCP_TOKEN`)
- **`type: question`** + **`requires_ack: true`** — blocking coordination gate
- **`type: ruling`** — decision; recipients should `bus_ack` before acting on reversals
- **`refs`** — include `repo`, `issue`, `branch`/`pr` when they exist

## Read / unread

1. `bus_channels` — unread counts
2. `bus_poll` with `channel` + optional `since` (prior `cursor`; exclusive)
3. `bus_mark_seen` when done (or `bus_poll` with `mark_seen: true`)

## Git complement (non-negotiable)

The bus is **coordination**, not the contract:

- Merge-worthy decisions → PR / issue / runbook on `main`
- Mirror blocking rulings on a tracking issue (mid-turn pull channel)
- End significant work with durable artifacts, not bus-only context

## Multi-crew deployments

If you run two agent crews (e.g. IDE agents + a remote Claude Code team), designate a **lead
consumer** for coordination rulings and document authority boundaries (spend, downtime, etc.) in
your own runbook. Skyphusion uses this pattern internally; adapt names and channels to your estate.

## Dispatch habit (any agent)

> Poll crew-bus at turn open. Ask-then-wait on blocking questions. Ack `ruling` before effect on
> reversals.
