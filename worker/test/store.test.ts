import { describe, expect, it } from "vitest";
import {
  ackMessage,
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

  it("sorts blocking messages before normal", async () => {
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
    expect(page.messages[0]!.priority).toBe("blocking");
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
