import { and, eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import * as entryRendering from "~/lib/entries.server";
import type { Db } from "~/lib/db/client.server";
import { entries, translationReports, translations } from "~/lib/db/schema";
import { createReply, createTopic, editEntry } from "~/lib/entries.server";
import { loadEntryDisplays } from "~/lib/entry-display.server";
import { createTranslationHandlers } from "~/lib/jobs/translation-jobs.server";
import { runDueJobs } from "~/lib/jobs/queue.server";
import type { Lang } from "~/lib/languages";
import { createFakeEngine } from "~/lib/llm/engines/fake.server";
import { createTranslationReport, dismissReport, listOpenReports, resolveReportWithHumanTranslation } from "~/lib/translation-reports.server";
import { addMember, createTestDb } from "./helpers/db";

const t0 = new Date("2026-10-05T00:00:00Z");

async function setup() {
  const db = await createTestDb();
  await addMember(db, "u1", "hana");
  await addMember(db, "u2", "somchai", { readLangs: ["th"] });
  await addMember(db, "op", "opal");
  const topic = await createTopic(db, "u1", { lang: "ja", title: "題", body: "本文" });
  if (!topic.ok) throw new Error("topic failed");
  const reply = await createReply(db, "u1", topic.id, { lang: "ja", body: "返信" });
  if (!reply.ok) throw new Error("reply failed");
  await runDueJobs(db, createTranslationHandlers({ llm: { engines: { primary: createFakeEngine(), secondary: null, judge: null }, env: {} } }), {
    now: t0,
    logger: { error() {}, warn() {} },
    limit: 500,
  });
  return { db, topicId: topic.id, replyId: reply.id };
}

const report = (db: Db, entryId: number, over: Record<string, unknown> = {}) =>
  createTranslationReport(db, "u2", { entryId, lang: "th", field: "body", excerpt: "[th] 本文", note: "wrong word", ...over }, { now: t0 });

async function shown(db: Db, entryId: number, lang: Lang, older = false) {
  const [e] = await db.select().from(entries).where(eq(entries.id, entryId));
  return (await loadEntryDisplays(db, [{ id: e.id, kind: e.kind as "topic", lang: e.lang as Lang, sourceHash: e.sourceHash }], { readLangs: [lang], displayLang: lang, forceOlder: new Set(older ? [entryId] : []) })).get(entryId)!;
}

describe("createTranslationReport", () => {
  it("stores an open report with the reporter, language, field, excerpt and note", async () => {
    const { db, topicId } = await setup();
    const res = await report(db, topicId, { field: "title", excerpt: "  [th] 題  ", note: " typo " });
    expect(res.ok).toBe(true);
    const [row] = await db.select().from(translationReports);
    expect(row).toMatchObject({ entryId: topicId, lang: "th", field: "title", reporterId: "u2", excerpt: "[th] 題", note: "typo", status: "open", resolvedBy: null, resolvedAt: null });
  });

  it("accepts a report with an excerpt only, a note only, or neither (one tap); the field defaults to the body", async () => {
    const { db, topicId } = await setup();
    expect((await report(db, topicId, { excerpt: "x", note: "" })).ok).toBe(true);
    expect((await report(db, topicId, { excerpt: "", note: "y" })).ok).toBe(true);
    expect((await createTranslationReport(db, "u1", { entryId: topicId, lang: "th" })).ok).toBe(true);
    const rows = await db.select().from(translationReports).orderBy(translationReports.id);
    expect(rows.map((r) => [r.reporterId, r.field, r.excerpt, r.note])).toEqual([["u2", "body", "x", ""], ["u2", "body", "", "y"], ["u1", "body", "", ""]]);
  });

  it("does not make a row for a second tap of the same member (nothing written, the first report is not used up)", async () => {
    const { db, topicId } = await setup();
    const first = await createTranslationReport(db, "u2", { entryId: topicId, lang: "th" }, { now: t0 });
    expect(first).toMatchObject({ ok: true, route: "moderator" });
    expect(await createTranslationReport(db, "u2", { entryId: topicId, lang: "th" })).toEqual({ ok: true, id: null, route: null });
    expect(await createTranslationReport(db, "u2", { entryId: topicId, lang: "th", field: "body", excerpt: "  ", note: "" })).toEqual({ ok: true, id: null, route: null });
    expect(await db.select().from(translationReports)).toHaveLength(1);
    // A location or explanation creates a new report. Different members, languages, and fields also create reports.
    expect((await createTranslationReport(db, "u2", { entryId: topicId, lang: "th", note: "more" })).ok).toBe(true);
    expect(await createTranslationReport(db, "u1", { entryId: topicId, lang: "th" })).toMatchObject({ ok: true, route: "moderator" });
    expect(await createTranslationReport(db, "u2", { entryId: topicId, lang: "fr" })).toMatchObject({ ok: true, route: "moderator" });
    expect(await createTranslationReport(db, "u2", { entryId: topicId, lang: "th", field: "title" })).toMatchObject({ ok: true, route: "moderator" });
    expect(await db.select().from(translationReports)).toHaveLength(5);
  });

  it("validates the entry, the language and the field (a title report is for topics only)", async () => {
    const { db, topicId, replyId } = await setup();
    expect(await report(db, 9999)).toEqual({ ok: false, error: "not_found" });
    expect(await report(db, topicId, { lang: "ja" })).toEqual({ ok: false, error: "invalid_lang" });
    expect(await report(db, topicId, { lang: "xx" })).toEqual({ ok: false, error: "invalid_lang" });
    expect(await report(db, topicId, { field: "html" })).toEqual({ ok: false, error: "invalid_field" });
    expect(await report(db, replyId, { field: "title" })).toEqual({ ok: false, error: "invalid_field" });
    expect(await report(db, topicId, { note: "x".repeat(2001) })).toEqual({ ok: false, error: "too_long" });
    await db.update(entries).set({ deletedAt: t0 }).where(eq(entries.id, replyId));
    expect(await report(db, replyId)).toEqual({ ok: false, error: "not_found" });
    expect(await db.select().from(translationReports)).toHaveLength(0);
  });
});

describe("listOpenReports", () => {
  it("lists open reports oldest first with the original and the translation now shown", async () => {
    const { db, topicId, replyId } = await setup();
    await createTranslationReport(db, "u2", { entryId: replyId, lang: "th", field: "body", excerpt: "e2", note: "" }, { now: new Date(t0.getTime() + 1000) });
    await report(db, topicId);
    const open = await listOpenReports(db);
    expect(open.map((r) => r.entryId)).toEqual([topicId, replyId]);
    expect(open[0]).toMatchObject({
      lang: "th",
      field: "body",
      reporterHandle: "somchai",
      threadId: topicId,
      entryKind: "topic",
      entryLang: "ja",
      original: { title: "題", body: "本文" },
      current: { text: "[th] 本文", kind: "primary", engine: "fake", stale: false },
    });
    expect(open[1]).toMatchObject({ threadId: topicId, entryKind: "reply", current: { text: "[th] 返信" } });
  });

  it("shows no current translation when there is none yet", async () => {
    const { db, topicId } = await setup();
    await db.delete(translations).where(eq(translations.lang, "th"));
    await report(db, topicId);
    expect((await listOpenReports(db))[0].current).toBeNull();
  });
});

describe("resolving a report with a human translation", () => {
  it("saves a kind=human translation for the current source, resolves the report, and it is shown instead of the machine translation", async () => {
    const { db, topicId } = await setup();
    const created = await report(db, topicId);
    if (!created.ok || created.id === null) throw new Error("report failed");
    const res = await resolveReportWithHumanTranslation(db, "op", created.id, "แก้แล้ว\n\nบรรทัดสอง", { now: t0 });
    expect(res).toEqual({ ok: true, entryId: topicId });
    const [entry] = await db.select({ h: entries.sourceHash }).from(entries).where(eq(entries.id, topicId));
    const [human] = await db.select().from(translations).where(and(eq(translations.entryId, topicId), eq(translations.kind, "human")));
    expect(human).toMatchObject({ field: "body", lang: "th", text: "แก้แล้ว\n\nบรรทัดสอง", sourceHash: entry.h, flags: [], createdBy: "op", engine: null });
    const [row] = await db.select().from(translationReports);
    expect(row).toMatchObject({ status: "resolved", resolvedBy: "op" });
    expect(row.resolvedAt?.toISOString()).toBe(t0.toISOString());
    expect(await listOpenReports(db)).toEqual([]);
    const view = await shown(db, topicId, "th");
    expect(view.translation).toMatchObject({ kind: "human", stale: false });
    expect(view.translation?.html).toContain("แก้แล้ว");
    // The title remains machine-translated.
    expect(view.translation?.title).toMatchObject({ kind: "primary" });
  });

  it("resolves every open report for the same entry, language and field, and leaves the others open", async () => {
    const { db, topicId, replyId } = await setup();
    const a = await report(db, topicId);
    const b = await createTranslationReport(db, "u1", { entryId: topicId, lang: "th", field: "body", excerpt: "again", note: "" });
    const otherField = await report(db, topicId, { field: "title" });
    const otherLang = await report(db, topicId, { lang: "fr" });
    const otherEntry = await report(db, replyId);
    if (![a, b, otherField, otherLang, otherEntry].every((r) => r.ok)) throw new Error("report failed");
    await resolveReportWithHumanTranslation(db, "op", (a as { id: number }).id, "fixed");
    const open = await listOpenReports(db);
    expect(open.map((r) => [r.entryId, r.lang, r.field]).sort()).toEqual(
      [
        [topicId, "th", "title"],
        [topicId, "fr", "body"],
        [replyId, "th", "body"],
      ].sort(),
    );
  });

  it("rejects an empty or too long text, a missing or already resolved report, and a deleted entry, changing nothing", async () => {
    const { db, topicId, replyId } = await setup();
    const created = await report(db, topicId);
    if (!created.ok || created.id === null) throw new Error("report failed");
    expect(await resolveReportWithHumanTranslation(db, "op", created.id, "   ")).toEqual({ ok: false, error: "invalid_text" });
    expect(await resolveReportWithHumanTranslation(db, "op", created.id, "x".repeat(50_001))).toEqual({ ok: false, error: "invalid_text" });
    expect(await resolveReportWithHumanTranslation(db, "op", 9999, "x")).toEqual({ ok: false, error: "not_found" });
    expect((await listOpenReports(db)).length).toBe(1);
    expect(await db.select().from(translations).where(eq(translations.kind, "human"))).toHaveLength(0);
    expect((await resolveReportWithHumanTranslation(db, "op", created.id, "fixed")).ok).toBe(true);
    expect(await resolveReportWithHumanTranslation(db, "op", created.id, "again")).toEqual({ ok: false, error: "not_found" });
    const other = await report(db, replyId);
    if (!other.ok || other.id === null) throw new Error("report failed");
    await db.update(entries).set({ deletedAt: t0 }).where(eq(entries.id, replyId));
    expect(await resolveReportWithHumanTranslation(db, "op", other.id, "x")).toEqual({ ok: false, error: "not_found" });
  });

  it("trims a title fix and keeps the report open when a title fix is empty", async () => {
    const { db, topicId } = await setup();
    const created = await report(db, topicId, { field: "title" });
    if (!created.ok || created.id === null) throw new Error("report failed");
    expect((await resolveReportWithHumanTranslation(db, "op", created.id, "  Fixed title  ")).ok).toBe(true);
    const [t] = await db.select().from(translations).where(and(eq(translations.kind, "human"), eq(translations.field, "title")));
    expect(t.text).toBe("Fixed title");
  });

  it("keeps the human translation (stale) when the original is edited, and machine translations are redone around it", async () => {
    const { db, topicId } = await setup();
    const created = await report(db, topicId);
    if (!created.ok || created.id === null) throw new Error("report failed");
    await resolveReportWithHumanTranslation(db, "op", created.id, "human fix");
    await editEntry(db, "u1", topicId, { title: "題", body: "直した本文" });
    await runDueJobs(db, createTranslationHandlers({ llm: { engines: { primary: createFakeEngine(), secondary: null, judge: null }, env: {} } }), {
      now: new Date(t0.getTime() + 1000),
      logger: { error() {}, warn() {} },
      limit: 500,
    });
    // The current source now has a primary translation, so it becomes the default. The old-source human correction remains selectable.
    const view = await shown(db, topicId, "th");
    expect(view.translation).toMatchObject({ kind: "primary", stale: false });
    expect(view.translation?.html).toContain("直した本文");
    expect(view.translation?.older).toMatchObject({ kind: "human" });
    expect(view.translation?.older?.html).toBeNull();
    expect((await shown(db, topicId, "th", true)).translation?.older?.html).toContain("human fix");
    const [primary] = await db.select().from(translations).where(and(eq(translations.entryId, topicId), eq(translations.lang, "th"), eq(translations.kind, "primary"), eq(translations.field, "body")));
    expect(primary.text).toBe("[th] 直した本文");
  });
});

it("returns invalid_text and keeps the report and translations unchanged when correction rendering fails", async () => {
  const { db, topicId } = await setup();
  const created = await report(db, topicId);
  if (!created.ok || created.id === null) throw new Error("report failed");
  const beforeReports = await db.select().from(translationReports).orderBy(translationReports.id);
  const beforeTranslations = await db.select().from(translations).orderBy(translations.id);
  const spy = vi.spyOn(entryRendering, "tryRenderTranslationHtml").mockResolvedValue(null);
  try {
    expect(await resolveReportWithHumanTranslation(db, "op", created.id, "Corrected body")).toEqual({ ok: false, error: "invalid_text" });
    expect(spy).toHaveBeenCalledWith("topic", topicId, "th", "Corrected body", expect.anything());
    expect(await db.select().from(translationReports).orderBy(translationReports.id)).toEqual(beforeReports);
    expect(await db.select().from(translations).orderBy(translations.id)).toEqual(beforeTranslations);
  } finally {
    spy.mockRestore();
  }
});

describe("dismissReport", () => {
  it("closes only that report without touching translations, and does nothing twice", async () => {
    const { db, topicId } = await setup();
    const a = await report(db, topicId);
    const b = await report(db, topicId, { excerpt: "other" });
    if (!a.ok || !b.ok || a.id === null || b.id === null) throw new Error("report failed");
    expect(await dismissReport(db, "op", a.id, { now: t0 })).toBe(true);
    expect(await dismissReport(db, "op", a.id)).toBe(false);
    expect((await listOpenReports(db)).map((r) => r.id)).toEqual([b.id]);
    expect(await db.select().from(translations).where(eq(translations.kind, "human"))).toHaveLength(0);
  });
});
