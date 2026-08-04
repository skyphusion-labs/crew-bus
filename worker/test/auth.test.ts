import { describe, expect, it } from "vitest";
import { consumerNames, matchConsumer } from "../src/auth";
import { isVisibleTo, retentionCutoff } from "../src/bus-types";

describe("matchConsumer", () => {
  it("matches name=token entries", () => {
    const secret = "conrad=abc,mackaye=def";
    expect(matchConsumer(secret, "abc")).toBe("conrad");
    expect(matchConsumer(secret, "def")).toBe("mackaye");
    expect(matchConsumer(secret, "nope")).toBeNull();
  });

  it("returns null when secret unset", () => {
    expect(matchConsumer(undefined, "abc")).toBeNull();
  });
});

describe("consumerNames", () => {
  it("returns the roster names without token values", () => {
    expect(consumerNames("conrad=abc,mackaye=def").sort()).toEqual(["conrad", "mackaye"]);
  });

  it("is empty when the secret is unset", () => {
    expect(consumerNames(undefined)).toEqual([]);
  });
});

describe("isVisibleTo", () => {
  it("broadcasts to all consumers", () => {
    expect(isVisibleTo(["*"], "strummer")).toBe(true);
  });

  it("respects explicit recipients", () => {
    expect(isVisibleTo(["conrad"], "conrad")).toBe(true);
    expect(isVisibleTo(["conrad"], "mackaye")).toBe(false);
  });
});

describe("retentionCutoff", () => {
  it("defaults to 30 days", () => {
    const cutoff = retentionCutoff({});
    const diff = Date.now() - Date.parse(cutoff);
    expect(diff).toBeGreaterThan(29 * 86400_000);
    expect(diff).toBeLessThan(31 * 86400_000);
  });
});
