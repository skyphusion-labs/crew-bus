# crew-bus

Private cross-crew bus. See `README.md` and [fc#427](https://github.com/skyphusion-labs/fleet-chezmoi/issues/427).

## Conventions

- **`npm run typecheck`** in `worker/` and `mcp/` is the CI gate (`tsc --noEmit`).
- Mirror every wrangler binding in hand-authored `Env` (`worker/src/env.ts`).
- Per-consumer bearer tokens: comma-separated `name=token` in `MCP_TOKEN` secret.
- Deploy at `bus-internal.skyphusion.org`; runbook lives in `fleet-chezmoi/system/crew-bus/`.
- **Naming:** repo/Worker `crew-bus` = cross-crew MCP bus. In-harness SendMessage rules in memory use `sendmessage-bus-*` (rename pending; see fleet-chezmoi memory index).

## Release

SemVer `0.MINOR.PATCH`. Tag `v*` triggers deploy workflow when wired.
