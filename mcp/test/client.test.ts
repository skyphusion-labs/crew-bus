import { afterEach, describe, expect, it, vi } from "vitest";
import { CrewBusClient } from "../src/client";

function okResponse(): Response {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("CrewBusClient ack dedup (#22)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("collapses repeated acks for one message onto a single request", async () => {
    const fetchMock = vi.fn(async () => okResponse());
    vi.stubGlobal("fetch", fetchMock);

    const client = new CrewBusClient("https://bus.example", "tok");
    // Three concurrent acks + one sequential repeat: still one HTTP call.
    await Promise.all([client.ack("msg_1"), client.ack("msg_1"), client.ack("msg_1")]);
    await client.ack("msg_1");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // A different message still reaches the network.
    await client.ack("msg_2");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("allows a genuine retry after a failed ack", async () => {
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error("network down");
      return okResponse();
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new CrewBusClient("https://bus.example", "tok");
    await expect(client.ack("msg_x")).rejects.toThrow();
    await expect(client.ack("msg_x")).resolves.toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
