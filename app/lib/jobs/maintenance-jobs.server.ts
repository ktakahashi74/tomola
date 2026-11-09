import { reconcileMissingTranslations } from "./translation-backfill.server";
import { pruneChatTranslationReports } from "~/lib/chat-translation-reports.server";
import { pruneChatReportSnapshots } from "~/lib/village-chat-reports.server";
import { and, inArray, lt, ne } from "drizzle-orm";
import type { Db } from "~/lib/db/client.server";
import { jobs } from "~/lib/db/schema";
import { RETENTION, daysBefore } from "~/lib/retention";
import { drainRetentionRows, withRetentionRun, type RetentionResults, type RetentionRunOptions } from "~/lib/retention-batch.server";
import { runRetentionCleanup } from "~/lib/retention.server";
import { pruneDeletedEntries } from "~/lib/entry-retention.server";
import { pruneVillageReportSnapshots } from "~/lib/village-moderation.server";
import { pruneIdentitySnapshots } from "~/lib/identity-retention.server";
import { pruneExpiredInvitationRecipients } from "~/lib/invitations.server";
import { pruneInvitationNotes } from "~/lib/invitation-note.server";
import { pruneRotationReplays, pruneUnusedClients } from "~/lib/mcp/connections.server";
import { ensureDailyJob } from "./daily.server";
import type { JobHandler, JobHandlers } from "./queue.server";

// Maintenance jobs.
// - cleanup_jobs ({ date }; dedupe: cleanup-jobs:<YYYY-MM-DD>): daily UTC 03:00, delete finished jobs older than the configured retention period
//   with status done or failed after exhausted retries. updated_at records completion/failure time. Never delete running/queued jobs.
//   As with digests, workers maintain exactly one future job (ensureCleanupScheduled); execution also queues the next day's job.
// Failed jobs and operator failure counts expire together. Recover before expiry using pnpm translations:requeue or pnpm embeddings:backfill.

export const CLEANUP_JOBS_JOB = "cleanup_jobs";
const CLEANUP_HOUR_UTC = 3;
const SPEC = { kind: CLEANUP_JOBS_JOB, keyPrefix: "cleanup-jobs", hourUtc: CLEANUP_HOUR_UTC } as const;

export const ensureCleanupScheduled = (db: Db, now: Date = new Date()) => ensureDailyJob(db, SPEC, now);

// Called before each worker iteration. Throttle per-process checks to this interval of one minute.
const ENSURE_INTERVAL_MS = 60_000;
const lastEnsured = new WeakMap<Db, number>();
export async function ensureCleanupScheduledThrottled(db: Db, now: Date = new Date()): Promise<void> {
  const last = lastEnsured.get(db) ?? 0;
  if (now.getTime() - last < ENSURE_INTERVAL_MS) return;
  lastEnsured.set(db, now.getTime());
  await ensureCleanupScheduled(db, now);
}

// Drain expired finished jobs in bounded transactions, returning the total deleted count.
export async function deleteFinishedJobs(db: Db, now: Date, results?: RetentionResults): Promise<number> {
  return (await drainRetentionRows(db, "finished_jobs", jobs,
    and(inArray(jobs.status, ["done", "failed"]), ne(jobs.kind, "translation_retry_marker"), lt(jobs.updatedAt, daysBefore(now, RETENTION.finishedJobDays)))!, results)).removed;
}

export function createMaintenanceHandlers(): JobHandlers {
  const cleanup: JobHandler = async (_job, ctx) => {
    // Queue the next day first; it remains queued even if cleanup fails and retries.
    await ensureCleanupScheduled(ctx.db, ctx.now);
    const signal = ctx.shutdownSignal ?? ctx.signal;
    const results = await runMaintenanceCleanup(ctx.db, ctx.now, { signal });
    // Queueing translation work is not retention: it belongs to this handler, not to the cleanup that a restore also runs (scripts/retention.ts), and it must not start
    // once the worker is stopping or the cleanup ran out of its time.
    if (!signal?.aborted && !Object.values(results).some(result => result.stop === "time" || result.stop === "signal")) await reconcileMissingTranslations(ctx.db, { now: ctx.now });
  };
  return { [CLEANUP_JOBS_JOB]: cleanup };
}

// Used after a restore too: run only cleanup, without claiming unrelated jobs.
export function runMaintenanceCleanup(db: Db, now = new Date(), options: RetentionRunOptions = {}): Promise<RetentionResults> {
  return withRetentionRun(options, async () => {
    const results = await runRetentionCleanup(db, now);
    const entries = await pruneDeletedEntries(db, now, results);
    console.log(`[retention] entry cleanup: ${JSON.stringify(entries)}`);
    const removed = await deleteFinishedJobs(db, now, results);
    await pruneVillageReportSnapshots(db, now, results);
    await pruneChatReportSnapshots(db, now, results);
    await pruneIdentitySnapshots(db, now, results);
    await pruneChatTranslationReports(db, now, results);
    await pruneExpiredInvitationRecipients(db, now, results);
    await pruneInvitationNotes(db, now, results);
    await pruneUnusedClients(db, now, results);
    await pruneRotationReplays(db, now, results);
    if (removed > 0) console.log(`[jobs] cleanup: deleted ${removed} finished job(s) older than ${RETENTION.finishedJobDays} days`);
    return results;
  });
}
