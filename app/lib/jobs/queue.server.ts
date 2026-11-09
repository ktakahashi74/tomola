import { safeErrorText } from "~/lib/error-text.server";
import { withMarkdownScope } from "../markdown-budget.server";
import { and, asc, eq, inArray, isNotNull, lt, lte, notInArray, sql } from "drizzle-orm";
import type { Db } from "~/lib/db/client.server";
import { jobs } from "~/lib/db/schema";
import { MAIL_JOB_KINDS } from "./mail-kinds";
import { abortable, withJobSignal } from "./signal.server";
import { withoutPaidTranslationMetadata, withPaidTranslationCalls } from "./paid-translation.server";
import { canRetryTranslationDaily, isTransientFailure } from "./transient-failure.server";

// Small queue using the DB `jobs` table; pg-boss is incompatible with PGlite.
// Usage: enqueue adds jobs; runDueJobs executes them, called every second by startWorker in app/lib/jobs/worker.server.ts.
// Register executable kinds and handlers in app/lib/jobs/handlers.server.ts.

export type JobRow = typeof jobs.$inferSelect;
export type JobStatus = "queued" | "running" | "done" | "failed";

export type JobContext = {
  db: Db;
  // Execution reference time (runDueJobs now), defaulting to current time when claimed.
  now: Date;
  // The time right now: `now` advanced by the real time that has passed since the job was started (so a test that fixes `now` still gets a stable, increasing clock).
  // A long call (a 30,000-character translation takes 95 seconds) must be recorded at the time it was made, not at `now` (when the job started).
  clock?: () => Date;
  signal?: AbortSignal;
  // Stop claiming signal, available immediately for cooperative batch shutdown.
  shutdownSignal?: AbortSignal;
};

// Resolve on success, throw on failure. Throws trigger exponential retry delays, then failed after the attempt limit.
// Throw DeferJob for temporary inability to run, such as a budget limit, rather than failure.
export type JobHandler = (job: JobRow, ctx: JobContext) => Promise<void>;
export type JobHandlers = Record<string, JobHandler>;

// A handler reports temporary inability to execute until a specified time.
// Return the job to queued with run_at = until. Do not increment attempts or approach the failure limit.
export class DeferJob extends Error {
  constructor(
    readonly until: Date,
    reason = "deferred",
    readonly reasonCode?: string,
  ) {
    super(reason);
    this.name = "DeferJob";
  }
}

// Whether a failure cannot be fixed by retry: an error with `retryable === false`, such as LLM refusal. Mark failed immediately without retry.
export function isPermanentFailure(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { retryable?: unknown }).retryable === false;
}

export const DEFAULT_MAX_ATTEMPTS = 5;
// Recover jobs left running beyond this interval as crashed-worker jobs: queued, or failed if the attempt limit was reached.
// Running jobs refresh locked_at every HEARTBEAT_MS (one quarter of STUCK_AFTER_MS), so long tasks such as daily digest delivery
// are not reclaimed while running. Only crashed workers stop heartbeats and allow reclamation.
export const STUCK_AFTER_MS = 10 * 60 * 1000;
export const HEARTBEAT_MS = STUCK_AFTER_MS / 4;
const BACKOFF_BASE_MS = 30 * 1000;
const BACKOFF_MAX_MS = 60 * 60 * 1000;
const LAST_ERROR_MAX = 2000;

// Successful effects must not be repeated merely because their final UPDATE
// failed. Keep ownership/heartbeats and retry only that UPDATE on later ticks.
const completions = new WeakMap<Db, Map<number, () => Promise<void>>>();
export async function flushJobCompletions(db: Db): Promise<void> {
  for (const complete of completions.get(db)?.values() ?? []) await complete();
}

// Retry delay based on attempts: 30 seconds, one minute, two, four, … capped at one hour.
export function backoffMs(attempts: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1), BACKOFF_MAX_MS);
}

export type EnqueueOptions = {
  priority?: number;
  runAt?: Date;
  // Do not create another job with the same key while queued/running.
  dedupeKey?: string;
  // Persist another request made while the deduplicated job is running. Its run_at advances as a revision marker, and completion atomically returns it to queued.
  // Queued jobs already read the latest source state; ordinary jobs keep the original deduplication behavior.
  rescheduleRunning?: boolean;
  maxAttempts?: number;
};

// Enqueue, also usable within tx assignable to Db. created indicates insertion; false means an unfinished job already had this key.
export async function enqueue(
  db: Db,
  kind: string,
  payload: unknown = {},
  opts: EnqueueOptions = {},
): Promise<{ id: number; created: boolean }> {
  const values = {
    kind,
    priority: opts.priority ?? (MAIL_JOB_KINDS.includes(kind as typeof MAIL_JOB_KINDS[number]) ? 0 : kind === "translate_title" ? 1 : kind === "translate_entry" ? 2 : kind === "rebuild_render_cache" ? 5 : 3),
    payload,
    runAt: opts.runAt,
    dedupeKey: opts.dedupeKey,
    maxAttempts: opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
  };
  if (opts.dedupeKey === undefined) {
    const [row] = await db.insert(jobs).values(values).returning({ id: jobs.id });
    return { id: row.id, created: true };
  }
  // Find and return the existing unfinished job. It may finish during the lookup; if absent, enqueue again.
  for (let attempt = 0; attempt < 3; attempt++) {
    const [row] = await db
      .insert(jobs)
      .values(values)
      .onConflictDoNothing({ target: jobs.dedupeKey, where: sql`${jobs.status} in ('queued', 'running')` })
      .returning({ id: jobs.id });
    if (row) return { id: row.id, created: true };
    const [existing] = await db
      .select({ id: jobs.id, status: jobs.status })
      .from(jobs)
      .where(and(eq(jobs.dedupeKey, opts.dedupeKey), inArray(jobs.status, ["queued", "running"])));
    if (existing) {
      if (opts.rescheduleRunning) {
        const [requested] = await db.update(jobs)
          .set({ runAt: sql`case when ${jobs.status} = 'running' then greatest(${jobs.runAt} + interval '1 millisecond', ${opts.runAt ?? new Date()}) else ${jobs.runAt} end` })
          .where(and(eq(jobs.id, existing.id), inArray(jobs.status, ["queued", "running"])))
          .returning({ id: jobs.id });
        // Lock queued jobs too: a worker must not claim them before the producer commits its updated source state.
        if (!requested) continue; // Completion won the race: find the queued job, or create a fresh one.
      }
      return { id: existing.id, created: false };
    }
  }
  throw new Error(`Could not enqueue job with dedupe key ${opts.dedupeKey}`);
}

export type RunStats = {
  // Attempted executions: done + retried + failed + deferred.
  ran: number;
  done: number;
  retried: number;
  failed: number;
  deferred: number;
  // Number of stale running jobs recovered to queued or failed.
  recovered: number;
};

export type RunOptions = {
  // Recheck before each claim so maintenance can pause a batch in progress.
  canClaim?: () => boolean;
  // The main loop recovers abandoned work; concurrent chat runners skip it.
  recover?: boolean;
  now?: Date;
  // Maximum jobs executed per call, default 20.
  limit?: number;
  logger?: Pick<Console, "error" | "warn">;
  // Interval refreshing running jobs' locked_at, default HEARTBEAT_MS; configurable for tests.
  heartbeatMs?: number;
  // Abort signal from worker stop. Stop claiming new jobs after the signal; let the current job finish.
  signal?: AbortSignal;
  // Aborted only after the shutdown grace period, while signal stops new claims immediately.
  executionSignal?: AbortSignal;
};

function errorMessage(error: unknown): string {
  const text = safeErrorText(error, { name: true });
  return `${isTransientFailure(error) ? "transient: " : ""}${text}`.slice(0, LAST_ERROR_MAX);
}

// Recover stale running jobs.
async function recoverStuck(db: Db, now: Date): Promise<number> {
  const rows = await db
    .update(jobs)
    .set({
      status: sql`case when ${jobs.attempts} >= ${jobs.maxAttempts} then 'failed' else 'queued' end`,
      lockedAt: null,
      runAt: now,
      lastError: "stuck in running (worker stopped?)",
      payload: sql`case when ${jobs.attempts} >= ${jobs.maxAttempts} then ${jobs.payload} - 'paidTranslationCalls' else ${jobs.payload} end`,
      updatedAt: now,
    })
    .where(and(eq(jobs.status, "running"), isNotNull(jobs.lockedAt), lt(jobs.lockedAt, new Date(now.getTime() - STUCK_AFTER_MS))))
    .returning({ id: jobs.id });
  return rows.length;
}

// Claim one due queued job as running using FOR UPDATE SKIP LOCKED, preventing concurrent workers claiming the same job twice.
// Claim only kinds with registered handlers.
// skip contains jobs already attempted in this call, avoiding repeated zero-delay failures/deferrals within one call.
async function claimOne(db: Db, kinds: string[], now: Date, skip: number[]): Promise<JobRow | undefined> {
  const next = db
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      and(
        eq(jobs.status, "queued"),
        lte(jobs.runAt, now),
        inArray(jobs.kind, kinds),
        skip.length > 0 ? notInArray(jobs.id, skip) : undefined,
      ),
    )
    .orderBy(
      asc(jobs.priority),
      asc(jobs.runAt), asc(jobs.id),
    )
    .limit(1)
    .for("update", { skipLocked: true });
  const [job] = await db
    .update(jobs)
    // A deletion fence belongs to the previous execution. A new attempt first
    // revalidates its source and may checkpoint fresh work after restoration.
    .set({ status: "running", payload: sql`${jobs.payload} - 'discardPaidTranslationCalls'`, lockedAt: now, attempts: sql`${jobs.attempts} + 1`, updatedAt: now })
    .where(inArray(jobs.id, next))
    .returning();
  return job;
}

// Execute due jobs individually up to the limit. Handler failure does not stop other jobs.
export async function runDueJobs(db: Db, handlers: JobHandlers, opts: RunOptions = {}): Promise<RunStats> {
  const logger = opts.logger ?? console;
  const limit = opts.limit ?? 20;
  const stats: RunStats = { ran: 0, done: 0, retried: 0, failed: 0, deferred: 0, recovered: 0 };
  await flushJobCompletions(db);
  if (opts.recover !== false) stats.recovered = await recoverStuck(db, opts.now ?? new Date());
  const kinds = Object.keys(handlers);
  if (kinds.length === 0) return stats;

  const attempted: number[] = [];
  while (stats.ran < limit && !opts.signal?.aborted && (opts.canClaim?.() ?? true)) {
    const now = opts.now ?? new Date();
    const job = await claimOne(db, kinds, now, attempted);
    if (!job) break;
    stats.ran++;
    attempted.push(job.id);
    // Refresh locked_at periodically during execution. Advance the timestamp from now by actual elapsed time, even in tests with fixed now.
    // The current locked_at proves ownership when recording results. Do not write results if another worker reclaimed and claimed the job.
    const lock = { at: now };
    const startedAt = Date.now();
    let beating: Promise<void> | undefined;
    const beat = async () => {
      const next = new Date(Math.max(now.getTime() + (Date.now() - startedAt), lock.at.getTime() + 1));
      const rows = await db
        .update(jobs)
        .set({ lockedAt: next, updatedAt: next })
        .where(and(eq(jobs.id, job.id), eq(jobs.status, "running"), eq(jobs.lockedAt, lock.at)))
        .returning({ id: jobs.id });
      // If no row updated, ownership was reclaimed; stop further heartbeats.
      if (rows.length === 0) clearInterval(timer);
      else lock.at = next;
    };
    const heartbeat = () => {
      // Skip this heartbeat if the previous update is unfinished. Let the next heartbeat recover temporary DB failures without stopping the job.
      if (beating) return;
      beating = beat()
        .catch((error) => logger.warn(`[jobs] heartbeat for job ${job.id} failed: ${safeErrorText(error)}`))
        .finally(() => {
          beating = undefined;
        });
    };
    let timer = setInterval(heartbeat, opts.heartbeatMs ?? HEARTBEAT_MS);
    timer.unref();
    // Stop heartbeats and await any in-flight update before recording results; lock.at is then current.
    const finish = async () => {
      clearInterval(timer);
      await beating;
      return and(eq(jobs.id, job.id), eq(jobs.status, "running"), eq(jobs.lockedAt, lock.at));
    };
    const complete = async () => {
      const owned = await finish();
      // Compare at JavaScript Date precision; DB defaults can have microseconds.
      const requestedAgain = sql`date_trunc('milliseconds', ${jobs.runAt}) is distinct from ${job.runAt}::timestamptz`;
      const [completed] = await db.update(jobs).set({
        status: sql`case when ${requestedAgain} then 'queued' else 'done' end`,
        payload: sql`${jobs.payload} - 'paidTranslationCalls'`,
        attempts: sql`case when ${requestedAgain} then greatest(0, ${jobs.attempts} - 1) else ${jobs.attempts} end`,
        lockedAt: null,
        updatedAt: now,
      }).where(owned).returning({ status: jobs.status });
      return completed?.status;
    };
    let handlerSucceeded = false;
    try {
      await abortable(opts.executionSignal, () => withJobSignal(opts.executionSignal, () => withMarkdownScope("background", undefined, () => withPaidTranslationCalls(job.payload, async (key, call) => {
        opts.executionSignal?.throwIfAborted();
        const [saved] = await db.update(jobs).set({ payload: sql`case when ${jobs.payload}->>'discardPaidTranslationCalls' = 'true' then ${jobs.payload} else coalesce(${jobs.payload}, '{}'::jsonb) || jsonb_build_object('paidTranslationCalls', coalesce(${jobs.payload}->'paidTranslationCalls', '{}'::jsonb) || ${JSON.stringify({ [key]: call })}::jsonb) end` })
          .where(and(eq(jobs.id, job.id), eq(jobs.status, "running"), eq(jobs.attempts, job.attempts))).returning({ id: jobs.id });
        if (!saved) throw new Error("Job no longer owns its paid translation checkpoint");
      }, () => handlers[job.kind]({ ...job, payload: withoutPaidTranslationMetadata(job.payload) }, { db, now, signal: opts.executionSignal, shutdownSignal: opts.signal, clock: () => new Date(now.getTime() + (Date.now() - startedAt)) })))));
      handlerSucceeded = true;
      if (await complete() === "queued") stats.deferred++;
      else stats.done++;
    } catch (error) {
      if (handlerSucceeded) {
        let pending = completions.get(db);
        if (!pending) completions.set(db, pending = new Map());
        const entries = pending;
        let saving: Promise<void> | undefined;
        entries.set(job.id, () => saving ??= (async () => {
          try { await complete(); entries.delete(job.id); }
          catch { timer = setInterval(heartbeat, opts.heartbeatMs ?? HEARTBEAT_MS); timer.unref(); }
        })().finally(() => { saving = undefined; }));
        timer = setInterval(heartbeat, opts.heartbeatMs ?? HEARTBEAT_MS);
        timer.unref();
        logger.warn(`[jobs] job ${job.id} succeeded; completion persistence will be retried`);
        stats.done++;
        continue;
      }
      const owned = await finish();
      if (opts.executionSignal?.aborted || error instanceof DeferJob) {
        const until = error instanceof DeferJob ? error.until : now;
        await db
          .update(jobs)
          .set({
            status: "queued",
            runAt: sql`greatest(${jobs.runAt}, ${until})`,
            attempts: Math.max(0, job.attempts - 1),
            lockedAt: null,
            lastError: opts.executionSignal?.aborted ? "interrupted during worker shutdown" : `deferred: ${error instanceof DeferJob && error.reasonCode ? `[${error.reasonCode}] ` : ""}${safeErrorText(error)}`.slice(0, LAST_ERROR_MAX),
            updatedAt: now,
          })
          .where(owned);
        stats.deferred++;
        continue;
      }
      const message = errorMessage(error);
      if (isPermanentFailure(error) || job.attempts >= job.maxAttempts) {
        await db.update(jobs).set({ status: "failed", lockedAt: null, lastError: message, updatedAt: now,
          ...(!isPermanentFailure(error) && canRetryTranslationDaily(job.kind, message, job.payload) ? {} : { payload: sql`${jobs.payload} - 'paidTranslationCalls'` }),
        }).where(owned);
        stats.failed++;
        logger.error(`[jobs] job ${job.id} (${job.kind}) failed after ${job.attempts} attempt(s)${isPermanentFailure(error) ? " (not retryable)" : ""}: ${message}`);
      } else {
        await db
          .update(jobs)
          .set({
            status: "queued",
            runAt: new Date(now.getTime() + backoffMs(job.attempts)),
            lockedAt: null,
            lastError: message,
            updatedAt: now,
          })
          .where(owned);
        stats.retried++;
        logger.warn(`[jobs] job ${job.id} (${job.kind}) failed (attempt ${job.attempts}/${job.maxAttempts}): ${message}`);
      }
    }
  }
  return stats;
}

// Return remaining failed-job counts by kind for operator screens. Recover with pnpm translations:requeue.
export async function countFailedJobs(db: Db): Promise<Array<{ kind: string; count: number }>> {
  const rows = await db
    .select({ kind: jobs.kind, count: sql<number>`count(*)::int` })
    .from(jobs)
    .where(eq(jobs.status, "failed"))
    .groupBy(jobs.kind)
    .orderBy(asc(jobs.kind));
  return rows.map((r) => ({ kind: r.kind, count: Number(r.count) }));
}
