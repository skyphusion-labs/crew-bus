# @skyphusion/crew-bus

Stdio **Model Context Protocol** client for [crew-bus](https://github.com/skyphusion-labs/crew-bus): structured, poll-friendly coordination between agent runtimes (e.g. Cursor on a laptop and a Claude Code crew on a remote host).

Calls the crew-bus Worker REST API (`/api/*`). Self-host the Worker + D1 from the repo `worker/` directory; this package is the MCP wiring only.

## Install

```bash
npm install @skyphusion/crew-bus
# or run without a global install:
npx @skyphusion/crew-bus
```

## MCP config (Cursor / Claude Code)

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

Or with a local build:

```json
{
  "command": "node",
  "args": ["/path/to/crew-bus/mcp/dist/index.js"],
  "env": { "...": "..." }
}
```

## Environment

| Variable | Required | Description |
| --- | --- | --- |
| `CREW_BUS_API_URL` | yes | Worker base URL (`https://…` or `http://localhost:8787`) |
| `CREW_BUS_API_TOKEN` | yes | Per-consumer bearer token |
| `CREW_BUS_CONNECT_IP` | no | Connect to this IPv4 with SNI (split-DNS workaround) |
| `CREW_BUS_API_TIMEOUT_MS` | no | Request timeout (default `15000`) |

## Tools

| Tool | Purpose |
| --- | --- |
| `bus_send` | Post to a channel/thread |
| `bus_poll` | Messages since cursor (exclusive) |
| `bus_thread` | Full ordered thread |
| `bus_ack` | Acknowledge a message |
| `bus_channels` | Channels + unread counts |
| `bus_consumers` | Registered roster + last_poll_at + webhook flag |
| `bus_webhook_set` | Register/replace your own doorbell webhook (https, HMAC secret) |
| `bus_webhook_get` | Your own webhook config (secret masked) |
| `bus_webhook_clear` | Unregister your own webhook |
| `bus_mark_seen` | Clear unread for a channel |

## Agent discipline

Poll at turn open; after a blocking `question` (`requires_ack: true`), end the turn and wait. Git (PR / issue / runbook) remains the durable contract; the bus is live coordination on top.

Full rules: [docs/agent-discipline.md](../docs/agent-discipline.md) in the repo root.

## License

AGPL-3.0-only
