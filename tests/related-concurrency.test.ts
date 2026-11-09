import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { entries, entryReferences } from "~/lib/db/schema";
import { createReply, createTopic, editEntry } from "~/lib/entries.server";
import { addMember } from "./helpers/db";
import { expectSettlesWithin, holdTx, waitForLockWait } from "./helpers/pg-concurrency";
import { createScratchDb, REAL_PG_URL, type ScratchDb } from "./helpers/pg-real";

describe.skipIf(!REAL_PG_URL)("reciprocal references on PostgreSQL", { tags: ["postgres"] }, () => {
  let scratch: ScratchDb, seq = 0;
  beforeAll(async () => { scratch = await createScratchDb(); }, 120_000);
  afterEach(async () => { await scratch?.closeOpened(); });
  afterAll(async () => { await scratch?.drop(); }, 60_000);
  it.each(["reply", "edit"] as const)("locks both topics in the same order for reciprocal %s writes", async kind => {
    const [blockDb, firstDb, secondDb] = await Promise.all([scratch.open("reference-block"), scratch.open("reference-first"), scratch.open("reference-second")]);
    const author = `reference_race_${++seq}`;
    await addMember(blockDb, author, author);
    const a = await createTopic(blockDb, author, { lang: "en", title: "First", body: "First body" });
    const b = await createTopic(blockDb, author, { lang: "en", title: "Second", body: "Second body" });
    if (!a.ok || !b.ok) throw new Error("fixture failed");
    const blocker = holdTx(blockDb, tx => tx.select().from(entries).where(eq(entries.id, a.id)).for("no key update"));
    await blocker.ready;
    const first = kind === "reply" ? createReply(firstDb, author, a.id, { lang: "en", body: `[first](/t/${b.id})` }) : editEntry(firstDb, author, a.id, { title: "First", body: `[first](/t/${b.id})` });
    const admin = await scratch.admin();
    await waitForLockWait(admin, "reference-first");
    const second = kind === "reply" ? createReply(secondDb, author, b.id, { lang: "en", body: `[second](/t/${a.id})` }) : editEntry(secondDb, author, b.id, { title: "Second", body: `[second](/t/${a.id})` });
    try {
      await waitForLockWait(admin, "reference-second");
      await blocker.commit();
      const results = await expectSettlesWithin(Promise.all([first, second]), 15_000, "reciprocal reference writes");
      expect(results.every(result => result.ok)).toBe(true);
      expect(await blockDb.select().from(entryReferences).where(inArray(entryReferences.targetEntryId, [a.id, b.id]))).toHaveLength(2);
      expect((await blockDb.select().from(entries).where(eq(entries.id, a.id)))[0].metaChangedAt).not.toBeNull();
      expect((await blockDb.select().from(entries).where(eq(entries.id, b.id)))[0].metaChangedAt).not.toBeNull();
    } finally { await blocker.rollback(); }
  }, 30_000);
});
