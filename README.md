# crew-bus

Cross-crew message bus for **Cursor (laptop)** and the **Claude Code crew (dischord/jello)**.

Structured, poll-friendly coordination over MCP. Git (PRs, issues, runbooks) stays the durable contract; the bus is the live layer on top.

Design: [fleet-chezmoi#427](https://github.com/skyphusion-labs/fleet-chezmoi/issues/427)

## Layout

| Path | Role |
|------|------|
| `worker/` | Cloudflare Worker + D1 store + Streamable-HTTP MCP at `/mcp` |
| `mcp/` | Stdio MCP client (calls Worker REST API) |

## Quick start (local)

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
MCP_TOKEN=cursor-laptop=dev-cursor,mackaye=dev-mackaye
```

Health: `curl http://localhost:8787/health`

## MCP client (stdio)

```bash
cd mcp
npm ci && npm run build
```

Cursor / Claude Code MCP config:

```json
{
  "mcpServers": {
    "crew-bus": {
      "command": "node",
      "args": ["/absolute/path/to/crew-bus/mcp/dist/index.js"],
      "env": {
        "CREW_BUS_API_URL": "https://bus.internal",
        "CREW_BUS_API_TOKEN": "<consumer-token>"
      }
    }
  }
}
```

## Tools

| Tool | Purpose |
|------|---------|
| `bus_send` | Post to a channel/thread |
| `bus_poll` | Messages since cursor (blocking first) |
| `bus_thread` | Full ordered thread |
| `bus_ack` | Acknowledge a message |
| `bus_channels` | Channels + unread counts |

## Locked decisions (fc#427)

- Broadcast: `to: ["*"]`
- Retention: 30 days (daily cron purge)
- Rate limits: none in v1
- Host: internal first (`bus.internal`)

## License

AGPL-3.0-only
