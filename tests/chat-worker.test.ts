import { afterEach, expect, it, vi } from "vitest";
import type { Db } from "~/lib/db/client.server";
import { startWorker, type Worker } from "~/lib/jobs/worker.server";
import type { JobHandlers, RunOptions, RunStats } from "~/lib/jobs/queue.server";

let worker: Worker | null = null;
afterEach(async () => { await worker?.stop({ timeoutMs: 0 }); worker = null; vi.useRealTimers(); vi.unstubAllEnvs(); });
const stats: RunStats = { ran: 0, done: 0, failed: 0, recovered: 0, retried: 0, deferred: 0 };
it.each(["", "1"])("keeps a closed chat or disabled worker from starting chat work (chat=%s)", async chat => {
  vi.useFakeTimers();
  const chatRun = vi.fn(async () => stats), run = vi.fn(async () => stats);
  worker = startWorker({ env: { VILLAGES: "1", VILLAGE_CHAT: chat, ...(chat ? { WORKER_ENABLED: "false" } : {}) }, signals: false, handlers: {}, getDb: async () => ({} as Db), run, chatRun });
  await vi.advanceTimersByTimeAsync(3000); expect(chatRun).not.toHaveBeenCalled();
  if (chat) expect(worker).toBeNull(); else expect(run).toHaveBeenCalled();
});
it("limits concurrent chat jobs, runs public jobs independently, and drains both loops", async () => {
  vi.useFakeTimers();
  const releases: Array<() => void> = [];
  const chatRun = vi.fn((_db: Db, _handlers: JobHandlers, _opts?: RunOptions) => new Promise<RunStats>(resolve => { releases.push(() => resolve(stats)); }));
  let releasePublic: () => void = () => {};
  const run = vi.fn(() => new Promise<RunStats>(resolve => { releasePublic = () => resolve(stats); }));
  worker = startWorker({ env: { VILLAGES: "1", VILLAGE_CHAT: "1", CHAT_TRANSLATION_CONCURRENCY: "2" }, signals: false, handlers: {}, getDb: async () => ({} as Db), run, chatRun });
  await vi.advanceTimersByTimeAsync(1000);
  expect(run).toHaveBeenCalledTimes(1); expect(chatRun).toHaveBeenCalledTimes(2);
  expect(chatRun.mock.calls[0][2]).toMatchObject({ limit: 1, recover: false, signal: expect.any(AbortSignal) });
  releasePublic(); await vi.advanceTimersByTimeAsync(1000);
  expect(run).toHaveBeenCalledTimes(2); expect(chatRun).toHaveBeenCalledTimes(2);
  const stop = worker!.stop({ timeoutMs: 1000 }); let done = false; void stop.then(() => { done = true; });
  releases[0](); releasePublic(); await Promise.resolve(); expect(done).toBe(false);
  releases[1](); expect(await stop).toEqual({ drained: true });
  await vi.advanceTimersByTimeAsync(5000); expect(chatRun).toHaveBeenCalledTimes(2);
});
it("logs fixed chat-loop errors at most once per minute across concurrent runs", async () => {
  vi.useFakeTimers();
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    worker = startWorker({ env: { VILLAGES: "1", VILLAGE_CHAT: "1" }, signals: false, handlers: {}, getDb: async () => ({} as Db), run: async () => stats,
      chatRun: async () => { throw new Error("Private source and context"); },
    });
    await vi.advanceTimersByTimeAsync(1000); expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]).toEqual(["[worker] chat run failed"]);
    await vi.advanceTimersByTimeAsync(59000); expect(error).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000); expect(error).toHaveBeenCalledTimes(2);
  } finally { error.mockRestore(); }
});
