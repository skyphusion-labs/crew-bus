// Per-consumer bearer attribution (same pattern as search-mcp).

interface ConsumerEntry {
  name: string;
  token: string;
}

/**
 * The roster-bearing shape of Env. Two secrets, ONE roster (fleet-chezmoi #1070).
 * Kept structural so any caller holding an Env satisfies it.
 */
export interface RosterEnv {
  MCP_TOKEN?: string;
  MCP_TOKEN_EXTRA?: string;
}

/**
 * The full consumer roster: MCP_TOKEN and MCP_TOKEN_EXTRA joined into one
 * comma-separated secret (fleet-chezmoi #1070).
 *
 * Workers secrets are write-only, so adding consumers by rewriting MCP_TOKEN is a
 * full-roster rewrite in which one mistyped entry silently locks that consumer off
 * the bus with a flat 401. The secret format is already comma-separated
 * `name=token`, so two such secrets concatenate into one valid roster and
 * MCP_TOKEN is never touched. Existing consumers therefore cannot break, whatever
 * MCP_TOKEN_EXTRA contains.
 *
 * MCP_TOKEN is joined FIRST, deliberately: see dedupeByName().
 *
 * Every consumer lookup goes through here. Reading env.MCP_TOKEN directly at a
 * call site yields a PARTIAL roster that 401s everyone in MCP_TOKEN_EXTRA.
 */
export function rosterSecret(env: RosterEnv): string {
  return [env.MCP_TOKEN, env.MCP_TOKEN_EXTRA]
    .filter((s): s is string => typeof s === "string" && s.trim() !== "")
    .join(",");
}

// Single parse of the roster secret. NEVER surface a token VALUE from here;
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

/**
 * DUPLICATE-NAME GUARD (fleet-chezmoi #1070). Keep the FIRST entry per name and
 * drop every later one.
 *
 * matchConsumer() returns the first match, so without this a name present in both
 * secrets lets two DIFFERENT tokens authenticate as ONE identity: precisely the
 * identity collapse #1070 exists to remove, reintroduced one layer down.
 *
 * Fail mode chosen: log-and-prefer-MCP_TOKEN (rosterSecret joins it first), NOT a
 * global refusal.
 *   - Fail-closed globally would 401 the whole bus on one typo in the additive
 *     secret, which is a worse version of the failure the additive design exists
 *     to avoid.
 *   - Dropping BOTH copies of the colliding name would break a live consumer via
 *     an edit to MCP_TOKEN_EXTRA, breaking the same guarantee.
 *   - This is still fail-closed on the AMBIGUITY: the second, ambiguous token
 *     authenticates as nobody, so two tokens can never map to one identity. The
 *     blast radius is exactly the misconfigured new entry.
 * The residual cost is a flat 401 on that new consumer, indistinguishable from a
 * bad client config, so the collision is logged by NAME (never a token value).
 */
function dedupeByName(entries: ConsumerEntry[]): ConsumerEntry[] {
  const seen = new Set<string>();
  const kept: ConsumerEntry[] = [];
  const collisions = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.name)) {
      collisions.add(entry.name);
      continue;
    }
    seen.add(entry.name);
    kept.push(entry);
  }
  if (collisions.size > 0) {
    // NAMES ONLY. A token value must never reach a log line.
    console.warn(
      JSON.stringify({
        event: "consumer_name_collision",
        names: [...collisions],
        detail:
          "consumer name registered more than once across MCP_TOKEN / MCP_TOKEN_EXTRA; " +
          "the first entry wins and every later token for that name is refused",
      }),
    );
  }
  return kept;
}

/** Consumer names registered more than once across the roster. Diagnostic only. */
export function duplicateConsumerNames(secret: string | undefined): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const { name } of parseConsumers(secret)) {
    if (seen.has(name)) dupes.add(name);
    seen.add(name);
  }
  return [...dupes];
}

export function matchConsumer(secret: string | undefined, presented: string): string | null {
  if (!presented) return null;
  for (const { name, token } of dedupeByName(parseConsumers(secret))) {
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

export function requireConsumer(request: Request, env: RosterEnv): string | Response {
  const consumer = matchConsumer(rosterSecret(env), bearerToken(request));
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
