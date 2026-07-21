// Single source for the served version string. A test asserts this matches
// worker/package.json so /health and MCP serverInfo cannot drift from the
// released code the way the hardcoded 0.1.0 did.
export const VERSION = "0.6.3";
