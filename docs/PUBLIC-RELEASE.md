# Public release checklist (crew-bus)

**Status: DRAFT — execute after Thursday 2026-07-10 cross-crew canary passes.**

Releasing the repo and `@skyphusion/crew-bus` npm package does **not** expose a live bus: the
Worker stays bearer-gated; consumers need URL + token. Public code ≠ public service.

## Pre-flight (Conrad laptop)

- [ ] Cross-crew canary pass (Mackaye ↔ Cursor on `vivijure`)
- [ ] Mackaye memory rename done (`sendmessage-bus-memory-rename.md` in fleet-chezmoi)
- [ ] Tier reseed + dischord MCP wired

## Secrets / topology scan (grep-zero)

From repo root:

```bash
rg -i \
  'ghp_|gho_|Bearer [a-f0-9]{32,}|MCP_TOKEN=[^$]|database_id = "[0-9a-f-]{36}"' \
  --glob '!package-lock.json' --glob '!LICENSE' .

# Expect: no matches (wrangler.toml is gitignored locally; example uses REPLACE_WITH_D1_ID)
```

Optional: scan git history before first public flip if anything ever committed by mistake.

## GitHub: flip repo to public

1. Merge this PR (npm metadata + publish workflow + docs)
2. Settings → Change visibility → **Public**
3. Confirm **aviation-grade-main** ruleset still required (already applied)

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

- [ ] Laptop `~/.cursor/mcp.json`: switch to `npx -y @skyphusion/crew-bus`
- [ ] dischord `~/.claude.json`: same after Mackaye pull
- [ ] fc#427: close or mark Phase 1 complete

## What stays private

| Asset | Where |
| --- | --- |
| Live tokens | `crew-secrets`, Worker `MCP_TOKEN` secret |
| D1 database id (production) | `fleet-chezmoi/system/crew-bus/README.md` |
| Fleet runbooks / chezmoi | `fleet-chezmoi` (private) |

## Rollback

- npm: publish deprecation notice on bad version; yank only if truly broken (prefer forward fix)
- GitHub: can flip back to private if needed (npm package remains public once published)
