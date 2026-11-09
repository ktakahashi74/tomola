import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Db } from "~/lib/db/client.server";
import { entries, jobs, notifications, profiles, translationReports, translations, user, villages } from "~/lib/db/schema";
import { createTranslationReport, dismissReport, resolveReportWithHumanTranslation } from "~/lib/translation-reports.server";
import { createTranslationHandlers } from "~/lib/jobs/translation-jobs.server";
import { createNotificationHandlers } from "~/lib/jobs/notification-jobs.server";
import { enqueue, runDueJobs } from "~/lib/jobs/queue.server";
import { SEND_MEMBER_DIGEST_JOB, SEND_NOTIFICATION_EMAIL_JOB } from "~/lib/jobs/mail-kinds";
import { createFakeEngine } from "~/lib/llm/engines/fake.server";
import { BudgetPausedError, LlmError } from "~/lib/llm/errors.server";
import { RETRANSLATE_REPORT_JOB, resolveTitleReports } from "~/lib/translations.server";
import { listNotifications, markAllNotificationsRead } from "~/lib/notifications.server";
import { REPLIES_PER_PAGE } from "~/lib/pagination";
import { notificationHref } from "~/lib/notification-opening.server";
import type { MailMessage } from "~/lib/mail/mail.server";
import { softDeleteEntry } from "~/lib/entries.server";
import { addMember, createTestDb } from "./helpers/db";

const now = new Date("2026-10-05T12:00:00Z");
const after = new Date("2026-10-06T00:00:00Z");
const quiet = { error() {}, warn() {} };
const llm = { engines: { primary: createFakeEngine(), secondary: null, judge: null, retry: createFakeEngine({ model: "fake-retry" }) }, env: {} };

async function world(database?: Db) {
  const db = database ?? await createTestDb();
  for (const id of ["result_author", "result_reader", "result_other", "result_mod"]) await addMember(db, id, id);
  const [topic] = await db.insert(entries).values({ kind: "topic", authorId: "result_author", lang: "ja", title: "Result topic", body: "日本語の原文です。", sourceHash: "revision-one" }).returning();
  await db.insert(translations).values({ entryId: topic.id, kind: "primary", field: "body", lang: "en", text: "Incorrect machine text", sourceHash: topic.sourceHash });
  return { db, topic };
}
async function report(db: Db, id: number, over: Record<string, unknown> = {}, reporter = "result_reader", retry = false) {
  const result = await createTranslationReport(db, reporter, { entryId: id, lang: "en", note: "Private report explanation", ...over }, { now, ...(retry ? { llm } : { llm: { env: {} } }) });
  if (!result.ok || result.id === null) throw new Error("report failed");
  return result.id;
}
const resultRows = (db: Db) => db.select().from(notifications).where(eq(notifications.kind, "translation_report_result")).orderBy(notifications.translationReportId);

describe("translation report outcomes", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("notifies only each newly closed report's owner, preserving old and unknown outcomes", async () => {
    const { db, topic } = await world();
    const first = await report(db, topic.id);
    const second = await report(db, topic.id, { note: "Another explanation" });
    const other = await report(db, topic.id, {}, "result_other");
    const old = await report(db, topic.id, { note: "Old revision" });
    await db.update(translationReports).set({ sourceHash: "older" }).where(eq(translationReports.id, old));
    const [legacy] = await db.insert(translationReports).values({ entryId: topic.id, lang: "en", field: "body", reporterId: "result_reader", status: "resolved", resolvedAt: now }).returning();
    expect(await resolveReportWithHumanTranslation(db, "result_mod", first, "A corrected translation", { now })).toMatchObject({ ok: true });
    const rows = await db.select().from(translationReports).orderBy(translationReports.id);
    expect(rows.map(row => [row.id, row.outcome])).toEqual([[first, "human_corrected"], [second, "human_corrected"], [other, "human_corrected"], [old, "source_updated"], [legacy.id, null]]);
    expect((await resultRows(db)).map(row => [row.translationReportId, row.userId])).toEqual([[first, "result_reader"], [second, "result_reader"], [other, "result_other"], [old, "result_reader"]]);
    expect((await listNotifications(db, "result_author")).items).toEqual([]);
    expect((await listNotifications(db, "result_mod")).items).toEqual([]);
    expect(await dismissReport(db, "result_mod", first)).toBe(false);
    expect(await resolveReportWithHumanTranslation(db, "result_mod", first, "Another correction")).toMatchObject({ ok: false });
    expect(await resultRows(db)).toHaveLength(4);
    expect(await db.select().from(jobs).where(eq(jobs.kind, "translate_entry"))).toEqual([]);
    const [existing] = await resultRows(db);
    await expect(db.insert(notifications).values({ kind: "translation_report_result", userId: existing.userId, entryId: topic.id, threadId: topic.id, translationReportId: first })).rejects.toThrow();
    const serialized = JSON.stringify((await listNotifications(db, "result_reader")).items);
    expect(serialized).not.toContain("Private report explanation");
    expect(serialized).not.toContain("result_mod");
  });

  it.each(["save", "dismiss"])("records unchanged for a human %s without changing quality correction counts", async method => {
    const { db, topic } = await world();
    const id = await report(db, topic.id);
    if (method === "save") await resolveReportWithHumanTranslation(db, "result_mod", id, "Incorrect machine text", { now });
    else await dismissReport(db, "result_mod", id, { now });
    expect((await db.select().from(translationReports))[0]).toMatchObject({ outcome: "unchanged", correctedAt: null });
    expect(await resultRows(db)).toHaveLength(1);
  });

  it("saves a machine result atomically and ignores job redelivery", async () => {
    const { db, topic } = await world();
    await db.update(profiles).set({ emailPref: "immediate" }).where(eq(profiles.userId, "result_reader"));
    const id = await report(db, topic.id, {}, "result_reader", true);
    const handlers = createTranslationHandlers({ llm });
    expect(await runDueJobs(db, handlers, { now, logger: quiet })).toMatchObject({ done: 1 });
    expect((await db.select().from(translationReports))[0]).toMatchObject({ outcome: "machine_retranslated", correctedAt: now });
    expect(await resultRows(db)).toHaveLength(1);
    const [job] = await db.select().from(jobs).where(eq(jobs.kind, RETRANSLATE_REPORT_JOB));
    await handlers[RETRANSLATE_REPORT_JOB](job, { db, now });
    expect(await resultRows(db)).toHaveLength(1);
    expect(await db.select().from(jobs).where(eq(jobs.kind, SEND_NOTIFICATION_EMAIL_JOB))).toHaveLength(1);
    expect((await db.select().from(translations).where(eq(translations.kind, "primary")))[0].text).not.toBe("Incorrect machine text");
    expect((await db.select().from(translationReports).where(eq(translationReports.id, id)))[0].outcome).toBe("machine_retranslated");
  });

  it.each(["source", "title"])("records source_updated after an actual %s update, without a correction timestamp", async path => {
    const { db, topic } = await world();
    const id = await report(db, topic.id, path === "title" ? { field: "title" } : {}, "result_reader", path !== "title");
    await db.transaction(async tx => {
      await tx.update(entries).set({ sourceHash: "revision-two", ...(path === "title" ? { title: null } : {}) }).where(eq(entries.id, topic.id));
      if (path === "title") await resolveTitleReports(tx, topic.id, now);
    });
    if (path === "source") await runDueJobs(db, createTranslationHandlers({ llm }), { now, logger: quiet });
    expect((await db.select().from(translationReports).where(eq(translationReports.id, id)))[0]).toMatchObject({ outcome: "source_updated", correctedAt: null, sourceHash: "revision-one" });
    expect(await resultRows(db)).toHaveLength(1);
  });

  it.each(["unchanged", "refusal", "failure", "budget"])("keeps %s retries open without any completion notice", async failure => {
    const { db, topic } = await world();
    await report(db, topic.id, {}, "result_reader", true);
    const retry = { ...createFakeEngine(), async translate() {
      if (failure === "budget") throw new BudgetPausedError("stopped", after, "retry");
      if (failure === "refusal") throw new LlmError("refusal", "Fake refusal");
      if (failure === "failure") throw new Error("Fake transient failure");
      return { text: "Incorrect machine text", model: "fake", promptVersion: "fake", inputTokens: 1, outputTokens: 1 };
    } };
    await runDueJobs(db, createTranslationHandlers({ llm: { ...llm, engines: { ...llm.engines, retry } } }), { now, logger: quiet });
    expect((await db.select().from(translationReports))[0]).toMatchObject({ status: "open", outcome: null });
    expect(await resultRows(db)).toEqual([]);
  });

  it("rolls back translation, result, notification and durable mail job together", async () => {
    const { db, topic } = await world();
    await db.update(profiles).set({ emailPref: "immediate" }).where(eq(profiles.userId, "result_reader"));
    const id = await report(db, topic.id);
    await expect(db.transaction(async tx => {
      await resolveReportWithHumanTranslation(tx, "result_mod", id, "Rolled back correction", { now });
      expect(await resultRows(tx)).toHaveLength(1);
      expect(await tx.select().from(jobs).where(eq(jobs.kind, SEND_NOTIFICATION_EMAIL_JOB))).toHaveLength(1);
      throw new Error("Abort transaction");
    })).rejects.toThrow("Abort transaction");
    expect((await db.select().from(translationReports))[0].outcome).toBeNull();
    expect(await resultRows(db)).toEqual([]);
    expect(await db.select().from(translations).where(eq(translations.kind, "human"))).toEqual([]);
    expect(await db.select().from(jobs).where(eq(jobs.kind, SEND_NOTIFICATION_EMAIL_JOB))).toEqual([]);
  });

  it("does not notify a deleted reporter; report deletion cascades its result without blocking post cleanup", async () => {
    const { db, topic } = await world();
    const gone = await report(db, topic.id, {}, "result_other");
    await db.delete(user).where(eq(user.id, "result_other"));
    await dismissReport(db, "result_mod", gone, { now });
    expect(await resultRows(db)).toEqual([]);
    const id = await report(db, topic.id);
    await dismissReport(db, "result_mod", id, { now });
    expect(await resultRows(db)).toHaveLength(1);
    await db.delete(translationReports).where(eq(translationReports.id, id));
    expect(await resultRows(db)).toEqual([]);
    expect(await softDeleteEntry(db, topic.id)).toMatchObject({ ok: true });
  });

  it("preserves the target translation language, reply page and anchor independently of UI language", async () => {
    const { db, topic } = await world();
    const replies = await db.insert(entries).values(Array.from({ length: REPLIES_PER_PAGE + 1 }, (_, i) => ({ kind: "reply", threadId: topic.id, parentId: topic.id, authorId: "result_author", lang: "ja", body: `Reply ${i}`, sourceHash: `reply-${i}`, createdAt: new Date(now.getTime() + i) }))).returning();
    const target = replies[REPLIES_PER_PAGE];
    const id = await report(db, target.id);
    await dismissReport(db, "result_mod", id, { now });
    const [notice] = (await listNotifications(db, "result_reader", { display: { displayLang: "ja", readLangs: ["ja"] } })).items;
    expect(notice.translationResult).toMatchObject({ outcome: "unchanged", lang: "en", field: "body" });
    expect(await notificationHref(db, notice)).toBe(`/t/${topic.id}?page=2&lang=en#c-${target.id}`);
    await db.update(entries).set({ sourceHash: "later-revision" }).where(eq(entries.id, target.id));
    expect((await listNotifications(db, "result_reader")).items[0].translationResult?.outcome).toBe("unchanged");
    await markAllNotificationsRead(db, "result_reader");
    expect((await listNotifications(db, "result_reader")).items[0].read).toBe(true);
  });

  it.each(["entry_hidden", "topic_hidden", "entry_deleted", "topic_deleted", "village"])("withholds content and suppresses mail when the %s becomes unreadable", async change => {
    if (change === "village") vi.stubEnv("VILLAGES", "1");
    const { db, topic } = await world();
    const [reply] = await db.insert(entries).values({ kind: "reply", threadId: topic.id, parentId: topic.id, authorId: "result_author", lang: "ja", body: "Private reply", sourceHash: "reply" }).returning();
    await db.update(profiles).set({ emailPref: "immediate" }).where(eq(profiles.userId, "result_reader"));
    const id = await report(db, reply.id);
    await dismissReport(db, "result_mod", id, { now });
    if (change === "village") {
      const [village] = await db.insert(villages).values({ id: "a".repeat(32), name: "Closed place", kind: "open" }).returning();
      await db.update(entries).set({ villageId: village.id }).where(eq(entries.id, topic.id));
    } else await db.update(entries).set(change.endsWith("deleted") ? { deletedAt: now } : { hiddenAt: now }).where(eq(entries.id, change.startsWith("entry") ? reply.id : topic.id));
    const [notice] = (await listNotifications(db, "result_reader", { excerpts: true })).items;
    expect(notice).toMatchObject({ unavailable: true, topicTitle: null, entryId: null, excerpt: null });
    expect(notice.translationResult).toBeUndefined();
    expect(await notificationHref(db, notice)).toBeNull();
    const send = vi.fn(async (_message: MailMessage) => {});
    await runDueJobs(db, createNotificationHandlers({ mailer: () => ({ kind: "memory", from: "noreply@example.com", send }) }), { now: after, logger: quiet });
    expect(send).not.toHaveBeenCalled();
  });

  it("suppresses a queued result email after its recipient deletes their account", async () => {
    const { db, topic } = await world();
    await db.update(profiles).set({ emailPref: "immediate" }).where(eq(profiles.userId, "result_reader"));
    const id = await report(db, topic.id);
    await dismissReport(db, "result_mod", id, { now });
    expect(await resultRows(db)).toHaveLength(1);
    await db.delete(user).where(eq(user.id, "result_reader"));
    const send = vi.fn(async (_message: MailMessage) => {});
    await runDueJobs(db, createNotificationHandlers({ mailer: () => ({ kind: "memory", from: "noreply@example.com", send }) }), { now: after, logger: quiet });
    expect(send).not.toHaveBeenCalled();
    expect(await resultRows(db)).toEqual([]);
    expect((await db.select().from(translationReports).where(eq(translationReports.id, id)))[0]).toMatchObject({ reporterId: null, outcome: "unchanged" });
  });

  it("does not call deletion a translation correction or create a completion notice", async () => {
    const { db, topic } = await world();
    const id = await report(db, topic.id);
    await softDeleteEntry(db, topic.id, { now });
    expect((await db.select().from(translationReports).where(eq(translationReports.id, id)))[0]).toMatchObject({ status: "resolved", outcome: null, correctedAt: null });
    expect(await resultRows(db)).toEqual([]);
  });

  it.each(["auto", "immediate", "daily", "none"])("honors %s email delivery with fake mail only", async pref => {
    const { db, topic } = await world();
    await db.update(profiles).set({ emailPref: pref, uiLocale: "ja", displayLang: "fr" }).where(eq(profiles.userId, "result_reader"));
    const id = await report(db, topic.id);
    await dismissReport(db, "result_mod", id, { now });
    const immediateJobs = await db.select().from(jobs).where(eq(jobs.kind, SEND_NOTIFICATION_EMAIL_JOB));
    expect(immediateJobs).toHaveLength(pref === "immediate" ? 1 : 0);
    await enqueue(db, SEND_MEMBER_DIGEST_JOB, { date: "2026-10-06", userId: "result_reader" });
    const send = vi.fn(async (_message: MailMessage) => {});
    await runDueJobs(db, createNotificationHandlers({ mailer: () => ({ kind: "memory", from: "noreply@example.com", send }) }), { now: after, logger: quiet });
    expect(send).toHaveBeenCalledTimes(pref === "none" ? 0 : 1);
    if (pref !== "none") {
      const mail = send.mock.calls[0][0] as unknown as { to: string; text: string };
      expect(mail.to).toBe("result_reader@example.com");
      expect(mail.text).toContain("lang=en");
      expect(mail.text).not.toContain("Private report explanation");
      expect(mail.text).not.toContain("result_mod");
    }
  });
});
