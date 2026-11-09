import fs from "node:fs";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { migrationsFolder } from "~/lib/db/client.server";
import { migrationsBefore } from "./helpers/migrations";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { entries, jobs, notifications, translationReports, translations, profiles } from "~/lib/db/schema";
import { createTranslationReport, dismissReport, resolveReportWithHumanTranslation } from "~/lib/translation-reports.server";
import { createTranslationHandlers } from "~/lib/jobs/translation-jobs.server";
import { createFakeEngine } from "~/lib/llm/engines/fake.server";
import { RETRANSLATE_REPORT_JOB, carryOverUnchangedFields } from "~/lib/translations.server";
import { SEND_NOTIFICATION_EMAIL_JOB } from "~/lib/jobs/mail-kinds";
import { addMember } from "./helpers/db";
import { createScratchDb, REAL_PG_URL, type ScratchDb } from "./helpers/pg-real";
import { holdTx, waitForLockWait, expectSettlesWithin } from "./helpers/pg-concurrency";

const now = new Date("2026-10-05T12:00:00Z");
const llm = { engines: { primary: createFakeEngine(), secondary: null, judge: null, retry: createFakeEngine({ model: "fake-retry" }) }, env: {} };
describe.skipIf(!REAL_PG_URL)("translation report result concurrency", { tags: ["postgres"] }, () => {
  let scratch: ScratchDb;
  beforeAll(async () => {
    scratch = await createScratchDb();
    const db = await scratch.open();
    for (const id of ["result_author", "result_reader", "result_mod"]) await addMember(db, id, id);
    await db.update(profiles).set({ emailPref: "immediate" }).where(eq(profiles.userId, "result_reader"));
  }, 60_000);
  afterEach(async () => { await scratch.closeOpened(); });
  afterAll(async () => { await scratch?.drop(); });

  async function world(retry = false) {
    const db = await scratch.open();
    const [topic] = await db.insert(entries).values({ kind: "topic", authorId: "result_author", lang: "ja", title: "Concurrent report", body: "日本語の原文です。", sourceHash: "first" }).returning();
    await db.insert(translations).values({ entryId: topic.id, lang: "en", field: "body", kind: "primary", text: "Incorrect machine text", sourceHash: "first" });
    const result = await createTranslationReport(db, "result_reader", { entryId: topic.id, lang: "en" }, { now, llm: retry ? llm : { env: {} } });
    if (!result.ok || !result.id) throw new Error("report failed");
    const reportId = result.id;
    const [job] = await db.select().from(jobs).where(and(eq(jobs.kind, RETRANSLATE_REPORT_JOB), eq(jobs.dedupeKey, `retranslate-report:${reportId}`)));
    return { db, topic, reportId, job };
  }

  it("upgrades populated legacy reports and notifications on PostgreSQL without backfilling results", { timeout: 60_000 }, async () => {
    const legacy = await createScratchDb({ migrate: false });
    const before = migrationsBefore("translation_report_results");
    const pool = new pg.Pool({ connectionString: legacy.url, max: 1 });
    try {
      const db = drizzle(pool);
      await migrate(db, { migrationsFolder: before });
      await pool.query(`insert into "user" (id,name,email,email_verified) values ('legacy-result','','legacy-result@example.invalid',true);
        insert into profiles (user_id,handle,handle_key,home_area) values ('legacy-result','legacy_result','legacy_result','ja');
        insert into entries (kind,author_id,lang,body) values ('topic','legacy-result','ja','Legacy source');
        insert into translation_reports (entry_id,reporter_id,lang,field,status,resolved_at) select id,'legacy-result','en','body','resolved',now() from entries;
        insert into translation_reports (entry_id,reporter_id,lang,field) select id,'legacy-result','en','title' from entries;
        insert into notifications (user_id,kind,entry_id,read_at,emailed_at) select 'legacy-result','mention',id,now(),now() from entries`);
      await migrate(db, { migrationsFolder: migrationsFolder() });
      expect((await pool.query("select status,outcome from translation_reports order by id")).rows).toEqual([{ status: "resolved", outcome: null }, { status: "open", outcome: null }]);
      expect((await pool.query("select kind,translation_report_id,read_at is not null as read,emailed_at is not null as emailed from notifications")).rows).toEqual([{ kind: "mention", translation_report_id: null, read: true, emailed: true }]);
      await migrate(db, { migrationsFolder: migrationsFolder() });
      expect((await pool.query("select count(*)::int as n from notifications")).rows).toEqual([{ n: 1 }]);
    } finally {
      await pool.end();
      await legacy.drop();
      fs.rmSync(before, { recursive: true, force: true });
    }
  });

  it("serializes duplicate manual saves and leaves one result and mail job", async () => {
    const { db, topic, reportId } = await world();
    const first = await scratch.open(), second = await scratch.open("result-second"), admin = await scratch.admin();
    const held = holdTx(first, tx => resolveReportWithHumanTranslation(tx, "result_mod", reportId, "Winning correction", { now }));
    expect(await held.ready).toMatchObject({ ok: true });
    const pending = resolveReportWithHumanTranslation(second, "result_mod", reportId, "Losing correction", { now });
    try { await waitForLockWait(admin, "result-second"); } finally { await held.commit(); }
    expect(await expectSettlesWithin(pending, 10_000, "duplicate correction")).toMatchObject({ ok: false });
    const notices = await db.select().from(notifications).where(eq(notifications.translationReportId, reportId));
    expect(notices).toHaveLength(1);
    expect(await db.select().from(jobs).where(eq(jobs.dedupeKey, `notification-email:${notices[0].id}`))).toHaveLength(1);
    expect((await db.select().from(translations).where(and(eq(translations.entryId, topic.id), eq(translations.kind, "human"))))[0].text).toBe("Winning correction");
  });

  it.each(["machine", "human"] as const)("keeps the %s winner when retry and manual correction race", async winner => {
    const { db, reportId, job } = await world(true);
    const first = await scratch.open(), second = await scratch.open("result-race"), admin = await scratch.admin();
    const handler = createTranslationHandlers({ llm })[RETRANSLATE_REPORT_JOB];
    const held = holdTx(first, async tx => winner === "machine" ? handler(job, { db: tx, now }) : resolveReportWithHumanTranslation(tx, "result_mod", reportId, "Human winner", { now }));
    await held.ready;
    const pending = winner === "machine" ? resolveReportWithHumanTranslation(second, "result_mod", reportId, "Human loser", { now }) : handler(job, { db: second, now });
    try { await waitForLockWait(admin, "result-race"); } finally { await held.commit(); }
    await expectSettlesWithin<Awaited<typeof pending>>(pending, 10_000, "automatic/manual result race");
    await handler(job, { db, now });
    expect((await db.select().from(translationReports).where(eq(translationReports.id, reportId)))[0].outcome).toBe(winner === "machine" ? "machine_retranslated" : "human_corrected");
    expect(await db.select().from(notifications).where(eq(notifications.translationReportId, reportId))).toHaveLength(1);
  });

  it("rolls back a correction and its mail job before a waiting dismiss wins", async () => {
    const { db, topic, reportId } = await world();
    const first = await scratch.open(), second = await scratch.open("result-rollback"), admin = await scratch.admin();
    const held = holdTx(first, tx => resolveReportWithHumanTranslation(tx, "result_mod", reportId, "Rolled back", { now }));
    await held.ready;
    const pending = dismissReport(second, "result_mod", reportId, { now });
    try { await waitForLockWait(admin, "result-rollback"); } finally { await held.rollback(); }
    expect(await expectSettlesWithin(pending, 10_000, "dismiss after rollback")).toBe(true);
    expect((await db.select().from(translationReports).where(eq(translationReports.id, reportId)))[0]).toMatchObject({ outcome: "unchanged", correctedAt: null });
    expect(await db.select().from(translations).where(and(eq(translations.entryId, topic.id), eq(translations.kind, "human")))).toEqual([]);
    const notices = await db.select().from(notifications).where(eq(notifications.translationReportId, reportId));
    expect(notices).toHaveLength(1);
    expect(await db.select().from(jobs).where(and(eq(jobs.kind, SEND_NOTIFICATION_EMAIL_JOB), eq(jobs.dedupeKey, `notification-email:${notices[0].id}`)))).toHaveLength(1);
  });

  it("keeps a carried unchanged field open while a stale retry waits for the post", async () => {
    const { db, topic, reportId, job } = await world(true);
    const first = await scratch.open(), second = await scratch.open("result-carry"), admin = await scratch.admin();
    const held = holdTx(first, async tx => {
      await tx.update(entries).set({ sourceHash: "second", mentionRevision: 1 }).where(eq(entries.id, topic.id));
      await carryOverUnchangedFields(tx, topic.id, "first", "second", { title: false, body: true });
    });
    await held.ready;
    const pending = createTranslationHandlers({ llm })[RETRANSLATE_REPORT_JOB](job, { db: second, now });
    try { await waitForLockWait(admin, "result-carry"); } finally { await held.commit(); }
    await expectSettlesWithin(pending, 10_000, "carried report retry");
    expect((await db.select().from(translationReports).where(eq(translationReports.id, reportId)))[0]).toMatchObject({ status: "open", sourceHash: "second", route: "moderator", outcome: null });
    expect(await db.select().from(notifications).where(eq(notifications.translationReportId, reportId))).toEqual([]);
  });
});
