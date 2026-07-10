// Hand-authored binding surface. Do not generate worker-configuration.d.ts.

export interface Env {
  DB: D1Database;
  /** Comma-separated `consumer=token` entries. wrangler secret put MCP_TOKEN */
  MCP_TOKEN?: string;
  /** Message retention in days (default 30). */
  RETENTION_DAYS?: string;
  // #26 doorbell webhooks: webhook_endpoints.auth_env holds the NAME of a
  // wrangler secret whose value is sent as the Authorization header. The value
  // is looked up dynamically as env[auth_env], so allow string-keyed access to
  // secret bindings not enumerated above (the real creds live in wrangler
  // secrets, D1 stores only the name). Named bindings above keep their types.
  [authEnvBinding: string]: unknown;
}
