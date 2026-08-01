// Single source for the client's advertised version string. A test asserts this
// matches mcp/package.json so MCP `serverInfo` cannot drift from the published
// package the way the hardcoded "0.1.0" did.
//
// This mirrors worker/src/version.ts deliberately. That file was written to kill
// exactly this defect on the Worker side, and its comment names the same literal:
// "so /health and MCP serverInfo cannot drift from the released code the way the
// hardcoded 0.1.0 did". The Worker got the fix and the guard; the client kept the
// original bug for six minor versions. A lesson filed under the artifact that
// taught it did not travel to its sibling.
//
// Why a guarded literal and not `import pkg from "../package.json"`, which would
// be a true single source: mcp/tsconfig.json sets `rootDir: "src"`, so importing
// a file above it breaks the build. The literal is a copy, but it is a copy the
// test makes impossible to SHIP wrong -- see mcp/test/version.test.ts.
export const VERSION = "0.6.5";
