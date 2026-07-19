# crew-bus

Cross-crew message bus for **multiple agent runtimes** (e.g. Cursor on a laptop and a Claude Code
crew on a remote host). Structured, poll-friendly coordination over MCP. Git (PRs, issues,
runbooks) stays the durable contract; the bus is the live layer on top.

**License:** AGPL-3.0-only — we publish what we build; self-host the Worker and wire your own tokens.

Design context: [fleet-chezmoi#427](https://github.com/skyphusion-labs/fleet-chezmoi/issues/427) (Skyphusion internal tracker).

## Layout

| Path | Role |
|------|------|
| `worker/` | Cloudflare Worker + D1 store + Streamable-HTTP MCP at `/mcp` |
| `mcp/` | Stdio MCP client (`@skyphusion/crew-bus` on npm) |

## Quick start (local Worker)

```bash
cd worker
cp wrangler.toml.example wrangler.toml
# Edit wrangler.toml: set D1 database_id after `wrangler d1 create crew-bus`
npm ci
npm run db:migrate:local
npm run dev
```

Set secrets for local dev in `.dev.vars`:

```
MCP_TOKEN=cursor-laptop=dev-cursor,lead=dev-lead
```

Health: `curl http://localhost:8787/health`

## MCP client (stdio)

**From npm** (after first publish):

```json
{
  "mcpServers": {
    "crew-bus": {
      "command": "npx",
      "args": ["-y", "@skyphusion/crew-bus"],
      "env": {
        "CREW_BUS_API_URL": "https://your-crew-bus.example.com",
        "CREW_BUS_API_TOKEN": "<consumer-token>"
      }
    }
  }
}
```

**From source:**

```bash
cd mcp && npm ci && npm run build
```

See [mcp/README.md](./mcp/README.md) for env vars and tool list.

## Tools

| Tool | Purpose |
|------|---------|
| `bus_send` | Post to a channel/thread |
| `bus_poll` | Messages since your stored cursor (auto-advances; explicit `since` overrides) |
| `bus_thread` | Full ordered thread |
| `bus_ack` | Acknowledge a message |
| `bus_channels` | Channels + unread counts |
| `bus_consumers` | Registered roster + last_poll_at + webhook flag + [doorbell reader health](docs/agent-discipline.md#doorbell-reader-health-47) |
| `bus_webhook_set` | Register/replace your own doorbell webhook (https, HMAC secret) |
| `bus_webhook_get` | Your own webhook config (secret masked) |
| `bus_webhook_clear` | Unregister your own webhook |
| `bus_mark_seen` | Clear unread for a channel |

## Smoke test (live Worker)

```bash
export CREW_BUS_API_URL=https://your-crew-bus.example.com
export CREW_BUS_API_TOKEN=<your-consumer-token>
./scripts/smoke.sh
```

## Agent discipline

[docs/agent-discipline.md](./docs/agent-discipline.md) — poll at turn open; ask-then-wait on blocking questions; git complement.

## Self-host notes

- Per-consumer bearer tokens: comma-separated `name=token` in Worker secret `MCP_TOKEN`
- Default channels: `vivijure`, `postern`, `common-thread`, `fleet`, `general` (edit in Worker source if needed)
- Broadcast: `to: ["*"]`; retention: 30 days (daily cron purge); no rate limits in v1

## Releases (two tag namespaces)

| Tag | Workflow | What it does |
| --- | --- | --- |
| `v0.1.2` | `deploy.yml` | Deploy the Cloudflare Worker |
| `crew-bus-v0.1.2` | `publish-npm.yml` | Publish `@skyphusion/crew-bus` to npm |

Do not use a `v*` tag expecting an npm publish, or a `crew-bus-v*` tag expecting a Worker deploy.

Production `wrangler.toml` is **not** in git. CI materializes it from Actions secret
`SKYPHUSION_WRANGLER_TOML` (`scripts/materialize-config.mjs`). Local operators: copy
`worker/wrangler.toml.example` → `worker/wrangler.toml`.

## Public release

Repo flip + npm publish checklist: [docs/PUBLIC-RELEASE.md](./docs/PUBLIC-RELEASE.md) (post-canary).

## License

AGPL-3.0-only — see [LICENSE](./LICENSE).
