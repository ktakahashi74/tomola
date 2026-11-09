import { safeErrorText } from "../app/lib/error-text.server.ts";
// Graceful shutdown for production server.ts on SIGTERM (docker stop) or SIGINT:
// 1. Stop accepting connections (server.close). Close idle keep-alive connections immediately; allow in-flight requests up to httpGraceMs, then close remaining connections.
// 2. Stop the worker in parallel with step 1 (Worker.stop: claim no new jobs and wait for the running job up to the worker's own timeout).
// 3. When both finish, drain and stop parsing, then exit with code 0.
// A repeated signal during shutdown exits immediately with code 1. Also exit at the overall forceExitMs timeout.
// startBackgroundServices uses signals: false, disabling worker signal handling, so the worker neither resends signals nor performs duplicate shutdown.
import type { Server } from "node:http";

export type ShutdownOptions = {
  server: Pick<Server, "close" | "closeIdleConnections" | "closeAllConnections">;
  // Worker stop function; null when no worker runs (WORKER_ENABLED=false).
  stopWorker: (() => Promise<unknown>) | null;
  // Parsing stays available to draining HTTP requests and background jobs.
  stopParsing?: () => Promise<unknown>;
  stopChat?: () => void;
  httpGraceMs: number;
  forceExitMs: number;
  log: (message: string) => void;
  exit: (code: number) => void;
  // Test timer.
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
};

export type Shutdown = {
  // Called when a signal arrives.
  handle(signal: string): void;
  // For tests, wait until shutdown calls exit; resolve immediately if shutdown has not started.
  done(): Promise<void>;
};

export function createShutdown(opts: ShutdownOptions): Shutdown {
  const setT = opts.setTimeout ?? setTimeout;
  const clearT = opts.clearTimeout ?? clearTimeout;
  let running: Promise<void> | undefined;

  async function run(signal: string): Promise<void> {
    opts.log(`${signal}: shutting down (closing the HTTP server, stopping the worker)`);
    const force = setT(() => {
      opts.log("shutdown took too long; exiting now");
      opts.exit(1);
    }, opts.forceExitMs);
    force.unref?.();
    opts.stopChat?.();
    const closeServer = new Promise<void>((resolve) => {
      // Also close connections that become idle after finishing an in-flight request. Close the rest when grace expires.
      const sweep = setInterval(() => opts.server.closeIdleConnections(), 500);
      sweep.unref?.();
      const grace = setT(() => {
        opts.log("closing the remaining HTTP connections");
        opts.server.closeAllConnections();
      }, opts.httpGraceMs);
      grace.unref?.();
      // Called when all connections close; treat an already-closed server reported as an error as finished too.
      opts.server.close(() => {
        clearInterval(sweep);
        clearT(grace);
        resolve();
      });
      opts.server.closeIdleConnections();
    });
    const stopWorker = opts.stopWorker
      ? opts.stopWorker().then(
          (result) => {
            if (result && typeof result === "object" && "drained" in result && result.drained === false) {
              opts.log("the running job did not finish in time; unfinished jobs were interrupted for retry");
            }
          },
          (error: unknown) => opts.log(`stopping the worker failed: ${safeErrorText(error)}`),
        )
      : Promise.resolve();
    await Promise.all([closeServer, stopWorker]);
    await opts.stopParsing?.();
    clearT(force);
    opts.log("stopped");
    opts.exit(0);
  }

  return {
    handle(signal) {
      if (running) {
        opts.log(`${signal}: already shutting down; exiting now`);
        opts.exit(1);
        return;
      }
      running = run(signal);
    },
    done: () => running ?? Promise.resolve(),
  };
}
