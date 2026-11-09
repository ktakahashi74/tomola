import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { addMember } from "./helpers/db";
import { createScratchDb, REAL_PG_URL, type ScratchDb } from "./helpers/pg-real";
import { expectSettlesWithin, holdTx, waitForLockWait } from "./helpers/pg-concurrency";
import { entries, moderationActions } from "~/lib/db/schema";
import { createTopic } from "~/lib/entries.server";
import { lockAbuseWriter } from "~/lib/moderation-automation.server";

describe.skipIf(!REAL_PG_URL)("automatic abuse detection on PostgreSQL", { tags: ["postgres"] }, () => {
  let scratch: ScratchDb;
  beforeAll(async () => { scratch = await createScratchDb(); }, 60_000);
  afterEach(async () => { vi.unstubAllEnvs(); await scratch.closeOpened(); });
  afterAll(async () => { await scratch?.drop(); });
  it("serializes the author's history checks before concurrent posts become visible", async () => {
    const db = await scratch.open("am-setup"); await addMember(db, "am_pg_author", "am_pg_author");
    vi.stubEnv("MODERATION_SPAM_ENABLED", "1");
    const post = (db: Parameters<typeof createTopic>[0]) => createTopic(db, "am_pg_author", { body: "Concurrent repetition", lang: "en" });
    expect((await post(db)).ok).toBe(true);
    const first = await scratch.open("am-first"), second = await scratch.open("am-wait"), admin = await scratch.admin();
    const held = holdTx(first, async tx => { await lockAbuseWriter(tx, "am_pg_author"); return post(tx); });
    await held.ready;
    const pending = post(second);
    try { await waitForLockWait(admin, "am-wait"); } finally { await held.commit(); }
    const third = await expectSettlesWithin(pending, 10_000, "serialized spam check"); if (!third.ok) throw new Error(third.error);
    expect((await db.select().from(entries).where(eq(entries.id, third.id)))[0].hiddenAt).not.toBeNull();
    expect(await db.select().from(moderationActions)).toMatchObject([{ automatic: true, actorId: null, targetEntryId: third.id }]);
  });
});
