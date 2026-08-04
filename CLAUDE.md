# crew-bus

Private cross-crew bus. See `README.md` and [fc#427](https://github.com/skyphusion-labs/fleet-chezmoi/issues/427).

## Conventions

- **`npm run typecheck`** in `worker/` and `mcp/` is the CI gate (`tsc --noEmit`).
- Mirror every wrangler binding in hand-authored `Env` (`worker/src/env.ts`).
- Per-consumer bearer tokens: comma-separated `name=token` in `MCP_TOKEN` secret.
- **Roster additions are ADDITIVE via `MCP_TOKEN_EXTRA`, never a rewrite of `MCP_TOKEN`**
  (write-only secret: one dropped entry silently 401s that consumer). Both are joined by
  `rosterSecret(env)` in `auth.ts`; never read `env.MCP_TOKEN` directly at a call site.
- Deploy at your Worker URL; runbook example in Skyphusion private `fleet-chezmoi/system/crew-bus/`.
- **npm:** `@skyphusion/crew-bus` (stdio MCP client). Public release checklist: `docs/PUBLIC-RELEASE.md`.

## Release / tagging

SemVer `0.MINOR.PATCH` (pre-1.0). Two **separate** tag namespaces (do not mix them up). Full public
checklist: `docs/PUBLIC-RELEASE.md`.

| Tag pattern | Workflow | Effect |
|-------------|----------|--------|
| `v*` (e.g. `v0.7.1`) | `deploy.yml` | Deploy Worker to Cloudflare |
| `crew-bus-v*` (e.g. `crew-bus-v0.7.1`) | `publish-npm.yml` | Publish `@skyphusion/crew-bus` |

A Worker deploy tag does **not** publish npm; an npm tag does **not** deploy the Worker.
A bare merge to `main` runs CI only and does **not** redeploy production.

### Cut a Worker release (`v*`)

1. **Release PR on `main`** if version pins or changelog need a bump (keep worker version
   discipline in tree as you already do for other estate Workers).
2. Tag and push:

```bash
git fetch origin main && git checkout main && git pull --ff-only
git tag -a vX.Y.Z -m "vX.Y.Z"
git push origin vX.Y.Z
```

3. Confirm `deploy.yml` green. Tag must be on `origin/main` (workflow asserts ancestry).

### Cut an npm package release (`crew-bus-v*`)

1. Bump `mcp/package.json` version on `main` if needed.
2. Tag `crew-bus-vX.Y.Z` and push (or Actions → Publish npm package → workflow_dispatch).
3. Verify: `npm view @skyphusion/crew-bus version`.
