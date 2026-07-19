import { describe, expect, it } from "vitest";
import { DOORBELL_STALE_MIN_AGE_MS, DOORBELL_STALE_MIN_RINGS } from "../src/bus-types";
import { listConsumers, recordPoll, setWebhook } from "../src/store";
import { makeFakeD1, type FakeD1State } from "./fake-d1";

// #47: a ring returning 2xx proves it was WRITTEN, not that anything READ it.
// These tests pin the boundaries of the delivered-but-never-consumed predicate.

const ROSTER = ["mackaye", "albini", "strummer"];

function freshState(): FakeD1State {
  return {
    messages: [],
    cursors: [],
    acks: [],
    consumers: [],
    webhook_endpoints: [],
    webhook_deliveries: [],
  };
}

/** ISO timestamp `minutes` in the past. */
function ago(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

const STALE_AGE_MIN = DOORBELL_STALE_MIN_AGE_MS / 60_000; // 15

/** Append `n` delivered rings for `consumer`, oldest at `oldestMinutesAgo`. */
function rings(state: FakeD1State, consumer: string, n: number, oldestMinutesAgo: number): void {
  for (let i = 0; i < n; i++) {
    state.webhook_deliveries!.push({
      message_id: `msg_${consumer}_${oldestMinutesAgo}_${i}`,
      consumer,
      // Each successive ring is one minute newer than the last.
      delivered_at: ago(oldestMinutesAgo - i),
      attempts: 1,
      last_status: 204,
    });
  }
}

async function statusOf(state: FakeD1State, name: string, register = true) {
  const db = makeFakeD1(state);
  if (register) {
    await setWebhook(db, name, { url: `https://${name}.example/h`, secret: "fake-fixture" });
  }
  const consumers = await listConsumers(db, ROSTER);
  return consumers.find((c) => c.name === name)!;
}

describe("doorbell reader health (#47)", () => {
  it("quiet channel: zero rings is never a fault", async () => {
    const state = freshState();
    const db = makeFakeD1(state);
    await setWebhook(db, "mackaye", { url: "https://m.example/h", secret: "fake-fixture" });
    await recordPoll(db, "mackaye");

    const c = (await listConsumers(db, ROSTER)).find((x) => x.name === "mackaye")!;
    expect(c.webhook).toBe(true);
    expect(c.last_ring_delivered_at).toBeNull();
    expect(c.undelivered_to_reader).toBe(0);
    expect(c.oldest_undelivered_ring_at).toBeNull();
    expect(c.doorbell_stale).toBe(false);
  });

  it("a single old unconsumed ring does not fire (below the ring floor)", async () => {
    const state = freshState();
    rings(state, "mackaye", 1, 120);

    const c = await statusOf(state, "mackaye");
    expect(c.undelivered_to_reader).toBe(1);
    expect(c.doorbell_stale).toBe(false);
  });

  it("one below the ring floor does not fire, at the floor does", async () => {
    const under = freshState();
    rings(under, "mackaye", DOORBELL_STALE_MIN_RINGS - 1, 120);
    expect((await statusOf(under, "mackaye")).doorbell_stale).toBe(false);

    const at = freshState();
    rings(at, "mackaye", DOORBELL_STALE_MIN_RINGS, 120);
    const c = await statusOf(at, "mackaye");
    expect(c.undelivered_to_reader).toBe(DOORBELL_STALE_MIN_RINGS);
    expect(c.doorbell_stale).toBe(true);
  });

  it("N rings inside one turn do not fire: the age term holds them", async () => {
    // Three rings, oldest 2 minutes ago. Count is met, age is not.
    const state = freshState();
    rings(state, "mackaye", 3, 2);

    const c = await statusOf(state, "mackaye");
    expect(c.undelivered_to_reader).toBe(3);
    expect(c.doorbell_stale).toBe(false);
  });

  it("crosses from healthy to stale as the oldest ring ages past the window", async () => {
    const young = freshState();
    rings(young, "mackaye", 3, STALE_AGE_MIN - 1); // oldest 14 min ago
    expect((await statusOf(young, "mackaye")).doorbell_stale).toBe(false);

    const old = freshState();
    rings(old, "mackaye", 3, STALE_AGE_MIN + 1); // oldest 16 min ago
    expect((await statusOf(old, "mackaye")).doorbell_stale).toBe(true);
  });

  it("the incident shape: many delivered rings, nothing reading, reads stale", async () => {
    const state = freshState();
    rings(state, "mackaye", 20, 600);

    const c = await statusOf(state, "mackaye");
    expect(c.webhook).toBe(true); // every legacy signal still green
    expect(c.last_ring_delivered_at).not.toBeNull();
    expect(c.last_message_consumed_at).toBeNull(); // and yet: never read anything
    expect(c.undelivered_to_reader).toBe(20);
    // Nothing was ever read, so the oldest unconsumed ring IS the first ring.
    expect(c.oldest_undelivered_ring_at).toBe(state.webhook_deliveries![0].delivered_at);
    expect(c.oldest_undelivered_ring_at! < c.last_ring_delivered_at!).toBe(true);
    expect(c.doorbell_stale).toBe(true);
  });

  it("a consumer that resumes polling clears immediately", async () => {
    const state = freshState();
    rings(state, "mackaye", 5, 120);
    const db = makeFakeD1(state);
    await setWebhook(db, "mackaye", { url: "https://m.example/h", secret: "fake-fixture" });

    const before = (await listConsumers(db, ROSTER)).find((c) => c.name === "mackaye")!;
    expect(before.doorbell_stale).toBe(true);
    expect(before.undelivered_to_reader).toBe(5);

    await recordPoll(db, "mackaye"); // the session comes back and reads

    const after = (await listConsumers(db, ROSTER)).find((c) => c.name === "mackaye")!;
    expect(after.undelivered_to_reader).toBe(0);
    expect(after.oldest_undelivered_ring_at).toBeNull();
    expect(after.doorbell_stale).toBe(false);
    // The delivery history itself is untouched; only the watermark moved.
    expect(after.last_ring_delivered_at).toBe(before.last_ring_delivered_at);
  });

  it("only rings NEWER than the last read count as unconsumed", async () => {
    const state = freshState();
    rings(state, "mackaye", 3, 120); // 120, 119, 118 min ago -- before the poll
    state.consumers.push({ name: "mackaye", last_poll_at: ago(60) });
    rings(state, "mackaye", 4, 30); // 30, 29, 28, 27 min ago -- after the poll

    const c = await statusOf(state, "mackaye");
    expect(c.last_message_consumed_at).toBe(state.consumers[0].last_poll_at);
    expect(c.undelivered_to_reader).toBe(4);
    expect(c.doorbell_stale).toBe(true);
  });

  it("an ack counts as consumption, not just a poll", async () => {
    const state = freshState();
    rings(state, "mackaye", 4, 120);
    // No poll row at all; the only evidence of reading is an ack.
    state.acks.push({
      message_id: "msg_x",
      from_consumer: "mackaye",
      body: null,
      created_at: ago(5),
    });

    const c = await statusOf(state, "mackaye");
    expect(c.last_poll_at).toBeNull();
    expect(c.last_message_consumed_at).toBe(state.acks[0].created_at);
    expect(c.undelivered_to_reader).toBe(0);
    expect(c.doorbell_stale).toBe(false);
  });

  it("the consumption watermark is the LATER of poll and ack", async () => {
    const state = freshState();
    state.consumers.push({ name: "mackaye", last_poll_at: ago(90) });
    state.acks.push({
      message_id: "msg_x",
      from_consumer: "mackaye",
      body: null,
      created_at: ago(200),
    });
    rings(state, "mackaye", 3, 150); // between the ack and the poll: all consumed

    const c = await statusOf(state, "mackaye");
    expect(c.last_message_consumed_at).toBe(state.consumers[0].last_poll_at);
    expect(c.undelivered_to_reader).toBe(0);
    expect(c.doorbell_stale).toBe(false);
  });

  it("a poll-only consumer never reads stale: no doorbell to be broken", async () => {
    // Deliveries exist from a doorbell that was later cleared or disabled.
    const state = freshState();
    rings(state, "mackaye", 10, 600);

    const unregistered = await statusOf(state, "mackaye", false);
    expect(unregistered.webhook).toBe(false);
    expect(unregistered.undelivered_to_reader).toBe(10); // still reported, honestly
    expect(unregistered.doorbell_stale).toBe(false); // but not a doorbell fault

    const db = makeFakeD1(state);
    await setWebhook(db, "mackaye", {
      url: "https://m.example/h",
      secret: "fake-fixture",
      enabled: false,
    });
    const disabled = (await listConsumers(db, ROSTER)).find((c) => c.name === "mackaye")!;
    expect(disabled.doorbell_stale).toBe(false);
  });

  it("staleness is per consumer: one dead reader does not taint the roster", async () => {
    const state = freshState();
    rings(state, "mackaye", 6, 120); // dead reader
    rings(state, "albini", 6, 120); // same rings, but albini keeps reading
    state.consumers.push({ name: "albini", last_poll_at: ago(1) });

    const db = makeFakeD1(state);
    await setWebhook(db, "mackaye", { url: "https://m.example/h", secret: "fake-fixture" });
    await setWebhook(db, "albini", { url: "https://a.example/h", secret: "fake-fixture" });
    const consumers = await listConsumers(db, ROSTER);
    const by = (n: string) => consumers.find((c) => c.name === n)!;

    expect(by("mackaye").doorbell_stale).toBe(true);
    expect(by("albini").doorbell_stale).toBe(false);
    expect(by("albini").undelivered_to_reader).toBe(0);
    // strummer has no rings and no doorbell at all.
    expect(by("strummer").doorbell_stale).toBe(false);
    expect(by("strummer").last_ring_delivered_at).toBeNull();
  });

  it("a ring that never got a 2xx is not counted as delivered", async () => {
    const state = freshState();
    rings(state, "mackaye", 3, 120);
    // Two rings that exhausted their attempts: delivered_at stays null.
    for (let i = 0; i < 2; i++) {
      state.webhook_deliveries!.push({
        message_id: `msg_failed_${i}`,
        consumer: "mackaye",
        delivered_at: null,
        attempts: 3,
        last_status: 0,
      });
    }

    const c = await statusOf(state, "mackaye");
    // Only the three delivered rings count. A ring that never landed is a
    // TRANSPORT failure, already visible in the thread delivery report; this
    // signal is strictly about rings that DID land and were never read.
    expect(c.undelivered_to_reader).toBe(3);
  });
});
