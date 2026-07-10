import { describe, expect, it } from "vitest";
import {
  ackMessage,
  getThread,
  listChannels,
  listConsumers,
  markChannelSeenLatest,
  pollMessages,
  sendMessage,
} from "../src/store";
import { makeFakeD1 } from "./fake-d1";

describe("store", () => {
  it("send, poll with exclusive since, and ack round-trip", async () => {
    const db = makeFakeD1();

    const sent = await sendMessage(db, "cursor-laptop", {
      channel: "general",
      to: ["*"],
      type: "ping",
      body: "hello",
    });

    const first = await pollMessages(db, "mackaye", { channel: "general" });
    expect(first.messages).toHaveLength(1);
    expect(first.messages[0]!.id).toBe(sent.id);

    const second = await pollMessages(db, "mackaye", {
      channel: "general",
      since: first.cursor!,
    });
    expect(second.messages).toHaveLength(0);

    const ack = await ackMessage(db, "mackaye", sent.id, "got it");
    expect(ack.type).toBe("ack");
    expect(ack.ack_of).toBe(sent.id);
    expect(ack.to).toEqual(["cursor-laptop"]);
  });

  it("polls in created_at order with priority surfaced as a field", async () => {
    const db = makeFakeD1();

    await sendMessage(db, "mackaye", {
      channel: "vivijure",
      to: ["cursor-laptop"],
      type: "status",
      priority: "normal",
      body: "normal first chronologically",
    });
    await new Promise((r) => setTimeout(r, 2));
    await sendMessage(db, "mackaye", {
      channel: "vivijure",
      to: ["cursor-laptop"],
      type: "question",
      priority: "blocking",
      body: "blocking gate",
    });

    const page = await pollMessages(db, "cursor-laptop", { channel: "vivijure" });
    expect(page.messages.map((m) => m.priority)).toEqual(["normal", "blocking"]);
  });

  it("cursor never skips a message when a page truncates (loss regression)", async () => {
    const db = makeFakeD1();

    for (let i = 0; i < 3; i++) {
      await sendMessage(db, "mackaye", {
        channel: "vivijure",
        to: ["cursor-laptop"],
        type: "status",
        body: `msg ${i}`,
      });
      await new Promise((r) => setTimeout(r, 2));
    }

    const seen: string[] = [];
    let since: string | undefined;
    for (let round = 0; round < 5 && seen.length < 3; round++) {
      const page = await pollMessages(db, "cursor-laptop", {
        channel: "vivijure",
        since,
        limit: 1,
      });
      seen.push(...page.messages.map((m) => m.body));
      if (!page.cursor) break;
      since = page.cursor;
    }
    expect(seen).toEqual(["msg 0", "msg 1", "msg 2"]);
  });

  it("cursor advances past messages invisible to the consumer (live-lock regression)", async () => {
    const db = makeFakeD1();

    await sendMessage(db, "mackaye", {
      channel: "vivijure",
      to: ["someone-else"],
      type: "status",
      body: "not for cursor-laptop",
    });
    await new Promise((r) => setTimeout(r, 2));

    const first = await pollMessages(db, "cursor-laptop", { channel: "vivijure" });
    expect(first.messages).toHaveLength(0);
    expect(first.cursor).not.toBeNull();

    await sendMessage(db, "mackaye", {
      channel: "vivijure",
      to: ["cursor-laptop"],
      type: "status",
      body: "for cursor-laptop",
    });
    const second = await pollMessages(db, "cursor-laptop", {
      channel: "vivijure",
      since: first.cursor!,
    });
    expect(second.messages.map((m) => m.body)).toEqual(["for cursor-laptop"]);
  });

  it("poll excludes own sends but thread includes them", async () => {
    const db = makeFakeD1();

    const sent = await sendMessage(db, "mackaye", {
      channel: "general",
      to: ["*"],
      type: "question",
      body: "own question",
    });
    await new Promise((r) => setTimeout(r, 2));
    const reply = await sendMessage(db, "cursor-laptop", {
      channel: "general",
      thread_id: sent.thread_id,
      to: ["mackaye"],
      type: "status",
      body: "their reply",
    });

    const page = await pollMessages(db, "mackaye", { channel: "general" });
    expect(page.messages.map((m) => m.id)).toEqual([reply.id]);

    const thread = await getThread(db, sent.thread_id, "mackaye");
    expect(thread.map((m) => m.id)).toEqual([sent.id, reply.id]);
  });

  it("own broadcasts do not count as unread for the sender", async () => {
    const db = makeFakeD1();

    await sendMessage(db, "mackaye", {
      channel: "general",
      to: ["*"],
      type: "ping",
      body: "hello all",
    });

    const mine = await listChannels(db, "mackaye");
    expect(mine.find((c) => c.channel === "general")!.unread).toBe(0);
    const theirs = await listChannels(db, "cursor-laptop");
    expect(theirs.find((c) => c.channel === "general")!.unread).toBe(1);
  });

  it("caps oversized bodies with a linkable error", async () => {
    const db = makeFakeD1();
    await expect(
      sendMessage(db, "mackaye", {
        channel: "general",
        to: ["*"],
        type: "status",
        body: "x".repeat(16385),
      }),
    ).rejects.toThrow(/capped at 16384 bytes/);
  });

  it("markChannelSeenLatest clears unread count", async () => {
    const db = makeFakeD1();

    await sendMessage(db, "mackaye", {
      channel: "fleet",
      to: ["cursor-laptop"],
      type: "handoff",
      body: "check bus",
    });

    let channels = await listChannels(db, "cursor-laptop");
    expect(channels.find((c) => c.channel === "fleet")!.unread).toBe(1);

    await markChannelSeenLatest(db, "cursor-laptop", "fleet");

    channels = await listChannels(db, "cursor-laptop");
    expect(channels.find((c) => c.channel === "fleet")!.unread).toBe(0);
  });

  it("rejects broadcast-invisible poll for wrong consumer", async () => {
    const db = makeFakeD1();

    await sendMessage(db, "mackaye", {
      channel: "postern",
      to: ["cursor-laptop"],
      type: "question",
      body: "direct only",
    });

    const page = await pollMessages(db, "strummer", { channel: "postern" });
    expect(page.messages).toHaveLength(0);
  });
  it("rejects a send to an unknown/retired recipient, listing the roster (#17.1)", async () => {
    const db = makeFakeD1();
    const roster = ["mackaye", "strummer"];

    await expect(
      sendMessage(
        db,
        "mackaye",
        { channel: "vivijure", to: ["albini"], type: "handoff", body: "render this" },
        roster,
      ),
    ).rejects.toThrow(/unknown recipient\(s\): albini.*valid consumers: mackaye, strummer/);

    // A registered name and a broadcast both pass validation.
    await expect(
      sendMessage(db, "mackaye", { channel: "vivijure", to: ["strummer"], type: "handoff", body: "ok" }, roster),
    ).resolves.toBeTruthy();
    await expect(
      sendMessage(db, "mackaye", { channel: "general", to: ["*"], type: "ping", body: "all" }, roster),
    ).resolves.toBeTruthy();
  });

  it("normalizes refs.issue / refs.pr to bare numbers (#17.4)", async () => {
    const db = makeFakeD1();
    const sent = await sendMessage(db, "mackaye", {
      channel: "vivijure",
      to: ["*"],
      type: "status",
      body: "see refs",
      refs: { repo: "crew-bus", issue: "#42", pr: "#17", branch: "feat/x" },
    });
    expect(sent.refs).toEqual({ repo: "crew-bus", issue: "42", pr: "17", branch: "feat/x" });

    const thread = await getThread(db, sent.thread_id, "mackaye", ["mackaye"]);
    expect(thread[0]!.refs).toEqual({ repo: "crew-bus", issue: "42", pr: "17", branch: "feat/x" });
  });

  it("bus_consumers roster reports last_poll_at, null before a poll (#17.2)", async () => {
    const db = makeFakeD1();
    const roster = ["mackaye", "cursor-laptop"];

    let consumers = await listConsumers(db, roster);
    expect(consumers).toEqual([
      { name: "mackaye", last_poll_at: null, webhook: false },
      { name: "cursor-laptop", last_poll_at: null, webhook: false },
    ]);

    await pollMessages(db, "cursor-laptop", { channel: "general" });
    consumers = await listConsumers(db, roster);
    expect(consumers.find((c) => c.name === "mackaye")!.last_poll_at).toBeNull();
    expect(consumers.find((c) => c.name === "cursor-laptop")!.last_poll_at).not.toBeNull();
  });

  it("thread attaches sender-side delivery: polled_after then acked_at (#17.3)", async () => {
    const db = makeFakeD1();
    const roster = ["mackaye", "cursor-laptop"];

    const sent = await sendMessage(
      db,
      "mackaye",
      { channel: "vivijure", to: ["cursor-laptop"], type: "handoff", body: "pick this up", requires_ack: true },
      roster,
    );

    // Before the recipient polls: addressed but not yet seen or acked.
    let thread = await getThread(db, sent.thread_id, "mackaye", roster);
    let delivery = thread.find((m) => m.id === sent.id)!.delivery!;
    expect(delivery).toEqual([{ recipient: "cursor-laptop", acked_at: null, polled_after: false, webhook_delivered_at: null, webhook_attempts: 0 }]);

    // Recipient polls (records last_poll_at), then acks.
    await new Promise((r) => setTimeout(r, 2));
    await pollMessages(db, "cursor-laptop", { channel: "vivijure" });
    await ackMessage(db, "cursor-laptop", sent.id, "on it");

    thread = await getThread(db, sent.thread_id, "mackaye", roster);
    delivery = thread.find((m) => m.id === sent.id)!.delivery!;
    expect(delivery[0]!.recipient).toBe("cursor-laptop");
    expect(delivery[0]!.polled_after).toBe(true);
    expect(delivery[0]!.acked_at).not.toBeNull();
  });

  it("broadcast delivery reports against the full roster minus the sender (#17.3)", async () => {
    const db = makeFakeD1();
    const roster = ["mackaye", "cursor-laptop", "strummer"];

    const sent = await sendMessage(
      db,
      "mackaye",
      { channel: "general", to: ["*"], type: "status", body: "heads up all" },
      roster,
    );

    const thread = await getThread(db, sent.thread_id, "mackaye", roster);
    const delivery = thread.find((m) => m.id === sent.id)!.delivery!;
    expect(delivery.map((d) => d.recipient).sort()).toEqual(["cursor-laptop", "strummer"]);
  });

  it("re-surfaces an unacked requires_ack message on every poll until acked (#21 incident replay)", async () => {
    const db = makeFakeD1();
    const roster = ["mackaye", "albini"];

    // The incident: a ruling sent WITHOUT requires_ack. It now defaults true for
    // type=ruling, so the drop is recoverable.
    const ruling = await sendMessage(
      db,
      "mackaye",
      { channel: "general", to: ["albini"], type: "ruling", body: "ship it" },
      roster,
    );
    expect(ruling.requires_ack).toBe(true);

    const first = await pollMessages(db, "albini", { channel: "general" });
    expect(first.messages.map((m) => m.id)).toContain(ruling.id);
    expect(first.pending_acks.map((m) => m.id)).toEqual([ruling.id]);
    expect(first.pending_acks[0]!.pending_ack).toBe(true);

    // Poll again past the cursor WITHOUT acking (the dropped-ack case): gone from
    // messages, but still surfaced in pending_acks. This is what a relay turn used to cost.
    const second = await pollMessages(db, "albini", { channel: "general", since: first.cursor! });
    expect(second.messages).toHaveLength(0);
    expect(second.pending_acks.map((m) => m.id)).toEqual([ruling.id]);

    // Acking clears it.
    await ackMessage(db, "albini", ruling.id, "acked");
    const third = await pollMessages(db, "albini", { channel: "general", since: first.cursor! });
    expect(third.pending_acks).toHaveLength(0);
  });

  it("requires_ack defaults true for ruling/handoff, explicit false honored (#21)", async () => {
    const db = makeFakeD1();
    const ruling = await sendMessage(db, "mackaye", { channel: "general", to: ["*"], type: "ruling", body: "r" });
    expect(ruling.requires_ack).toBe(true);
    const handoff = await sendMessage(db, "mackaye", { channel: "general", to: ["*"], type: "handoff", body: "h" });
    expect(handoff.requires_ack).toBe(true);
    const status = await sendMessage(db, "mackaye", { channel: "general", to: ["*"], type: "status", body: "s" });
    expect(status.requires_ack).toBe(false);
    const optOut = await sendMessage(db, "mackaye", {
      channel: "general",
      to: ["*"],
      type: "ruling",
      body: "r2",
      requires_ack: false,
    });
    expect(optOut.requires_ack).toBe(false);
  });

  it("bus_channels reports per-channel pending_ack counts, cleared on ack (#21)", async () => {
    const db = makeFakeD1();
    const handoff = await sendMessage(db, "mackaye", { channel: "fleet", to: ["albini"], type: "handoff", body: "do x" });

    let channels = await listChannels(db, "albini");
    expect(channels.find((c) => c.channel === "fleet")!.pending_ack).toBe(1);

    // The sender carries no obligation on their own message.
    const mine = await listChannels(db, "mackaye");
    expect(mine.find((c) => c.channel === "fleet")!.pending_ack).toBe(0);

    await ackMessage(db, "albini", handoff.id);
    channels = await listChannels(db, "albini");
    expect(channels.find((c) => c.channel === "fleet")!.pending_ack).toBe(0);
  });

  it("ack is idempotent: repeats keep one row, first acked_at, one ack message (#22)", async () => {
    const db = makeFakeD1();
    const roster = ["mackaye", "cursor-laptop"];
    const sent = await sendMessage(
      db,
      "mackaye",
      { channel: "vivijure", to: ["cursor-laptop"], type: "handoff", body: "pick up", requires_ack: true },
      roster,
    );
    await pollMessages(db, "cursor-laptop", { channel: "vivijure" });

    const first = await ackMessage(db, "cursor-laptop", sent.id, "on it");
    await new Promise((r) => setTimeout(r, 2));
    const second = await ackMessage(db, "cursor-laptop", sent.id, "on it again");
    const third = await ackMessage(db, "cursor-laptop", sent.id);

    // Every repeat returns the FIRST ack unchanged (true no-op).
    expect(second.id).toBe(first.id);
    expect(third.id).toBe(first.id);
    expect(second.body).toBe(first.body);

    const thread = await getThread(db, sent.thread_id, "mackaye", roster);
    const handoff = thread.find((m) => m.id === sent.id)!;
    // Delivery report: a single ack, acked_at is the FIRST ack time.
    expect(handoff.delivery).toEqual([
      { recipient: "cursor-laptop", acked_at: first.created_at, polled_after: true, webhook_delivered_at: null, webhook_attempts: 0 },
    ]);
    // Exactly one ack-type message landed in the thread.
    expect(thread.filter((m) => m.type === "ack")).toHaveLength(1);
  });

});
