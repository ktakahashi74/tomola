// Startup log for server.ts: whether background work (the job worker) runs in this process. If not, give the actual reason:
// - The build lacks startBackgroundServices: mismatched build.
// - WORKER_ENABLED=false: intentionally disabled by the operator.
// - WORKER_ENABLED is not false but the worker did not start: startup failed, with the reason in the preceding [worker] failed to start: line.
// No app alias ~/ here; server.ts imports this file directly.

export function workerDisabledByEnv(env: Record<string, string | undefined>): boolean {
  return /^(false|0|no|off)$/i.test(env.WORKER_ENABLED?.trim() ?? "");
}

export type BackgroundStatus = { level: "info" | "warn"; message: string };

export function describeBackground(opts: { hasStarter: boolean; worker: unknown; env: Record<string, string | undefined> }): BackgroundStatus {
  if (!opts.hasStarter) {
    return {
      level: "warn",
      message:
        "the server build has no startBackgroundServices (is BUILD_PATH pointing at a build of another version?): no background service is running in this process, so no job (translation, embedding, notification mail) will run",
    };
  }
  if (opts.worker) return { level: "info", message: "the job worker is running in this process" };
  if (workerDisabledByEnv(opts.env)) return { level: "info", message: "the job worker is not running in this process (WORKER_ENABLED=false)" };
  return {
    level: "warn",
    message: "the job worker is not running in this process although WORKER_ENABLED is not false: it failed to start (see the [worker] line above); jobs stay queued until a worker runs",
  };
}
