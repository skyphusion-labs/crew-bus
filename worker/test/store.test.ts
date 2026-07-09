import { describe, expect, it } from "vitest";
import {
  ackMessage,
  getThread,
  listChannels,
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
});
