import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { chatMessages, notifications, villageMembers, villages } from "~/lib/db/schema";
import { mutateChat } from "~/lib/village-chat.server";
import { addMember } from "./helpers/db";
import { consentChatMembers } from "./helpers/chat-consent";
import { createScratchDb, REAL_PG_URL, type ScratchDb } from "./helpers/pg-real";
import { expectPending, holdTx, waitForLockWait } from "./helpers/pg-concurrency";

describe.skipIf(!REAL_PG_URL)("chat reply target validation on PostgreSQL", { tags: ["postgres"] }, () => {
  let scratch: ScratchDb, index = 0;
  beforeAll(async () => { scratch = await createScratchDb(); }, 120_000);
  afterAll(async () => { await scratch?.drop(); }, 60_000);
  afterEach(async () => { vi.unstubAllEnvs(); await scratch?.closeOpened(); });

  it.each(["hidden", "deleted"])("rechecks a target after a concurrent %s transaction commits", async state => {
    vi.stubEnv("VILLAGES", "1"); vi.stubEnv("VILLAGE_CHAT", "1");
    const db = await scratch.open(), writer = `qry_pg_writer${++index}`, reader = `qry_pg_reader${index}`;
    for (const id of [writer, reader]) await addMember(db, id, id, { homeArea: "en", readLangs: ["en"] });
    const [village] = await db.insert(villages).values({ slug: `reply-pg-${index}`, kind: "open" }).returning();
    await db.insert(villageMembers).values([writer, reader].map(userId => ({ villageId: village.id, userId })));
    await consentChatMembers(db);
    const parent = await mutateChat(db, reader, village.slug!, "send", { body: "Concurrent reply target" });
    const held = holdTx(db, tx => tx.update(chatMessages).set(state === "hidden" ? { hiddenAt: new Date() } : { deletedAt: new Date(), body: "" }).where(eq(chatMessages.id, parent.id)));
    await held.ready;
    const sender = await scratch.open(`reply-target-waiter-${index}`);
    const sending = mutateChat(sender, writer, village.slug!, "send", { body: "Reply after target disappears", replyToId: parent.id });
    const refused = expect(sending).rejects.toMatchObject({ code: "invalid_reply" });
    try {
      await waitForLockWait(await scratch.admin(), `reply-target-waiter-${index}`);
      await expectPending(sending);
    } finally { await held.commit(); }
    await refused;
    expect(await db.select().from(notifications)).toEqual([]);
    expect(await db.select().from(chatMessages).where(eq(chatMessages.authorId, writer))).toEqual([]);
  });
});
