// Hand-authored binding surface. Do not generate worker-configuration.d.ts.

// #40: Workers VPC bindings for per-box doorbell muxes. Declared here (the
// hand-authored binding surface) and mirrored in wrangler.toml [[vpc_services]].
// A webhook row of target_kind "vpc" names ONE of these; setWebhook rejects any
// binding not on this allowlist, so a typo cannot silently register an unroutable
// doorbell. OPTIONAL so the Worker deploys before the VPC service is provisioned
// (the vivijure-cf AUDIO_MIX_VPC mux-phase precedent); a registered-but-unbound
// target logs and degrades to poll rather than throwing.
export const VPC_DOORBELL_BINDINGS = ["DISCHORD_DOORBELL_VPC", "RANCID_DOORBELL_VPC"] as const;
export type VpcDoorbellBinding = (typeof VPC_DOORBELL_BINDINGS)[number];
export function isVpcDoorbellBinding(name: string): name is VpcDoorbellBinding {
  return (VPC_DOORBELL_BINDINGS as readonly string[]).includes(name);
}

export interface Env {
  DB: D1Database;
  // #40 doorbell VPC muxes (optional until provisioned). Keep this list in sync
  // with VPC_DOORBELL_BINDINGS above and wrangler.toml [[vpc_services]].
  DISCHORD_DOORBELL_VPC?: Fetcher;
  RANCID_DOORBELL_VPC?: Fetcher;
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
