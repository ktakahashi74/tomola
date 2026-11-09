import { consentChatMembers } from "./helpers/chat-consent";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { chatMessages, profiles, villageMembers, villages } from "~/lib/db/schema";
import { chatChanges, mutateChat, nextChatSequence } from "~/lib/village-chat.server";
import { addMember } from "./helpers/db";
import { createScratchDb, REAL_PG_URL, type ScratchDb } from "./helpers/pg-real";
import { expectPending, expectSettlesWithin, holdTx, waitForLockWait } from "./helpers/pg-concurrency";

describe.skipIf(!REAL_PG_URL)("village chat PostgreSQL transaction ordering", { tags: ["postgres"] }, () => {
  let scratch: ScratchDb, index = 0;
  beforeAll(async () => { scratch = await createScratchDb(); }, 120_000);
  afterAll(async () => { await scratch?.drop(); }, 60_000);
  afterEach(async () => { vi.unstubAllEnvs(); await scratch?.closeOpened(); });
  async function world() {
    vi.stubEnv("VILLAGES", "1"); vi.stubEnv("VILLAGE_CHAT", "1");
    const db = await scratch.open(); const id = `chatpg${++index}`;
    await addMember(db, id, id);
    const [village] = await db.insert(villages).values({ slug: id, kind: "open" }).returning();
    await db.insert(villageMembers).values({ villageId: village.id, userId: id });
    await consentChatMembers(db);
    return { db, id, village };
  }
  it("waits for the prior allocation to commit and then retrieves both in order", async () => {
    const { db, id, village } = await world();
    const first = holdTx(db, async tx => {
      const seq = await nextChatSequence(tx, village.id);
      await tx.insert(chatMessages).values({ villageId: village.id, authorId: id, lang: "ja", body: "First", createdSeq: seq, changedSeq: seq });
      return seq;
    });
    expect(await first.ready).toBe(1);
    const other = await scratch.open("chat-sequence-waiter");
    const second = mutateChat(other, id, village.slug!, "send", { body: "Second" });
    try {
      await waitForLockWait(await scratch.admin(), "chat-sequence-waiter"); await expectPending(second);
      expect((await chatChanges(other, id, village.slug!, { since: 0 })).messages).toEqual([]);
    } finally { await first.commit(); }
    expect((await second).seq).toBe(2);
    const result = await chatChanges(other, id, village.slug!, { since: 0 });
    expect(result.messages.map(message => message.createdSeq)).toEqual([1, 2]); expect(result.next).toBe(2);
    expect((await chatChanges(other, id, village.slug!, { since: 1 })).messages.map(message => message.createdSeq)).toEqual([2]);
  });
  it("does not lock the profile row while writing", async () => {
    const { db, id, village } = await world();
    const held = holdTx(db, tx => tx.select().from(profiles).where(eq(profiles.userId, id)).for("update"));
    await held.ready;
    try {
      const other = await scratch.open("chat-profile-independent");
      const result = await expectSettlesWithin(mutateChat(other, id, village.slug!, "send", { body: "Independent" }), 2500, "chat send with locked profile");
      expect(result.seq).toBe(1);
    } finally { await held.rollback(); }
  });
  it("a membership deletion waits for an in-flight shared membership lock", async () => {
    const { db, id, village } = await world();
    const held = holdTx(db, async tx => {
      await tx.select().from(villageMembers).where(and(eq(villageMembers.villageId, village.id), eq(villageMembers.userId, id))).for("share");
      const seq = await nextChatSequence(tx, village.id);
      await tx.insert(chatMessages).values({ villageId: village.id, authorId: id, lang: "ja", body: "Before leave", createdSeq: seq, changedSeq: seq });
    });
    await held.ready;
    const other = await scratch.open("chat-leave-waiter");
    const leaving = other.delete(villageMembers).where(and(eq(villageMembers.villageId, village.id), eq(villageMembers.userId, id))).execute();
    try { await waitForLockWait(await scratch.admin(), "chat-leave-waiter"); await expectPending(leaving); } finally { await held.commit(); }
    await leaving;
    await expect(mutateChat(other, id, village.slug!, "send", { body: "After leave" })).rejects.toMatchObject({ code: "not_found" });
  });
});
