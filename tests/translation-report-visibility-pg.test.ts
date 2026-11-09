import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { addMember } from "./helpers/db";
import { createScratchDb, REAL_PG_URL, type ScratchDb } from "./helpers/pg-real";
import { expectSettlesWithin, holdTx, waitForLockWait } from "./helpers/pg-concurrency";
import { entries, translationReports, translations } from "~/lib/db/schema";
import { createReply, createTopic, softDeleteEntry } from "~/lib/entries.server";
import { createTranslationReport, resolveReportWithHumanTranslation, updateTranslationReportDetails } from "~/lib/translation-reports.server";

describe.skipIf(!REAL_PG_URL)("translation review visibility on PostgreSQL", { tags: ["postgres"] }, () => {
  let scratch: ScratchDb;
  beforeAll(async () => { scratch = await createScratchDb(); const db = await scratch.open(); await addMember(db, "report_author", "report_author"); await addMember(db, "report_reader", "report_reader"); }, 60_000);
  afterEach(async () => { await scratch.closeOpened(); });
  afterAll(async () => { await scratch?.drop(); });
  async function world() {
    const db = await scratch.open();
    const topic = await createTopic(db, "report_author", { lang: "ja", body: "Concurrent topic" });
    if (!topic.ok) throw new Error(topic.error);
    const reply = await createReply(db, "report_author", topic.id, { lang: "ja", body: "Concurrent reply" });
    if (!reply.ok) throw new Error(reply.error);
    const input = { entryId: reply.id, lang: "en", field: "body", excerpt: "", note: "" };
    const report = await createTranslationReport(db, "report_reader", input);
    if (!report.ok || !report.id) throw new Error("report failed");
    return { db, topic, reply, input, reportId: report.id };
  }
  it.each(["create", "details", "correct"] as const)("rechecks after a root deletion wins against %s", async action => {
    const { db, topic, reply, input, reportId } = await world();
    const first = await scratch.open(), second = await scratch.open("review-wait"), admin = await scratch.admin();
    const held = holdTx(first, tx => softDeleteEntry(tx, topic.id));
    await held.ready;
    const pending = action === "create" ? createTranslationReport(second, "report_reader", { ...input, lang: "fr" })
      : action === "details" ? updateTranslationReportDetails(second, "report_reader", reportId, { ...input, note: "More context" })
      : resolveReportWithHumanTranslation(second, "report_author", reportId, "Correction");
    try { await waitForLockWait(admin, "review-wait"); } finally { await held.commit(); }
    expect(await expectSettlesWithin<Awaited<typeof pending>>(pending, 10_000, "review after root deletion")).toEqual({ ok: false, error: "not_found" });
    expect(await db.select().from(translationReports).where(eq(translationReports.entryId, reply.id))).toMatchObject([{ id: reportId, status: "open", note: "" }]);
    expect(await db.select().from(translations).where(eq(translations.entryId, reply.id))).toEqual([]);
  });
  it("holds root visibility until a correction commits, before allowing root deletion", async () => {
    const { db, topic, reportId } = await world();
    const first = await scratch.open(), second = await scratch.open("deletion-wait"), admin = await scratch.admin();
    const held = holdTx(first, tx => resolveReportWithHumanTranslation(tx, "report_author", reportId, "Correction"));
    expect(await held.ready).toMatchObject({ ok: true });
    const pending = softDeleteEntry(second, topic.id);
    try { await waitForLockWait(admin, "deletion-wait"); } finally { await held.commit(); }
    expect(await expectSettlesWithin(pending, 10_000, "root deletion after correction")).toMatchObject({ ok: true });
    expect((await db.select().from(entries).where(eq(entries.id, topic.id)))[0].deletedAt).not.toBeNull();
  });
  it("allows corrections of distinct replies to share the root lock", async () => {
    const { db, topic, reportId } = await world();
    const reply = await createReply(db, "report_author", topic.id, { lang: "ja", body: "Another concurrent reply" });
    if (!reply.ok) throw new Error(reply.error);
    const report = await createTranslationReport(db, "report_reader", { entryId: reply.id, lang: "en" });
    if (!report.ok || !report.id) throw new Error("report failed");
    const first = await scratch.open(), second = await scratch.open();
    const held = holdTx(first, tx => resolveReportWithHumanTranslation(tx, "report_author", reportId, "First correction"));
    expect(await held.ready).toMatchObject({ ok: true });
    try {
      expect(await expectSettlesWithin(resolveReportWithHumanTranslation(second, "report_author", report.id, "Second correction"), 10_000, "independent reply correction")).toEqual({ ok: true, entryId: reply.id });
    } finally { await held.commit(); }
  });
  it("serializes corrections of the topic itself without a shared-lock upgrade", async () => {
    const { db, topic } = await world();
    const reports = await Promise.all(["en", "fr"].map(lang => createTranslationReport(db, "report_reader", { entryId: topic.id, lang })));
    const ids = reports.map(report => { if (!report.ok || !report.id) throw new Error("report failed"); return report.id; });
    const blocker = await scratch.open(), first = await scratch.open("topic-correct-en"), second = await scratch.open("topic-correct-fr"), admin = await scratch.admin();
    const held = holdTx(blocker, tx => tx.select({ id: entries.id }).from(entries).where(eq(entries.id, topic.id)).for("update"));
    await held.ready;
    const pending = Promise.all([first, second].map((connection, i) => resolveReportWithHumanTranslation(connection, "report_author", ids[i], `Topic correction ${i}`)));
    try {
      await waitForLockWait(admin, "topic-correct-en");
      await waitForLockWait(admin, "topic-correct-fr");
    } finally { await held.commit(); }
    expect(await expectSettlesWithin(pending, 10_000, "topic corrections")).toEqual([{ ok: true, entryId: topic.id }, { ok: true, entryId: topic.id }]);
  });
});
