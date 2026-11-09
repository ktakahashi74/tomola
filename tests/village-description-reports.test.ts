import { afterEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { addMember, createTestDb } from "./helpers/db";
import { selectedTables } from "./helpers/query-tables";
import { moderationActions, reports, villages } from "~/lib/db/schema";
import { editVillage } from "~/lib/village-management.server";
import { createVillageReport } from "~/lib/village-moderation.server";
import { ensureLanguageVillages } from "~/lib/villages.server";

afterEach(() => vi.unstubAllEnvs());
async function world() {
  vi.stubEnv("VILLAGES", "1"); vi.stubEnv("ENABLED_LANGS", "en,ja"); vi.stubEnv("OPERATOR_EMAILS", "lr_operator@example.com");
  const db = await createTestDb(); await ensureLanguageVillages(db);
  for (const id of ["lr_operator", "lr_reporter", "lr_other"]) await addMember(db, id, id);
  const [village] = await db.select().from(villages).where(eq(villages.slug, "en"));
  const report = await createVillageReport(db, "lr_reporter", { slug: "en", reason: "other" }); if (!report.ok) throw new Error(report.error);
  return { db, village, reportId: report.id };
}

it.each([false, true])("ordinary language-description saving leaves reports open, including an unchanged save (changed=%s)", async changed => {
  const { db, village, reportId } = await world();
  expect(await editVillage(db, "lr_operator", "en", { name: village.name, description: changed ? "A configuration correction" : village.description })).toMatchObject({ ok: true });
  expect((await db.select().from(reports).where(eq(reports.id, reportId)))[0]).toMatchObject({ status: "open", handledAt: null });
  expect(await db.select().from(moderationActions)).toEqual([]);
});

it("resolves the village's grouped reports only when the edit explicitly identifies an open moderation card", async () => {
  const { db, village, reportId } = await world();
  expect(await createVillageReport(db, "lr_other", { slug: "en", reason: "spam" })).toMatchObject({ ok: true });
  expect(await createVillageReport(db, "lr_reporter", { slug: "ja", reason: "other" })).toMatchObject({ ok: true });
  expect(await editVillage(db, "lr_operator", "en", { name: village.name, description: "Corrected after reading the card", resolveReportId: reportId })).toMatchObject({ ok: true });
  const rows = await db.select().from(reports);
  expect(rows.filter(row => row.villageId === village.id).map(row => row.status)).toEqual(["resolved", "resolved"]);
  expect(rows.find(row => row.villageId !== village.id)?.status).toBe("open");
  expect(await db.select().from(moderationActions)).toEqual([]);
});

it("rejects a card for another village without changing the description or closing any report", async () => {
  const { db, reportId } = await world();
  const [before] = await db.select().from(villages).where(eq(villages.slug, "ja"));
  expect(await editVillage(db, "lr_operator", "ja", { name: before.name, description: "Should not save", resolveReportId: reportId })).toMatchObject({ ok: false, error: "not_found" });
  expect((await db.select().from(villages).where(eq(villages.id, before.id)))[0].description).toBe(before.description);
  expect((await db.select().from(reports))[0].status).toBe("open");
});

it("does nothing and performs no queries when villages are disabled", async () => {
  const { db, village, reportId } = await world(); vi.stubEnv("VILLAGES", "");
  const seen = selectedTables(db);
  expect(await editVillage(db, "lr_operator", "en", { name: village.name, description: "Should not save", resolveReportId: reportId })).toMatchObject({ ok: false, error: "disabled" });
  expect(seen.tables.size).toBe(0); seen.restore();
  expect((await db.select().from(reports))[0].status).toBe("open");
});
