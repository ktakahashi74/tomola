import { afterAll, beforeAll, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";
import { createTopic } from "~/lib/entries.server";
import { entries, translationReports } from "~/lib/db/schema";
import { createTranslationReport, loadOwnTranslationReports, updateTranslationReportDetails } from "~/lib/translation-reports.server";

let h: RouteHarness;
beforeAll(async () => { h = await setupRouteHarness(); for (const member of ["ux_author", "ux_reader", "ux_other"]) await h.signIn(member); });
afterAll(() => h.restore());

it("amends only the member's current report and keeps one report row", async () => {
  const topic = await createTopic(h.db, h.ids.ux_author, { lang: "ja", body: "報告を試す本文です。" });
  if (!topic.ok) throw new Error(topic.error);
  const input = { entryId: topic.id, lang: "en", field: "body", excerpt: "", note: "" };
  const report = await createTranslationReport(h.db, h.ids.ux_reader, input);
  if (!report.ok || !report.id) throw new Error("report failed");
  const [source] = await h.db.select().from(entries).where(eq(entries.id, topic.id));
  expect(await loadOwnTranslationReports(h.db, h.ids.ux_reader, [source])).toMatchObject([{ id: report.id }]);
  expect(await loadOwnTranslationReports(h.db, h.ids.ux_other, [source])).toEqual([]);
  expect(await updateTranslationReportDetails(h.db, h.ids.ux_other, report.id, { ...input, note: "A foreign change" })).toMatchObject({ ok: false });
  expect(await updateTranslationReportDetails(h.db, h.ids.ux_reader, report.id, { ...input, note: "More context", excerpt: "A sentence" })).toMatchObject({ ok: true, id: report.id });
  const rows = await h.db.select().from(translationReports).where(eq(translationReports.entryId, topic.id));
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ id: report.id, excerpt: "A sentence", note: "More context", sourceHash: source.sourceHash });
  expect(await updateTranslationReportDetails(h.db, h.ids.ux_reader, report.id, { ...input, field: "title", note: "Wrong field" })).toMatchObject({ ok: false });
  expect(await updateTranslationReportDetails(h.db, h.ids.ux_reader, NaN, input)).toMatchObject({ ok: false });
  expect(await updateTranslationReportDetails(h.db, h.ids.ux_reader, report.id, { ...input, note: "x".repeat(2001) })).toMatchObject({ ok: false });
  await h.db.update(entries).set({ sourceHash: "f".repeat(64) }).where(eq(entries.id, topic.id));
  expect(await loadOwnTranslationReports(h.db, h.ids.ux_reader, [{ ...source, sourceHash: "f".repeat(64) }])).toEqual([]);
  expect(await updateTranslationReportDetails(h.db, h.ids.ux_reader, report.id, { ...input, note: "A stale change" })).toMatchObject({ ok: false });
});
