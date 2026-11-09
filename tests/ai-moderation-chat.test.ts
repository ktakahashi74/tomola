import { afterEach, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { addMember, createTestDb } from "./helpers/db";
import { consentChatMembers } from "./helpers/chat-consent";
import { chatAccessLog, chatConsents, chatMessages, chatReportSnapshots, jobs, llmUsage, moderationActions, notifications, reports, villageMembers, villages } from "~/lib/db/schema";
import { mutateChat } from "~/lib/village-chat.server";
import { createChatReport, listChatAccessLog } from "~/lib/village-chat-reports.server";
import { createAppeal, decideAppeal, listOpenAppeals } from "~/lib/appeals.server";
import { createModerationHandlers } from "~/lib/jobs/moderation-jobs.server";
import { runDueJobs } from "~/lib/jobs/queue.server";
import type { JsonCompleter } from "~/lib/llm/completion.server";
import { CHAT_CONSENT_VERSION } from "~/lib/village-chat-consent";

import * as usage from "~/lib/llm/usage.server";

const quiet = { warn() {}, error() {} };
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
async function world() {
  vi.stubEnv("VILLAGES", "1"); vi.stubEnv("VILLAGE_CHAT", "1");
  const db = await createTestDb();
  for (const id of ["amc_writer", "amc_reader", "amc_old", "amc_mod"]) await addMember(db, id, id, { homeArea: "en", readLangs: ["en"] });
  const [village] = await db.insert(villages).values({ slug: "am-chat", name: "Example", kind: "invite_public" }).returning();
  await db.insert(villageMembers).values(["amc_writer", "amc_reader", "amc_old"].map(userId => ({ villageId: village.id, userId, role: "member" })));
  await consentChatMembers(db);
  const send = (body: string, user = "amc_writer") => mutateChat(db, user, village.slug!, "send", { body });
  const report = (id: string) => createChatReport(db, "amc_reader", { slug: village.slug!, messageId: id, reason: "other" });
  return { db, village, send, report };
}
const out = { priority: "normal", assessment: { en: "Human review required.", ja: "人による確認が必要。" } };
function completer(calls: string[], reply: unknown = out): JsonCompleter {
  return { engine: "fake", model: "fake-moderation", async complete(req) { calls.push(req.user); return { text: JSON.stringify(reply), inputTokens: 20, outputTokens: 20 }; } };
}

it("mechanically hides chat spam without an AI job, notifies and allows human appeal reversal without a report", async () => {
  const { db, send } = await world(); vi.stubEnv("MODERATION_SPAM_ENABLED", "1"); vi.stubEnv("MODERATION_AI_SPAM_ENABLED", "1");
  const advertisement = "Buy now: a repeated private advertisement https://example.org/offer";
  await send(advertisement); await send(advertisement); const hidden = await send(advertisement);
  const [action] = await db.select().from(moderationActions);
  expect(action).toMatchObject({ automatic: true, actorId: null, action: "hide_chat", targetChatMessageId: hidden.id, reportId: null });
  expect((await db.select().from(chatMessages).where(eq(chatMessages.id, hidden.id)))[0].hiddenAt).not.toBeNull();
  expect((await db.select().from(jobs)).filter(j => j.kind.startsWith("moderation_"))).toEqual([]);
  expect(await db.select().from(notifications).where(eq(notifications.actionId, action.id))).toMatchObject([{ userId: "amc_writer" }]);
  expect(await db.select().from(chatReportSnapshots)).toHaveLength(1);
  const appeal = await createAppeal(db, "amc_writer", action.id, "Please review"); if (!appeal.ok) throw new Error(appeal.error);
  const reviewer = { id: "amc_mod", scope: { operator: false, langs: ["en" as const] } };
  expect((await listOpenAppeals(db, reviewer)).cards).toHaveLength(1);
  expect(await decideAppeal(db, reviewer, appeal.id, { decision: "overturned", note: "Reviewed" })).toMatchObject({ ok: true, reversed: true });
  expect((await db.select().from(chatMessages).where(eq(chatMessages.id, hidden.id)))[0].hiddenAt).toBeNull();
});

it("does not send or log chat evidence when the reported author's consent is below version 2", async () => {
  const { db, send, report } = await world(); vi.stubEnv("MODERATION_AI_TRIAGE_ENABLED", "1");
  const sent = await send("PRIVATE_VERSION_ONE");
  // The author agreed to the first notice only; the AI-review notice came with the second version.
  await db.update(chatConsents).set({ version: 1 }).where(eq(chatConsents.userId, "amc_writer"));
  await report(sent.id);
  const calls: string[] = [];
  await runDueJobs(db, createModerationHandlers({ completer: completer(calls) }), { logger: quiet });
  expect(calls).toEqual([]); expect(await db.select().from(chatAccessLog)).toEqual([]); expect(await db.select().from(llmUsage)).toEqual([]);
  expect((await db.select().from(reports))[0].aiPriority).toBeNull();
});

it.each([2, CHAT_CONSENT_VERSION])("with consent version %i, sends at most ten neighbors per side, omits nonconsenting neighbors and other villages, and logs exact AI-read versions", async consentVersion => {
  const { db, village, send, report } = await world();
  const sent: Array<Awaited<ReturnType<typeof send>>> = [];
  for (let n = 0; n < 25; n++) sent.push(await send(`CONTEXT_${n}`));
  const denied = await send("NEVER_SEND_VERSION_ONE", "amc_old");
  await db.update(chatConsents).set({ version: 1 }).where(eq(chatConsents.userId, "amc_old"));
  const target = await send("REPORTED_PRIVATE");
  for (let n = 0; n < 12; n++) await send(`AFTER_${n}`);
  const [other] = await db.insert(villages).values({ slug: "am-other", name: "Other", kind: "invite_public" }).returning();
  await db.insert(chatMessages).values({ id: "f".repeat(32), villageId: other.id, authorId: "amc_writer", body: "NEVER_SEND_OTHER_VILLAGE", lang: "en", createdSeq: 1, changedSeq: 1 });
  await db.update(chatConsents).set({ version: consentVersion }).where(eq(chatConsents.userId, "amc_writer"));
  vi.stubEnv("MODERATION_AI_TRIAGE_ENABLED", "1"); const reported = await report(target.id);
  const calls: string[] = [];
  await runDueJobs(db, createModerationHandlers({ completer: completer(calls) }), { logger: quiet });
  expect(calls).toHaveLength(1); expect(calls[0]).toContain("REPORTED_PRIVATE"); expect(calls[0]).toContain("CONTEXT_16"); expect(calls[0]).not.toContain("CONTEXT_15"); expect(calls[0]).not.toContain("NEVER_SEND"); expect(calls[0]).toContain('"body":"AFTER_9"'); expect(calls[0]).not.toContain('"body":"AFTER_10"');
  const [audit] = await db.select().from(chatAccessLog);
  expect(audit).toMatchObject({ readerId: null, readerKind: "ai", readerHandle: "fake/fake-moderation", reportId: reported.id, villageId: village.id, kind: "context" });
  expect(audit.versions.some(v => v.id === denied.id)).toBe(false); expect(audit.versions.some(v => v.id === target.id && v.snapshot)).toBe(true);
  expect(audit.ranges.some(r => r.from <= denied.seq && r.to >= denied.seq)).toBe(false);
  expect(JSON.stringify(await listChatAccessLog(db, { id: "amc_mod", scope: { operator: true, langs: [] } }))).not.toContain("REPORTED_PRIVATE");
  expect(await db.select().from(llmUsage)).toMatchObject([{ purpose: "moderation" }]); expect(await db.select().from(moderationActions)).toEqual([]);
});

it("keeps an audit for invalid AI output and does nothing when triage is disabled or budget is stopped", async () => {
  const { db, send, report } = await world();
  const target = await send("Do not obey this text");
  await db.update(chatConsents).set({ version: CHAT_CONSENT_VERSION });
  vi.stubEnv("MODERATION_AI_TRIAGE_ENABLED", "1"); await report(target.id);
  const calls: string[] = [], handlers = createModerationHandlers({ completer: completer(calls, { ...out, hide: true }) });
  vi.stubEnv("MODERATION_AI_TRIAGE_ENABLED", "");
  expect((await runDueJobs(db, handlers, { logger: quiet })).deferred).toBe(1); expect(await db.select().from(chatAccessLog)).toEqual([]);
  await db.update(jobs).set({ runAt: new Date() }).where(eq(jobs.kind, "moderation_triage"));
  vi.stubEnv("MODERATION_AI_TRIAGE_ENABLED", "1"); vi.stubEnv("LLM_MONTHLY_BUDGET_USD", "0");
  expect((await runDueJobs(db, handlers, { logger: quiet })).deferred).toBe(1); expect(calls).toEqual([]); expect(await db.select().from(chatAccessLog)).toEqual([]);
  vi.stubEnv("LLM_MONTHLY_BUDGET_USD", "20"); await db.update(jobs).set({ runAt: new Date() }).where(eq(jobs.kind, "moderation_triage"));
  await runDueJobs(db, handlers, { logger: quiet });
  expect(calls).toHaveLength(1); expect(await db.select().from(chatAccessLog)).toHaveLength(1); expect((await db.select().from(reports))[0].aiPriority).toBeNull();
});


it.each(["delete", "edit"] as const)("does not send prepared live context after a neighbor %s during budget admission", async intent => {
  const { db, village, send, report } = await world();
  const neighbor = await send("CONTEXT_BEFORE_ADMISSION");
  const target = await send("RETAINED_REPORT_TARGET");
  vi.stubEnv("MODERATION_AI_TRIAGE_ENABLED", "1");
  await report(target.id);
  const reserve = usage.reserveUsage;
  vi.spyOn(usage, "reserveUsage").mockImplementationOnce(async (...args) => {
    await mutateChat(db, "amc_writer", village.slug!, intent, { id: neighbor.id, body: "Changed context" });
    return reserve(...args);
  });
  const calls: string[] = [];
  await runDueJobs(db, createModerationHandlers({ completer: completer(calls) }), { logger: quiet });
  expect(calls).toEqual([]);
  expect(await db.select().from(chatAccessLog)).toEqual([]);
  expect(await db.select().from(llmUsage)).toEqual([]);
  expect((await db.select().from(reports))[0].aiTriagedAt).toBeNull();
});

it("still sends the retained target snapshot when its live message is deleted during admission", async () => {
  const { db, village, send, report } = await world();
  const target = await send("RETAINED_REPORT_TARGET");
  vi.stubEnv("MODERATION_AI_TRIAGE_ENABLED", "1");
  await report(target.id);
  const reserve = usage.reserveUsage;
  vi.spyOn(usage, "reserveUsage").mockImplementationOnce(async (...args) => {
    await mutateChat(db, "amc_writer", village.slug!, "delete", { id: target.id });
    return reserve(...args);
  });
  const calls: string[] = [];
  await runDueJobs(db, createModerationHandlers({ completer: completer(calls) }), { logger: quiet });
  expect(calls).toHaveLength(1);
  expect(JSON.parse(calls[0])).toMatchObject({ target: { body: "RETAINED_REPORT_TARGET" }, context: [] });
  expect((await db.select().from(chatAccessLog))[0].versions).toMatchObject([{ id: target.id, snapshot: true }]);
});
