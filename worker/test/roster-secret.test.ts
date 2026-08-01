// fleet-chezmoi #1070: MCP_TOKEN_EXTRA is an ADDITIVE second roster secret.
// Fixtures use obvious fakes; no real token value appears here or anywhere.
import { describe, expect, it, vi } from "vitest";
import { consumerNames, matchConsumer, rosterSecret } from "../src/auth";

const BASE = "mackaye=fake-base-mackaye,strummer=fake-base-strummer";
const EXTRA = "mackaye-fleet=fake-extra-fleet,mackaye-vivijure=fake-extra-vivijure";

describe("rosterSecret", () => {
  it("EXTRA absent behaves exactly as MCP_TOKEN alone", () => {
    // The regression that matters: today's deployed state must not change.
    expect(rosterSecret({ MCP_TOKEN: BASE })).toBe(BASE);
    expect(consumerNames(rosterSecret({ MCP_TOKEN: BASE })).sort()).toEqual(
      consumerNames(BASE).sort(),
    );
    expect(matchConsumer(rosterSecret({ MCP_TOKEN: BASE }), "fake-base-mackaye")).toBe("mackaye");
    expect(matchConsumer(rosterSecret({ MCP_TOKEN: BASE }), "fake-extra-fleet")).toBeNull();
  });

  it("both secrets absent yields an empty roster, not a throw", () => {
    expect(rosterSecret({})).toBe("");
    expect(consumerNames(rosterSecret({}))).toEqual([]);
    expect(matchConsumer(rosterSecret({}), "fake-base-mackaye")).toBeNull();
  });

  it("EXTRA present is additive: both secrets authenticate, neither displaces the other", () => {
    const secret = rosterSecret({ MCP_TOKEN: BASE, MCP_TOKEN_EXTRA: EXTRA });
    expect(consumerNames(secret).sort()).toEqual([
      "mackaye",
      "mackaye-fleet",
      "mackaye-vivijure",
      "strummer",
    ]);
    // pre-existing consumers keep working
    expect(matchConsumer(secret, "fake-base-mackaye")).toBe("mackaye");
    expect(matchConsumer(secret, "fake-base-strummer")).toBe("strummer");
    // new consumers work
    expect(matchConsumer(secret, "fake-extra-fleet")).toBe("mackaye-fleet");
    expect(matchConsumer(secret, "fake-extra-vivijure")).toBe("mackaye-vivijure");
  });

  it("EXTRA alone (no MCP_TOKEN) still forms a valid roster", () => {
    const secret = rosterSecret({ MCP_TOKEN_EXTRA: EXTRA });
    expect(matchConsumer(secret, "fake-extra-fleet")).toBe("mackaye-fleet");
    expect(consumerNames(secret).sort()).toEqual(["mackaye-fleet", "mackaye-vivijure"]);
  });

  it("empty / whitespace EXTRA does not corrupt the roster with a trailing comma", () => {
    for (const extra of ["", "   ", "\t\n ", ","]) {
      const secret = rosterSecret({ MCP_TOKEN: BASE, MCP_TOKEN_EXTRA: extra });
      expect(consumerNames(secret).sort()).toEqual(["mackaye", "strummer"]);
      expect(matchConsumer(secret, "fake-base-mackaye")).toBe("mackaye");
    }
    // whitespace-only EXTRA must not even reach the join
    expect(rosterSecret({ MCP_TOKEN: BASE, MCP_TOKEN_EXTRA: "   " })).toBe(BASE);
  });

  it("empty / whitespace MCP_TOKEN with a real EXTRA does not corrupt the roster", () => {
    const secret = rosterSecret({ MCP_TOKEN: "  ", MCP_TOKEN_EXTRA: EXTRA });
    expect(secret).toBe(EXTRA);
    expect(matchConsumer(secret, "fake-extra-fleet")).toBe("mackaye-fleet");
  });
});

describe("duplicate-name guard (#1070)", () => {
  it("a name in BOTH secrets cannot be authenticated by the EXTRA token", () => {
    // THE defect this issue exists to fix, one layer down: matchConsumer returns
    // the FIRST match, so without a guard two different tokens both resolve to the
    // same consumer identity -- exactly the identity collapse being removed.
    const collide = "mackaye=fake-collide-token,other=fake-other";
    const secret = rosterSecret({ MCP_TOKEN: BASE, MCP_TOKEN_EXTRA: collide });

    // MCP_TOKEN wins the collision: its token still authenticates.
    expect(matchConsumer(secret, "fake-base-mackaye")).toBe("mackaye");
    // The colliding EXTRA token must NOT authenticate as anyone.
    expect(matchConsumer(secret, "fake-collide-token")).toBeNull();
    // Non-colliding entries in the SAME EXTRA secret are unaffected.
    expect(matchConsumer(secret, "fake-other")).toBe("other");
    expect(matchConsumer(secret, "fake-base-strummer")).toBe("strummer");
  });

  it("the collision is surfaced loudly, by NAME only", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const collide = "mackaye=fake-collide-token";
      matchConsumer(rosterSecret({ MCP_TOKEN: BASE, MCP_TOKEN_EXTRA: collide }), "no-such-token");
      expect(warn).toHaveBeenCalled();
      const logged = warn.mock.calls.map((c) => JSON.stringify(c)).join(" ");
      expect(logged).toContain("consumer_name_collision");
      expect(logged).toContain("mackaye");
      // a token VALUE must never reach a log line
      expect(logged).not.toContain("fake-collide-token");
      expect(logged).not.toContain("fake-base-mackaye");
    } finally {
      warn.mockRestore();
    }
  });

  it("no collision means no warning (positive control that the warn is conditional)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      matchConsumer(rosterSecret({ MCP_TOKEN: BASE, MCP_TOKEN_EXTRA: EXTRA }), "fake-extra-fleet");
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("a duplicate name WITHIN one secret is deduped the same way", () => {
    const secret = rosterSecret({ MCP_TOKEN: "a=fake-one,a=fake-two" });
    expect(matchConsumer(secret, "fake-one")).toBe("a");
    expect(matchConsumer(secret, "fake-two")).toBeNull();
    expect(consumerNames(secret)).toEqual(["a"]);
  });
});
