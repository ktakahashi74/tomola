import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { maintenanceActive } from "../server/maintenance";
import { maintenanceResponse } from "~/lib/maintenance.server";
import { startWorker, getWorkerLastTickAt } from "~/lib/jobs/worker.server";
import { runDueJobs, type RunStats } from "~/lib/jobs/queue.server";
import { createTestDb } from "./helpers/db";
import { jobs } from "~/lib/db/schema";
import * as metering from "~/lib/llm/metering.server";

vi.mock("~/paraglide/messages.js", async () => ({ m: (await import("./helpers/messages-json")).jsonMessages() }));
const directories: string[] = [];
afterEach(() => { vi.useRealTimers(); for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tomola-maintenance-"));
  directories.push(dir);
  return { MAINTENANCE_FLAG_FILE: path.join(dir, "readonly") };
}

it("rechecks flag creation and removal within one second", async () => {
  vi.useFakeTimers();
  const env = fixture();
  expect(maintenanceActive(env)).toBe(false);
  fs.writeFileSync(env.MAINTENANCE_FLAG_FILE, "");
  await vi.advanceTimersByTimeAsync(1000);
  expect(maintenanceActive(env)).toBe(true);
  fs.unlinkSync(env.MAINTENANCE_FLAG_FILE);
  await vi.advanceTimersByTimeAsync(1000);
  expect(maintenanceActive(env)).toBe(false);
});

it.each(["POST", "PUT", "PATCH", "DELETE"])("blocks %s including login and authentication before handlers run", async method => {
  const env = fixture();
  fs.writeFileSync(env.MAINTENANCE_FLAG_FILE, "");
  for (const url of ["/login", "/api/auth/sign-in/email", "/t/1"]) {
    const response = maintenanceResponse(new Request(`http://localhost${url}`, { method, headers: { "Accept-Language": "ja" } }), env)!;
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("30");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: "maintenance_readonly", message: "tomola を更新しています。数分後にもう一度試してください。読むことはできます。" });
  }
});

it.each(["GET", "HEAD", "OPTIONS"])("keeps %s available during maintenance", method => {
  const env = fixture();
  fs.writeFileSync(env.MAINTENANCE_FLAG_FILE, "");
  expect(maintenanceResponse(new Request("http://localhost/t/1", { method }), env)).toBeNull();
});

it("pauses all worker lanes, keeps a heartbeat, and resumes when the flag is removed", async () => {
  const db = await createTestDb();
  const env = { ...fixture(), VILLAGES: "1", VILLAGE_CHAT: "1" };
  fs.writeFileSync(env.MAINTENANCE_FLAG_FILE, "");
  vi.useFakeTimers();
  const stats: RunStats = { ran: 0, done: 0, failed: 0, recovered: 0, retried: 0, deferred: 0 };
  const run = vi.fn(async () => stats), translationRun = vi.fn(async () => stats), chatRun = vi.fn(async () => stats);
  const flush = vi.spyOn(metering, "flushUsageSettlements");
  const worker = startWorker({ env, signals: false, getDb: async () => db, handlers: { translate_entry: async () => {} }, run, translationRun, chatRun })!;
  try {
    await vi.advanceTimersByTimeAsync(2000);
    expect(run).not.toHaveBeenCalled(); expect(translationRun).not.toHaveBeenCalled(); expect(chatRun).not.toHaveBeenCalled();
    expect(getWorkerLastTickAt()).toBe(Date.now());
    // Fake timers do not await real database I/O. Await the bookkeeping receipt
    // and drain its microtasks before expecting the serial lane to start again.
    await Promise.all(flush.mock.results.map(result => result.value));
    await vi.advanceTimersByTimeAsync(0);
    fs.unlinkSync(env.MAINTENANCE_FLAG_FILE);
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalled(); expect(translationRun).toHaveBeenCalled(); expect(chatRun).toHaveBeenCalled();
  } finally { await worker.stop(); flush.mockRestore(); }
});

it("finishes the current job but leaves the next job queued when maintenance starts mid-batch", async () => {
  const db = await createTestDb();
  await db.insert(jobs).values([{ kind: "maintenance_test" }, { kind: "maintenance_test" }]);
  let active = false;
  const handler = vi.fn(async () => { active = true; });
  const stats = await runDueJobs(db, { maintenance_test: handler }, { canClaim: () => !active });
  expect(stats.done).toBe(1);
  expect(handler).toHaveBeenCalledTimes(1);
  expect((await db.select().from(jobs)).map(j => j.status).sort()).toEqual(["done", "queued"]);
});
