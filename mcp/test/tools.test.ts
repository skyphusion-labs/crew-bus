import { describe, expect, it } from "vitest";
import { TOOLS } from "../src/tools";

describe("TOOLS", () => {
  it("exposes the bus tools", () => {
    expect(TOOLS.map((t) => t.name).sort()).toEqual([
      "bus_ack",
      "bus_channels",
      "bus_claim",
      "bus_consumers",
      "bus_mark_seen",
      "bus_poll",
      "bus_send",
      "bus_thread",
      "bus_webhook_clear",
      "bus_webhook_get",
      "bus_webhook_set",
    ]);
  });
});
