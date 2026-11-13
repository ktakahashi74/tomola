import { workerDisabledByEnv } from "../../../server/background";
import { safeErrorText } from "~/lib/error-text.server";
import { flushUsageSettlements } from "../llm/metering.server";
import { maintenanceActive } from "../../../server/maintenance";
import { translationConcurrency, TRANSLATION_JOB_KINDS } from "./translation-config.server";
import { ensureTranslationRecoveryScheduledThrottled } from "./translation-recovery.server";
import { getDb, type Db } from "~/lib/db/client.server";
import { queueRenderRebuildIfStale } from "~/lib/render-cache.server";
import { jobHandlers } from "./handlers.server";
import { chatJobHandlers } from "./chat-translation-jobs.server";
import { villageChatEnabled } from "../village-chat-enabled.server";
import { resumeBudgetWaits } from "./budget-wait.server";
import { chatTranslationConcurrency } from "../llm/config.server";
import { ensureCleanupScheduledThrottled } from "./maintenance-jobs.server";
import { ensureDigestScheduledThrottled } from "./notification-jobs.server";
import { flushJobCompletions, runDueJobs, type JobHandlers, type RunOptions, type RunStats } from "./queue.server";

export type WorkerOptions = {
  env?: Record<string, string | undefined>;
  intervalMs?: number;
  handlers?: JobHandlers;
  chatHandlers?: JobHandlers;
  getDb?: () => Promise<Db>;
  run?: (db: Db, handlers: JobHandlers, opts?: RunOptions) => Promise<RunStats>;
  translationRun?: (db: Db, handlers: JobHandlers, opts?: RunOptions) => Promise<RunStats>;
  chatRun?: (db: Db, handlers: JobHandlers, opts?: RunOptions) => Promise<RunStats>;
  // Whether SIGTERM/SIGINT call stop(); default true, false in tests.
  signals?: boolean;
  // Maximum time stop() waits for running jobs, in milliseconds. Defaults to DEFAULT_SHUTDOWN_TIMEOUT_MS; WORKER_SHUTDOWN_TIMEOUT_MS overrides it.
  shutdownTimeoutMs?: number;
};

export type StopResult = {
  // Whether the running job finished within the limit. False means the grace period expired and unfinished handlers were aborted and requeued.
  drained: boolean;
};

export type Worker = {
  // Stop starting iterations and wait up to the limit for the current iteration's active job.
  stop(opts?: { timeoutMs?: number }): Promise<StopResult>;
  // Await shutdown initiated by SIGTERM/SIGINT, including the decision to resend the signal. Complete immediately without signal shutdown; for tests.
  whenStopped(): Promise<void>;
};

export type WorkerProgress = {
  lastTickAt: number | null;
  currentTickStartedAt: number | null;
  lastTickCompletedAt: number | null;
};
const g = globalThis as { __tomolaWorker?: Worker; __tomolaWorkerProgress?: WorkerProgress };
export function getWorkerProgress(): WorkerProgress {
  return { ...(g.__tomolaWorkerProgress ?? { lastTickAt: null, currentTickStartedAt: null, lastTickCompletedAt: null }) };
}
export function getWorkerLastTickAt(): number | null { return getWorkerProgress().lastTickAt; }

export function isWorkerEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return !workerDisabledByEnv(env);
}

const ERROR_LOG_INTERVAL_MS = 60_000;
// Keep shorter than Docker's default 10-second shutdown grace period.
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 8_000;

export function shutdownTimeoutMs(env: Record<string, string | undefined> = process.env): number {
  const raw = env.WORKER_SHUTDOWN_TIMEOUT_MS?.trim();
  if (raw && /^\d{1,7}$/.test(raw)) return Number(raw);
  return DEFAULT_SHUTDOWN_TIMEOUT_MS;
}

// Start one worker per process, retained on globalThis so development hot reload
// and repeated root-loader calls cannot start duplicates. Call runDueJobs every second.
// WORKER_ENABLED=false returns null without starting. Unref timers so tests/scripts can exit.
// On SIGTERM/SIGINT, call stop() and await the running job up to shutdownTimeoutMs. If no other signal handler handles server shutdown or similar,
// resend the same signal after waiting to terminate the process, since registering a handler disables default termination.
// Determine absence of other handlers using both the count present at registration (including react-router-serve's `process.once`, which may already run and detach before us)
// and the count remaining when signaled. Both must be zero; our own `once` handler detaches before invocation, so do not subtract it.
export function startWorker(opts: WorkerOptions = {}): Worker | null {
  if (!isWorkerEnabled(opts.env)) return null;
  if (g.__tomolaWorker) return g.__tomolaWorker;

  const allHandlers = opts.handlers ?? jobHandlers;
  const translationKinds: ReadonlySet<string> = new Set(TRANSLATION_JOB_KINDS);
  const translationHandlers = Object.fromEntries(Object.entries(allHandlers).filter(([kind]) => translationKinds.has(kind)));
  const handlers = Object.keys(translationHandlers).length
    ? Object.fromEntries(Object.entries(allHandlers).filter(([kind]) => !translationKinds.has(kind))) : allHandlers;
  const open = opts.getDb ?? getDb;
  const canClaim = () => !maintenanceActive(opts.env);
  // Retain this worker's state locally: a finishing tick after stop() must not
  // overwrite the progress of a replacement worker.
  const progress: WorkerProgress = { lastTickAt: Date.now(), currentTickStartedAt: null, lastTickCompletedAt: null };
  g.__tomolaWorkerProgress = progress;
  // Before each iteration, ensure exactly one future daily digest (send_digest) and finished-job cleanup (cleanup_jobs)
  // checking at most once per minute, with dedupe_key preventing duplicates.
  const abort = new AbortController();
  const executionAbort = new AbortController();
  // Once per process, before the first run: if some saved render is at another version than RENDER_VERSION (a deploy raised it), queue the rebuild (render-cache.server.ts).
  // It is checked again at the next start only (a failure is tried again on the next tick, until it works once).
  let renderCacheChecked = false;
  let budgetWaitsResumed = false;
  const flushSettlements = async (db: Db) => {
    try { await flushUsageSettlements(db); }
    catch (error) { console.error(`[worker] usage settlement failed; continuing this tick: ${safeErrorText(error, { name: true }).slice(0, 300)}`); }
  };
  const run =
    opts.run ??
    (async (db: Db, h: JobHandlers, o?: RunOptions) => {
      await flushSettlements(db);
      if (!budgetWaitsResumed) {
        await resumeBudgetWaits(db);
        budgetWaitsResumed = true;
      }
      if (!renderCacheChecked) {
        await queueRenderRebuildIfStale(db);
        renderCacheChecked = true;
      }
      await ensureDigestScheduledThrottled(db);
      await ensureCleanupScheduledThrottled(db);
      await ensureTranslationRecoveryScheduledThrottled(db);
      return runDueJobs(db, h, { ...o, signal: abort.signal });
    });
  let stopped = false;
  let shutdown: Promise<void> | undefined;
  let current: Promise<void> | undefined;
  const chatRunning = new Set<Promise<void>>();
  const translationRunning = new Set<Promise<void>>();
  let lastErrorLoggedAt = 0;
  let lastChatErrorLoggedAt: number | undefined;

  const tick = async () => {
    try {
      const db = await open();
      if (!canClaim()) {
        await flushSettlements(db);
        await flushJobCompletions(db);
        return;
      }
      await run(db, handlers, { canClaim, signal: abort.signal, executionSignal: executionAbort.signal });
    } catch (error) {
      // Avoid logging every second during failures such as DB unavailability.
      const now = Date.now();
      if (now - lastErrorLoggedAt >= ERROR_LOG_INTERVAL_MS) {
        lastErrorLoggedAt = now;
        console.error("[worker] run failed:", safeErrorText(error));
      }
    }
  };
  const timer = setInterval(() => {
    if (!stopped) progress.lastTickAt = Date.now();
    // Keep the main lane serial; translations use their own bounded slots.
    if (stopped || current) return;
    progress.currentTickStartedAt = Date.now();
    current = tick().finally(() => {
      progress.lastTickCompletedAt = Date.now();
      progress.currentTickStartedAt = null;
      current = undefined;
    });
  }, opts.intervalMs ?? 1000);
  timer.unref();

  const translationRun = opts.translationRun ?? runDueJobs;
  const translations = translationConcurrency(opts.env);
  let lastTranslationErrorLoggedAt: number | undefined;
  const translationTimer = Object.keys(translationHandlers).length ? setInterval(() => {
    if (stopped || !canClaim()) return;
    while (translationRunning.size < translations) {
      const task = (async () => {
        // Drain a bounded batch in each slot. A per-job polling delay would cap
        // throughput even when the provider finishes immediately.
        try { await translationRun(await open(), translationHandlers, { canClaim, limit: 20, recover: false, signal: abort.signal, executionSignal: executionAbort.signal }); }
        catch {
          const now = Date.now();
          if (lastTranslationErrorLoggedAt === undefined || now - lastTranslationErrorLoggedAt >= ERROR_LOG_INTERVAL_MS) {
            lastTranslationErrorLoggedAt = now;
            console.error("[worker] translation run failed");
          }
        }
      })().finally(() => { translationRunning.delete(task); });
      translationRunning.add(task);
    }
  }, opts.intervalMs ?? 1000) : undefined;
  translationTimer?.unref();

  const chatEnabled = villageChatEnabled(opts.env);
  const concurrency = chatEnabled ? chatTranslationConcurrency(opts.env) : 0;
  const chatRun = opts.chatRun ?? runDueJobs;
  const chatTimer = chatEnabled ? setInterval(() => {
    if (stopped || !canClaim() || !villageChatEnabled(opts.env)) return;
    while (chatRunning.size < concurrency) {
      const task = (async () => {
        try { await chatRun(await open(), opts.chatHandlers ?? chatJobHandlers, { canClaim, limit: 1, recover: false, signal: abort.signal, executionSignal: executionAbort.signal }); }
        catch {
          const now = Date.now();
          if (lastChatErrorLoggedAt === undefined || now - lastChatErrorLoggedAt >= ERROR_LOG_INTERVAL_MS) {
            lastChatErrorLoggedAt = now;
            console.error("[worker] chat run failed");
          }
        }
      })().finally(() => { chatRunning.delete(task); });
      chatRunning.add(task);
    }
  }, opts.intervalMs ?? 1000) : undefined;
  chatTimer?.unref();

  const signalNames = ["SIGTERM", "SIGINT"] as const;
  const handlersBySignal = new Map<NodeJS.Signals, () => void>();
  const removeSignalHandlers = () => {
    for (const [name, handler] of handlersBySignal) process.off(name, handler);
    handlersBySignal.clear();
  };

  const worker: Worker = {
    whenStopped: () => shutdown ?? Promise.resolve(),
    async stop(stopOpts = {}) {
      stopped = true;
      abort.abort();
      clearInterval(timer);
      clearInterval(chatTimer);
      clearInterval(translationTimer);
      removeSignalHandlers();
      if (g.__tomolaWorker === worker) { g.__tomolaWorker = undefined; g.__tomolaWorkerProgress = undefined; }
      const active = [...translationRunning, ...chatRunning, ...(current ? [current] : [])];
      if (!active.length) return { drained: true };
      const running = Promise.all(active);
      const timeoutMs = stopOpts.timeoutMs ?? opts.shutdownTimeoutMs ?? shutdownTimeoutMs(opts.env);
      let timeout: NodeJS.Timeout | undefined;
      const expired = new Promise<"timeout">((resolve) => {
        timeout = setTimeout(() => resolve("timeout"), timeoutMs);
        timeout.unref();
      });
      try {
        if (await Promise.race([running.then(() => "done" as const), expired]) === "done") return { drained: true };
        executionAbort.abort(new Error("worker shutdown grace period expired"));
        // Queue runners race the handler against executionAbort and persist its requeue before settling.
        // Bound cleanup too when the database itself is unavailable during shutdown.
        clearTimeout(timeout);
        const cleanup = new Promise<void>(resolve => { timeout = setTimeout(resolve, 1000); timeout.unref(); });
        await Promise.race([running, cleanup]);
        return { drained: false };
      } finally {
        clearTimeout(timeout);
      }
    },
  };
  g.__tomolaWorker = worker;

  if (opts.signals !== false) {
    for (const name of signalNames) {
      // If another handler already existed for this signal at registration, let it terminate the process.
      const othersAtStart = process.listenerCount(name);
      const handler = () => {
        // Our `process.once` handler detaches before invocation, so the remaining count excludes us.
        const others = othersAtStart + process.listenerCount(name);
        console.log(`[worker] ${name}: stopping, waiting for the running job`);
        const resend = () => {
          if (others === 0) process.kill(process.pid, name);
        };
        shutdown = worker.stop().then(
          (result) => {
            if (!result.drained) console.warn("[worker] the shutdown grace period expired; unfinished jobs were interrupted for retry");
            resend();
          },
          resend,
        );
      };
      handlersBySignal.set(name, handler);
      process.once(name, handler);
    }
  }
  return worker;
}
