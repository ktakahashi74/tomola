import { afterEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { addMember, createTestDb } from "./helpers/db";
import { consentChatMembers } from "./helpers/chat-consent";
import { chatAccessLog, chatMessages, chatReportSnapshots, entries, jobs, moderationActions, reports, villageMembers, villages } from "~/lib/db/schema";
import { createReply, createTopic } from "~/lib/entries.server";
import { automaticallyHideEntry } from "~/lib/moderation-automation.server";
import { createReport, listReportCards } from "~/lib/moderation.server";
import { createChatReport, readChatEvidence } from "~/lib/village-chat-reports.server";
import { createAppeal, getAppealableAction } from "~/lib/appeals.server";
import { mutateChat } from "~/lib/village-chat.server";
import { createModerationHandlers } from "~/lib/jobs/moderation-jobs.server";
import { runDueJobs } from "~/lib/jobs/queue.server";
import { assertStartupConfig } from "~/lib/startup-checks.server";
import { scoreAbuse } from "~/lib/abuse";

afterEach(() => vi.unstubAllEnvs());
const now = new Date("2026-10-10T12:00:00Z");
const advertisement = "Buy now: this repeated advertising offer https://example.org/offer";
const reviewer = { id: "reg_mod", scope: { operator: true, langs: [] } };
async function world() {
  const db = await createTestDb();
  for (const id of ["reg_writer", "reg_reader", "reg_mod"]) await addMember(db, id, id);
  return db;
}
async function chatWorld() {
  vi.stubEnv("VILLAGES", "1"); vi.stubEnv("VILLAGE_CHAT", "1");
  const db = await world();
  for (const slug of ["reg-chat-one", "reg-chat-two", "reg-chat-three"]) {
    const [village] = await db.insert(villages).values({ slug, name: slug, kind: "invite_public" }).returning();
    await db.insert(villageMembers).values(["reg_writer", "reg_reader"].map(userId => ({ villageId: village.id, userId, role: "member" })));
  }
  await consentChatMembers(db);
  const send = (body: string, slug = "reg-chat-one") => mutateChat(db, "reg_writer", slug, "send", { body });
  return { db, send };
}
const topic = (db: Awaited<ReturnType<typeof world>>, body: string, date = now) => createTopic(db, "reg_writer", { title: "Regression example", body, lang: "en" }, { now: date });

it("normalizes repetition length and requires independent spam signals in busy chat", () => {
  const score = (body: string, chat = false, recentCount = 3) => scoreAbuse({ body, previous: [body, body], recentCount, chat });
  expect(score("a".repeat(19)).score).toBe(0);
  expect(score("Ａ".repeat(20)).score).toBe(7);
  expect(score("👍".repeat(30)).score).toBe(0);
  expect(score("!".repeat(30)).score).toBe(0);
  expect(score("An ordinary repeated notice for everyone.", true, 20).score).toBeLessThan(7);
  expect(score(advertisement, true).score).toBeGreaterThanOrEqual(7);
  expect(scoreAbuse({ body: "Ordinary conversation", previous: [], recentCount: 17, chat: true }).score).toBe(0);
  expect(scoreAbuse({ body: "Ordinary conversation", previous: [], recentCount: 18, chat: true }).score).toBe(3);
  expect(scoreAbuse({ body: "Ordinary conversation", previous: [], recentCount: 12 }).score).toBe(7);
});

it("keeps short acknowledgments and symbol-only repetitions visible in public replies", async () => {
  const db = await world(), root = await topic(db, "A conversation");
  if (!root.ok) throw new Error(root.error);
  vi.stubEnv("MODERATION_SPAM_ENABLED", "1");
  for (const body of ["了解です", "👍".repeat(25)]) {
    for (let n = 0; n < 3; n++) {
      const reply = await createReply(db, "reg_writer", root.id, { body, lang: "en" }, { now: new Date(now.getTime() + n * 120_000) });
      expect(reply.ok).toBe(true);
    }
  }
  expect(await db.select().from(moderationActions)).toEqual([]);
});

it("ignores repetitions outside ten minutes but still hides repeated linked advertisements inside the window", async () => {
  const db = await world(); vi.stubEnv("MODERATION_SPAM_ENABLED", "1");
  for (let n = 0; n < 3; n++) await topic(db, advertisement, new Date(now.getTime() + n * 86400_000));
  expect(await db.select().from(moderationActions)).toEqual([]);
  const later = new Date(now.getTime() + 3 * 86400_000);
  for (let n = 0; n < 3; n++) await topic(db, advertisement, new Date(later.getTime() + n * 120_000));
  expect(await db.select().from(moderationActions)).toHaveLength(1);
});

it("keeps acknowledgments, cross-village notices and rapid ordinary chat visible", async () => {
  const { db, send } = await chatWorld(); vi.stubEnv("MODERATION_SPAM_ENABLED", "1");
  for (let n = 0; n < 3; n++) await send("ありがとう");
  for (const slug of ["reg-chat-one", "reg-chat-two", "reg-chat-three"]) await send("The meeting starts tomorrow at the usual time.", slug);
  for (let n = 0; n < 14; n++) await send(`Ordinary conversation message number ${n}`);
  expect(await db.select().from(moderationActions)).toEqual([]);
  // Even repetition plus a rapid conversation needs an independent link/promotion signal.
  for (let n = 0; n < 3; n++) await send("An ordinary repeated notice for everyone here.");
  expect(await db.select().from(moderationActions)).toEqual([]);
});

it("ignores old chat repetitions and captures the automatically hidden edit rather than an earlier report version", async () => {
  const { db, send } = await chatWorld();
  const target = await send("Original reported version");
  await createChatReport(db, "reg_reader", { slug: "reg-chat-one", messageId: target.id, reason: "other" });
  await send(advertisement); await send(advertisement);
  await db.update(chatMessages).set({ createdAt: new Date(Date.now() - 86400_000) });
  vi.stubEnv("MODERATION_SPAM_ENABLED", "1");
  await send(advertisement);
  expect(await db.select().from(moderationActions)).toEqual([]);
  await send(advertisement);
  const edited = await mutateChat(db, "reg_writer", "reg-chat-one", "edit", { id: target.id, body: advertisement });
  const [action] = await db.select().from(moderationActions);
  expect(action).toMatchObject({ targetChatMessageId: target.id, automatic: true });
  const [snapshot] = await db.select().from(chatReportSnapshots).where(eq(chatReportSnapshots.messageId, target.id));
  expect(snapshot).toMatchObject({ body: advertisement, changedSeq: edited.seq, prunedAt: null });
  expect((await getAppealableAction(db, "reg_writer", action.id))?.chat?.body).toBe(advertisement);
  const appeal = await createAppeal(db, "reg_writer", action.id, "Review this version"); if (!appeal.ok) throw new Error(appeal.error);
  const evidence = await readChatEvidence(db, reviewer, { kind: "appeal", id: appeal.id }, { intent: "open" });
  expect(evidence.snapshot?.body).toBe(advertisement);
  expect((await listReportCards(db, reviewer.scope, { handled: true })).cards[0].reports[0]).toMatchObject({ automaticallyResolved: true });
});

it("returns chat AI assessments only with audited evidence reads", async () => {
  const { db, send } = await chatWorld(), target = await send("Private evidence");
  const report = await createChatReport(db, "reg_reader", { slug: "reg-chat-one", messageId: target.id, reason: "other" });
  const assessment = { en: "PRIVATE_AI_ASSESSMENT", ja: "非公開の見立て" };
  await db.update(reports).set({ aiPriority: "urgent", aiAssessment: assessment }).where(eq(reports.id, report.id));
  const cards = await listReportCards(db, reviewer.scope);
  expect(cards.cards[0].reports[0]).toMatchObject({ aiPriority: "urgent" });
  expect(JSON.stringify(cards)).not.toContain("PRIVATE_AI_ASSESSMENT");
  expect(await db.select().from(chatAccessLog)).toEqual([]);
  const opened = await readChatEvidence(db, reviewer, { kind: "report", id: report.id }, { intent: "open" });
  expect(opened).toMatchObject({ assessments: [{ aiPriority: "urgent", aiAssessment: assessment }] });
  expect(await db.select().from(chatAccessLog)).toHaveLength(1);
});

it("distinguishes automatically resolved reports from null-actor closures and later human decisions", async () => {
  const db = await world(), root = await topic(db, "Reported example"); if (!root.ok) throw new Error(root.error);
  const report = await createReport(db, "reg_reader", { entryId: root.id, reason: "other" }); if (!report.ok) throw new Error(report.error);
  await db.transaction(tx => automaticallyHideEntry(tx, root.id, "Automated reason", now));
  const summary = async () => (await listReportCards(db, reviewer.scope, { handled: true })).cards[0].reports[0];
  expect(await summary()).toMatchObject({ automaticallyResolved: true });
  await db.update(reports).set({ handledAt: new Date(now.getTime() + 1000) }).where(eq(reports.id, report.id));
  expect(await summary()).toMatchObject({ automaticallyResolved: false });
  await db.update(reports).set({ handledBy: "reg_mod", handledAt: now }).where(eq(reports.id, report.id));
  expect(await summary()).toMatchObject({ automaticallyResolved: false });
});

it.each(["moderation_spam", "moderation_triage"])("revisits disabled %s jobs in one hour, preserving the existing budget delay", async kind => {
  const db = await world(), root = await topic(db, "See https://example.org"); if (!root.ok) throw new Error(root.error);
  const [entry] = await db.select().from(entries).where(eq(entries.id, root.id));
  const report = await createReport(db, "reg_reader", { entryId: root.id, reason: "other" }); if (!report.ok) throw new Error(report.error);
  await db.insert(jobs).values({ kind, payload: kind === "moderation_spam" ? { entryId: root.id, sourceHash: entry.sourceHash } : { reportId: report.id }, runAt: now });
  const handlers = createModerationHandlers();
  expect((await runDueJobs(db, handlers, { now })).deferred).toBe(1);
  expect((await db.select().from(jobs).where(eq(jobs.kind, kind)))[0].runAt).toEqual(new Date(now.getTime() + 3600_000));
  vi.stubEnv("MODERATION_SPAM_ENABLED", "1"); vi.stubEnv("MODERATION_AI_SPAM_ENABLED", "1"); vi.stubEnv("MODERATION_AI_TRIAGE_ENABLED", "1"); vi.stubEnv("LLM_MONTHLY_BUDGET_USD", "0");
  const resumed = new Date(now.getTime() + 3600_000);
  expect((await runDueJobs(db, handlers, { now: resumed })).deferred).toBe(1);
  expect((await db.select().from(jobs).where(eq(jobs.kind, kind)))[0].runAt).toEqual(new Date(resumed.getTime() + 15 * 60_000));
});

it("rejects malformed moderation switches and mismatched models at startup even with switches closed", () => {
  const base = { NODE_ENV: "test", TRANSLATION_PRIMARY: "fake" };
  for (const name of ["MODERATION_SPAM_ENABLED", "MODERATION_AI_SPAM_ENABLED", "MODERATION_AI_TRIAGE_ENABLED"]) {
    for (const value of ["0", "true", "yes", " 1 "]) expect(() => assertStartupConfig({ TOMOLA_OPERATOR_DIR: process.env.TOMOLA_OPERATOR_DIR, ...base, [name]: value })).toThrow(name);
    for (const value of ["", "1", undefined]) expect(() => assertStartupConfig({ TOMOLA_OPERATOR_DIR: process.env.TOMOLA_OPERATOR_DIR, ...base, [name]: value })).not.toThrow();
  }
  for (const [provider, model] of [["gemini", "claude-wrong"], ["claude", "gemini-wrong"]]) {
    expect(() => assertStartupConfig({ TOMOLA_OPERATOR_DIR: process.env.TOMOLA_OPERATOR_DIR, ...base, TRANSLATION_PRIMARY: provider, MODERATION_AI_MODEL: model })).toThrow("MODERATION_AI_MODEL");
  }
  for (const [provider, model] of [["gemini", "gemini-test"], ["claude", "claude-test"], ["fake", "fake-moderation"]]) {
    expect(() => assertStartupConfig({ TOMOLA_OPERATOR_DIR: process.env.TOMOLA_OPERATOR_DIR, ...base, TRANSLATION_PRIMARY: provider, MODERATION_AI_MODEL: model })).not.toThrow();
  }
});
