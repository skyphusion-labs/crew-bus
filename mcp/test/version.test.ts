// Mirrors worker/test/version.test.ts. Without this the advertised version is a
// hand-maintained copy that can drift silently; with it, a drifted copy cannot
// pass CI, which is the only thing that makes a literal acceptable here.
import { describe, expect, it } from "vitest";
import { VERSION } from "../src/version";
import pkg from "../package.json";

describe("version", () => {
  it("advertised serverInfo version matches package.json (no npm drift)", () => {
    expect(VERSION).toBe(pkg.version);
  });

  it("is not the hardcoded 0.1.0 that this file exists to prevent", () => {
    // Regression pin: "0.1.0" was advertised for six minor versions and was never
    // even a published release (npm goes 0.1.2, 0.2.0, 0.3.0, 0.4.0, 0.6.1).
    expect(VERSION).not.toBe("0.1.0");
  });
});
