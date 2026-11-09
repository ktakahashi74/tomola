import { DrizzleQueryError, eq, SQL } from "drizzle-orm";
import { afterEach, expect, it, vi } from "vitest";
import type { Db } from "~/lib/db/client.server";
import { jobs, llmUsage } from "~/lib/db/schema";
import * as queueRunner from "~/lib/jobs/queue.server";
import { enqueue, runDueJobs, type JobHandlers, type RunOptions, type RunStats } from "~/lib/jobs/queue.server";
import { startWorker, type Worker } from "~/lib/jobs/worker.server";
import { createTestDb } from "./helpers/db";

const stats: RunStats = { ran: 0, done: 0, failed: 0, recovered: 0, retried: 0, deferred: 0 };
let worker: Worker | null = null;
it("keeps database parameters out of job errors and worker logs", async () => {
  const db = await createTestDb();
  const { id } = await enqueue(db, "private_failure", {}, { maxAttempts: 1 });
  const failure = new DrizzleQueryError("select * from session where token = $1", ["private-session-token"], Object.assign(new Error("private-session-token"), { code: "23505" }));
  const logger = { error: vi.fn(), warn: vi.fn() };
  await runDueJobs(db, { private_failure: async () => { throw failure; } }, { logger });
  const [row] = await db.select().from(jobs).where(eq(jobs.id, id));
  expect(row.status).toBe("failed");
  expect(row.lastError).toContain("23505");
  expect(row.lastError).not.toContain("private-session-token");
  expect(JSON.stringify(logger.error.mock.calls)).not.toContain("private-session-token");
});
afterEach(async () => {
  const stopping = worker?.stop({ timeoutMs: 0 });
  if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(1001);
  await stopping;
  worker = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("finalizes abandoned reservations on an idle worker tick without process-local pending records", async () => {
  const db = await createTestDb();
  await db.insert(llmUsage).values({ engine: "claude", model: "claude-haiku-4-5", purpose: "translate", costUsdMicro: 60, reserved: true, createdAt: new Date("2026-10-17T00:00:00Z") });
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-17T00:10:01Z"));
  let ran!: () => void;
  const iteration = new Promise<void>(resolve => { ran = resolve; });
  vi.spyOn(queueRunner, "runDueJobs").mockImplementation(async () => { ran(); return stats; });
  worker = startWorker({ env: {}, handlers: {}, signals: false, getDb: async () => db });
  await vi.advanceTimersByTimeAsync(1000);
  await iteration;
  expect(await db.select().from(llmUsage)).toMatchObject([{ reserved: false, costUsdMicro: 60 }]);
});

it("retries completion persistence without invoking a successful mail handler again", async () => {
  const db = await createTestDb();
  const { id } = await enqueue(db, "send_notification_email");
  const update = db.update.bind(db);
  let failCompletion = false;
  vi.spyOn(db, "update").mockImplementation(table => {
    const builder = update(table);
    const set = builder.set.bind(builder);
    builder.set = values => {
      if (table === jobs && "status" in values && values.status instanceof SQL && failCompletion) {
        failCompletion = false;
        throw new Error("completion write unavailable");
      }
      return set(values);
    };
    return builder;
  });
  const delivered = vi.fn(async () => { failCompletion = true; });
  const handlers = { send_notification_email: delivered };
  const first = await runDueJobs(db, handlers, { logger: { warn() {}, error() {} } });
  expect(first).toMatchObject({ ran: 1, retried: 0, failed: 0 });
  await runDueJobs(db, handlers, { now: new Date("2030-01-01") });
  expect(delivered).toHaveBeenCalledTimes(1);
  expect((await db.select().from(jobs).where(eq(jobs.id, id)))[0]).toMatchObject({ status: "done", attempts: 1, lastError: null });
});

it("runs two public translations alongside mail and drains all three", async () => {
  vi.useFakeTimers();
  const releases: Array<() => void> = [];
  const translationRun = vi.fn((_db: Db, _handlers: JobHandlers, _opts?: RunOptions) => new Promise<RunStats>(resolve => releases.push(() => resolve(stats))));
  let releaseMail = () => {};
  const run = vi.fn((_db: Db, _handlers: JobHandlers, _opts?: RunOptions) => new Promise<RunStats>(resolve => { releaseMail = () => resolve(stats); }));
  const handler = async () => {};
  worker = startWorker({ env: { TRANSLATION_CONCURRENCY: "2" }, signals: false, getDb: async () => ({} as Db),
    handlers: { translate_entry: handler, translate_title: handler, measure_divergence: handler, retranslate_after_report: handler, send_notification_email: handler },
    run, translationRun,
  });
  await vi.advanceTimersByTimeAsync(1000);
  expect(translationRun).toHaveBeenCalledTimes(2);
  expect(run).toHaveBeenCalledTimes(1);
  expect(run.mock.calls[0][1]).toEqual({ send_notification_email: handler });
  expect(translationRun.mock.calls[0][1]).toEqual({ translate_entry: handler, translate_title: handler, measure_divergence: handler, retranslate_after_report: handler });
  const stopping = worker!.stop();
  releases[0](); releaseMail();
  let drained = false;
  void stopping.then(() => { drained = true; });
  await vi.advanceTimersByTimeAsync(0);
  expect(drained).toBe(false);
  releases[1]();
  expect(await stopping).toEqual({ drained: true });
});

it("aborts after the grace period, returns the job to queued and refunds its attempt", async () => {
  const db = await createTestDb();
  const { id } = await enqueue(db, "translate_entry");
  vi.useFakeTimers();
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  let signal: AbortSignal | undefined;
  worker = startWorker({ env: { TRANSLATION_CONCURRENCY: "1" }, signals: false, getDb: async () => db,
    run: async () => stats,
    handlers: { translate_entry: async (_job, ctx) => {
      signal = ctx.signal;
      entered();
      await new Promise<void>((_resolve, reject) => ctx.signal!.addEventListener("abort", () => reject(ctx.signal!.reason), { once: true }));
    } },
  });
  await vi.advanceTimersByTimeAsync(1000);
  await started;
  const stopping = worker!.stop({ timeoutMs: 8000 });
  await vi.advanceTimersByTimeAsync(7999);
  expect(signal?.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(await stopping).toEqual({ drained: false });
  expect(signal?.aborted).toBe(true);
  const [row] = await db.select().from(jobs).where(eq(jobs.id, id));
  expect(row).toMatchObject({ status: "queued", attempts: 0, lockedAt: null });
});

it("drains ready short translations within a slot instead of waiting a poll between every job", async () => {
  const db = await createTestDb();
  for (let i = 0; i < 12; i++) await enqueue(db, "translate_entry", { i });
  let complete!: (result: RunStats) => void;
  const finishedBatch = new Promise<RunStats>(resolve => { complete = resolve; });
  let calls = 0;
  vi.useFakeTimers();
  worker = startWorker({ env: { TRANSLATION_CONCURRENCY: "1" }, signals: false, getDb: async () => db,
    run: async () => stats,
    translationRun: async (db, handlers, options) => {
      const result = await runDueJobs(db, handlers, options);
      complete(result);
      return result;
    },
    handlers: { translate_entry: async () => { calls++; } },
  });
  await vi.advanceTimersByTimeAsync(1000);
  expect(await finishedBatch).toMatchObject({ ran: 12, done: 12 });
  expect(calls).toBe(12);
});

it("uses stored priorities so fresh translations precede older bulk translations", async () => {
  const db = await createTestDb();
  const order: string[] = [];
  await enqueue(db, "translate_entry", { label: "bulk" }, { priority: 5 });
  await enqueue(db, "embed_entry");
  await enqueue(db, "translate_entry", { label: "fresh" });
  await enqueue(db, "translate_title");
  await enqueue(db, "send_notification_email");
  const handler = async (job: typeof jobs.$inferSelect) => { order.push((job.payload as { label?: string }).label ?? job.kind); };
  await runDueJobs(db, Object.fromEntries(["translate_entry", "embed_entry", "translate_title", "send_notification_email"].map(kind => [kind, handler])), { now: new Date("2030-01-01") });
  expect(order).toEqual(["send_notification_email", "translate_title", "fresh", "embed_entry", "bulk"]);
});

it.each([
  [new Error("lock timeout"), "Error: lock timeout"],
  [new DrizzleQueryError("select * from llm_usage where reservation_token = $1", ["private-body"], Object.assign(new Error("private-body"), { code: "55P03" })), "55P03"],
] as const)("continues ordinary work and safely logs expired settlement failures (%s)", async (error, expected) => {
  vi.useFakeTimers();
  const metering = await import("~/lib/llm/metering.server");
  const render = await import("~/lib/render-cache.server");
  const notification = await import("~/lib/jobs/notification-jobs.server");
  const maintenance = await import("~/lib/jobs/maintenance-jobs.server");
  const recovery = await import("~/lib/jobs/translation-recovery.server");
  vi.spyOn(metering, "flushUsageSettlements").mockRejectedValue(error);
  vi.spyOn(render, "queueRenderRebuildIfStale").mockResolvedValue(false);
  vi.spyOn(notification, "ensureDigestScheduledThrottled").mockResolvedValue(undefined);
  vi.spyOn(maintenance, "ensureCleanupScheduledThrottled").mockResolvedValue(undefined);
  vi.spyOn(recovery, "ensureTranslationRecoveryScheduledThrottled").mockResolvedValue(undefined);
  const run = vi.spyOn(queueRunner, "runDueJobs").mockResolvedValue(stats);
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  worker = startWorker({ env: {}, signals: false, getDb: async () => ({} as Db), handlers: {} });
  await vi.advanceTimersByTimeAsync(1000);
  expect(run).toHaveBeenCalledTimes(1);
  expect(logged).toHaveBeenCalledWith(expect.stringContaining(expected));
  expect(JSON.stringify(logged.mock.calls)).not.toContain("private-body");
});
