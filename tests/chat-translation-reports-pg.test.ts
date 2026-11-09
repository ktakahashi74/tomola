import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { createScratchDb, REAL_PG_URL, type ScratchDb } from "./helpers/pg-real";
import { addMember } from "./helpers/db";
import { holdTx, waitForLockWait } from "./helpers/pg-concurrency";
import { chatConsents, chatMessages, chatMessageTranslations, chatTranslationReports, jobs, villageMembers, villages } from "~/lib/db/schema";
import { CHAT_CONSENT_VERSION } from "~/lib/village-chat-consent";
import { createChatTranslationReport } from "~/lib/chat-translation-reports.server";
import { chatSourceHash } from "~/lib/village-chat-translations.server";

describe.skipIf(!REAL_PG_URL)("chat translation report PostgreSQL races", { tags: ["postgres"] }, () => {
  let scratch: ScratchDb, index = 0;
  beforeAll(async () => { scratch = await createScratchDb(); }, 120000);
  afterAll(async () => { await scratch?.drop(); }, 60000);
  afterEach(async () => { vi.unstubAllEnvs(); await scratch.closeOpened(); });
  async function world() {
    vi.stubEnv("VILLAGES", "1"); vi.stubEnv("VILLAGE_CHAT", "1"); vi.stubEnv("ENABLED_LANGS", "ja,en");
    const db = await scratch.open(), prefix = `qrpg${++index}`, author = `${prefix}_author`, readers = [`${prefix}_r1`, `${prefix}_r2`];
    for (const id of [author, ...readers]) await addMember(db, id, id);
    const [village] = await db.insert(villages).values({ slug: prefix, kind: "open" }).returning();
    await db.insert(villageMembers).values(readers.map(userId => ({ villageId: village.id, userId })));
    await db.insert(chatConsents).values(readers.map(userId => ({ villageId: village.id, userId, version: CHAT_CONSENT_VERSION })));
    const [message] = await db.insert(chatMessages).values({ villageId: village.id, authorId: author, body: "原文。", lang: "ja", createdSeq: 1, changedSeq: 1 }).returning();
    await db.insert(chatMessageTranslations).values({ messageId: message.id, lang: "en", sourceHash: chatSourceHash(message.body), text: "Translation", state: "ready" });
    const input = { slug: village.slug!, messageId: message.id, lang: "en" };
    return { db, village, message, readers, input };
  }
  it("serializes concurrent first reports into exactly one regeneration job", async () => {
    const w = await world(), other = await scratch.open();
    const results = await Promise.all([createChatTranslationReport(w.db, w.readers[0], w.input), createChatTranslationReport(other, w.readers[1], w.input)]);
    expect(results.filter(r => r.retry)).toHaveLength(1);
    const rows = await w.db.select().from(chatTranslationReports).where(eq(chatTranslationReports.messageId, w.message.id));
    expect(rows.map(r => r.status).sort()).toEqual(["open", "retry"]);
    const queued = await w.db.select().from(jobs).where(and(eq(jobs.kind, "retranslate_chat_report"), eq(jobs.dedupeKey, `chat-translation-report:${results.find(r => r.retry)!.id}`)));
    expect(queued).toHaveLength(1);
  });
  it("rechecks an edit committed while waiting for the message lock", async () => {
    const w = await world(), other = await scratch.open("quality-report-wait");
    const edit = holdTx(w.db, async tx => {
      await tx.select().from(villages).where(eq(villages.id, w.village.id)).for("share");
      await tx.select().from(chatMessages).where(eq(chatMessages.id, w.message.id)).for("update");
      await tx.update(chatMessages).set({ body: "更新した原文。", changedSeq: 2 }).where(eq(chatMessages.id, w.message.id));
      await tx.delete(chatMessageTranslations).where(eq(chatMessageTranslations.messageId, w.message.id));
    });
    await edit.ready;
    const pending = createChatTranslationReport(other, w.readers[0], w.input).then(() => "accepted", (error: Error) => error.message);
    try { await waitForLockWait(await scratch.admin(), "quality-report-wait"); }
    finally { await edit.commit(); }
    expect(await pending).toBe("not_found");
    expect(await other.select().from(chatTranslationReports).where(eq(chatTranslationReports.messageId, w.message.id))).toHaveLength(0);
  });
});
