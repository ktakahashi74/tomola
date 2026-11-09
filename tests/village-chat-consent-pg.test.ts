import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { addMember } from "./helpers/db";
import { createScratchDb, REAL_PG_URL, type ScratchDb } from "./helpers/pg-real";
import { expectPending, holdTx, waitForLockWait } from "./helpers/pg-concurrency";
import { chatConsents, villageMembers, villages } from "~/lib/db/schema";
import { acceptChatConsent, chatPage } from "~/lib/village-chat.server";
import { changeVillageMembership } from "~/lib/villages.server";

describe.skipIf(!REAL_PG_URL)("chat consent lifecycle transactions", { tags: ["postgres"] }, () => {
  let scratch: ScratchDb, index = 0;
  beforeAll(async () => { scratch = await createScratchDb(); }, 60_000);
  afterEach(async () => { await scratch.closeOpened(); vi.unstubAllEnvs(); });
  afterAll(async () => { await scratch?.drop(); });
  async function world() {
    vi.stubEnv("VILLAGES", "1"); vi.stubEnv("VILLAGE_CHAT", "1");
    const db = await scratch.open(), id = `ccpg${++index}`;
    await addMember(db, id, id);
    const [village] = await db.insert(villages).values({ slug: id, kind: "open" }).returning();
    await db.insert(villageMembers).values({ villageId: village.id, userId: id });
    return { db, id, village };
  }
  it("departure waits for an in-flight consent and removes it in the same transaction", async () => {
    const w = await world(), other = await scratch.open("consent-leave-waiter");
    const held = holdTx(w.db, tx => acceptChatConsent(tx, w.id, w.village.slug!));
    await held.ready;
    const leaving = changeVillageMembership(other, w.id, w.village.slug!, "leave");
    try { await waitForLockWait(await scratch.admin(), "consent-leave-waiter"); await expectPending(leaving); }
    finally { await held.commit(); }
    expect(await leaving).toBe(true);
    expect(await w.db.select().from(chatConsents).where(eq(chatConsents.villageId, w.village.id))).toEqual([]);
    await w.db.insert(villageMembers).values({ villageId: w.village.id, userId: w.id });
    expect(await chatPage(w.db, w.id, w.village.slug!)).toHaveProperty("consentRequired", true);
  });
  it("consent waits for an in-flight departure and cannot leave a stale record", async () => {
    const w = await world(), other = await scratch.open("consent-after-leave");
    const held = holdTx(w.db, async tx => {
      await tx.select().from(villages).where(eq(villages.id, w.village.id)).for("update");
      await tx.delete(villageMembers).where(and(eq(villageMembers.villageId, w.village.id), eq(villageMembers.userId, w.id)));
    });
    await held.ready;
    const consenting = acceptChatConsent(other, w.id, w.village.slug!);
    const denied = expect(consenting).rejects.toMatchObject({ code: "not_found" });
    try { await waitForLockWait(await scratch.admin(), "consent-after-leave"); await expectPending(consenting); }
    finally { await held.commit(); }
    await denied;
    expect(await w.db.select().from(chatConsents).where(eq(chatConsents.villageId, w.village.id))).toEqual([]);
  });
});
