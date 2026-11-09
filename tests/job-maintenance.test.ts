import { quietLogger as silent } from "./helpers/logger";
import { RETENTION } from "~/lib/retention";
import { asc, eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Db } from "~/lib/db/client.server";
import { verification } from "~/lib/db/auth-schema";
import { jobs, rateLimits } from "~/lib/db/schema";
import { dateOf, ensureDailyJob, nextDailyAt } from "~/lib/jobs/daily.server";
import {
  CLEANUP_JOBS_JOB,
  createMaintenanceHandlers,
  deleteFinishedJobs,
  ensureCleanupScheduled,
  ensureCleanupScheduledThrottled,
} from "~/lib/jobs/maintenance-jobs.server";
import { ensureDigestScheduled } from "~/lib/jobs/notification-jobs.server";
import { enqueue, HEARTBEAT_MS, runDueJobs, STUCK_AFTER_MS, type JobHandler } from "~/lib/jobs/queue.server";
import { startWorker } from "~/lib/jobs/worker.server";
import { SEND_DIGEST_JOB } from "~/lib/notifications.server";
import { addMember, createTestDb } from "./helpers/db";
import { createTopic } from "~/lib/entries.server";
import { runMaintenanceCleanup } from "~/lib/jobs/maintenance-jobs.server";

// run_at defaults to database now(), so keep the test clock ahead of wall time.
const t0 = new Date("2030-10-01T00:00:00Z");
const at = (sec: number) => new Date(t0.getTime() + sec * 1000);

const DAY = 24 * 60 * 60 * 1000;
const one = async (db: Db, id: number) => (await db.select().from(jobs).where(eq(jobs.id, id)))[0];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("the heartbeat of running jobs", () => {
  it("is every STUCK_AFTER_MS / 4", () => {
    expect(HEARTBEAT_MS).toBe(STUCK_AFTER_MS / 4);
  });

  it("refreshes locked_at while the handler runs, so another worker does not take the job over, and clears it when done", async () => {
    const db = await createTestDb();
    const { id } = await enqueue(db, "slow", {}, { runAt: t0 });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let started!: () => void;
    const startedP = new Promise<void>((r) => (started = r));
    const slow: JobHandler = async () => {
      started();
      await gate;
    };
    const a = runDueJobs(db, { slow }, { now: t0, logger: silent, heartbeatMs: 10 });
    await startedP;
    expect((await one(db, id)).lockedAt).toEqual(t0);
    await vi.waitFor(async () => expect((await one(db, id)).lockedAt!.getTime()).toBeGreaterThan(t0.getTime()));
    // Another worker past STUCK_AFTER_MS since startup must not reclaim it because locked_at was refreshed.
    const b = await runDueJobs(db, { slow }, { now: new Date(t0.getTime() + STUCK_AFTER_MS + 5), logger: silent });
    expect(b).toMatchObject({ recovered: 0, ran: 0 });
    expect(await one(db, id)).toMatchObject({ status: "running", attempts: 1 });
    release();
    expect(await a).toMatchObject({ ran: 1, done: 1 });
    expect(await one(db, id)).toMatchObject({ status: "done", lockedAt: null });
  });

  it("without a heartbeat the same job would be taken over (the control)", async () => {
    const db = await createTestDb();
    const { id } = await enqueue(db, "slow", {}, { runAt: t0 });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let started!: () => void;
    const startedP = new Promise<void>((r) => (started = r));
    const a = runDueJobs(db, { slow: async () => { started(); await gate; } }, { now: t0, logger: silent, heartbeatMs: 3_600_000 });
    await startedP;
    const b = await runDueJobs(db, { slow: async () => {} }, { now: new Date(t0.getTime() + STUCK_AFTER_MS + 5), logger: silent });
    expect(b).toMatchObject({ recovered: 1 });
    release();
    await a;
    // Worker b reclaimed and owns the job, so a must not write its result.
    expect((await one(db, id)).status).toBe("done");
    expect((await one(db, id)).attempts).toBe(2);
  });

  it("stops beating when the job was taken over, and does not overwrite the new owner's result", async () => {
    const db = await createTestDb();
    const { id } = await enqueue(db, "slow", {}, { runAt: t0 });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let started!: () => void;
    const startedP = new Promise<void>((r) => (started = r));
    const a = runDueJobs(db, { slow: async () => { started(); await gate; } }, { now: t0, logger: silent, heartbeatMs: 10 });
    await startedP;
    // Simulate b reclaiming a long-running job by moving locked_at behind current time.
    await db.update(jobs).set({ lockedAt: new Date(t0.getTime() - STUCK_AFTER_MS - 1000) }).where(eq(jobs.id, id));
    let bRunning!: () => void;
    const bStarted = new Promise<void>((r) => (bRunning = r));
    let bRelease!: () => void;
    const bGate = new Promise<void>((r) => (bRelease = r));
    const bNow = at(1);
    const b = runDueJobs(db, { slow: async () => { bRunning(); await bGate; } }, { now: bNow, logger: silent, heartbeatMs: 3_600_000 });
    await bStarted;
    await sleep(60);
    // a can no longer update b's row; locked_at stays at b's claim time.
    expect((await one(db, id)).lockedAt).toEqual(bNow);
    release();
    await a;
    expect(await one(db, id)).toMatchObject({ status: "running", attempts: 2 });
    bRelease();
    await b;
    expect(await one(db, id)).toMatchObject({ status: "done", attempts: 2 });
  });

  it("does not start another job once the abort signal is given, but finishes the running one", async () => {
    const db = await createTestDb();
    const abort = new AbortController();
    const ran: string[] = [];
    const handler: JobHandler = async (job) => {
      ran.push((job.payload as { n: string }).n);
      abort.abort();
    };
    for (const n of ["a", "b", "c"]) await enqueue(db, "job", { n }, { runAt: t0 });
    const stats = await runDueJobs(db, { job: handler }, { now: t0, logger: silent, signal: abort.signal });
    expect(stats).toMatchObject({ ran: 1, done: 1 });
    expect(ran).toEqual(["a"]);
    expect((await db.select().from(jobs).where(eq(jobs.status, "queued"))).length).toBe(2);
  });
});

describe("the worker's stop and the signals", () => {
  type G = { __tomolaWorker?: { stop(): Promise<unknown> } };
  const g = globalThis as G;
  afterEach(async () => {
    vi.restoreAllMocks();
    await g.__tomolaWorker?.stop();
    g.__tomolaWorker = undefined;
  });
  const stats = { ran: 0, done: 0, retried: 0, failed: 0, deferred: 0, recovered: 0 };

  it("waits for the run in progress, up to the timeout, and reports whether it finished", async () => {
    const db = await createTestDb();
    let release!: () => void;
    let started = 0;
    let finished = 0;
    const run = vi.fn(async () => {
      started++;
      await new Promise<void>((r) => (release = r));
      finished++;
      return stats;
    });
    const first = startWorker({ env: {}, intervalMs: 5, getDb: async () => db, handlers: {}, run, signals: false })!;
    await vi.waitFor(() => expect(started).toBe(1));
    // Wait for the running iteration to finish, completing it while waiting.
    const stopping = first.stop({ timeoutMs: 5_000 });
    release();
    expect(await stopping).toEqual({ drained: true });
    expect(finished).toBe(1);
    // If execution exceeds the limit, return without waiting; that iteration remains unfinished.
    const second = startWorker({ env: {}, intervalMs: 5, getDb: async () => db, handlers: {}, run, signals: false })!;
    await vi.waitFor(() => expect(started).toBe(2));
    expect(await second.stop({ timeoutMs: 5 })).toEqual({ drained: false });
    expect(finished).toBe(1);
    release();
    await vi.waitFor(() => expect(finished).toBe(2));
  });

  // Temporarily remove existing signal handlers, including Vitest's, and restore afterward.
  function withListeners<T>(name: NodeJS.Signals, install: Array<{ kind: "on" | "once"; fn: () => void }>, run: () => Promise<T>): Promise<T> {
    const saved = process.listeners(name);
    process.removeAllListeners(name);
    for (const { kind, fn } of install) process[kind](name, fn);
    return run().finally(() => {
      process.removeAllListeners(name);
      for (const fn of saved) process.on(name, fn as () => void);
    });
  }

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    // Three cases: an earlier process.on handler; an earlier process.once handler that removes itself first; or no other handler.
    for (const [label, install, expectKill] of [
      ["(a) another process.on listener registered first: no kill (it is left to that listener)", [{ kind: "on" as const, fn: () => {} }], false],
      ["(b) another process.once listener registered first (it is gone when the signal arrives): no kill", [{ kind: "once" as const, fn: () => {} }], false],
      ["(c) no other listener: the signal is sent again so the process ends", [], true],
    ] as const) {
      it(`${signal}: stops the worker, removes its handlers, and ${label}`, async () => {
        const db = await createTestDb();
        const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
        vi.spyOn(console, "log").mockImplementation(() => {});
        await withListeners(signal, [...install], async () => {
          const before = { SIGTERM: process.listenerCount("SIGTERM"), SIGINT: process.listenerCount("SIGINT") };
          const run = vi.fn(async () => stats);
          const worker = startWorker({ env: {}, intervalMs: 5, getDb: async () => db, handlers: {}, run })!;
          expect(process.listenerCount("SIGTERM")).toBe(before.SIGTERM + 1);
          expect(process.listenerCount("SIGINT")).toBe(before.SIGINT + 1);
          await vi.waitFor(() => expect(run).toHaveBeenCalled());
          process.emit(signal);
          // Wait for shutdown and the decision whether to resend the signal.
          await worker.whenStopped();
          expect(g.__tomolaWorker).toBeUndefined();
          const calls = run.mock.calls.length;
          // Both signal handlers are removed; other once handlers have run and removed themselves.
          expect(process.listenerCount("SIGTERM")).toBe(before.SIGTERM - (signal === "SIGTERM" ? install.filter((i) => i.kind === "once").length : 0));
          expect(process.listenerCount("SIGINT")).toBe(before.SIGINT - (signal === "SIGINT" ? install.filter((i) => i.kind === "once").length : 0));
          await sleep(30);
          expect(run.mock.calls.length).toBe(calls);
          if (expectKill) expect(kill).toHaveBeenCalledWith(process.pid, signal);
          else expect(kill).not.toHaveBeenCalled();
        });
      });
    }
  }
});

describe("nextDailyAt and ensureDailyJob", () => {
  it("is the next UTC hour strictly after now", () => {
    expect(nextDailyAt(new Date("2026-10-05T01:00:00Z"), 3)).toEqual(new Date("2026-10-05T03:00:00Z"));
    expect(nextDailyAt(new Date("2026-10-05T03:00:00Z"), 3)).toEqual(new Date("2026-10-06T03:00:00Z"));
    expect(nextDailyAt(new Date("2026-10-05T23:59:59Z"), 3)).toEqual(new Date("2026-10-06T03:00:00Z"));
    expect(nextDailyAt(new Date("2026-12-31T12:00:00Z"), 0)).toEqual(new Date("2027-01-01T00:00:00Z"));
    expect(dateOf(new Date("2026-10-06T03:00:00Z"))).toBe("2026-10-06");
  });
});

describe("the digest is not created again for a day that already ran (clock skew)", () => {
  const digests = (db: Db) => db.select().from(jobs).where(eq(jobs.kind, SEND_DIGEST_JOB)).orderBy(asc(jobs.dedupeKey));

  it("does not recreate digest:D after it is done, when another process's clock is a little behind", async () => {
    const db = await createTestDb();
    // D=2030-10-06; the job ran at midnight D and became done.
    await enqueue(db, SEND_DIGEST_JOB, { date: "2030-10-06" }, { runAt: new Date("2030-10-06T00:00:00Z"), dedupeKey: "digest:2030-10-06" });
    await runDueJobs(db, { [SEND_DIGEST_JOB]: async () => {} }, { now: new Date("2030-10-06T00:00:00Z"), logger: silent });
    expect((await digests(db)).map((j) => [j.dedupeKey, j.status])).toEqual([["digest:2030-10-06", "done"]]);
    // A process two seconds behind midnight D does not requeue D.
    expect(await ensureDigestScheduled(db, new Date("2030-10-05T23:59:58Z"))).toMatchObject({ date: "2030-10-06", created: false });
    expect((await digests(db)).map((j) => [j.dedupeKey, j.status])).toEqual([["digest:2030-10-06", "done"]]);
    // After midnight D, queue the next day.
    expect(await ensureDigestScheduled(db, new Date("2030-10-06T00:00:01Z"))).toMatchObject({ date: "2030-10-07", created: true });
    // Do not requeue a day that finished failed either.
    await db.update(jobs).set({ status: "failed" }).where(eq(jobs.dedupeKey, "digest:2030-10-07"));
    expect(await ensureDigestScheduled(db, new Date("2030-10-06T23:59:59Z"))).toMatchObject({ created: false });
    expect(await ensureDigestScheduled(db, new Date("2030-10-07T00:00:00Z"))).toMatchObject({ date: "2030-10-08", created: true });
  });

  it("still keeps exactly one future job when none exists yet, and ignores other kinds of jobs", async () => {
    const db = await createTestDb();
    await enqueue(db, "other", {}, { dedupeKey: "digest:2099-01-01" });
    expect(await ensureDigestScheduled(db, new Date("2030-10-05T12:00:00Z"))).toMatchObject({ date: "2030-10-06", created: true });
    expect(await ensureDigestScheduled(db, new Date("2030-10-05T12:00:30Z"))).toMatchObject({ created: false });
    expect(await digests(db)).toHaveLength(1);
  });
});

describe("cleanup_jobs", () => {
  it("is scheduled for the next 03:00 UTC with one job per date, and not again once that date ran", async () => {
    const db = await createTestDb();
    const now = new Date("2030-10-05T13:45:00Z");
    expect(await ensureCleanupScheduled(db, now)).toMatchObject({ date: "2030-10-06", runAt: new Date("2030-10-06T03:00:00Z"), created: true });
    expect(await ensureCleanupScheduled(db, now)).toMatchObject({ created: false });
    const rows = await db.select().from(jobs).where(eq(jobs.kind, CLEANUP_JOBS_JOB));
    expect(rows.map((j) => [j.dedupeKey, j.status, j.payload])).toEqual([["cleanup-jobs:2030-10-06", "queued", { date: "2030-10-06" }]]);
    // Execution queues the following day's job.
    const handlers = createMaintenanceHandlers();
    await runDueJobs(db, handlers, { now: new Date("2030-10-06T03:00:00Z"), logger: silent });
    const after = await db.select().from(jobs).where(eq(jobs.kind, CLEANUP_JOBS_JOB)).orderBy(asc(jobs.dedupeKey));
    expect(after.map((j) => [j.dedupeKey, j.status])).toEqual([["cleanup-jobs:2030-10-06", "done"], ["cleanup-jobs:2030-10-07", "queued"]]);
    // A slow-clock process must not requeue a completed day.
    expect(await ensureCleanupScheduled(db, new Date("2030-10-06T02:59:58Z"))).toMatchObject({ date: "2030-10-06", created: false });
    // Throttle worker prechecks to once per minute.
    const throttled = await createTestDb();
    await ensureCleanupScheduledThrottled(throttled, now);
    await throttled.delete(jobs);
    await ensureCleanupScheduledThrottled(throttled, new Date(now.getTime() + 1000));
    expect(await throttled.select().from(jobs)).toEqual([]);
    await ensureCleanupScheduledThrottled(throttled, new Date(now.getTime() + 61_000));
    expect(await throttled.select().from(jobs)).toHaveLength(1);
  });

  afterEach(() => vi.unstubAllEnvs());
  it("fills in missing translations after the cleanup in the job handler, not inside the retention run, and not once the worker is stopping", async () => {
    vi.stubEnv("TRANSLATION_BACKFILL_ENABLED", "1"); vi.stubEnv("ENABLED_LANGS", "ja,en");
    const db = await createTestDb(); await addMember(db, "mj_author", "mj_author");
    expect((await createTopic(db, "mj_author", { title: "題", body: "日本語の本文。", lang: "ja" })).ok).toBe(true);
    const translateJobs = async () => (await db.select().from(jobs)).filter(row => row.kind === "translate_entry").length;
    await db.delete(jobs);
    const now = new Date("2030-10-06T03:00:00Z");
    const handler = createMaintenanceHandlers()[CLEANUP_JOBS_JOB];
    // The restore path (scripts/retention.ts run) only cleans up.
    await runMaintenanceCleanup(db, now);
    expect(await translateJobs()).toBe(0);
    const stopping = new AbortController(); stopping.abort();
    await handler({} as never, { db, now, shutdownSignal: stopping.signal } as never);
    expect(await translateJobs()).toBe(0);
    await handler({} as never, { db, now, shutdownSignal: new AbortController().signal } as never);
    expect(await translateJobs()).toBe(1);
  });

  it("deletes done and failed jobs finished more than 30 days ago, and keeps newer ones and unfinished ones", async () => {
    const db = await createTestDb();
    const now = new Date("2030-11-15T03:00:00Z");
    const make = async (status: string, daysAgo: number, kind = "x") => {
      const { id } = await enqueue(db, kind, {}, { runAt: t0 });
      await db.update(jobs).set({ status, updatedAt: new Date(now.getTime() - daysAgo * DAY) }).where(eq(jobs.id, id));
      return id;
    };
    const oldDone = await make("done", 31);
    const oldFailed = await make("failed", 45);
    const edgeDone = await make("done", RETENTION.finishedJobDays - 0.001);
    const newFailed = await make("failed", 5);
    const oldQueued = await make("queued", 90);
    const oldRunning = await make("running", 90);
    expect(await deleteFinishedJobs(db, now)).toBe(2);
    const left = (await db.select({ id: jobs.id }).from(jobs)).map((j) => j.id).sort((a, b) => a - b);
    expect(left).toEqual([edgeDone, newFailed, oldQueued, oldRunning].sort((a, b) => a - b));
    expect([oldDone, oldFailed].some((id) => left.includes(id))).toBe(false);
  });

  it("the handler deletes them when it runs", async () => {
    const db = await createTestDb();
    const now = new Date("2030-11-15T03:00:00Z");
    const { id } = await enqueue(db, "x", {}, { runAt: t0 });
    await db.update(jobs).set({ status: "done", updatedAt: new Date(now.getTime() - 40 * DAY) }).where(eq(jobs.id, id));
    for (const [key, expiresAt] of [["expired", new Date(now.getTime() - 1)], ["live", new Date(now.getTime() + DAY)]] as const) {
      await db.insert(rateLimits).values({ key, windowStart: t0, expiresAt });
      await db.insert(verification).values({ id: key, identifier: key, value: "test", expiresAt });
    }
    await ensureCleanupScheduled(db, new Date(now.getTime() - DAY));
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await runDueJobs(db, createMaintenanceHandlers(), { now, logger: silent })).toMatchObject({ done: 1 });
    expect((await db.select({ id: jobs.id }).from(jobs).where(eq(jobs.id, id))).length).toBe(0);
    expect(await db.select({ key: rateLimits.key }).from(rateLimits)).toEqual([{ key: "live" }]);
    expect(await db.select({ id: verification.id }).from(verification)).toEqual([{ id: "live" }]);
    vi.restoreAllMocks();
  });

  it("ensureDailyJob is generic: one job per date per key prefix", async () => {
    const db = await createTestDb();
    const spec = { kind: "daily_x", keyPrefix: "daily-x", hourUtc: 5 };
    expect(await ensureDailyJob(db, spec, new Date("2030-10-05T06:00:00Z"))).toMatchObject({ date: "2030-10-06", created: true });
    expect(await ensureDailyJob(db, spec, new Date("2030-10-05T07:00:00Z"))).toMatchObject({ created: false });
    expect(await ensureDailyJob(db, spec, new Date("2030-10-06T05:00:00Z"))).toMatchObject({ date: "2030-10-07", created: true });
  });
});
