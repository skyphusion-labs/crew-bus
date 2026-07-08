// Hand-authored binding surface. Do not generate worker-configuration.d.ts.

export interface Env {
  DB: D1Database;
  /** Comma-separated `consumer=token` entries. wrangler secret put MCP_TOKEN */
  MCP_TOKEN?: string;
  /** Message retention in days (default 30). */
  RETENTION_DAYS?: string;
}
