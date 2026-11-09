import { and, eq, isNotNull, like, max } from "drizzle-orm";
import type { Db } from "~/lib/db/client.server";
import { jobs } from "~/lib/db/schema";
import { enqueue } from "./queue.server";

// Keep exactly one future job for work running once daily at a UTC time: daily digest email and finished-job cleanup.
// dedupe_key `<prefix>:<YYYY-MM-DD>` uses the execution date. Workers check before each iteration (ensureDailyJob).
// Clock skew between processes: after `<prefix>:D` finishes, a slower process checking just before D
// computes D as the next execution. Dedupe checks only unfinished jobs, so it would queue the completed D again.
// Never queue dates at or before the latest date for this job kind, including done/failed jobs. Fixed-width dates allow lexical comparison.
// Cleanup deletes finished rows after 30 days; they serve as markers until then.

const pad = (n: number) => String(n).padStart(2, "0");
export const dateOf = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

// First UTC hour:00 strictly after now.
export function nextDailyAt(now: Date, hourUtc: number): Date {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hourUtc);
  return new Date(today > now.getTime() ? today : today + 24 * 60 * 60 * 1000);
}

export type DailyJobSpec = { kind: string; keyPrefix: string; hourUtc: number };

// Keep exactly one future job. Do nothing if any job, in any status, already exists for this date or later. created indicates a newly queued job.
export async function ensureDailyJob(db: Db, spec: DailyJobSpec, now: Date = new Date()): Promise<{ date: string; runAt: Date; created: boolean }> {
  const runAt = nextDailyAt(now, spec.hourUtc);
  const date = dateOf(runAt);
  const key = `${spec.keyPrefix}:${date}`;
  const [latest] = await db
    .select({ key: max(jobs.dedupeKey) })
    .from(jobs)
    .where(and(eq(jobs.kind, spec.kind), isNotNull(jobs.dedupeKey), like(jobs.dedupeKey, `${spec.keyPrefix}:%`)));
  if (latest?.key != null && latest.key >= key) return { date, runAt, created: false };
  const res = await enqueue(db, spec.kind, { date }, { runAt, dedupeKey: key });
  return { date, runAt, created: res.created };
}
