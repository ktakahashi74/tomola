import { afterEach, expect, it, vi } from "vitest";
import type { Db } from "~/lib/db/client.server";
import { jobs } from "~/lib/db/schema";
import { createReadinessResponder } from "~/lib/readiness.server";
import { getWorkerProgress, startWorker } from "~/lib/jobs/worker.server";
import type { RunStats } from "~/lib/jobs/queue.server";
import { revision, shortRevision } from "~/lib/revision";
import { createTestDb } from "./helpers/db";

afterEach(() => vi.useRealTimers());
const now = Date.parse("2026-10-17T00:00:00Z");
const env = { REVISION: "0123456789abcdef0123456789abcdef01234567", WORKER_ENABLED: "true" };
const progress = (lastTickAt: number | null) => ({ lastTickAt, currentTickStartedAt: null, lastTickCompletedAt: null });
// Control connection/transaction timing separately from SQL correctness below.
const probeDb = () => ({ transaction: vi.fn(async () => 0) }) as unknown as Db;

it("reports database readiness, heartbeat, due-job age and revision without counts", async () => {
  const db = await createTestDb();
  await db.insert(jobs).values([
    { kind: "translate_entry", runAt: new Date(now - 125_000) },
    { kind: "send_digest", runAt: new Date(now + 20_000) },
    { kind: "embed_entry", status: "done", runAt: new Date(now - 900_000) },
  ]);
  const respond = createReadinessResponder({ getDb: async () => db, workerProgress: () => progress(now - 1000), now: () => now, env });
  const response = await respond();
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  expect(await response.json()).toEqual({ status: "ready", database: "ok", worker: {
    enabled: true, lastTickAt: new Date(now - 1000).toISOString(), lastTickCompletedAt: null, currentTickSeconds: 0,
  }, oldestDueJobAgeSeconds: 125, revision: env.REVISION });
});

it("returns 503 without leaking connection errors", async () => {
  const respond = createReadinessResponder({ getDb: async () => { throw new Error("private database URL"); }, workerProgress: () => progress(now), now: () => now, env });
  const response = await respond();
  expect(response.status).toBe(503);
  const body = await response.text();
  expect(body).not.toContain("private");
  expect(JSON.parse(body)).toMatchObject({ database: "unavailable", oldestDueJobAgeSeconds: null });
});

it.each(["connection", "transaction"])("bounds a stalled %s wait and keeps sharing it after the timeout", async stage => {
  vi.useFakeTimers({ now });
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const transaction = vi.fn(async () => { if (stage === "transaction") await blocked; return 0; });
  const db = { transaction } as unknown as Db;
  const getDb = vi.fn(async () => { if (stage === "connection") await blocked; return db; });
  const respond = createReadinessResponder({ getDb, env: { WORKER_ENABLED: "false" } });
  const requests = Array.from({ length: 20 }, () => respond());
  await vi.advanceTimersByTimeAsync(2000);
  expect((await Promise.all(requests)).map(response => response.status)).toEqual(Array(20).fill(503));
  // Expiry of the cached timeout must not start another underlying wait.
  await vi.advanceTimersByTimeAsync(20_000);
  expect((await Promise.all(Array.from({ length: 20 }, () => respond()))).map(response => response.status)).toEqual(Array(20).fill(503));
  expect(getDb).toHaveBeenCalledTimes(1);
  expect(transaction).toHaveBeenCalledTimes(stage === "connection" ? 0 : 1);
  release();
  await vi.advanceTimersByTimeAsync(0);
  expect((await respond()).status).toBe(200);
  expect(getDb).toHaveBeenCalledTimes(2);
});

it("shares one database probe between concurrent requests and reuses it for exactly two seconds", async () => {
  vi.useFakeTimers({ now });
  const db = probeDb();
  let release!: (value: Db) => void;
  const opened = new Promise<Db>(resolve => { release = resolve; });
  const getDb = vi.fn(() => opened);
  const respond = createReadinessResponder({ getDb, workerProgress: () => progress(Date.now()), env });
  const requests = Array.from({ length: 20 }, () => respond());
  release(db);
  const responses = await Promise.all(requests);
  expect(getDb).toHaveBeenCalledTimes(1);
  expect(db.transaction).toHaveBeenCalledTimes(1);
  // Every caller owns its response body, even when the database result is shared.
  const bodies = await Promise.all(responses.map(response => response.json()));
  expect(bodies).toHaveLength(20);
  expect(bodies.every(body => body.status === "ready")).toBe(true);
  await vi.advanceTimersByTimeAsync(1999);
  expect((await respond()).status).toBe(200);
  expect(getDb).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  await Promise.all(Array.from({ length: 20 }, () => respond()));
  expect(getDb).toHaveBeenCalledTimes(2);
  expect(db.transaction).toHaveBeenCalledTimes(2);
});

it("caches database failures for two seconds and then allows recovery", async () => {
  vi.useFakeTimers({ now });
  const getDb = vi.fn<() => Promise<Db>>().mockRejectedValueOnce(new Error("unavailable")).mockResolvedValue(probeDb());
  const respond = createReadinessResponder({ getDb, env: { WORKER_ENABLED: "false" } });
  expect((await respond()).status).toBe(503);
  await vi.advanceTimersByTimeAsync(1999);
  expect((await respond()).status).toBe(503);
  expect(getDb).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect((await respond()).status).toBe(200);
  expect(getDb).toHaveBeenCalledTimes(2);
});

it("exposes a stalled main tick while keeping scheduler readiness and live worker metrics available", async () => {
  const db = probeDb();
  vi.useFakeTimers({ now });
  const stats: RunStats = { ran: 0, done: 0, failed: 0, recovered: 0, retried: 0, deferred: 0 };
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const run = vi.fn().mockResolvedValueOnce(stats).mockImplementation(async () => { await blocked; return stats; });
  const worker = startWorker({ env, signals: false, handlers: {}, getDb: async () => db, run })!;
  const respond = createReadinessResponder({ getDb: async () => db, env });
  try {
    expect((await (await respond()).json()).worker).toMatchObject({ lastTickCompletedAt: null, currentTickSeconds: 0 });
    await vi.advanceTimersByTimeAsync(1000);
    expect((await (await respond()).json()).worker).toMatchObject({ lastTickCompletedAt: new Date(now + 1000).toISOString(), currentTickSeconds: 0 });
    await vi.advanceTimersByTimeAsync(181_000);
    const response = await respond();
    expect(response.status).toBe(200);
    expect((await response.json()).worker).toMatchObject({ currentTickSeconds: 180, lastTickCompletedAt: new Date(now + 1000).toISOString() });
    await vi.advanceTimersByTimeAsync(1000);
    expect((await (await respond()).json()).worker.currentTickSeconds).toBe(181);
    expect(run).toHaveBeenCalledTimes(2);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect((await (await respond()).json()).worker).toMatchObject({ currentTickSeconds: 0, lastTickCompletedAt: new Date(Date.now()).toISOString() });
  } finally { release(); await worker.stop(); }
  expect(getWorkerProgress()).toEqual(progress(null));
  expect((await respond()).status).toBe(503);
});

it.each([null, now - 120_000])("returns 503 for an absent or stale heartbeat (%s)", async heartbeat => {
  const respond = createReadinessResponder({ getDb: async () => probeDb(), workerProgress: () => progress(heartbeat), now: () => now, env });
  expect((await respond()).status).toBe(503);
});

it("omits worker metrics when workers are disabled and reports no due jobs", async () => {
  const db = await createTestDb();
  const respond = createReadinessResponder({ getDb: async () => db, workerProgress: () => progress(null), now: () => now, env: { WORKER_ENABLED: "false" } });
  const response = await respond();
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ worker: { enabled: false }, oldestDueJobAgeSeconds: 0, revision: "unknown" });
  expect((await (await respond()).json()).worker).toEqual({ enabled: false });
});

it("uses a short revision even without a source URL and rejects malformed values", () => {
  expect(revision(env)).toBe(env.REVISION);
  expect(shortRevision(env.REVISION)).toBe("0123456");
  expect(revision({ REVISION: "<private configuration>" })).toBe("unknown");
});
