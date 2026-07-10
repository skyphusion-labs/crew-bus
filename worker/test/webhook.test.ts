import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import {
  deleteWebhook,
  fireWebhooks,
  getThread,
  getWebhook,
  getWebhookView,
  listConsumers,
  sendMessage,
  setWebhook,
} from "../src/store";
import { makeFakeD1, type FakeD1State } from "./fake-d1";

function freshState(): FakeD1State {
  return { messages: [], cursors: [], acks: [], consumers: [], webhook_endpoints: [], webhook_deliveries: [] };
}

// Recompute the expected signature exactly as the store does, to assert the
// header is a real HMAC over timestamp + "." + rawBody (not a stub).
async function hmacHex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const noSleep = async () => {};

describe("webhook registry (#26)", () => {
  it("rejects a non-https url", async () => {
    const db = makeFakeD1(freshState());
    await expect(
      setWebhook(db, "albini", { url: "http://recv.example/hook", secret: "fake" }),
    ).rejects.toThrow(/https/);
    await expect(
      setWebhook(db, "albini", { url: "not-a-url", secret: "fake" }),
    ).rejects.toThrow(/https/);
  });

  it("registers, masks the secret in the view, and never exposes the value", async () => {
    const db = makeFakeD1(freshState());
    const view = await setWebhook(db, "albini", {
      url: "https://recv.example/hook",
      secret: "super-fake-secret",
      auth_env: "ALBINI_AUTH",
    });
    expect(view).toMatchObject({
      consumer: "albini",
      url: "https://recv.example/hook",
      auth_env: "ALBINI_AUTH",
      enabled: true,
      secret_set: true,
    });
    // The secret VALUE must not appear anywhere in the caller-safe view.
    expect(JSON.stringify(view)).not.toContain("super-fake-secret");
    expect((view as unknown as Record<string, unknown>).secret).toBeUndefined();

    const got = await getWebhookView(db, "albini");
    expect(got).toMatchObject({ consumer: "albini", secret_set: true });
    expect(JSON.stringify(got)).not.toContain("super-fake-secret");
    // The internal getter DOES carry the secret (needed for signing).
    const internal = await getWebhook(db, "albini");
    expect(internal!.secret).toBe("super-fake-secret");
  });

  it("replace preserves created_at and bumps updated_at", async () => {
    const db = makeFakeD1(freshState());
    const first = await setWebhook(db, "albini", { url: "https://a.example/1", secret: "fake" });
    await new Promise((r) => setTimeout(r, 2));
    const second = await setWebhook(db, "albini", {
      url: "https://a.example/2",
      secret: "fake2",
      enabled: false,
    });
    expect(second.created_at).toBe(first.created_at);
    expect(second.updated_at >= first.updated_at).toBe(true);
    expect(second.url).toBe("https://a.example/2");
    expect(second.enabled).toBe(false);
  });

  it("delete removes the row (own-row lifecycle)", async () => {
    const db = makeFakeD1(freshState());
    await setWebhook(db, "albini", { url: "https://a.example/h", secret: "fake" });
    expect(await getWebhookView(db, "albini")).not.toBeNull();
    await deleteWebhook(db, "albini");
    expect(await getWebhookView(db, "albini")).toBeNull();
  });

  it("rows are per-consumer: one consumer cannot see or clobber another (#26 own-row)", async () => {
    const db = makeFakeD1(freshState());
    await setWebhook(db, "albini", { url: "https://a.example/h", secret: "fake-a" });
    await setWebhook(db, "mackaye", { url: "https://m.example/h", secret: "fake-m" });
    expect((await getWebhookView(db, "albini"))!.url).toBe("https://a.example/h");
    expect((await getWebhookView(db, "mackaye"))!.url).toBe("https://m.example/h");
    // Deleting one leaves the other intact.
    await deleteWebhook(db, "albini");
    expect(await getWebhookView(db, "albini")).toBeNull();
    expect(await getWebhookView(db, "mackaye")).not.toBeNull();
  });

  it("bus_consumers webhook flag: true only when registered AND enabled", async () => {
    const db = makeFakeD1(freshState());
    const roster = ["mackaye", "albini", "strummer"];
    await setWebhook(db, "albini", { url: "https://a.example/h", secret: "fake" });
    await setWebhook(db, "strummer", { url: "https://s.example/h", secret: "fake", enabled: false });

    const consumers = await listConsumers(db, roster);
    const flag = (n: string) => consumers.find((c) => c.name === n)!.webhook;
    expect(flag("albini")).toBe(true);
    expect(flag("strummer")).toBe(false); // registered but disabled
    expect(flag("mackaye")).toBe(false); // not registered
  });
});

describe("webhook firing (#26)", () => {
  it("fires a signed, body-less doorbell to an enabled recipient, minus the sender", async () => {
    const state = freshState();
    const db = makeFakeD1(state);
    const roster = ["mackaye", "albini"];
    await setWebhook(db, "albini", { url: "https://recv.example/hook", secret: "sign-key-fake" });
    // mackaye also has an endpoint, but is the sender -> must NOT be rung.
    await setWebhook(db, "mackaye", { url: "https://self.example/hook", secret: "fake" });

    const captured: { url: string; init: RequestInit }[] = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      captured.push({ url, init });
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;

    const msg = await sendMessage(
      db,
      "mackaye",
      { channel: "general", to: ["*"], type: "status", body: "heads up" },
      roster,
    );
    await fireWebhooks({ DB: db } as unknown as Env, msg, roster, { fetchImpl, sleep: noSleep });

    // Only albini rung (sender mackaye excluded even with an endpoint).
    expect(captured).toHaveLength(1);
    expect(captured[0]!.url).toBe("https://recv.example/hook");

    const headers = captured[0]!.init.headers as Record<string, string>;
    const rawBody = String(captured[0]!.init.body);
    const payload = JSON.parse(rawBody);
    // Doorbell only: NO message body ever.
    expect(payload).toEqual({
      message_id: msg.id,
      channel: "general",
      thread_id: msg.thread_id,
      sent_at: msg.created_at,
    });
    expect(payload.body).toBeUndefined();

    expect(headers["X-Bus-Consumer"]).toBe("albini");
    expect(/^[0-9]+$/.test(headers["X-Bus-Timestamp"]!)).toBe(true);
    const expected = `sha256=${await hmacHex("sign-key-fake", `${headers["X-Bus-Timestamp"]}.${rawBody}`)}`;
    expect(headers["X-Bus-Signature"]).toBe(expected);
    // No auth_env configured -> no Authorization header.
    expect(headers["Authorization"]).toBeUndefined();

    // Delivery recorded: one attempt, 2xx, delivered_at set.
    expect(state.webhook_deliveries).toHaveLength(1);
    expect(state.webhook_deliveries![0]).toMatchObject({
      message_id: msg.id,
      consumer: "albini",
      attempts: 1,
      last_status: 204,
    });
    expect(state.webhook_deliveries![0]!.delivered_at).not.toBeNull();
  });

  it("adds Authorization from auth_env when the binding exists; skips it (still fires) when missing", async () => {
    const db = makeFakeD1(freshState());
    const roster = ["mackaye", "albini"];
    await setWebhook(db, "albini", {
      url: "https://recv.example/hook",
      secret: "fake",
      auth_env: "RECV_AUTH",
    });

    const runs: Record<string, string>[] = [];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      runs.push(init.headers as Record<string, string>);
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;

    const msg = await sendMessage(
      db,
      "mackaye",
      { channel: "general", to: ["albini"], type: "status", body: "x" },
      roster,
    );

    // Binding present -> Authorization sent verbatim.
    await fireWebhooks(
      { DB: db, RECV_AUTH: "Bearer fake-trigger-token" } as unknown as Env,
      msg,
      roster,
      { fetchImpl, sleep: noSleep },
    );
    expect(runs[0]!["Authorization"]).toBe("Bearer fake-trigger-token");

    // Binding absent -> header skipped, but the doorbell still fires.
    await fireWebhooks({ DB: db } as unknown as Env, msg, roster, { fetchImpl, sleep: noSleep });
    expect(runs).toHaveLength(2);
    expect(runs[1]!["Authorization"]).toBeUndefined();
  });

  it("does not fire a disabled endpoint", async () => {
    const db = makeFakeD1(freshState());
    const roster = ["mackaye", "albini"];
    await setWebhook(db, "albini", { url: "https://recv.example/hook", secret: "fake", enabled: false });
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch;
    const msg = await sendMessage(
      db,
      "mackaye",
      { channel: "general", to: ["albini"], type: "status", body: "x" },
      roster,
    );
    await fireWebhooks({ DB: db } as unknown as Env, msg, roster, { fetchImpl, sleep: noSleep });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("retries up to 3 attempts on non-2xx, records attempts + last_status, delivered_at null", async () => {
    const state = freshState();
    const db = makeFakeD1(state);
    const roster = ["mackaye", "albini"];
    await setWebhook(db, "albini", { url: "https://recv.example/hook", secret: "fake" });
    const fetchImpl = vi.fn(async () => new Response(null, { status: 500 })) as unknown as typeof fetch;
    const msg = await sendMessage(
      db,
      "mackaye",
      { channel: "general", to: ["albini"], type: "status", body: "x" },
      roster,
    );
    await fireWebhooks({ DB: db } as unknown as Env, msg, roster, { fetchImpl, sleep: noSleep });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(state.webhook_deliveries![0]).toMatchObject({ attempts: 3, last_status: 500 });
    expect(state.webhook_deliveries![0]!.delivered_at).toBeNull();
  });

  it("stops retrying once a 2xx lands (success on the second attempt)", async () => {
    const state = freshState();
    const db = makeFakeD1(state);
    const roster = ["mackaye", "albini"];
    await setWebhook(db, "albini", { url: "https://recv.example/hook", secret: "fake" });
    let n = 0;
    const fetchImpl = vi.fn(async () => {
      n += 1;
      return new Response(null, { status: n === 1 ? 503 : 200 });
    }) as unknown as typeof fetch;
    const msg = await sendMessage(
      db,
      "mackaye",
      { channel: "general", to: ["albini"], type: "status", body: "x" },
      roster,
    );
    await fireWebhooks({ DB: db } as unknown as Env, msg, roster, { fetchImpl, sleep: noSleep });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(state.webhook_deliveries![0]).toMatchObject({ attempts: 2, last_status: 200 });
    expect(state.webhook_deliveries![0]!.delivered_at).not.toBeNull();
  });

  it("a throwing fetch never breaks the send path (records network error status 0)", async () => {
    const state = freshState();
    const db = makeFakeD1(state);
    const roster = ["mackaye", "albini"];
    await setWebhook(db, "albini", { url: "https://recv.example/hook", secret: "fake" });
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const msg = await sendMessage(
      db,
      "mackaye",
      { channel: "general", to: ["albini"], type: "status", body: "x" },
      roster,
    );
    // The invariant: fireWebhooks resolves, never rejects.
    await expect(
      fireWebhooks({ DB: db } as unknown as Env, msg, roster, { fetchImpl, sleep: noSleep }),
    ).resolves.toBeUndefined();
    expect(state.webhook_deliveries![0]).toMatchObject({ attempts: 3, last_status: 0 });
    expect(state.webhook_deliveries![0]!.delivered_at).toBeNull();
  });

  it("bus_thread delivery report joins webhook_delivered_at + webhook_attempts (#26)", async () => {
    const db = makeFakeD1(freshState());
    const roster = ["mackaye", "albini"];
    await setWebhook(db, "albini", { url: "https://recv.example/hook", secret: "fake" });
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch;

    const msg = await sendMessage(
      db,
      "mackaye",
      { channel: "vivijure", to: ["albini"], type: "handoff", body: "pick up", requires_ack: true },
      roster,
    );
    await fireWebhooks({ DB: db } as unknown as Env, msg, roster, { fetchImpl, sleep: noSleep });

    const thread = await getThread(db, msg.thread_id, "mackaye", roster);
    const delivery = thread.find((m) => m.id === msg.id)!.delivery!;
    expect(delivery).toHaveLength(1);
    expect(delivery[0]!.recipient).toBe("albini");
    expect(delivery[0]!.webhook_attempts).toBe(1);
    expect(delivery[0]!.webhook_delivered_at).not.toBeNull();
    // The webhook fields sit alongside the existing ack/poll signals.
    expect(delivery[0]!.acked_at).toBeNull();
  });

  it("a recipient without an endpoint yields webhook_attempts 0 in the report", async () => {
    const db = makeFakeD1(freshState());
    const roster = ["mackaye", "albini"];
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch;
    const msg = await sendMessage(
      db,
      "mackaye",
      { channel: "general", to: ["albini"], type: "status", body: "x" },
      roster,
    );
    await fireWebhooks({ DB: db } as unknown as Env, msg, roster, { fetchImpl, sleep: noSleep });
    expect(fetchImpl).not.toHaveBeenCalled();

    const thread = await getThread(db, msg.thread_id, "mackaye", roster);
    const delivery = thread.find((m) => m.id === msg.id)!.delivery!;
    expect(delivery[0]).toMatchObject({ recipient: "albini", webhook_attempts: 0, webhook_delivered_at: null });
  });
});
