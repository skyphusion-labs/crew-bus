import { describe, expect, it } from "vitest";
import { VERSION } from "../src/version";
import pkg from "../package.json";

describe("version", () => {
  it("served version matches package.json (no /health drift)", () => {
    expect(VERSION).toBe(pkg.version);
  });
});
