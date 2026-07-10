# crew-bus

Private cross-crew bus. See `README.md` and [fc#427](https://github.com/skyphusion-labs/fleet-chezmoi/issues/427).

## Conventions

- **`npm run typecheck`** in `worker/` and `mcp/` is the CI gate (`tsc --noEmit`).
- Mirror every wrangler binding in hand-authored `Env` (`worker/src/env.ts`).
- Per-consumer bearer tokens: comma-separated `name=token` in `MCP_TOKEN` secret.
- Deploy at your Worker URL; runbook example in Skyphusion private `fleet-chezmoi/system/crew-bus/`.
- **npm:** `@skyphusion/crew-bus` (stdio MCP client). Public release checklist: `docs/PUBLIC-RELEASE.md`.

## Release

SemVer `0.MINOR.PATCH`. Tag `v*` triggers deploy workflow when wired.
