import { quietLogger as silent } from "./helpers/logger";
import { deferred } from "./helpers/deferred";
import { asc, eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Db } from "~/lib/db/client.server";
import { jobs } from "~/lib/db/schema";
import {
  backoffMs,
  countFailedJobs,
  DeferJob,
  enqueue,
  isPermanentFailure,
  runDueJobs,
  STUCK_AFTER_MS,
  type JobHandler,
  type JobRow,
} from "~/lib/jobs/queue.server";
import { isWorkerEnabled, startWorker } from "~/lib/jobs/worker.server";
import { createTestDb } from "./helpers/db";

// run_at defaults to database now(), so keep the test clock ahead of wall time; otherwise advancing real time can leave queued jobs not yet due.
const t0 = new Date("2030-10-01T00:00:00Z");
const at = (sec: number) => new Date(t0.getTime() + sec * 1000);

const run = (db: Db, handlers: Record<string, JobHandler>, now = t0, limit?: number) =>
  runDueJobs(db, handlers, { now, limit, logger: silent });
const ok: JobHandler = async () => {};
const boom: JobHandler = async () => {
  throw new Error("boom");
};

const all = (db: Db) => db.select().from(jobs).orderBy(asc(jobs.id));
const one = async (db: Db, id: number): Promise<JobRow> => {
  const [row] = await db.select().from(jobs).where(eq(jobs.id, id));
  return row;
};

describe("enqueue", () => {
  it("creates a queued job with defaults", async () => {
    const db = await createTestDb();
    const { id, created } = await enqueue(db, "demo", { a: 1, nested: { b: [1, 2] } });
    expect(created).toBe(true);
    expect(await one(db, id)).toMatchObject({
      kind: "demo",
      payload: { a: 1, nested: { b: [1, 2] } },
      status: "queued",
      attempts: 0,
      maxAttempts: 5,
      lastError: null,
      dedupeKey: null,
      lockedAt: null,
    });
  });

  it("takes runAt and maxAttempts", async () => {
    const db = await createTestDb();
    const { id } = await enqueue(db, "demo", {}, { runAt: at(90), maxAttempts: 2 });
    expect(await one(db, id)).toMatchObject({ runAt: at(90), maxAttempts: 2 });
  });

  it("does not create a second job while one with the same dedupe key is queued or running", async () => {
    const db = await createTestDb();
    const first = await enqueue(db, "demo", { n: 1 }, { dedupeKey: "k" });
    const second = await enqueue(db, "demo", { n: 2 }, { dedupeKey: "k" });
    expect(first.created).toBe(true);
    expect(second).toEqual({ id: first.id, created: false });
    expect(await all(db)).toHaveLength(1);
    // Different keys or no key create separate jobs.
    expect((await enqueue(db, "demo", {}, { dedupeKey: "other" })).created).toBe(true);
    expect((await enqueue(db, "demo", {})).created).toBe(true);
    expect((await enqueue(db, "demo", {})).created).toBe(true);
    expect(await all(db)).toHaveLength(4);

    // Same behavior while running.
    let duringRun: { id: number; created: boolean } | undefined;
    await run(
      db,
      {
        demo: async (job) => {
          if (job.id === first.id) duringRun = await enqueue(db, "demo", {}, { dedupeKey: "k" });
        },
      },
      t0,
      1,
    );
    expect(duringRun).toEqual({ id: first.id, created: false });
  });

  it("allows the same dedupe key again once the job is done or failed", async () => {
    const db = await createTestDb();
    const a = await enqueue(db, "ok", {}, { dedupeKey: "k" });
    await run(db, { ok });
    expect((await one(db, a.id)).status).toBe("done");
    const b = await enqueue(db, "bad", {}, { dedupeKey: "k", maxAttempts: 1 });
    expect(b).toMatchObject({ created: true });
    expect(b.id).not.toBe(a.id);
    await run(db, { bad: boom });
    expect((await one(db, b.id)).status).toBe("failed");
    const c = await enqueue(db, "ok", {}, { dedupeKey: "k" });
    expect(c.created).toBe(true);
    expect(await all(db)).toHaveLength(3);
  });

  it("persists an opted-in request at the completion boundary, including an unchanged requested time, without consuming retry attempts", async () => {
    const db = await createTestDb();
    const { id } = await enqueue(db, "demo", {}, { dedupeKey: "again", runAt: t0, maxAttempts: 1 });
    let calls = 0;
    const handler: JobHandler = async () => {
      if (++calls === 1) await enqueue(db, "demo", {}, { dedupeKey: "again", runAt: t0, rescheduleRunning: true });
    };
    expect(await run(db, { demo: handler })).toMatchObject({ ran: 1, deferred: 1, done: 0 });
    expect(await one(db, id)).toMatchObject({ status: "queued", attempts: 0, runAt: new Date(t0.getTime() + 1) });
    expect(await run(db, { demo: handler }, at(1))).toMatchObject({ ran: 1, done: 1, deferred: 0 });
    expect(await one(db, id)).toMatchObject({ status: "done", attempts: 1 });
    expect(calls).toBe(2);
  });

  it("preserves a later running request when the handler defers", async () => {
    const db = await createTestDb();
    const { id } = await enqueue(db, "demo", {}, { dedupeKey: "later", runAt: t0 });
    await run(db, { demo: async () => {
      await enqueue(db, "demo", {}, { dedupeKey: "later", runAt: at(100), rescheduleRunning: true });
      throw new DeferJob(at(10));
    } });
    expect(await one(db, id)).toMatchObject({ status: "queued", attempts: 0, runAt: at(100) });
  });

  it("is rolled back with the transaction it was enqueued in", async () => {
    const db = await createTestDb();
    await expect(
      db.transaction(async (tx) => {
        await enqueue(tx, "demo", {}, { dedupeKey: "k" });
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(await all(db)).toHaveLength(0);
    await db.transaction(async (tx) => {
      await enqueue(tx, "demo", {}, { dedupeKey: "k" });
      // Deduplicate within one transaction too.
      expect((await enqueue(tx, "demo", {}, { dedupeKey: "k" })).created).toBe(false);
    });
    expect(await all(db)).toHaveLength(1);
  });
});

describe("runDueJobs", () => {
  it("runs due queued jobs in run_at order, passing the job and marking them done", async () => {
    const db = await createTestDb();
    const seen: Array<[string, unknown, Date]> = [];
    const handler: JobHandler = async (job, ctx) => {
      seen.push([job.kind, job.payload, ctx.now]);
    };
    await enqueue(db, "later", { n: 2 }, { runAt: at(-10) });
    await enqueue(db, "early", { n: 1 }, { runAt: at(-100) });
    const future = await enqueue(db, "later", { n: 3 }, { runAt: at(60) });
    const stats = await run(db, { early: handler, later: handler });
    expect(stats).toMatchObject({ ran: 2, done: 2, retried: 0, failed: 0 });
    expect(seen).toEqual([
      ["early", { n: 1 }, t0],
      ["later", { n: 2 }, t0],
    ]);
    const rows = await all(db);
    expect(rows.map((r) => r.status)).toEqual(["done", "done", "queued"]);
    expect(rows[0]).toMatchObject({ attempts: 1, lockedAt: null });
    // Jobs not yet due run when their time arrives.
    expect((await one(db, future.id)).status).toBe("queued");
    expect(await run(db, { later: handler }, at(61))).toMatchObject({ ran: 1, done: 1 });
  });

  it("respects the limit", async () => {
    const db = await createTestDb();
    for (let i = 0; i < 5; i++) await enqueue(db, "demo", { i });
    expect(await run(db, { demo: ok }, t0, 3)).toMatchObject({ ran: 3, done: 3 });
    expect((await all(db)).filter((r) => r.status === "queued")).toHaveLength(2);
  });

  it("leaves jobs without a registered handler alone", async () => {
    const db = await createTestDb();
    const { id } = await enqueue(db, "unknown");
    expect(await run(db, { other: ok })).toMatchObject({ ran: 0 });
    expect(await run(db, {})).toMatchObject({ ran: 0 });
    expect(await one(db, id)).toMatchObject({ status: "queued", attempts: 0 });
  });

  it("does not run the same job twice when called concurrently", async () => {
    const db = await createTestDb();
    await enqueue(db, "demo");
    let calls = 0;
    const entered = deferred(), release = deferred();
    const handler: JobHandler = async () => { calls++; entered.resolve(); await release.promise; };
    const first = run(db, { demo: handler });
    await entered.promise;
    let b;
    try { b = await run(db, { demo: handler }); }
    finally { release.resolve(); }
    const a = await first;
    expect(calls).toBe(1);
    expect(a.ran + b.ran).toBe(1);
  });

  it("delays a failed job exponentially and runs it again when it is due", async () => {
    const db = await createTestDb();
    const { id } = await enqueue(db, "flaky");
    let calls = 0;
    const flaky: JobHandler = async () => {
      calls++;
      if (calls < 3) throw new Error(`fail ${calls}`);
    };
    expect(await run(db, { flaky }, t0)).toMatchObject({ ran: 1, retried: 1 });
    expect(await one(db, id)).toMatchObject({
      status: "queued",
      attempts: 1,
      lastError: "Error: fail 1",
      runAt: new Date(t0.getTime() + backoffMs(1)),
      lockedAt: null,
    });
    // Do not run before the delay.
    expect(await run(db, { flaky }, at(29))).toMatchObject({ ran: 0 });
    expect(await run(db, { flaky }, at(30))).toMatchObject({ ran: 1, retried: 1 });
    expect(await one(db, id)).toMatchObject({ attempts: 2, runAt: at(30 + 60) });
    expect(await run(db, { flaky }, at(30 + 59))).toMatchObject({ ran: 0 });
    expect(await run(db, { flaky }, at(90))).toMatchObject({ ran: 1, done: 1 });
    expect(await one(db, id)).toMatchObject({ status: "done", attempts: 3 });
  });

  it("marks a job failed when it runs out of attempts, and does not run it again", async () => {
    const db = await createTestDb();
    const { id } = await enqueue(db, "bad", {}, { maxAttempts: 3 });
    let now = t0;
    const stats = [];
    for (let i = 0; i < 4; i++) {
      stats.push(await run(db, { bad: boom }, now));
      now = new Date(now.getTime() + 3600_000);
    }
    expect(stats.map((s) => [s.retried, s.failed])).toEqual([
      [1, 0],
      [1, 0],
      [0, 1],
      [0, 0],
    ]);
    expect(await one(db, id)).toMatchObject({ status: "failed", attempts: 3, lastError: "Error: boom", lockedAt: null });
  });

  it("keeps running other jobs when a handler throws (also for non-Error values)", async () => {
    const db = await createTestDb();
    const a = await enqueue(db, "ok");
    const b = await enqueue(db, "bad");
    const c = await enqueue(db, "weird");
    const d = await enqueue(db, "ok");
    const weird: JobHandler = async () => {
      throw "just a string";
    };
    const stats = await run(db, { ok, bad: boom, weird });
    expect(stats).toMatchObject({ ran: 4, done: 2, retried: 2 });
    expect((await one(db, a.id)).status).toBe("done");
    expect((await one(db, d.id)).status).toBe("done");
    expect(await one(db, b.id)).toMatchObject({ status: "queued", lastError: "Error: boom" });
    expect(await one(db, c.id)).toMatchObject({ status: "queued", lastError: "just a string" });
  });

  it("truncates a very long error message", async () => {
    const db = await createTestDb();
    const { id } = await enqueue(db, "bad");
    await run(db, {
      bad: async () => {
        throw new Error("x".repeat(10_000));
      },
    });
    expect((await one(db, id)).lastError).toHaveLength(2000);
  });

  it("puts a deferred job back without counting an attempt", async () => {
    const db = await createTestDb();
    const { id } = await enqueue(db, "paused", {}, { maxAttempts: 1 });
    let paused = true;
    const handler: JobHandler = async () => {
      if (paused) throw new DeferJob(at(600), "budget stopped");
    };
    expect(await run(db, { paused: handler }, t0)).toMatchObject({ ran: 1, deferred: 1, retried: 0, failed: 0 });
    expect(await one(db, id)).toMatchObject({
      status: "queued",
      attempts: 0,
      runAt: at(600),
      lastError: "deferred: budget stopped",
      lockedAt: null,
    });
    // Repeated deferral never fails a job, even with maxAttempts=1.
    expect(await run(db, { paused: handler }, at(599))).toMatchObject({ ran: 0 });
    expect(await run(db, { paused: handler }, at(600))).toMatchObject({ deferred: 1 });
    expect(await one(db, id)).toMatchObject({ status: "queued", attempts: 0 });
    paused = false;
    expect(await run(db, { paused: handler }, at(1200))).toMatchObject({ done: 1 });
    expect(await one(db, id)).toMatchObject({ status: "done", attempts: 1 });
  });
});

describe("errors that are not retried", () => {
  class NoRetry extends Error {
    readonly retryable = false;
  }

  it("fails a job at once (attempt 1, no retry scheduled) when the error says it is not retryable", async () => {
    const db = await createTestDb();
    const { id } = await enqueue(db, "a", {}, { maxAttempts: 10 });
    const stats = await run(db, {
      a: async () => {
        throw new NoRetry("refused");
      },
    });
    expect(stats).toMatchObject({ ran: 1, failed: 1, retried: 0 });
    expect(await one(db, id)).toMatchObject({ status: "failed", attempts: 1, lastError: "Error: refused", lockedAt: null });
    // No further execution.
    expect(await run(db, { a: ok }, at(3600))).toMatchObject({ ran: 0 });
  });

  it("still retries ordinary errors and errors that say retryable: true", async () => {
    const db = await createTestDb();
    const a = await enqueue(db, "a");
    class Flaky extends Error {
      readonly retryable = true;
    }
    const stats = await run(db, {
      a: async () => {
        throw new Flaky("again");
      },
    });
    expect(stats).toMatchObject({ retried: 1, failed: 0 });
    expect(await one(db, a.id)).toMatchObject({ status: "queued", attempts: 1 });
    expect(isPermanentFailure(new NoRetry("x"))).toBe(true);
    expect(isPermanentFailure(new Error("x"))).toBe(false);
    expect(isPermanentFailure("x")).toBe(false);
    expect(isPermanentFailure(null)).toBe(false);
  });

  it("counts failed jobs per kind", async () => {
    const db = await createTestDb();
    expect(await countFailedJobs(db)).toEqual([]);
    await enqueue(db, "b", {}, { maxAttempts: 1 });
    await enqueue(db, "a", {}, { maxAttempts: 1 });
    await enqueue(db, "a", {}, { maxAttempts: 1 });
    await enqueue(db, "c");
    await run(db, { a: boom, b: boom, c: ok });
    expect(await countFailedJobs(db)).toEqual([
      { kind: "a", count: 2 },
      { kind: "b", count: 1 },
    ]);
  });
});

describe("recovery of stuck jobs", () => {
  async function insertRunning(db: Db, lockedAgoMs: number, opts: { attempts?: number; maxAttempts?: number } = {}) {
    const [row] = await db
      .insert(jobs)
      .values({
        kind: "demo",
        status: "running",
        lockedAt: new Date(t0.getTime() - lockedAgoMs),
        attempts: opts.attempts ?? 1,
        maxAttempts: opts.maxAttempts ?? 5,
      })
      .returning({ id: jobs.id });
    return row.id;
  }

  it("puts a job that has been running for over 10 minutes back to queued and runs it", async () => {
    const db = await createTestDb();
    const stuck = await insertRunning(db, STUCK_AFTER_MS + 1000);
    const recent = await insertRunning(db, STUCK_AFTER_MS - 60_000);
    const calls: number[] = [];
    const handler: JobHandler = async (job) => {
      calls.push(job.id);
    };
    const stats = await run(db, { demo: handler });
    expect(stats).toMatchObject({ recovered: 1, ran: 1, done: 1 });
    expect(calls).toEqual([stuck]);
    expect(await one(db, stuck)).toMatchObject({ status: "done", attempts: 2 });
    // Leave jobs younger than ten minutes untouched.
    expect(await one(db, recent)).toMatchObject({ status: "running", attempts: 1 });
  });

  it("recovers even when no handler is registered for the kind, and records why", async () => {
    const db = await createTestDb();
    const stuck = await insertRunning(db, STUCK_AFTER_MS + 1000);
    expect(await run(db, {})).toMatchObject({ recovered: 1, ran: 0 });
    expect(await one(db, stuck)).toMatchObject({ status: "queued", lockedAt: null, runAt: t0 });
    expect((await one(db, stuck)).lastError).toMatch(/stuck/);
  });

  it("fails a stuck job that has used all its attempts", async () => {
    const db = await createTestDb();
    const stuck = await insertRunning(db, STUCK_AFTER_MS + 1000, { attempts: 3, maxAttempts: 3 });
    expect(await run(db, { demo: ok })).toMatchObject({ recovered: 1, ran: 0 });
    expect(await one(db, stuck)).toMatchObject({ status: "failed", attempts: 3 });
  });

  it("does not overwrite a job that another worker took over while the handler was running", async () => {
    const db = await createTestDb();
    const { id } = await enqueue(db, "slow");
    const slow: JobHandler = async (job) => {
      // Simulate another worker reclaiming the job.
      await db
        .update(jobs)
        .set({ lockedAt: new Date(t0.getTime() + 999_000), attempts: job.attempts + 1 })
        .where(eq(jobs.id, job.id));
    };
    await run(db, { slow });
    expect(await one(db, id)).toMatchObject({ status: "running", attempts: 2 });
  });
});

describe("backoffMs", () => {
  it("doubles from 30 seconds up to an hour", () => {
    expect([1, 2, 3, 4, 5].map(backoffMs)).toEqual([30_000, 60_000, 120_000, 240_000, 480_000]);
    expect(backoffMs(20)).toBe(3_600_000);
    expect(backoffMs(0)).toBe(30_000);
  });
});

describe("startWorker", () => {
  type G = { __tomolaWorker?: unknown };
  const g = globalThis as G;
  afterEach(async () => {
    const w = g.__tomolaWorker as { stop(): Promise<void> } | undefined;
    await w?.stop();
    g.__tomolaWorker = undefined;
    vi.useRealTimers();
  });

  it("reads WORKER_ENABLED", () => {
    expect(isWorkerEnabled({})).toBe(true);
    expect(isWorkerEnabled({ WORKER_ENABLED: "true" })).toBe(true);
    expect(isWorkerEnabled({ WORKER_ENABLED: "" })).toBe(true);
    for (const v of ["false", "FALSE", " false ", "0", "off", "no"]) expect(isWorkerEnabled({ WORKER_ENABLED: v })).toBe(false);
  });

  it("does not start when disabled", () => {
    expect(startWorker({ env: { WORKER_ENABLED: "false" } })).toBeNull();
    expect(g.__tomolaWorker).toBeUndefined();
  });

  it("starts once per process and calls runDueJobs on an interval", async () => {
    const db = await createTestDb();
    const handlers = { demo: ok };
    const run = vi.fn(async (_db: Db, _handlers: Record<string, JobHandler>) => ({
      ran: 0,
      done: 0,
      retried: 0,
      failed: 0,
      deferred: 0,
      recovered: 0,
    }));
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
    const worker = startWorker({ env: {}, intervalMs: 5, getDb: async () => db, handlers, run });
    expect(worker).not.toBeNull();
    expect(startWorker({ env: {}, intervalMs: 5, getDb: async () => db, handlers, run })).toBe(worker);
    await vi.advanceTimersByTimeAsync(15);
    expect(run.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(run.mock.calls[0][0]).toBe(db);
    expect(run.mock.calls[0][1]).toBe(handlers);
    await worker!.stop();
    const calls = run.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30);
    expect(run.mock.calls.length).toBe(calls);
    expect(g.__tomolaWorker).toBeUndefined();
  });

  it("does not overlap runs and survives errors", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    let active = 0;
    let maxActive = 0;
    let calls = 0;
    const pending: Array<ReturnType<typeof deferred<void>>> = [];
    const run = async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      calls++;
      const gate = deferred(); pending.push(gate);
      await gate.promise;
      active--;
      if (calls === 1) throw new Error("db down");
      return { ran: 0, done: 0, retried: 0, failed: 0, deferred: 0, recovered: 0 };
    };
    const db = await createTestDb();
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
    const worker = startWorker({ env: {}, intervalMs: 2, getDb: async () => db, handlers: {}, run });
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(20);
      expect(calls).toBe(i + 1);
      pending[i].resolve();
      await vi.advanceTimersByTimeAsync(0);
    }
    await worker!.stop();
    expect(maxActive).toBe(1);
    expect(errors).toHaveBeenCalledTimes(1);
    errors.mockRestore();
  });

  it("does not keep the process alive (the timer is unref'd)", async () => {
    const timeouts = () => process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
    const db = await createTestDb();
    const before = timeouts();
    startWorker({ env: {}, intervalMs: 1000, getDb: async () => db, handlers: {} });
    expect(timeouts()).toBe(before);
  });
});
