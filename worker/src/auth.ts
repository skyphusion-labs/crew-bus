// Per-consumer bearer attribution (same pattern as search-mcp).

export function matchConsumer(secret: string | undefined, presented: string): string | null {
  if (!secret || !presented) return null;
  for (const entry of secret.split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    const name = eq === -1 ? "default" : trimmed.slice(0, eq).trim();
    const token = eq === -1 ? trimmed : trimmed.slice(eq + 1).trim();
    if (token && presented === token) return name || "default";
  }
  return null;
}

export function bearerToken(request: Request): string {
  const auth = request.headers.get("Authorization") ?? "";
  return auth.startsWith("Bearer ") ? auth.slice(7) : "";
}

export function requireConsumer(request: Request, env: { MCP_TOKEN?: string }): string | Response {
  const consumer = matchConsumer(env.MCP_TOKEN, bearerToken(request));
  if (!consumer) {
    return json({ error: "unauthorized" }, 401, { "WWW-Authenticate": "Bearer" });
  }
  return consumer;
}

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...extra },
  });
}

export { json };
