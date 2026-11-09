import { and, eq, lte, min, sql } from "drizzle-orm";
import { getDb, type Db } from "./db/client.server";
import { jobs } from "./db/schema";
import { getWorkerProgress, isWorkerEnabled, type WorkerProgress } from "./jobs/worker.server";
import { revision } from "./revision";

type Options = {
  getDb?: () => Promise<Db>;
  workerProgress?: () => WorkerProgress;
  now?: () => number;
  env?: Record<string, string | undefined>;
};
type DatabaseResult = { database: "ok" | "unavailable"; oldestDueJobAgeSeconds: number | null };
const unavailable: DatabaseResult = { database: "unavailable", oldestDueJobAgeSeconds: null };
const CACHE_MS = 2000;

// One instance per process in production; isolated instances allow deterministic
// tests without sharing cached results between different databases or clocks.
export function createReadinessResponder(opts: Options = {}): () => Promise<Response> {
  const clock = opts.now ?? Date.now;
  let cached: { result: DatabaseResult; expiresAt: number } | undefined;
  let inFlight: Promise<DatabaseResult> | undefined;

  const probe = async (): Promise<DatabaseResult> => {
    const now = clock();
    if (cached && now < cached.expiresAt) return cached.result;
    if (inFlight) return inFlight;
    const databaseWork = (async (): Promise<DatabaseResult> => {
      try {
        const db = await (opts.getDb ?? getDb)();
        const age = await db.transaction(async tx => {
          await tx.execute(sql`SET LOCAL statement_timeout = '1000ms'`);
          await tx.execute(sql`SELECT 1`);
          const [row] = await tx.select({ oldest: min(jobs.runAt) }).from(jobs).where(and(eq(jobs.status, "queued"), lte(jobs.runAt, new Date(now))));
          return row?.oldest ? Math.max(0, Math.floor((now - new Date(row.oldest).getTime()) / 1000)) : 0;
        });
        return { database: "ok", oldestDueJobAgeSeconds: age };
      } catch { return unavailable; } // Never expose connection details.
    })();
    let timer: ReturnType<typeof setTimeout>;
    const shared = Promise.race([
      databaseWork,
      new Promise<DatabaseResult>(resolve => { timer = setTimeout(() => resolve(unavailable), 2000); }),
    ]).then(result => {
      cached = { result, expiresAt: clock() + CACHE_MS };
      return result;
    }).finally(() => clearTimeout(timer));
    inFlight = shared;
    // Timing out the response does not cancel a connection/transaction wait.
    // Keep its slot until the underlying work settles, so later requests cannot
    // accumulate more probes while the database is stalled.
    void Promise.all([databaseWork, shared]).then(() => { inFlight = undefined; });
    return shared;
  };

  return async () => {
    const { database, oldestDueJobAgeSeconds } = await probe();
    const env = opts.env ?? process.env, now = clock();
    const enabled = isWorkerEnabled(env);
    const progress = (opts.workerProgress ?? getWorkerProgress)();
    const ready = database === "ok" && (!enabled || (progress.lastTickAt !== null && now - progress.lastTickAt < 120_000));
    const iso = (time: number | null) => time === null ? null : new Date(time).toISOString();
    return Response.json({ status: ready ? "ready" : "unavailable", database,
      worker: enabled ? {
        enabled: true,
        lastTickAt: iso(progress.lastTickAt),
        lastTickCompletedAt: iso(progress.lastTickCompletedAt),
        currentTickSeconds: progress.currentTickStartedAt === null ? 0 : Math.max(0, Math.floor((now - progress.currentTickStartedAt) / 1000)),
      } : { enabled: false },
      oldestDueJobAgeSeconds, revision: revision(env),
    }, { status: ready ? 200 : 503, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
  };
}

export const readinessResponse = createReadinessResponder();
