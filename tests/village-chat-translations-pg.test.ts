import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { addMember } from "./helpers/db";
import { consentChatMembers, consentedChatPage as chatPage } from "./helpers/chat-consent";
import { createScratchDb, REAL_PG_URL, type ScratchDb } from "./helpers/pg-real";
import { expectPending, expectSettlesWithin, holdTx, waitForLockWait } from "./helpers/pg-concurrency";
import { chatMessageTranslations, chatMessages, chatSequences, jobs, llmUsage, profiles, villageMembers, villages } from "~/lib/db/schema";
import { chatChanges, currentChatSequence, mutateChat, nextChatSequence } from "~/lib/village-chat.server";
import { chatSourceHash, clearChatTranslations, saveChatTranslation } from "~/lib/village-chat-translations.server";
import { createChatTranslationHandlers } from "~/lib/jobs/chat-translation-jobs.server";
import { createFakeEngine } from "~/lib/llm/engines/fake.server";

describe.skipIf(!REAL_PG_URL)("chat translation PostgreSQL locking and migration", { tags: ["postgres"] }, () => {
  let scratch: ScratchDb, index = 0;
  beforeAll(async () => { scratch = await createScratchDb(); }, 120000);
  afterAll(async () => { await scratch?.drop(); }, 60000);
  afterEach(async () => { vi.unstubAllEnvs(); await scratch.closeOpened(); });
  async function world() {
    vi.stubEnv("VILLAGES", "1"); vi.stubEnv("VILLAGE_CHAT", "1"); vi.stubEnv("ENABLED_LANGS", "ja,en,fr");
    const db = await scratch.open(); const author = `ctpg_author${++index}`, reader = `ctpg_reader${index}`;
    await addMember(db, author, author, { homeArea: "ja" }); await addMember(db, reader, reader, { homeArea: "en", readLangs: ["en"] });
    await db.update(profiles).set({ displayLang: "en", uiLocale: "en" }).where(eq(profiles.userId, reader));
    const [village] = await db.insert(villages).values({ slug: `ctpg${index}`, kind: "open" }).returning();
    await db.insert(villageMembers).values([{ villageId: village.id, userId: author }, { villageId: village.id, userId: reader }]); await consentChatMembers(db);
    const sent = await mutateChat(db, author, village.slug!, "send", { body: "こんにちは。" });
    const payload = { messageId: sent.id, lang: "en" as const, sourceHash: chatSourceHash("こんにちは。") };
    return { db, author, reader, village, sent, payload };
  }
  it("applies the chat purpose CHECK and rejects unrelated purposes", async () => {
    const w = await world();
    await w.db.insert(llmUsage).values({ engine: "fake", model: "fake-1", purpose: "chat", inputTokens: 1, outputTokens: 1, costUsdMicro: 0 });
    await expect(w.db.insert(llmUsage).values({ engine: "fake", model: "fake-1", purpose: "unrelated", inputTokens: 1, outputTokens: 1, costUsdMicro: 0 })).rejects.toThrow();
  });
  it("rechecks the source after waiting for an editing transaction and never resurrects old output", async () => {
    const w = await world();
    const edit = holdTx(w.db, async tx => {
      await tx.select().from(villages).where(eq(villages.id, w.village.id)).for("share");
      await tx.select().from(chatMessages).where(eq(chatMessages.id, w.sent.id)).for("update");
      await clearChatTranslations(tx, [w.sent.id]);
      const seq = await nextChatSequence(tx, w.village.id);
      await tx.update(chatMessages).set({ body: "直した発言。", changedSeq: seq }).where(eq(chatMessages.id, w.sent.id));
    }); await edit.ready;
    const other = await scratch.open("chat-stale-save");
    const save = saveChatTranslation(other, w.payload, { state: "ready", text: "Old translation" });
    try { await waitForLockWait(await scratch.admin(), "chat-stale-save"); await expectPending(save); }
    finally { await edit.commit(); }
    expect(await save).toBe(false); expect(await other.select().from(chatMessageTranslations).where(eq(chatMessageTranslations.messageId, w.sent.id))).toEqual([]);
  });
  it("commits translation and its change cursor together, and serializes parallel languages", async () => {
    const w = await world();
    const gate = holdTx(w.db, tx => tx.select().from(chatSequences).where(eq(chatSequences.villageId, w.village.id)).for("update")); await gate.ready;
    const other = await scratch.open("chat-sequence-save");
    const save = saveChatTranslation(other, w.payload, { state: "ready", text: "English" });
    try {
      await waitForLockWait(await scratch.admin(), "chat-sequence-save"); await expectPending(save);
      expect(await currentChatSequence(w.db, w.village.id)).toBe(w.sent.seq);
      expect((await w.db.select().from(chatMessageTranslations).where(eq(chatMessageTranslations.messageId, w.sent.id)))[0].state).toBe("pending");
    } finally { await gate.commit(); }
    expect(await save).toBe(true);
    const saves = await Promise.all([
      saveChatTranslation(w.db, w.payload, { state: "ready", text: "English updated" }),
      saveChatTranslation(other, { ...w.payload, lang: "fr" }, { state: "ready", text: "French" }),
    ]); expect(saves).toEqual([true, true]);
    expect(await currentChatSequence(w.db, w.village.id)).toBe(w.sent.seq + 3);
    expect((await chatChanges(w.db, w.reader, w.village.slug!, { since: w.sent.seq })).messages[0]).toMatchObject({ changedSeq: w.sent.seq + 3, translation: { text: "English updated", state: "ready" } });
  });
  it("deduplicates concurrent read requests without queuing other page languages", async () => {
    const w = await world(); await w.db.delete(chatMessageTranslations).where(eq(chatMessageTranslations.messageId, w.sent.id)); await w.db.delete(jobs);
    const other = await scratch.open("chat-parallel-read");
    await Promise.all([chatPage(w.db, w.reader, w.village.slug!), chatPage(other, w.reader, w.village.slug!, { topics: { displayLang: "fr", readLangs: [], langParam: "fr" } })]);
    expect(await w.db.select().from(jobs)).toMatchObject([{ kind: "translate_chat", payload: { messageId: w.sent.id, lang: "en" } }]);
    expect(await w.db.select().from(jobs)).toHaveLength(1);
  });
  it.each(["pending", "ready"] as const)("does not serialize two readers of an existing %s translation", async state => {
    const w = await world(); if (state === "ready") await saveChatTranslation(w.db, w.payload, { state: "ready", text: "English" });
    const first = holdTx(w.db, tx => chatPage(tx, w.reader, w.village.slug!)); await first.ready;
    const other = await scratch.open("chat-independent-ready-read");
    const reading = chatPage(other, w.reader, w.village.slug!);
    try { expect(await expectSettlesWithin(reading, 2500, "second translated read")).toMatchObject({ messages: [{ translation: { state } }] }); }
    finally { await first.commit(); await reading; }
  });
  it("allows readers requesting different missing languages to share the message lock", async () => {
    const w = await world(), third = `ctpg_third${index}`;
    await addMember(w.db, third, third, { homeArea: "fr", readLangs: ["fr"] });
    await w.db.update(profiles).set({ displayLang: "fr", uiLocale: "fr" }).where(eq(profiles.userId, third));
    await w.db.insert(villageMembers).values({ villageId: w.village.id, userId: third }); await consentChatMembers(w.db);
    await w.db.delete(chatMessageTranslations).where(eq(chatMessageTranslations.messageId, w.sent.id)); await w.db.delete(jobs);
    const first = holdTx(w.db, tx => chatPage(tx, w.reader, w.village.slug!)); await first.ready;
    const other = await scratch.open("chat-independent-missing-read");
    const reading = chatPage(other, third, w.village.slug!);
    try { expect(await expectSettlesWithin(reading, 2500, "different-language read")).toMatchObject({ messages: [{ translation: { state: "pending", lang: "fr" } }] }); }
    finally { await first.commit(); await reading; }
    expect(await w.db.select().from(jobs)).toHaveLength(2);
  });
  it("reads ready translations without waiting for a source-row write lock", async () => {
    const w = await world(); await saveChatTranslation(w.db, w.payload, { state: "ready", text: "English" });
    const held = holdTx(w.db, tx => tx.select().from(chatMessages).where(eq(chatMessages.id, w.sent.id)).for("update")); await held.ready;
    const other = await scratch.open("chat-ready-with-source-write");
    const reading = chatPage(other, w.reader, w.village.slug!);
    try { expect(await expectSettlesWithin(reading, 2500, "ready read with a writer")).toMatchObject({ messages: [{ translation: { state: "ready" } }] }); }
    finally { await held.rollback(); await reading; }
  });
  it("skips the engine when ready commits while the worker waits to prepare pending", async () => {
    const w = await world();
    const usage = await w.db.select().from(llmUsage);
    const [job] = await w.db.select().from(jobs).where(eq(jobs.dedupeKey, `translate-chat:${w.sent.id}:en:${w.payload.sourceHash}`));
    const finishing = holdTx(w.db, tx => saveChatTranslation(tx, w.payload, { state: "ready", text: "English" })); await finishing.ready;
    const other = await scratch.open("chat-recovered-ready");
    const engine = { ...createFakeEngine(), translate: vi.fn(createFakeEngine().translate) };
    const running = createChatTranslationHandlers({ chatEngine: engine }).translate_chat({ ...job, status: "running", attempts: 1 }, { db: other, now: new Date() });
    try { await waitForLockWait(await scratch.admin(), "chat-recovered-ready"); await expectPending(running); }
    finally { await finishing.commit(); }
    await running; expect(engine.translate).not.toHaveBeenCalled();
    expect(await currentChatSequence(w.db, w.village.id)).toBe(w.sent.seq + 1);
    expect(await w.db.select().from(chatMessageTranslations).where(eq(chatMessageTranslations.messageId, w.sent.id))).toMatchObject([{ state: "ready", text: "English" }]);
    expect(await w.db.select().from(llmUsage)).toEqual(usage);
  });
  it("commits the recreation limit and cursor together under concurrent readers", async () => {
    const w = await world(); const [job] = await w.db.select().from(jobs).where(eq(jobs.dedupeKey, `translate-chat:${w.sent.id}:en:${w.payload.sourceHash}`));
    await w.db.update(jobs).set({ status: "failed", attempts: 5 }).where(eq(jobs.id, job.id));
    await w.db.insert(jobs).values(Array.from({ length: 3 }, () => ({ kind: job.kind, payload: job.payload, dedupeKey: job.dedupeKey, status: "failed", attempts: 5, maxAttempts: 5 })));
    const gate = holdTx(w.db, tx => tx.select().from(chatSequences).where(eq(chatSequences.villageId, w.village.id)).for("update")); await gate.ready;
    const first = await scratch.open("chat-cap-first"), second = await scratch.open("chat-cap-second");
    const reading = chatPage(first, w.reader, w.village.slug!);
    let parallel: ReturnType<typeof chatPage> | undefined;
    try {
      await waitForLockWait(await scratch.admin(), "chat-cap-first");
      expect((await w.db.select().from(chatMessageTranslations).where(eq(chatMessageTranslations.messageId, w.sent.id)))[0].state).toBe("pending");
      expect(await currentChatSequence(w.db, w.village.id)).toBe(w.sent.seq);
      parallel = chatPage(second, w.reader, w.village.slug!);
      await waitForLockWait(await scratch.admin(), "chat-cap-second"); await expectPending(parallel);
    } finally { await gate.commit(); await Promise.all([reading, parallel]); }
    for (const page of await Promise.all([reading, parallel])) expect(page).toMatchObject({ messages: [{ translation: { state: "failed", text: null } }] });
    expect(await currentChatSequence(w.db, w.village.id)).toBe(w.sent.seq + 1);
    expect(await w.db.select().from(jobs).where(eq(jobs.dedupeKey, job.dedupeKey!))).toHaveLength(4);
    expect((await chatChanges(w.db, w.reader, w.village.slug!, { since: w.sent.seq })).messages[0]).toMatchObject({ changedSeq: w.sent.seq + 1, translation: { state: "failed" } });
  });
  it("defers a newly reached recreation cap until readers hold exclusive message locks", async () => {
    const w = await world();
    const [job] = await w.db.select().from(jobs).where(eq(jobs.dedupeKey, `translate-chat:${w.sent.id}:en:${w.payload.sourceHash}`));
    await w.db.delete(chatMessageTranslations).where(eq(chatMessageTranslations.messageId, w.sent.id));
    await w.db.update(jobs).set({ status: "done" }).where(eq(jobs.id, job.id));
    await w.db.insert(jobs).values(Array.from({ length: 3 }, () => ({ kind: job.kind, payload: job.payload, dedupeKey: job.dedupeKey, status: "done", attempts: 5, maxAttempts: 5 })));
    const gate = holdTx(w.db, tx => tx.select().from(chatMessages).where(eq(chatMessages.id, w.sent.id)).for("update")); await gate.ready;
    const first = await scratch.open("chat-late-cap-first"), second = await scratch.open("chat-late-cap-second");
    const reading = chatPage(first, w.reader, w.village.slug!), parallel = chatPage(second, w.reader, w.village.slug!);
    const outcomes = Promise.allSettled([reading, parallel]);
    try {
      const admin = await scratch.admin();
      await waitForLockWait(admin, "chat-late-cap-first"); await waitForLockWait(admin, "chat-late-cap-second");
      await w.db.update(jobs).set({ status: "failed", attempts: 5 }).where(eq(jobs.dedupeKey, job.dedupeKey!));
    } finally { await gate.commit(); }
    const results = await expectSettlesWithin(outcomes, 5000, "parallel reads after late job recovery");
    expect(results.map(result => result.status)).toEqual(["fulfilled", "fulfilled"]);
    for (const result of results) if (result.status === "fulfilled") expect(result.value).toMatchObject({ messages: [{ translation: { state: "pending" } }] });
    expect(await currentChatSequence(w.db, w.village.id)).toBe(w.sent.seq);
    await w.db.update(jobs).set({ status: "failed" }).where(eq(jobs.dedupeKey, job.dedupeKey!));
    expect(await chatPage(w.db, w.reader, w.village.slug!)).toMatchObject({ messages: [{ translation: { state: "failed" } }] });
    expect(await currentChatSequence(w.db, w.village.id)).toBe(w.sent.seq + 1);
  });

});
