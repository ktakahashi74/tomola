import { and, eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { addMember, createTestDb } from "./helpers/db";
import { PG_MODE } from "./helpers/pg-test";
import { entries, jobs, translationReports } from "~/lib/db/schema";
import { updateTranslationReportDetails } from "~/lib/translation-reports.server";
import { retryFailedTranslations } from "~/lib/jobs/translation-recovery.server";
import { enqueue } from "~/lib/jobs/queue.server";
import { holdTx } from "./helpers/pg-concurrency";

describe.skipIf(!PG_MODE)("short server-side write locks", { tags: ["postgres"] }, () => {
  it.each(["current", "legacy"])("skips only the %s recovery that conflicts with ordinary enqueue and rolls back its allowance", async format => {
    let updating!: () => void;
    const updateStarted = new Promise<void>(resolve => { updating = resolve; });
    let watchedId: number | undefined;
    const db = await createTestDb({ logger: { logQuery: query => {
      if (watchedId && /^update "jobs" set "(?:payload|status)"/.test(query)) updating();
    } } });
    await addMember(db, "author", "author");
    const [entry] = await db.insert(entries).values({ authorId: "author", kind: "topic", body: "source", lang: "ja", sourceHash: "h" }).returning();
    const key = `translate:${entry.id}:ja:en:h`;
    const [failed] = await db.insert(jobs).values({ kind: "translate_entry", dedupeKey: format === "legacy" ? `translate:${entry.id}:en:h` : key, payload: { entryId: entry.id, lang: "en", sourceHash: "h" }, status: "failed", lastError: "network timeout" }).returning();
    await db.insert(jobs).values({ kind: "translate_entry", dedupeKey: `translate:${entry.id}:ja:fr:h`, payload: { entryId: entry.id, lang: "fr", sourceHash: "h" }, status: "failed", lastError: "network timeout" });
    const lock = holdTx(db, async tx => { await tx.select().from(jobs).where(eq(jobs.id, failed.id)).for("update"); });
    await lock.ready;
    watchedId = failed.id;
    const now = new Date("2026-10-17T03:00:00Z");
    const recovery = retryFailedTranslations(db, now);
    // Observe a query after the active-job lookup, without timing sleeps.
    try {
      await updateStarted;
      await enqueue(db, "translate_entry", { entryId: entry.id, lang: "en", sourceHash: "h" }, { dedupeKey: key });
    } finally { await lock.commit(); }
    expect(await recovery).toBe(1);
    expect((await db.select().from(jobs).where(eq(jobs.id, failed.id)))[0].status).toBe("failed");
    expect(await db.select().from(jobs).where(and(eq(jobs.kind, "translation_retry_marker"), eq(jobs.dedupeKey, `translation-retry:${entry.id}:en:h`)))).toHaveLength(0);
  });
  it("edits report details while an independent transaction shares the source row", async () => {
    const db = await createTestDb();
    await addMember(db, "author", "author");
    const [entry] = await db.insert(entries).values({ authorId: "author", kind: "topic", body: "source", lang: "ja", sourceHash: "h" }).returning();
    const [report] = await db.insert(translationReports).values({ entryId: entry.id, lang: "en", field: "body", reporterId: "author", sourceHash: "h" }).returning();
    let acquired!: () => void, release!: () => void;
    const held = new Promise<void>(resolve => { acquired = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const lock = db.transaction(async tx => { await tx.select().from(entries).where(eq(entries.id, entry.id)).for("share"); acquired(); await gate; });
    await held;
    try {
      const result = await db.transaction(async tx => {
        await tx.execute(sql`SET LOCAL lock_timeout = '250ms'`);
        return updateTranslationReportDetails(tx, "author", report.id, { entryId: entry.id, lang: "en", field: "body", excerpt: "updated", note: "note" });
      });
      expect(result).toMatchObject({ ok: true });
    } finally { release(); await lock; }
  });
  it("recovers once under concurrent runs without blocking an unrelated job write", async () => {
    const queries: string[] = [];
    const db = await createTestDb({ logger: { logQuery: query => { queries.push(query); } } });
    await addMember(db, "author", "author");
    const [entry] = await db.insert(entries).values({ authorId: "author", kind: "topic", body: "source", lang: "ja", sourceHash: "h" }).returning();
    await db.insert(jobs).values({ kind: "translate_entry", dedupeKey: `translate:${entry.id}:ja:en:h`, payload: { entryId: entry.id, lang: "en", sourceHash: "h" }, status: "failed", lastError: "network timeout" });
    const [other] = await db.insert(jobs).values({ kind: "unrelated" }).returning();
    let acquired!: () => void, release!: () => void;
    const held = new Promise<void>(resolve => { acquired = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const lock = db.transaction(async tx => { await tx.update(jobs).set({ attempts: 1 }).where(eq(jobs.id, other.id)); acquired(); await gate; });
    await held;
    const now = new Date("2026-10-17T03:00:00Z");
    try {
      const recovered = await db.transaction(async tx => { await tx.execute(sql`SET LOCAL lock_timeout = '250ms'`); return retryFailedTranslations(tx, now); });
      expect(recovered).toBe(1);
      expect(queries.some(query => /lock table .*jobs/i.test(query))).toBe(false);
      expect(queries.some(query => /payload.*->>/.test(query))).toBe(false);
    } finally { release(); await lock; }
    await db.update(jobs).set({ status: "failed" }).where(and(eq(jobs.kind, "translate_entry"), eq(jobs.dedupeKey, `translate:${entry.id}:ja:en:h`)));
    const runs = await Promise.all([retryFailedTranslations(db, new Date("2026-10-18T03:00:00Z")), retryFailedTranslations(db, new Date("2026-10-18T03:00:00Z"))]);
    expect(runs.reduce((sum, n) => sum + n, 0)).toBe(1);
    expect((await db.select().from(jobs).where(eq(jobs.kind, "translate_entry"))).filter(job => job.status === "queued")).toHaveLength(1);
  });
});
