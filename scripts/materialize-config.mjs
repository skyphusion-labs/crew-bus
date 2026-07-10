#!/usr/bin/env node
// Write production wrangler.toml from a CI secret (never committed).
//
// Env (required when invoked):
//   SKYPHUSION_WRANGLER_TOML

import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

const FILES = [["SKYPHUSION_WRANGLER_TOML", join("worker", "wrangler.toml")]];

function main() {
  let missing = false;
  for (const [envVar, relPath] of FILES) {
    const val = process.env[envVar];
    if (!val) {
      console.error(`::error::Missing required secret/env ${envVar}`);
      missing = true;
      continue;
    }
    writeFileSync(join(REPO, relPath), val, "utf8");
    console.log(`Materialized ${relPath}`);
  }
  if (missing) process.exit(2);
}

const invokedDirectly =
  process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
