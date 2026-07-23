import { describe, expect, it } from "vitest";
import { markChannelSeenLatest, pollMessages, sendMessage } from "../src/store";
import { makeFakeD1, type FakeD1State, type MessageRow } from "./fake-d1";

// #37 regression: bus_poll pinned to the oldest-unread page. The cursors table
// IS the consumer poll cursor: a poll WITHOUT since resumes from it, every poll
// advances it (forward-only), and bus_mark_seen advances it too. Pre-fix, a
// consumer with a >limit backlog re-read page 1 forever and went blind to new
// traffic (live: fc#660 rancid drill, 2026-07-17 -- two real messages never
// surfaced behind a 50-message backlog).

function backlogRow(i: number, createdAt: string, channel = "general"): MessageRow {
  return {
    id: `msg_backlog${String(i).padStart(3, "0")}`,
    channel,
    thread_id: "thr_backlog",
    from_consumer: "strummer",
    to_json: JSON.stringify(["mackaye"]),
    type: "status",
    priority: "normal",
    body: `backlog ${i}`,
    refs_json: null,
    requires_ack: 0,
    ack_of: null,
    created_at: createdAt,
  };
}

function isoAt(base: number, i: number): string {
  return new Date(base + i * 1000).toISOString();
}

describe("poll cursor (#37)", () => {
  it("successive no-since polls page forward through a >limit backlog (drill replay)", async () => {
    const base = Date.parse("2026-07-10T15:00:00.000Z");
    const state: FakeD1State = { messages: [], cursors: [], acks: [], consumers: [] };
    for (let i = 0; i < 55; i++) state.messages.push(backlogRow(i, isoAt(base, i)));
    // The two live drill messages, behind the backlog.
    state.messages.push(backlogRow(100, "2026-07-17T18:45:59.000Z"));
    state.messages.push(backlogRow(101, "2026-07-17T18:47:09.000Z"));
    const db = makeFakeD1(state);

    const first = await pollMessages(db, "mackaye", {});
    expect(first.messages).toHaveLength(50);
    expect(first.messages[0]!.body).toBe("backlog 0");

    // Pre-fix this returned the IDENTICAL page 1 again; the two drill messages
    // never surfaced.
    const second = await pollMessages(db, "mackaye", {});
    expect(second.messages.map((m) => m.body)).toEqual([
      "backlog 50",
      "backlog 51",
      "backlog 52",
      "backlog 53",
      "backlog 54",
      "backlog 100",
      "backlog 101",
    ]);

    const third = await pollMessages(db, "mackaye", {});
    expect(third.messages).toHaveLength(0);
  });

  it("channel-scoped no-since polls advance through the backlog", async () => {
    const db = makeFakeD1();
    for (let i = 0; i < 3; i++) {
      await sendMessage(db, "strummer", {
        channel: "vivijure",
        to: ["mackaye"],
        type: "status",
        body: `msg ${i}`,
      });
      await new Promise((r) => setTimeout(r, 2));
    }

    const seen: string[] = [];
    for (let round = 0; round < 3; round++) {
      const page = await pollMessages(db, "mackaye", { channel: "vivijure", limit: 1 });
      seen.push(...page.messages.map((m) => m.body));
    }
    expect(seen).toEqual(["msg 0", "msg 1", "msg 2"]);
  });

  it("bus_mark_seen advances the poll cursor", async () => {
    const db = makeFakeD1();
    await sendMessage(db, "strummer", { channel: "fleet", to: ["mackaye"], type: "status", body: "old fleet" });
    await new Promise((r) => setTimeout(r, 2));
    await sendMessage(db, "strummer", { channel: "general", to: ["mackaye"], type: "status", body: "old general" });
    await new Promise((r) => setTimeout(r, 2));

    await markChannelSeenLatest(db, "mackaye", "fleet");
    await markChannelSeenLatest(db, "mackaye", "general");

    // Marked seen on every channel that has traffic: a bare poll starts AFTER
    // the marks instead of re-reading the backlog.
    const cleared = await pollMessages(db, "mackaye", {});
    expect(cleared.messages).toHaveLength(0);

    await sendMessage(db, "strummer", { channel: "general", to: ["mackaye"], type: "status", body: "fresh" });
    const next = await pollMessages(db, "mackaye", {});
    expect(next.messages.map((m) => m.body)).toEqual(["fresh"]);
  });

  it("partial mark_seen suppresses only the seen channel on a bare poll", async () => {
    const db = makeFakeD1();
    await sendMessage(db, "strummer", { channel: "fleet", to: ["mackaye"], type: "status", body: "seen fleet" });
    await new Promise((r) => setTimeout(r, 2));
    await sendMessage(db, "strummer", { channel: "general", to: ["mackaye"], type: "status", body: "unseen general" });
    await new Promise((r) => setTimeout(r, 2));

    await markChannelSeenLatest(db, "mackaye", "fleet");

    const page = await pollMessages(db, "mackaye", {});
    expect(page.messages.map((m) => m.body)).toEqual(["unseen general"]);
  });

  it("explicit since still re-reads history and never rewinds the stored cursor", async () => {
    const db = makeFakeD1();
    await sendMessage(db, "strummer", { channel: "general", to: ["mackaye"], type: "status", body: "a" });
    await new Promise((r) => setTimeout(r, 2));
    await sendMessage(db, "strummer", { channel: "general", to: ["mackaye"], type: "status", body: "b" });
    await new Promise((r) => setTimeout(r, 2));

    const first = await pollMessages(db, "mackaye", {});
    expect(first.messages.map((m) => m.body)).toEqual(["a", "b"]);
    const drained = await pollMessages(db, "mackaye", {});
    expect(drained.messages).toHaveLength(0);

    // Explicit since is a caller-driven history re-read: honored verbatim, no
    // stored-cursor suppression.
    const replay = await pollMessages(db, "mackaye", { since: "1970-01-01T00:00:00.000Z" });
    expect(replay.messages.map((m) => m.body)).toEqual(["a", "b"]);

    // ...and it must NOT rewind the stored cursor: the next bare poll is still empty.
    const after = await pollMessages(db, "mackaye", {});
    expect(after.messages).toHaveLength(0);
  });

  it("same-ms messages are not dropped by the poll cursor", async () => {
    const ts = "2026-07-22T01:02:03.000Z";
    const state: FakeD1State = {
      messages: [
        {
          id: "msg_a",
          channel: "general",
          thread_id: "thr_a",
          from_consumer: "strummer",
          to_json: JSON.stringify(["mackaye"]),
          type: "status",
          priority: "normal",
          body: "first same ms",
          refs_json: null,
          requires_ack: 0,
          ack_of: null,
          created_at: ts,
        },
        {
          id: "msg_b",
          channel: "general",
          thread_id: "thr_b",
          from_consumer: "strummer",
          to_json: JSON.stringify(["mackaye"]),
          type: "status",
          priority: "normal",
          body: "second same ms",
          refs_json: null,
          requires_ack: 0,
          ack_of: null,
          created_at: ts,
        },
      ],
      cursors: [],
      acks: [],
      consumers: [],
    };
    const db = makeFakeD1(state);

    const first = await pollMessages(db, "mackaye", { limit: 1 });
    expect(first.messages.map((m) => m.body)).toEqual(["first same ms"]);

    const second = await pollMessages(db, "mackaye", { limit: 1 });
    expect(second.messages.map((m) => m.body)).toEqual(["second same ms"]);
  });
});
