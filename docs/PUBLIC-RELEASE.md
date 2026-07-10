# Public release checklist (crew-bus)

**Status: DRAFT — execute after Thursday 2026-07-10 cross-crew canary passes.**

Releasing the repo and `@skyphusion/crew-bus` npm package does **not** expose a live bus: the
Worker stays bearer-gated; consumers need URL + token. Public code ≠ public service.

## Pre-flight (Conrad laptop)

- [ ] Cross-crew canary pass (Mackaye ↔ Cursor on `vivijure`)
- [ ] Mackaye memory rename done (`sendmessage-bus-memory-rename.md` in fleet-chezmoi)
- [ ] Tier reseed + dischord MCP wired
- [ ] Actions secrets present: `SKYPHUSION_WRANGLER_TOML`, `CREW_BUS_HEALTH_URL`,
      `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `NPM_TOKEN`

## Secrets / topology scan (grep-zero)

From repo root — must be **zero** matches before flip:

```bash
rg -i \
  'ghp_|gho_|Bearer [a-f0-9]{32,}|MCP_TOKEN=[^$]|database_id = "[0-9a-f-]{36}"|bus-internal\.skyphusion\.org|self-hosted,\s*fleet|4ffbdf50-2408-4664-aed2-917be11d0ab8' \
  --glob '!package-lock.json' --glob '!LICENSE' --glob '!docs/PUBLIC-RELEASE.md' .

# Expect: no matches
# - wrangler.toml is gitignored; example uses REPLACE_WITH_D1_ID + placeholder route
# - ci.yml / deploy.yml use ubuntu-latest (not [self-hosted, fleet])
# - deploy health URL comes from CREW_BUS_HEALTH_URL secret
```

Optional: scan git history before first public flip if anything ever committed by mistake.

## GitHub: flip repo to public

1. Merge this PR (npm metadata + publish workflow + docs + public-safe CI/deploy)
2. Settings → Change visibility → **Public**
3. Confirm **aviation-grade-main** ruleset still required (already applied)
4. Confirm org Default runner group still has `allows_public_repositories=false` (fc#394) —
   public jobs must stay on `ubuntu-latest`

## Tag namespaces (do not fat-finger)

| Tag pattern | Workflow | Effect |
| --- | --- | --- |
| `v*` (e.g. `v0.1.2`) | `deploy.yml` | Deploy Worker to Cloudflare |
| `crew-bus-v*` (e.g. `crew-bus-v0.1.2`) | `publish-npm.yml` | Publish `@skyphusion/crew-bus` |

A Worker deploy tag does **not** publish npm, and an npm tag does **not** deploy the Worker.

## npm: first publish

1. Ensure org secret **`NPM_TOKEN`** on `skyphusion-labs/crew-bus` (automation token with
   publish scope for `@skyphusion`; same token as postern/search-mcp)
2. Bump `mcp/package.json` version if needed (SemVer patch for publish-only)
3. Tag and push:

```bash
git tag crew-bus-v0.1.2
git push origin crew-bus-v0.1.2
```

Or: Actions → **Publish npm package** → workflow_dispatch.

4. Verify: `npm view @skyphusion/crew-bus version`

## Post-publish (optional)

- [ ] Laptop / seat MCP: switch to `npx -y @skyphusion/crew-bus`
- [ ] dischord `~/.claude.json`: same after Mackaye pull
- [ ] fc#427: close or mark Phase 1 complete

## What stays private

| Asset | Where |
| --- | --- |
| Live tokens | `crew-secrets`, Worker `MCP_TOKEN` secret |
| Production `wrangler.toml` (D1 id + custom domain) | Actions secret `SKYPHUSION_WRANGLER_TOML` |
| Health-check hostname | Actions secret `CREW_BUS_HEALTH_URL` |
| Fleet runbooks / chezmoi | `fleet-chezmoi` (private) |

## Rollback

- npm: publish deprecation notice on bad version; yank only if truly broken (prefer forward fix)
- GitHub: can flip back to private if needed (npm package remains public once published)
