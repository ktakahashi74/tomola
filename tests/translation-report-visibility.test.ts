import { and, eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { addMember, createTestDb } from "./helpers/db";
import { entries, translationReports, translations } from "~/lib/db/schema";
import { createReply, createTopic, getThread, isEntryInThread, softDeleteEntry } from "~/lib/entries.server";
import { createTranslationReport, listOpenReports, loadOwnTranslationReports, loadReportNotices, resolveReportWithHumanTranslation, updateTranslationReportDetails } from "~/lib/translation-reports.server";

async function world() {
  const db = await createTestDb();
  await addMember(db, "visibility_author", "visibility_author");
  await addMember(db, "visibility_reader", "visibility_reader");
  const topic = await createTopic(db, "visibility_author", { lang: "ja", body: "Topic source" });
  if (!topic.ok) throw new Error(topic.error);
  const reply = await createReply(db, "visibility_author", topic.id, { lang: "ja", body: "Reply source" });
  if (!reply.ok) throw new Error(reply.error);
  const input = { entryId: reply.id, lang: "en", field: "body", excerpt: "Example", note: "Review" };
  const created = await createTranslationReport(db, "visibility_reader", input);
  if (!created.ok || !created.id) throw new Error("report failed");
  const [source] = await db.select({ sourceHash: entries.sourceHash }).from(entries).where(eq(entries.id, reply.id));
  await db.insert(translations).values({ entryId: reply.id, lang: "en", field: "body", kind: "primary", text: "Example translation", sourceHash: source.sourceHash });
  return { db, topic, reply, input, reportId: created.id };
}

it("keeps reports and translations as evidence after root deletion, withholding all ordinary review paths", async () => {
  const { db, topic, reply, input, reportId } = await world();
  expect(await getThread(db, topic.id)).not.toBeNull();
  expect(await isEntryInThread(db, reply.id, topic.id)).toBe(true);
  expect(await listOpenReports(db)).toMatchObject([{ id: reportId, original: { body: "Reply source" }, current: { text: "Example translation" } }]);
  await softDeleteEntry(db, topic.id);
  expect(await getThread(db, topic.id)).toBeNull();
  expect(await isEntryInThread(db, reply.id, topic.id)).toBe(false);
  expect(await createTranslationReport(db, "visibility_reader", { ...input, lang: "fr" })).toEqual({ ok: false, error: "not_found" });
  expect(await updateTranslationReportDetails(db, "visibility_reader", reportId, input)).toEqual({ ok: false, error: "not_found" });
  expect(await resolveReportWithHumanTranslation(db, "visibility_author", reportId, "Correction")).toEqual({ ok: false, error: "not_found" });
  for (const scope of [{ operator: true, langs: [] }, { operator: false, langs: ["en" as const] }]) expect(await listOpenReports(db, { scope })).toEqual([]);
  const [source] = await db.select().from(entries).where(eq(entries.id, reply.id));
  expect(await loadOwnTranslationReports(db, "visibility_reader", [source])).toEqual([]);
  expect(await loadReportNotices(db, [{ entryId: reply.id, lang: "en" }])).toEqual(new Map());
  expect(await db.select().from(translationReports).where(eq(translationReports.entryId, reply.id))).toMatchObject([{ id: reportId, status: "open" }]);
  expect(await db.select().from(translations).where(and(eq(translations.entryId, reply.id), eq(translations.kind, "primary")))).toHaveLength(1);
});

it("withholds hidden reply reports, then restores ordinary review when unhidden", async () => {
  const { db, reply, input, reportId } = await world();
  const id = reply.id;
  await db.update(entries).set({ hiddenAt: new Date() }).where(eq(entries.id, id));
  expect(await listOpenReports(db)).toEqual([]);
  expect(await createTranslationReport(db, "visibility_reader", input)).toEqual({ ok: false, error: "not_found" });
  expect(await resolveReportWithHumanTranslation(db, "visibility_author", reportId, "Correction")).toEqual({ ok: false, error: "not_found" });
  await db.update(entries).set({ hiddenAt: null }).where(eq(entries.id, id));
  expect(await listOpenReports(db)).toMatchObject([{ id: reportId }]);
  expect(await updateTranslationReportDetails(db, "visibility_reader", reportId, input)).toMatchObject({ ok: true });
  expect(await resolveReportWithHumanTranslation(db, "visibility_author", reportId, "Correction")).toMatchObject({ ok: true, entryId: reply.id });
});


it("keeps a visible reply reviewable under a hidden topic, matching ordinary reading and signing previews", async () => {
  const { db, topic, reply, input, reportId } = await world();
  await db.update(entries).set({ hiddenAt: new Date() }).where(eq(entries.id, topic.id));
  const thread = await getThread(db, topic.id);
  expect(thread?.replies.find(row => row.id === reply.id)).toMatchObject({ visibility: "visible", body: "Reply source" });
  expect(await listOpenReports(db, { scope: { operator: false, langs: ["en"] } })).toMatchObject([{ id: reportId, original: { body: "Reply source" } }]);
  expect(await createTranslationReport(db, "visibility_reader", { ...input, lang: "fr" })).toMatchObject({ ok: true });
  expect(await updateTranslationReportDetails(db, "visibility_reader", reportId, input)).toMatchObject({ ok: true });
  expect(await resolveReportWithHumanTranslation(db, "visibility_author", reportId, "Correction")).toMatchObject({ ok: true, entryId: reply.id });
});
