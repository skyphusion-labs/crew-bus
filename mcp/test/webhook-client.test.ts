import { afterEach, describe, expect, it, vi } from "vitest";
import { CrewBusClient } from "../src/client";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("CrewBusClient webhook methods (#26)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("maps webhookSet/get/clear to PUT/GET/DELETE /api/webhook", async () => {
    const calls: { method: string; url: string; body?: string }[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({
        method: String(init?.method),
        url: String(url),
        body: init?.body ? String(init.body) : undefined,
      });
      return jsonResponse({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new CrewBusClient("https://bus.example", "tok");
    await client.webhookSet({ url: "https://recv.example/hook", secret: "fake-secret" });
    await client.webhookGet();
    await client.webhookClear();

    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "PUT https://bus.example/api/webhook",
      "GET https://bus.example/api/webhook",
      "DELETE https://bus.example/api/webhook",
    ]);
    // The consumer is never sent in the body: the server keys on the bearer.
    expect(JSON.parse(calls[0]!.body!)).toEqual({
      url: "https://recv.example/hook",
      secret: "fake-secret",
    });
  });
  it("forwards a vpc target verbatim to PUT /api/webhook (#40)", async () => {
    const calls: { method: string; url: string; body?: string }[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({
        method: String(init?.method),
        url: String(url),
        body: init?.body ? String(init.body) : undefined,
      });
      return jsonResponse({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new CrewBusClient("https://bus.example", "tok");
    await client.webhookSet({ vpc: { binding: "DISCHORD_DOORBELL_VPC" }, secret: "fake-secret" });

    expect(calls[0]!.method).toBe("PUT");
    expect(calls[0]!.url).toBe("https://bus.example/api/webhook");
    // The vpc target is forwarded untouched; the server validates + keys on the bearer.
    expect(JSON.parse(calls[0]!.body!)).toEqual({
      vpc: { binding: "DISCHORD_DOORBELL_VPC" },
      secret: "fake-secret",
    });
  });
});
