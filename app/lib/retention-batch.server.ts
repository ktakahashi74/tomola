import { AsyncLocalStorage } from "node:async_hooks";
import { sql, type SQL } from "drizzle-orm";
import type { AnyPgTable } from "drizzle-orm/pg-core";
import type { Db } from "~/lib/db/client.server";
import { RETENTION_BATCH_SIZE, RETENTION_MAX_BATCHES, RETENTION_MAX_RUN_MS } from "~/lib/retention";
import { withRetentionBatch } from "~/lib/retention-guard.server";

export type RetentionResult = { removed: number; remaining: number; skipped: number; batches: number; stop: "complete" | "limit" | "hold" | "deferred" | "time" | "signal" };
export type RetentionResults = Record<string, RetentionResult>;
export type RetentionRunOptions = { signal?: AbortSignal; clock?: () => number };
type RetentionRun = { signal?: AbortSignal; clock: () => number; deadline: number };
const runs = new AsyncLocalStorage<RetentionRun>();

// Nested cleanup entry points share the invocation's monotonic deadline.
export function withRetentionRun<T>(options: RetentionRunOptions, run: () => Promise<T>): Promise<T> {
  if (runs.getStore()) return run();
  const clock = options.clock ?? (() => performance.now());
  return runs.run({ signal: options.signal, clock, deadline: clock() + RETENTION_MAX_RUN_MS }, run);
}

// Composite categories may scan a batch of blocked parents without changing a
// row. They exclude those parents next time and report more until exhausted.
type BatchResult = number | { removed: number; more: boolean };

export function recordRetentionResult(category: string, result: RetentionResult, results: RetentionResults = {}): RetentionResult {
  results[category] = result;
  console.log(`[retention] ${category}: ${JSON.stringify(result)}`);
  return result;
}

export async function countRetentionRows(db: Db, table: AnyPgTable, where: SQL): Promise<number> {
  const { rows } = await db.execute(sql`select count(*)::int as count from ${table} where ${where}`) as { rows: { count: number }[] };
  return rows[0].count;
}

// The hold lock is released between batches, allowing a new hold to stop a drain.
// Callbacks change at most RETENTION_BATCH_SIZE rows in total per transaction.
export function drainRetentionBatches(db: Db, category: string, batch: (tx: Db) => Promise<BatchResult>, pending: () => Promise<number>, results: RetentionResults = {}): Promise<RetentionResult> {
  return withRetentionRun({}, async () => {
    const run = runs.getStore()!;
    const result: RetentionResult = { removed: 0, remaining: 0, skipped: 0, batches: 0, stop: "complete" };
    while (result.batches < RETENTION_MAX_BATCHES) {
      if (run.signal?.aborted) { result.stop = "signal"; break; }
      if (run.clock() >= run.deadline) { result.stop = "time"; break; }
      const outcome = await withRetentionBatch(db, batch);
      if (outcome === null) { result.stop = "hold"; break; }
      const removed = typeof outcome === "number" ? outcome : outcome.removed;
      result.removed += removed;
      result.batches++;
      if (removed === 0 && (typeof outcome === "number" || !outcome.more)) break;
    }
    // Recount eligible rows, including locked ones, rather than claiming a drain
    // is complete simply because SKIP LOCKED returned a short batch.
    result.remaining = await pending();
    if (result.remaining > 0 && result.stop === "complete") {
      if (result.batches === RETENTION_MAX_BATCHES) result.stop = "limit";
      else { result.stop = "deferred"; result.skipped = result.remaining; }
    }
    return recordRetentionResult(category, result, results);
  });
}

export function drainRetentionRows(db: Db, category: string, table: AnyPgTable, where: SQL, results?: RetentionResults, values?: SQL): Promise<RetentionResult> {
  return drainRetentionBatches(db, category, tx => values ? updateRetentionRows(tx, table, where, values) : deleteRetentionRows(tx, table, where),
    () => countRetentionRows(db, table, where), results);
}

// ctid is used only inside this statement, never persisted across transactions.
// Row locking keeps concurrent workers from waiting on or changing the same rows.
export async function deleteRetentionRows(db: Db, table: AnyPgTable, where: SQL, limit = RETENTION_BATCH_SIZE): Promise<number> {
  if (limit <= 0) return 0;
  const rows = await db.execute(sql`delete from ${table} where ctid in
    (select ctid from ${table} where ${where} limit ${limit} for update skip locked) returning 1`) as { rows: unknown[] };
  return rows.rows.length;
}

export async function updateRetentionRows(db: Db, table: AnyPgTable, where: SQL, values: SQL, limit = RETENTION_BATCH_SIZE): Promise<number> {
  if (limit <= 0) return 0;
  const rows = await db.execute(sql`update ${table} set ${values} where ctid in
    (select ctid from ${table} where ${where} limit ${limit} for update skip locked) returning 1`) as { rows: unknown[] };
  return rows.rows.length;
}
