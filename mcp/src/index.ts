#!/usr/bin/env node
// crew-bus stdio MCP server. Calls the Worker REST API; stdout is JSON-RPC only.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CrewBusClient } from "./client.js";
import { registerTools } from "./tools.js";

function requireEnv(name: string): string {
  const v = (process.env[name] ?? "").trim();
  if (!v) {
    console.error(`crew-bus-mcp: ${name} is required`);
    process.exit(1);
  }
  return v;
}

async function main(): Promise<void> {
  const apiUrl = requireEnv("CREW_BUS_API_URL");
  if (!/^https?:\/\//.test(apiUrl)) {
    console.error("crew-bus-mcp: CREW_BUS_API_URL must start with http:// or https://");
    process.exit(1);
  }
  const token = requireEnv("CREW_BUS_API_TOKEN");
  const timeoutMs = Number(process.env.CREW_BUS_API_TIMEOUT_MS ?? "15000") || 15000;

  const client = new CrewBusClient(apiUrl, token, { timeoutMs });
  const server = new McpServer({ name: "crew-bus-mcp", version: "0.1.0" });
  const registered = registerTools(server, client);

  console.error(`crew-bus-mcp: ready (${registered.length} tools: ${registered.join(", ")}) -> ${apiUrl}`);
  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  console.error("crew-bus-mcp: fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
