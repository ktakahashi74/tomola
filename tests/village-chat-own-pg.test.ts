import { consentChatMembers } from "./helpers/chat-consent";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import type pg from "pg";
import { createScratchDb, REAL_PG_URL, type ScratchDb } from "./helpers/pg-real";
import { expectSettlesWithin, holdTx, waitForLockWait } from "./helpers/pg-concurrency";
import { addMember } from "./helpers/db";
import { villageMembers, villages } from "~/lib/db/schema";
import { deleteOwnChat } from "~/lib/village-chat-own.server";
import { chatChanges, mutateChat } from "~/lib/village-chat.server";
describe.skipIf(!REAL_PG_URL)("own chat deletion concurrency on PostgreSQL", { tags: ["postgres"] }, () => {
  let scratch: ScratchDb, admin: pg.Client, seq = 0;
  beforeAll(async () => { scratch = await createScratchDb(); admin = await scratch.admin(); }, 60000);
  afterEach(async () => { await scratch.closeOpened(); vi.unstubAllEnvs(); });
  afterAll(async () => { await scratch?.drop(); });
  async function world() {
    vi.stubEnv("VILLAGES", "1"); vi.stubEnv("VILLAGE_CHAT", "1");
    const db = await scratch.open("own-setup"), suffix = ++seq;
    const author = `own_pg_author_${suffix}`, reader = `own_pg_reader_${suffix}`, slug = `own-pg-${suffix}`;
    for (const id of [author, reader]) await addMember(db, id, id, { homeArea: "en" });
    const [village] = await db.insert(villages).values({ kind: "open", slug }).returning();
    await db.insert(villageMembers).values([author, reader].map(userId => ({ villageId: village.id, userId })));
    await consentChatMembers(db);
    const sent = await mutateChat(db, author, slug, "send", { body: "Own concurrency text" });
    return { db, author, reader, slug, village, sent };
  }
  it("waits for departure to commit and then deletes by authorship without membership", async () => {
    const w = await world(), leaving = await scratch.open("own-leaving"), deleting = await scratch.open("own-delete-waiter");
    const held = holdTx(leaving, async tx => {
      await tx.select().from(villages).where(eq(villages.id, w.village.id)).for("update");
      await tx.delete(villageMembers).where(and(eq(villageMembers.villageId, w.village.id), eq(villageMembers.userId, w.author)));
    });
    await held.ready;
    const result = deleteOwnChat(deleting, w.author, w.sent.id);
    try { await waitForLockWait(admin, "own-delete-waiter"); } finally { await held.commit(); }
    expect(await expectSettlesWithin(result, 10000, "own deletion after departure")).toEqual({ count: 1, more: false });
    expect((await chatChanges(w.db, w.reader, w.slug, { since: w.sent.seq })).messages).toEqual([{ id: w.sent.id, createdSeq: w.sent.seq, changedSeq: w.sent.seq + 1, deleted: true }]);
  });
  it("commits all bulk tombstones before a concurrent send receives its sequence", async () => {
    const w = await world(), deleting = await scratch.open("own-bulk"), sender = await scratch.open("own-sequence-waiter");
    const second = await mutateChat(w.db, w.author, w.slug, "send", { body: "Another own message" });
    const held = holdTx(deleting, tx => deleteOwnChat(tx, w.author, w.sent.id, true));
    expect(await held.ready).toEqual({ count: 2, more: false });
    expect((await chatChanges(w.db, w.reader, w.slug, { since: second.seq })).messages).toEqual([]);
    const sending = mutateChat(sender, w.reader, w.slug, "send", { body: "After bulk deletion" });
    try { await waitForLockWait(admin, "own-sequence-waiter"); } finally { await held.commit(); }
    const sent = await expectSettlesWithin(sending, 10000, "send after bulk deletion");
    const changed = await chatChanges(w.db, w.reader, w.slug, { since: second.seq });
    expect(changed.messages.filter(m => m.deleted).map(m => m.changedSeq)).toEqual([second.seq + 1, second.seq + 2]);
    expect(sent.seq).toBe(second.seq + 3);
    expect(changed.messages.at(-1)).toMatchObject({ id: sent.id, deleted: false });
  });
});
