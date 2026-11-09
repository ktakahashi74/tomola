import { expect } from "vitest";
import type pg from "pg";
import type { Db } from "../../app/lib/db/client.server";

// Helpers for real-PostgreSQL two-connection concurrency tests (tests/pg-concurrency.test.ts).
// Make races deterministic instead of relying on timing: pause one transaction while it holds a lock,
// verify through pg_stat_activity that the other connection is waiting on that lock, then release the first.

// Manually control transaction completion. body runs inside the transaction, e.g. acquiring locks; ready resolves when body finishes; commit() and rollback() close it.
class Rollback extends Error {}
export type HeldTx<T> = { ready: Promise<T>; commit(): Promise<void>; rollback(): Promise<void> };

export function holdTx<T>(db: Db, body: (tx: Db) => Promise<T>): HeldTx<T> {
  let resolveGate!: (mode: "commit" | "rollback") => void;
  const gate = new Promise<"commit" | "rollback">((resolve) => (resolveGate = resolve));
  let resolveReady!: (value: T) => void;
  let rejectReady!: (error: unknown) => void;
  const ready = new Promise<T>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const done = db
    .transaction(async (tx) => {
      let value: T;
      try {
        value = await body(tx);
      } catch (error) {
        rejectReady(error);
        throw error;
      }
      resolveReady(value);
      if ((await gate) === "rollback") throw new Rollback();
    })
    .catch((error) => {
      if (!(error instanceof Rollback)) throw error;
    });
  // If body fails, prevent an unhandled ready rejection before the caller receives it.
  ready.catch(() => {});
  return {
    ready,
    commit: async () => {
      resolveGate("commit");
      await done;
    },
    rollback: async () => {
      resolveGate("rollback");
      await done;
    },
  };
}

// Wait until the application_name connection has wait_event_type = Lock.
export async function waitForLockWait(admin: pg.Client, applicationName: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await admin.query<{ n: string }>("SELECT count(*)::text AS n FROM pg_stat_activity WHERE datname = current_database() AND application_name = $1 AND wait_event_type = 'Lock'", [applicationName]);
    if (Number(res.rows[0].n) > 0) return;
    if (Date.now() > deadline) throw new Error(`${applicationName} did not start waiting for a lock within ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

// Verify a promise remains pending for ms, blocked on a lock.
export async function expectPending(promise: Promise<unknown>, ms = 400): Promise<void> {
  const state = await Promise.race([promise.then(() => "settled" as const, () => "settled" as const), new Promise<"pending">((r) => setTimeout(() => r("pending"), ms))]);
  expect(state, "the call should still be waiting for a lock").toBe("pending");
}

// Verify a promise settles within ms without being blocked by conflicting locks.
export async function expectSettlesWithin<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`${what} did not finish within ${ms} ms (blocked by a lock?)`)), ms)));
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
