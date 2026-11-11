# crew-bus

Status: the Skyphusion-hosted Worker was deleted 2026-09-25 (fleet-chezmoi#2102);
the D1 database `crew-bus` was kept, not inspected. A `v*` tag would re-create a
production Worker; do not cut one without a ruling. Self-host use is unchanged.

Private cross-crew message bus (Worker + stdio MCP client). See `README.md`,
`docs/agent-discipline.md`, and fleet tracker
[fc#427](https://github.com/skyphusion-labs/fleet-chezmoi/issues/427).

No hosted hostname is in this tree. Self-hosters set `CREW_BUS_API_URL` to their own
Worker (`README.md`). Production `wrangler.toml` is not committed; `deploy.yml` materializes
it from the `SKYPHUSION_WRANGLER_TOML` secret. Runbook: private `fleet-chezmoi/system/crew-bus/`.

## Layout

| Path | Role | Version pin |
|------|------|-------------|
| `worker/` | Cloudflare Worker + D1 + Streamable-HTTP MCP at `/mcp` | `worker/package.json` |
| `mcp/` | Stdio MCP client `@skyphusion/crew-bus` | `mcp/package.json` |

## Conventions

- **`npm run typecheck`** in `worker/` and `mcp/` is the CI gate (`tsc --noEmit`).
- Mirror every wrangler binding in hand-authored `Env` (`worker/src/env.ts`).
- Per-consumer bearer tokens: comma-separated `name=token` in `MCP_TOKEN` secret.
- **Roster additions are ADDITIVE via `MCP_TOKEN_EXTRA`, never a rewrite of `MCP_TOKEN`**
  (write-only secret: one dropped entry silently 401s that consumer). Both are joined by
  `rosterSecret(env)` in `auth.ts`; never read `env.MCP_TOKEN` directly at a call site.
- **npm:** `@skyphusion/crew-bus` (stdio MCP client). Public release checklist: `docs/PUBLIC-RELEASE.md`.
- No em-dashes (U+2014) or en-dashes (U+2013) in source or docs.

## Dual version trains (do not mix)

Worker and MCP package versions move **independently**. Trust each package.json + its tag
namespace; do not assume they share a number.

| Tag pattern | Workflow | Effect |
|-------------|----------|--------|
| `v*` (e.g. `v0.7.1`) | `deploy.yml` | Deploy Worker to Cloudflare |
| `crew-bus-v*` (e.g. `crew-bus-v0.6.5`) | `publish-npm.yml` | Publish `@skyphusion/crew-bus` |

A Worker deploy tag does **not** publish npm; an npm tag does **not** deploy the Worker.
A bare merge to `main` runs CI only and does **not** redeploy production.

## Wake traffic (doorbell)

Anything that must **wake** another context goes as `type=status` or `type=handoff` (or
`ruling` / `question` as appropriate). A pure `type=ack` is a delivery receipt on the bus; do
not treat ack alone as the wake path for a sleeping reader. Prefer `bus_send` with an explicit
type when the goal is to ring a doorbell. Full discipline: `docs/agent-discipline.md`.

## Release / tagging

SemVer `0.MINOR.PATCH` (pre-1.0). Full public checklist: `docs/PUBLIC-RELEASE.md`.

### Cut a Worker release (`v*`)

1. **Release PR on `main`** if version pins or changelog need a bump (keep `worker/package.json`
   discipline in tree).
2. Tag and push:

```bash
git fetch origin main && git checkout main && git pull --ff-only
git tag -a vX.Y.Z -m "vX.Y.Z"
git push origin vX.Y.Z
```

3. Confirm `deploy.yml` green. Tag must be on `origin/main` (workflow asserts ancestry).

### Cut an npm package release (`crew-bus-v*`)

1. Bump `mcp/package.json` version on `main` if needed.
2. Tag `crew-bus-vX.Y.Z` and push (or Actions -> Publish npm package -> workflow_dispatch).
3. Verify: `npm view @skyphusion/crew-bus version`.

## Release convention (bump-at-release)

One convention for every skyphusion-labs repo (Conrad, ruled 2026-11-10, fleet-chezmoi#1766). A version moves ONLY in a release PR: bump the version, then assemble the changelog. Feature and fix PRs do not bump. Releases go through a PR (fleet-chezmoi#1622) and the tag goes on that PR's merge commit.

- Version of record here: worker/package.json and worker/src/version.ts (and package-lock.json).
- Tag shape: `v*`.
- Check before a release PR: does a tag already exist for the version currently in the manifest? Yes means the cycle is closed, so the release PR bumps. No means a bump already landed outside a release PR; stop and read why before bumping again.
