import { eq, sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { chatAccessLog, invitations, jobs, llmUsage, notifications, rateLimits, reports, retentionHold, session, signingChallenges, verification, villages } from "~/lib/db/schema";
import { createMaintenanceHandlers, ensureCleanupScheduled, runMaintenanceCleanup } from "~/lib/jobs/maintenance-jobs.server";
import { runDueJobs } from "~/lib/jobs/queue.server";
import { runRetentionCleanup } from "~/lib/retention.server";
import { RETENTION, RETENTION_BATCH_SIZE, RETENTION_MAX_BATCHES, monthsBefore } from "~/lib/retention";
import { withRetentionBatch } from "~/lib/retention-guard.server";
import { PG_MODE } from "./helpers/pg-test";
import { addMember, createTestDb } from "./helpers/db";
import { auditRetentionTransactions, expectBoundedTransactions } from "./helpers/retention";

const NOW = new Date("2030-03-31T12:00:00Z");
const DAY = 86_400_000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);

it("uses the supplied clock for notification, session, login, rate-limit and LLM expiry boundaries", async () => {
  const db = await createTestDb();
  await addMember(db, "a", "alice");
  await db.insert(notifications).values([
    { userId: "a", kind: "mention", createdAt: ago(92), readAt: ago(91) },
    { userId: "a", kind: "mention", createdAt: ago(179) },
    { userId: "a", kind: "mention", createdAt: ago(181) },
    { userId: "a", kind: "mention", createdAt: ago(89), readAt: ago(1) },
  ]);
  await db.insert(session).values([
    { id: "expired", token: "expired", userId: "a", createdAt: ago(1), updatedAt: ago(1), expiresAt: NOW },
    { id: "absolute", token: "absolute", userId: "a", createdAt: ago(90), updatedAt: ago(1), expiresAt: ago(-1) },
    { id: "live", token: "live", userId: "a", createdAt: ago(89), updatedAt: ago(1), expiresAt: ago(-1) },
  ]);
  for (const [id, expiresAt] of [["expired", NOW], ["live", ago(-1)]] as const) {
    await db.insert(verification).values({ id, identifier: id, value: "private", expiresAt });
    await db.insert(rateLimits).values({ key: id, windowStart: ago(1), count: 1, expiresAt });
  }
  await db.insert(llmUsage).values([
    { engine: "fake", model: "m", purpose: "translate", createdAt: new Date("2029-02-28T11:59:59Z") },
    { engine: "fake", model: "m", purpose: "translate", createdAt: new Date("2029-02-28T12:00:00Z") },
    { engine: "fake", model: "m", purpose: "translate", createdAt: NOW },
  ]);
  await runRetentionCleanup(db, NOW);
  expect(await db.select().from(notifications)).toHaveLength(2);
  expect((await db.select().from(session)).map(r => r.id)).toEqual(["live"]);
  expect((await db.select().from(verification)).map(r => r.id)).toEqual(["live"]);
  expect((await db.select().from(rateLimits)).map(r => r.key)).toEqual(["live"]);
  expect(await db.select().from(llmUsage)).toHaveLength(2);
});

it("retains audit and notification records at the cutoff, holds all categories, and deletes immediately after it", async () => {
  const db = await createTestDb();
  await addMember(db, "a", "alice");
  const [village] = await db.insert(villages).values({ kind: "invite_public", name: "Audit fixture", slug: "audit-fixture" }).returning();
  const [report] = await db.insert(reports).values({ villageId: village.id, reporterId: "a", reason: "other" }).returning();
  await db.insert(chatAccessLog).values({ villageId: village.id, reportId: report.id, readerId: "a", readerHandle: "alice", kind: "context", fromSeq: 0, toSeq: 0, ranges: [], versions: [], reason: "Review", createdAt: monthsBefore(NOW, RETENTION.chatAccessYears * 12) });
  await db.insert(notifications).values([
    { userId: "a", kind: "mention", createdAt: ago(100), readAt: ago(RETENTION.readNotificationDays) },
    { userId: "a", kind: "mention", createdAt: ago(RETENTION.unreadNotificationDays) },
  ]);
  await db.insert(session).values({ id: "s", token: "s", userId: "a", createdAt: ago(1), updatedAt: ago(1), expiresAt: NOW });
  await db.insert(llmUsage).values({ engine: "fake", model: "m", purpose: "translate", createdAt: new Date("2029-02-28T12:00:00Z") });
  await db.insert(signingChallenges).values({ challenge: "c", userId: "a", operation: "create-topic", payload: "private", payloadHash: "p", formHash: "f", createdAt: ago(1), expiresAt: NOW });
  await db.update(retentionHold).set({ active: true });
  await runRetentionCleanup(db, new Date(NOW.getTime() + 1));
  expect(await db.select().from(chatAccessLog)).toHaveLength(1);
  expect(await db.select().from(notifications)).toHaveLength(2);
  expect(await db.select().from(session)).toHaveLength(1);
  expect(await db.select().from(llmUsage)).toHaveLength(1);
  expect(await db.select().from(signingChallenges)).toHaveLength(1);
  await db.update(retentionHold).set({ active: false });
  await runRetentionCleanup(db, NOW);
  expect(await db.select().from(chatAccessLog)).toHaveLength(1);
  expect(await db.select().from(notifications)).toHaveLength(2);
  expect(await db.select().from(llmUsage)).toHaveLength(1);
  await runRetentionCleanup(db, new Date(NOW.getTime() + 1));
  expect(await db.select().from(chatAccessLog)).toEqual([]);
  expect(await db.select().from(notifications)).toEqual([]);
  expect(await db.select().from(session)).toEqual([]);
  expect(await db.select().from(llmUsage)).toEqual([]);
  expect(await db.select().from(signingChallenges)).toEqual([]);
});

it("a preservation hold stops the existing maintenance cleanups too, then release resumes them", async () => {
  const db = await createTestDb();
  await addMember(db, "a", "alice");
  await db.insert(jobs).values({ kind: "old", status: "done", updatedAt: ago(31) });
  await db.insert(invitations).values({ id: "i", tokenHash: "x", email: "invitee@example.com", createdBy: "a", expiresAt: ago(31) });
  await db.insert(verification).values({ id: "v", identifier: "v", value: "private", expiresAt: ago(1) });
  await db.insert(rateLimits).values({ key: "r", windowStart: ago(2), count: 1, expiresAt: ago(1) });
  await db.update(retentionHold).set({ active: true, reason: "test preservation" });
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    await ensureCleanupScheduled(db, ago(1));
    await runDueJobs(db, createMaintenanceHandlers(), { now: NOW });
    expect((await db.select().from(jobs).where(eq(jobs.kind, "old")))).toHaveLength(1);
    expect((await db.select().from(invitations))[0].email).toBe("invitee@example.com");
    expect(await db.select().from(verification)).toHaveLength(1);
    expect(await db.select().from(rateLimits)).toHaveLength(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("preservation hold"));
    await db.update(retentionHold).set({ active: false, reason: null });
    await runRetentionCleanup(db, NOW);
    expect(await db.select().from(verification)).toEqual([]);
    expect(await db.select().from(rateLimits)).toEqual([]);
  } finally { log.mockRestore(); }
});

describe("bounded retention on PostgreSQL", () => {
  it("drains 350 expired records in one invocation using transactions of at most 100 rows", async () => {
    const db = await createTestDb();
    await db.insert(verification).values(Array.from({ length: 350 }, (_, i) => ({ id: `v${i}`, identifier: `v${i}`, value: "private", expiresAt: ago(1) })));
    await auditRetentionTransactions(db, [verification]);
    await runRetentionCleanup(db, NOW);
    expect(await db.select().from(verification)).toEqual([]);
    await expectBoundedTransactions(db, 350);
  });

  it("reports the capped backlog and drains it on the next invocation", async () => {
    const db = await createTestDb();
    const size = RETENTION_BATCH_SIZE * RETENTION_MAX_BATCHES;
    await db.insert(verification).values(Array.from({ length: size + 7 }, (_, i) => ({ id: `v${i}`, identifier: `v${i}`, value: "private", expiresAt: ago(1) })));
    const first = await runRetentionCleanup(db, NOW);
    expect(first.verification).toMatchObject({ removed: size, remaining: 7, batches: RETENTION_MAX_BATCHES, stop: "limit" });
    expect(await db.select().from(verification)).toHaveLength(7);
    const next = await runRetentionCleanup(db, NOW);
    expect(next.verification).toMatchObject({ removed: 7, remaining: 0, stop: "complete" });
    expect(await db.select().from(verification)).toEqual([]);
  });

  it("rechecks a newly committed hold between batches", async () => {
    const db = await createTestDb();
    await db.insert(verification).values(Array.from({ length: 350 }, (_, i) => ({ id: `v${i}`, identifier: `v${i}`, value: "private", expiresAt: ago(1) })));
    await db.execute(sql`create function request_hold() returns trigger language plpgsql as $$ begin
      update retention_hold set active = true where id = 1;
      return old;
    end $$`);
    await db.execute(sql`create trigger request_hold after delete on verification for each statement execute function request_hold()`);
    const result = await runRetentionCleanup(db, NOW);
    expect(result.verification).toMatchObject({ removed: 100, remaining: 250, batches: 1, stop: "hold" });
    expect(await db.select().from(verification)).toHaveLength(250);
    await db.execute(sql`drop trigger request_hold on verification`);
    await db.update(retentionHold).set({ active: false });
    await runRetentionCleanup(db, NOW);
    expect(await db.select().from(verification)).toEqual([]);
  });
});

it.skipIf(!PG_MODE)("enabling a hold waits for the in-flight batch and prevents the next batch", { tags: ["postgres"] }, async () => {
  const db = await createTestDb();
  let entered!: () => void, release!: () => void;
  const inside = new Promise<void>(r => { entered = r; });
  const gate = new Promise<void>(r => { release = r; });
  const first = withRetentionBatch(db, async () => { entered(); await gate; return "finished"; });
  await inside;
  const hold = db.update(retentionHold).set({ active: true, reason: "test hold" }).then(() => "held");
  try {
    await expect.poll(async () => {
      const result = await db.execute(sql`select count(*)::int as waiting from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and cardinality(pg_blocking_pids(pid)) > 0`) as { rows: { waiting: number }[] };
      return result.rows[0].waiting;
    }).toBeGreaterThan(0);
  } finally { release(); }
  expect(await first).toBe("finished");
  expect(await hold).toBe("held");
  const next = vi.fn(async () => "should not run");
  expect(await withRetentionBatch(db, next)).toBeNull();
  expect(next).not.toHaveBeenCalled();
});

it("fails closed when the permanent hold control row is missing", async () => {
  const db = await createTestDb();
  await db.insert(verification).values({ id: "v", identifier: "v", value: "private", expiresAt: ago(1) });
  await db.delete(retentionHold);
  await expect(runRetentionCleanup(db, NOW)).rejects.toThrow("Missing retention hold control row");
  expect(await db.select().from(verification)).toHaveLength(1);
});

it.each(["rate_limits", "verification"])("shares one elapsed-time budget across maintenance categories, expiring during %s", async category => {
  let elapsed = 0;
  const db = await createTestDb({ logger: { logQuery(query) {
    // Advance a fake monotonic clock during a real mutation, without sleeping.
    if (query.startsWith(`delete from "${category}"`)) elapsed = 60_000;
  } } });
  await db.insert(rateLimits).values(Array.from({ length: 350 }, (_, i) => ({ key: `r${i}`, windowStart: ago(2), count: 1, expiresAt: ago(1) })));
  await db.insert(verification).values(Array.from({ length: 350 }, (_, i) => ({ id: `v${i}`, identifier: `v${i}`, value: "private", expiresAt: ago(1) })));
  await db.insert(jobs).values({ kind: "old", status: "done", updatedAt: ago(31) });
  await auditRetentionTransactions(db, [rateLimits, verification, jobs]);
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    const result = await runMaintenanceCleanup(db, NOW, { clock: () => elapsed });
    expect(result[category]).toMatchObject({ removed: 100, remaining: 250, batches: 1, stop: "time" });
    expect(result.finished_jobs).toMatchObject({ removed: 0, remaining: 1, batches: 0, stop: "time" });
    if (category === "rate_limits") expect(result.verification).toMatchObject({ removed: 0, remaining: 350, batches: 0, stop: "time" });
    else expect(result.rate_limits).toMatchObject({ removed: 350, remaining: 0, stop: "complete" });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('"stop":"time"'));
    await expectBoundedTransactions(db, category === "rate_limits" ? 100 : 450);
    // A fresh invocation gets its own budget and can finish the backlog.
    const next = await runMaintenanceCleanup(db, NOW, { clock: () => elapsed });
    expect(next.verification).toMatchObject({ remaining: 0, stop: "complete" });
    expect(next.finished_jobs).toMatchObject({ removed: 1, remaining: 0, stop: "complete" });
  } finally { log.mockRestore(); }
});

it("finishes the in-flight transaction and stops maintenance at the worker shutdown signal", async () => {
  const shutdown = new AbortController();
  const db = await createTestDb({ logger: { logQuery(query) {
    if (query.startsWith('delete from "verification"')) shutdown.abort();
  } } });
  await db.insert(verification).values(Array.from({ length: 350 }, (_, i) => ({ id: `v${i}`, identifier: `v${i}`, value: "private", expiresAt: ago(1) })));
  await db.insert(jobs).values({ kind: "old", status: "done", updatedAt: ago(31) });
  await auditRetentionTransactions(db, [verification]);
  await ensureCleanupScheduled(db, ago(1));
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    const stats = await runDueJobs(db, createMaintenanceHandlers(), { now: NOW, signal: shutdown.signal });
    expect(stats.done).toBe(1);
    expect(await db.select().from(verification)).toHaveLength(250);
    expect(await db.select().from(jobs).where(eq(jobs.kind, "old"))).toHaveLength(1);
    await expectBoundedTransactions(db, 100);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('"stop":"signal"'));
  } finally { log.mockRestore(); }
});
