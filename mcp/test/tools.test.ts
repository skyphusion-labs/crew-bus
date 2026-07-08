import { describe, expect, it } from "vitest";
import { TOOLS } from "../src/tools";

describe("TOOLS", () => {
  it("exposes the five v1 bus tools", () => {
    expect(TOOLS.map((t) => t.name).sort()).toEqual([
      "bus_ack",
      "bus_channels",
      "bus_poll",
      "bus_send",
      "bus_thread",
    ]);
  });
});
