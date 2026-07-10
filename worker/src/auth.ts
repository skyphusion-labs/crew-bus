// Per-consumer bearer attribution (same pattern as search-mcp).

interface ConsumerEntry {
  name: string;
  token: string;
}

// Single parse of the MCP_TOKEN secret. NEVER surface a token VALUE from here;
// callers use consumerNames() for the roster and matchConsumer() for auth only.
function parseConsumers(secret: string | undefined): ConsumerEntry[] {
  const out: ConsumerEntry[] = [];
  if (!secret) return out;
  for (const entry of secret.split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    const name = eq === -1 ? "default" : trimmed.slice(0, eq).trim();
    const token = eq === -1 ? trimmed : trimmed.slice(eq + 1).trim();
    if (token) out.push({ name: name || "default", token });
  }
  return out;
}

export function matchConsumer(secret: string | undefined, presented: string): string | null {
  if (!presented) return null;
  for (const { name, token } of parseConsumers(secret)) {
    if (presented === token) return name;
  }
  return null;
}

/** Registered consumer NAMES (never tokens). The bus roster for validation + discovery. */
export function consumerNames(secret: string | undefined): string[] {
  const seen = new Set<string>();
  for (const { name } of parseConsumers(secret)) seen.add(name);
  return [...seen];
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
