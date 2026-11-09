import { describe, expect, it, vi } from "vitest";
import { createShutdown } from "../server/shutdown.ts";

// Graceful shutdown of the production server (server.ts) via server/shutdown.ts.
function setup(opts: { stopWorker?: (() => Promise<unknown>) | null; stopParsing?: () => Promise<unknown>; closes?: "immediately" | "never" } = {}) {
  const calls: string[] = [];
  let closeCallback: (() => void) | undefined;
  const server = {
    close: vi.fn((cb?: () => void) => {
      calls.push("close");
      closeCallback = cb;
      if ((opts.closes ?? "immediately") === "immediately") cb?.();
      return server as never;
    }),
    closeIdleConnections: vi.fn(() => calls.push("closeIdle")),
    closeAllConnections: vi.fn(() => calls.push("closeAll")),
  };
  const logs: string[] = [];
  const exits: number[] = [];
  const shutdown = createShutdown({
    server,
    stopWorker: opts.stopWorker === undefined ? async () => ({ drained: true }) : opts.stopWorker,
    ...{ stopParsing: opts.stopParsing },
    httpGraceMs: 10_000,
    forceExitMs: 15_000,
    log: (m) => logs.push(m),
    exit: (code) => exits.push(code),
  });
  return { shutdown, server, calls, logs, exits, finishClose: () => closeCallback?.() };
}

describe("createShutdown", () => {
  it("closes chat connections before waiting for HTTP drain", async () => {
    const calls: string[] = [];
    const shutdown = createShutdown({
      server: { close: cb => { calls.push("http"); cb?.(); return undefined as never; }, closeIdleConnections() {}, closeAllConnections() {} },
      stopWorker: null, stopChat: () => { calls.push("chat"); },
      httpGraceMs: 10_000, forceExitMs: 15_000, log() {}, exit() {},
    });
    shutdown.handle("SIGTERM"); await shutdown.done(); expect(calls).toEqual(["chat", "http"]);
  });
  it("keeps parsing available until HTTP requests and background jobs have drained", async () => {
    let releaseJob: () => void = () => {};
    const job = new Promise<void>(resolve => { releaseJob = resolve; });
    const stopParsing = vi.fn(async () => {});
    const t = setup({ stopWorker: () => job, stopParsing, closes: "never" });
    t.shutdown.handle("SIGTERM"); releaseJob();
    await Promise.resolve(); await Promise.resolve();
    expect(stopParsing).not.toHaveBeenCalled();
    t.finishClose(); await t.shutdown.done();
    expect(stopParsing).toHaveBeenCalledTimes(1);
  });
  it("closes the HTTP server and stops the worker, then exits 0", async () => {
    const stopWorker = vi.fn(async () => ({ drained: true }));
    const t = setup({ stopWorker });
    t.shutdown.handle("SIGTERM");
    await t.shutdown.done();
    expect(t.server.close).toHaveBeenCalledTimes(1);
    expect(t.server.closeIdleConnections).toHaveBeenCalled();
    expect(stopWorker).toHaveBeenCalledTimes(1);
    expect(t.exits).toEqual([0]);
    expect(t.logs[0]).toContain("SIGTERM");
  });

  it("waits for the worker's running job and for the open connections before exiting", async () => {
    vi.useFakeTimers();
    try {
      let releaseJob: () => void = () => {};
      const job = new Promise<void>(resolve => { releaseJob = resolve; });
      const t = setup({ stopWorker: () => job.then(() => ({ drained: true })), closes: "never" });
      t.shutdown.handle("SIGTERM");
      await vi.advanceTimersByTimeAsync(0);
      expect(t.exits).toEqual([]);
      releaseJob();
      await vi.advanceTimersByTimeAsync(0);
      expect(t.exits).toEqual([]);
      t.finishClose();
      await t.shutdown.done();
      expect(t.exits).toEqual([0]);
    } finally { vi.useRealTimers(); }
  });

  it("works without a worker (WORKER_ENABLED=false)", async () => {
    const t = setup({ stopWorker: null });
    t.shutdown.handle("SIGINT");
    await t.shutdown.done();
    expect(t.exits).toEqual([0]);
  });

  it("says when the running job did not finish in time, and still exits 0", async () => {
    const t = setup({ stopWorker: async () => ({ drained: false }) });
    t.shutdown.handle("SIGTERM");
    await t.shutdown.done();
    expect(t.logs.some((l) => l.includes("did not finish in time"))).toBe(true);
    expect(t.exits).toEqual([0]);
  });

  it("does not stop the server on a failure to stop the worker, and says so", async () => {
    const t = setup({ stopWorker: async () => Promise.reject(new Error("db gone")) });
    t.shutdown.handle("SIGTERM");
    await t.shutdown.done();
    expect(t.logs.some((l) => l.includes("db gone"))).toBe(true);
    expect(t.exits).toEqual([0]);
  });

  it("exits at once on a second signal, and never closes the server or stops the worker twice", async () => {
    const stopWorker = vi.fn(() => new Promise<unknown>(() => {}));
    const t = setup({ stopWorker, closes: "never" });
    t.shutdown.handle("SIGTERM");
    t.shutdown.handle("SIGTERM");
    expect(t.exits).toEqual([1]);
    expect(t.server.close).toHaveBeenCalledTimes(1);
    expect(stopWorker).toHaveBeenCalledTimes(1);
  });

  it("closes the connections that are still open after the grace period, and exits after the limit", async () => {
    vi.useFakeTimers();
    try {
      const t = setup({ stopWorker: () => new Promise(() => {}), closes: "never" });
      t.shutdown.handle("SIGTERM");
      await vi.advanceTimersByTimeAsync(9_000);
      expect(t.server.closeAllConnections).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1_500);
      expect(t.server.closeAllConnections).toHaveBeenCalledTimes(1);
      expect(t.exits).toEqual([]);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(t.exits).toEqual([1]);
    } finally {
      vi.useRealTimers();
    }
  });
});
