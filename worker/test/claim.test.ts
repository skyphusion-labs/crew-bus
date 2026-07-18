import { describe, expect, it } from "vitest";
import { makeFakeD1, type FakeD1State } from "./fake-d1";
import { claimMessage, getThread, pollMessages, sendMessage } from "../src/store";
import { BusError } from "../src/bus-error";

const ROSTER = ["mackaye", "albini", "gordon", "mould"];

function freshState(): FakeD1State {
  return { messages: [], cursors: [], acks: [], consumers: [] };
}

async function broadcastHandoff(db: D1Database, from = "mackaye") {
  return sendMessage(
    db,
    from,
    {
      channel: "general",
      to: ["*"],
      type: "handoff",
      body: "take prism#86: fix the retriever",
      refs: { repo: "prism", issue: "86" },
    },
    ROSTER,
  );
}

describe("claimMessage (#41)", () => {
  it("first claim wins and records the claim as the ack", async () => {
    const state = freshState();
    const db = makeFakeD1(state);
    const handoff = await broadcastHandoff(db);

    const outcome = await claimMessage(db, "albini", handoff.id);
    expect(outcome.claimed).toBe(true);
    expect(outcome.claim.claimed_by).toBe("albini");
    expect(outcome.claim.message_id).toBe(handoff.id);
    expect(outcome.ack.type).toBe("ack");
    expect(outcome.ack.body).toBe(`claim ${handoff.id}`);
    expect(state.acks.some((a) => a.message_id === handoff.id && a.from_consumer === "albini")).toBe(
      true,
    );
  });

  it("a later claim loses, learns the winner, and still gets a receipt ack", async () => {
    const state = freshState();
    const db = makeFakeD1(state);
    const handoff = await broadcastHandoff(db);

    await claimMessage(db, "albini", handoff.id);
    const lost = await claimMessage(db, "gordon", handoff.id, "on it, starting now");

    expect(lost.claimed).toBe(false);
    expect(lost.claim.claimed_by).toBe("albini");
    // The loser's claim body is discarded: the receipt must state the winner,
    // not read like the loser took the work.
    expect(lost.ack.body).toBe(`ack ${handoff.id} (claim lost to albini)`);
    expect(state.acks.some((a) => a.message_id === handoff.id && a.from_consumer === "gordon")).toBe(
      true,
    );
  });

  it("a lost claim clears the loser's pending_ack obligation", async () => {
    const state = freshState();
    const db = makeFakeD1(state);
    const handoff = await broadcastHandoff(db);

    await claimMessage(db, "albini", handoff.id);
    await claimMessage(db, "mould", handoff.id);

    const page = await pollMessages(db, "mould", {});
    expect(page.pending_acks.find((m) => m.id === handoff.id)).toBeUndefined();
  });

  it("re-claiming is idempotent for the winner (no duplicate ack message)", async () => {
    const state = freshState();
    const db = makeFakeD1(state);
    const handoff = await broadcastHandoff(db);

    const first = await claimMessage(db, "albini", handoff.id);
    const again = await claimMessage(db, "albini", handoff.id);

    expect(again.claimed).toBe(true);
    expect(again.ack.id).toBe(first.ack.id);
    const ackMessages = state.messages.filter(
      (m) => m.type === "ack" && m.ack_of === handoff.id && m.from_consumer === "albini",
    );
    expect(ackMessages).toHaveLength(1);
  });

  it("rejects claiming your own message, a non-handoff, an invisible message, and a missing id", async () => {
    const state = freshState();
    const db = makeFakeD1(state);
    const handoff = await broadcastHandoff(db, "mackaye");
    await expect(claimMessage(db, "mackaye", handoff.id)).rejects.toThrow(BusError);

    const ruling = await sendMessage(
      db,
      "mackaye",
      { channel: "general", to: ["*"], type: "ruling", body: "ruled" },
      ROSTER,
    );
    await expect(claimMessage(db, "albini", ruling.id)).rejects.toThrow(/type=handoff/);

    const direct = await sendMessage(
      db,
      "mackaye",
      { channel: "general", to: ["albini"], type: "handoff", body: "direct work" },
      ROSTER,
    );
    await expect(claimMessage(db, "gordon", direct.id)).rejects.toThrow(/not authorized/);

    await expect(claimMessage(db, "albini", "msg_nope")).rejects.toThrow(/not found/);
  });

  it("a direct handoff to one recipient is claimable by that recipient", async () => {
    const db = makeFakeD1(freshState());
    const direct = await sendMessage(
      db,
      "mackaye",
      { channel: "general", to: ["albini"], type: "handoff", body: "direct work" },
      ROSTER,
    );
    const outcome = await claimMessage(db, "albini", direct.id);
    expect(outcome.claimed).toBe(true);
  });

  it("annotates handoffs with claim state in threads and pending_acks", async () => {
    const state = freshState();
    const db = makeFakeD1(state);
    const handoff = await broadcastHandoff(db);

    // Unclaimed: annotation present and null for thread readers + pollers.
    const before = await getThread(db, handoff.thread_id, "gordon", ROSTER);
    expect(before.find((m) => m.id === handoff.id)?.claim).toBeNull();
    const pageBefore = await pollMessages(db, "gordon", {});
    expect(pageBefore.pending_acks.find((m) => m.id === handoff.id)?.claim).toBeNull();

    await claimMessage(db, "albini", handoff.id);

    // Claimed: every reader (including the sender's delivery-report path) sees
    // the winner without needing the delivery report.
    for (const reader of ["gordon", "mackaye"]) {
      const thread = await getThread(db, handoff.thread_id, reader, ROSTER);
      expect(thread.find((m) => m.id === handoff.id)?.claim?.claimed_by).toBe("albini");
    }
    const pageAfter = await pollMessages(db, "mould", {});
    expect(pageAfter.pending_acks.find((m) => m.id === handoff.id)?.claim?.claimed_by).toBe(
      "albini",
    );
  });
});
