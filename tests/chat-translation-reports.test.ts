import { afterEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { addMember, createTestDb } from "./helpers/db";
import { consentChatMembers } from "./helpers/chat-consent";
import { chatConsents, chatMessages, chatMessageTranslations, chatTranslationReports, chatAccessLog, jobs, profiles, qualityMetricState, villageMembers, villages } from "~/lib/db/schema";
import { translationQualitySignals } from "~/lib/eval/signals.server";
import { mutateChat } from "~/lib/village-chat.server";
import { saveChatTranslation, chatSourceHash } from "~/lib/village-chat-translations.server";
import { createChatTranslationReport, listChatTranslationReports, readChatTranslationReport, moderateChatTranslationReport, pruneChatTranslationReports } from "~/lib/chat-translation-reports.server";
import { createChatTranslationReportHandlers } from "~/lib/jobs/chat-translation-report-jobs.server";
import { runDueJobs } from "~/lib/jobs/queue.server";
import { createFakeEngine } from "~/lib/llm/engines/fake.server";
import { createGlossaryEntry } from "~/lib/glossary.server";
import { hitRateLimit } from "~/lib/rate-limit.server";
import { CHAT_TRANSLATION_REPORT_LIMIT } from "~/lib/chat-translation-reports.server";
import { createChatTranslationHandlers } from "~/lib/jobs/chat-translation-jobs.server";
import { deleteAccount } from "~/lib/account-delete.server";
import { leakedReasoning } from "./helpers/translation-leak";

it("fails leaked chat retranslation once, preserving the existing text for moderator review", async () => {
  const w = await world(); await w.report(); let calls = 0;
  const engine = { ...createFakeEngine(), async translate() {
    calls++;
    return { text: leakedReasoning, model: "fake-1", promptVersion: "chat-v3", inputTokens: 10, outputTokens: 20 };
  } };
  expect(await runDueJobs(w.db, createChatTranslationReportHandlers({ chatEngine: engine }), { logger: { warn() {}, error() {} } })).toMatchObject({ failed: 1, retried: 0 });
  expect(calls).toBe(2);
  expect((await w.db.select().from(chatMessageTranslations))[0]).toMatchObject({ state: "ready", text: "Wrong translation" });
  expect((await w.db.select().from(chatTranslationReports))[0]).toMatchObject({ status: "open", retryAttemptedAt: expect.any(Date) });
  expect((await w.db.select().from(jobs))[0]).toMatchObject({ status: "failed", attempts: 1 });
  expect(JSON.stringify(await w.db.select().from(jobs))).not.toContain("Wait, the expression");
});

afterEach(() => vi.unstubAllEnvs());
async function world() {
  vi.stubEnv("VILLAGES", "1"); vi.stubEnv("VILLAGE_CHAT", "1"); vi.stubEnv("ENABLED_LANGS", "ja,en");
  const db = await createTestDb();
  for (const id of ["qrt_author", "qrt_reader", "qrt_second", "qrt_mod", "qrt_outside"]) await addMember(db, id, id, { readLangs: [id === "qrt_author" ? "ja" : "en"] });
  await db.update(profiles).set({ displayLang: "en", uiLocale: "en" }).where(eq(profiles.userId, "qrt_reader"));
  const [village] = await db.insert(villages).values({ slug: "quality-chat", kind: "open" }).returning();
  await db.insert(villageMembers).values(["qrt_author", "qrt_reader", "qrt_second"].map(userId => ({ villageId: village.id, userId })));
  await consentChatMembers(db);
  const sent = await mutateChat(db, "qrt_author", village.slug!, "send", { body: "こんにちは。" });
  const payload = { messageId: sent.id, lang: "en" as const, sourceHash: chatSourceHash("こんにちは。") };
  await saveChatTranslation(db, payload, { state: "ready", text: "Wrong translation", model: "fake-1" });
  await db.delete(jobs);
  const report = (id = "qrt_reader") => createChatTranslationReport(db, id, { slug: village.slug!, messageId: sent.id, lang: "en", note: "Meaning changed" });
  const actor = { id: "qrt_mod", scope: { operator: false, langs: ["en" as const] } };
  return { db, village, sent, payload, report, actor };
}
it("requires membership, consent, a visible foreign translation, and rejects duplicate reports", async () => {
  const w = await world();
  await expect(w.report("qrt_outside")).rejects.toThrow();
  await expect(w.report("qrt_author")).rejects.toThrow();
  await w.db.delete(chatConsents).where(eq(chatConsents.userId, "qrt_reader"));
  await expect(w.report()).rejects.toThrow();
  await consentChatMembers(w.db);
  expect(await w.report()).toMatchObject({ retry: true });
  await expect(w.report()).rejects.toThrow("duplicate");
  expect(await w.db.select().from(jobs)).toMatchObject([{ kind: "retranslate_chat_report" }]);
});
it("retranslates once with the chat engine and escalates a second report", async () => {
  const w = await world();
  await w.db.update(qualityMetricState).set({ startedAt: new Date(Date.now() - 10_000) });
  await w.report();
  const engine = createFakeEngine(); const call = vi.spyOn(engine, "translate");
  await runDueJobs(w.db, createChatTranslationReportHandlers({ chatEngine: engine }), { logger: { warn() {}, error() {} } });
  expect(call).toHaveBeenCalledTimes(1);
  expect(call.mock.calls[0][0].chat).toEqual({ context: [] });
  expect((await w.db.select().from(chatMessageTranslations))[0].text).toBe("[en] こんにちは。");
  expect(await w.report("qrt_second")).toMatchObject({ retry: false });
  expect((await listChatTranslationReports(w.db, w.actor)).items).toHaveLength(1);
  expect((await w.db.select().from(jobs)).filter(j => j.kind === "retranslate_chat_report")).toHaveLength(1);
  const signals = await translationQualitySignals(w.db);
  expect(signals.translations).toMatchObject([{ scope: "chat", from: "ja", to: "en", generated: 2, reports: 2, corrected: 1, reportRate: 1, correctionRate: 0.5 }]);
  expect(signals.translations[0].medianDays).toBeGreaterThanOrEqual(0);
  expect(JSON.stringify(signals)).not.toMatch(/qrt_|reporterId|messageId|Wrong translation/);
});
it("escalates unchanged output, audits evidence reads, and limits decisions to the translation target language", async () => {
  const w = await world(); const first = await w.report();
  const engine = { ...createFakeEngine(), async translate() { return { text: "Wrong translation", model: "fake-1", promptVersion: "chat-v3", inputTokens: 1, outputTokens: 1 }; } };
  await runDueJobs(w.db, createChatTranslationReportHandlers({ chatEngine: engine }), { logger: { warn() {}, error() {} } });
  expect((await listChatTranslationReports(w.db, w.actor)).items).toHaveLength(1);
  expect(await w.db.select().from(chatAccessLog)).toHaveLength(0);
  vi.stubEnv("VILLAGE_CHAT", "");
  expect((await listChatTranslationReports(w.db, w.actor)).items).toHaveLength(1);
  await expect(readChatTranslationReport(w.db, { ...w.actor, scope: { operator: false, langs: ["ja"] } }, first.id)).rejects.toThrow();
  expect(await readChatTranslationReport(w.db, w.actor, first.id)).toMatchObject({ original: "こんにちは。", translation: "Wrong translation" });
  expect(await w.db.select().from(chatAccessLog)).toMatchObject([{ translationReportId: first.id }]);
  await moderateChatTranslationReport(w.db, w.actor, first.id, "hide");
  expect((await w.db.select().from(chatTranslationReports))[0].correctedAt).toBeNull();
  expect((await w.db.select().from(chatMessageTranslations))[0]).toMatchObject({ state: "failed", text: null });
  const future = new Date(Date.now() + 181 * 86400000);
  expect(await pruneChatTranslationReports(w.db, future)).toBe(1);
  expect((await w.db.select().from(chatTranslationReports))[0]).toMatchObject({ original: null, translation: null, note: null });
});
it("does not overwrite an edited source after a report", async () => {
  const w = await world(); await w.report();
  await mutateChat(w.db, "qrt_author", w.village.slug!, "edit", { id: w.sent.id, body: "別の発言。" });
  const engine = createFakeEngine(); const call = vi.spyOn(engine, "translate");
  await runDueJobs(w.db, createChatTranslationReportHandlers({ chatEngine: engine }), { logger: { warn() {}, error() {} } });
  expect(call).not.toHaveBeenCalled();
  expect((await w.db.select().from(chatMessages))[0].body).toBe("別の発言。");
});
it("escalates a queued regeneration when chat is disabled and leaves the case reviewable", async () => {
  for (const flag of ["VILLAGE_CHAT", "VILLAGES"]) {
    const w = await world(); const first = await w.report();
    vi.stubEnv(flag, "");
    const engine = createFakeEngine(); const call = vi.spyOn(engine, "translate");
    await runDueJobs(w.db, createChatTranslationReportHandlers({ chatEngine: engine }), { logger: { warn() {}, error() {} } });
    expect(call).not.toHaveBeenCalled();
    expect((await w.db.select().from(chatTranslationReports))[0]).toMatchObject({ id: first.id, status: "open", retryAttemptedAt: null });
    expect((await listChatTranslationReports(w.db, w.actor)).items).toMatchObject([{ id: first.id }]);
    expect(await readChatTranslationReport(w.db, w.actor, first.id)).toMatchObject({ original: "こんにちは。", translation: "Wrong translation" });
    vi.stubEnv(flag, "1");
    await runDueJobs(w.db, createChatTranslationReportHandlers({ chatEngine: engine }), { logger: { warn() {}, error() {} } });
    expect(call).not.toHaveBeenCalled();
  }
});
it("passes the same matching glossary to ordinary chat translation and report regeneration", async () => {
  const w = await world();
  expect((await createGlossaryEntry(w.db, { userId: "qrt_mod", scope: { operator: true, langs: [] } }, { term: "こんにちは", lang: "ja", targetLang: "en", candidates: "Hello", note: "Greeting", keepOriginal: false, needsReview: false })).ok).toBe(true);
  const engine = createFakeEngine(); const call = vi.spyOn(engine, "translate");
  const sent = await mutateChat(w.db, "qrt_author", w.village.slug!, "send", { body: "こんにちは。こんにちは。" });
  await runDueJobs(w.db, createChatTranslationHandlers({ chatEngine: engine }), { logger: { warn() {}, error() {} } });
  const ordinary = call.mock.calls.find(([req]) => req.text === "こんにちは。こんにちは。")![0];
  expect(ordinary.glossary).toEqual([{ term: "こんにちは", candidates: ["Hello"], note: "Greeting" }]);
  await w.report();
  await runDueJobs(w.db, createChatTranslationReportHandlers({ chatEngine: engine }), { logger: { warn() {}, error() {} } });
  expect(call.mock.calls.at(-1)![0].glossary).toEqual(ordinary.glossary);
  expect(sent.id).not.toBe(w.sent.id);
});
it("caps accepted reports per member per hour", async () => {
  const w = await world();
  for (let n = 0; n < CHAT_TRANSLATION_REPORT_LIMIT.limit; n++) await hitRateLimit(w.db, { key: "chat-translation-report:qrt_reader", ...CHAT_TRANSLATION_REPORT_LIMIT });
  await expect(w.report()).rejects.toThrow("limit");
  expect(await w.db.select().from(chatTranslationReports)).toHaveLength(0);
  expect(await w.db.select().from(jobs)).toHaveLength(0);
});

it("closes an open or queued report and erases the copies of every report about the message, handled ones too, when the author deletes it", async () => {
  const w = await world(); const queued = await w.report();
  const engine = { ...createFakeEngine(), async translate() { return { text: "Wrong translation", model: "fake-1", promptVersion: "chat-v3", inputTokens: 1, outputTokens: 1 }; } };
  await runDueJobs(w.db, createChatTranslationReportHandlers({ chatEngine: engine }), { logger: { warn() {}, error() {} } });
  const open = await w.report("qrt_second");
  expect((await w.db.select().from(chatTranslationReports).where(eq(chatTranslationReports.id, queued.id)))[0].status).toBe("open");
  // A handled report on another message: its copy goes when that message is deleted, and who closed it stays.
  const other = await mutateChat(w.db, "qrt_author", w.village.slug!, "send", { body: "おはよう。" });
  await saveChatTranslation(w.db, { messageId: other.id, lang: "en", sourceHash: chatSourceHash("おはよう。") }, { state: "ready", text: "Good night" });
  await w.db.delete(jobs);
  const handled = await createChatTranslationReport(w.db, "qrt_reader", { slug: w.village.slug!, messageId: other.id, lang: "en", note: "Wrong word" });
  await w.db.update(chatTranslationReports).set({ status: "open" }).where(eq(chatTranslationReports.id, handled.id));
  await moderateChatTranslationReport(w.db, w.actor, handled.id, "dismiss");
  expect((await listChatTranslationReports(w.db, w.actor)).items).toHaveLength(2);
  await mutateChat(w.db, "qrt_author", w.village.slug!, "delete", { id: w.sent.id });
  await mutateChat(w.db, "qrt_author", w.village.slug!, "delete", { id: other.id });
  const rows = await w.db.select().from(chatTranslationReports).orderBy(chatTranslationReports.id);
  const forFirst = rows.filter(row => row.messageId === w.sent.id);
  expect(forFirst).toHaveLength(2);
  for (const row of forFirst) expect(row).toMatchObject({ status: "dismissed", original: null, translation: null, note: null });
  expect(forFirst.every(row => row.prunedAt !== null)).toBe(true);
  expect(rows.find(row => row.id === open.id)).toMatchObject({ original: null });
  const erasedHandled = rows.find(row => row.id === handled.id)!;
  expect(erasedHandled).toMatchObject({ status: "dismissed", original: null, translation: null, note: null, handledBy: w.actor.id });
  expect(erasedHandled.handledAt).not.toBeNull();
  expect(erasedHandled.prunedAt).not.toBeNull();
  expect((await listChatTranslationReports(w.db, w.actor)).items).toHaveLength(0);
  await expect(readChatTranslationReport(w.db, w.actor, queued.id)).rejects.toThrow();
  await runDueJobs(w.db, createChatTranslationReportHandlers({ chatEngine: engine }), { logger: { warn() {}, error() {} } });
  expect((await w.db.select().from(chatTranslationReports).where(eq(chatTranslationReports.id, queued.id)))[0]).toMatchObject({ status: "dismissed" });
  // Nothing is left for the retention period to empty.
  expect(await pruneChatTranslationReports(w.db, new Date(Date.now() + 181 * 86400000))).toBe(0);
});
it("account deletion closes reports on the leaver's messages and erases the note the leaver wrote on others'", async () => {
  const w = await world(); const mine = await w.report("qrt_reader");
  await deleteAccount(w.db, "qrt_author", { confirmation: "qrt_author" });
  expect((await w.db.select().from(chatTranslationReports).where(eq(chatTranslationReports.id, mine.id)))[0]).toMatchObject({ status: "dismissed", original: null, translation: null, note: null });
  expect((await listChatTranslationReports(w.db, w.actor)).items).toHaveLength(0);
  const v = await world(); await v.report("qrt_reader");
  await deleteAccount(v.db, "qrt_reader", { confirmation: "qrt_reader" });
  const [kept] = await v.db.select().from(chatTranslationReports);
  expect(kept).toMatchObject({ reporterId: null, note: null, status: "retry", original: "こんにちは。", translation: "Wrong translation" });
});
