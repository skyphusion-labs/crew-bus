import { describe, expect, it } from "vitest";
import { BusError, clientErrorMessage } from "../src/bus-error";

describe("BusError", () => {
  it("marks client-safe validation errors", () => {
    const err = new BusError("invalid channel: foo");
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("invalid channel: foo");
  });
});

describe("clientErrorMessage", () => {
  it("returns message for BusError", () => {
    expect(clientErrorMessage(new BusError("body is required"))).toBe("body is required");
  });

  it("returns null for unexpected errors", () => {
    expect(clientErrorMessage(new Error("D1 internal failure"))).toBeNull();
    expect(clientErrorMessage("boom")).toBeNull();
  });
});
