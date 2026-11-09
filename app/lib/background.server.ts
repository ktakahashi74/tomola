import { safeErrorText } from "~/lib/error-text.server";
import { ensureDevelopmentVillagesOnce } from "~/lib/villages.server";
import { getDb } from "~/lib/db/client.server";
import { startWorker, type Worker } from "~/lib/jobs/worker.server";
import { syncOperatorRolesOnce } from "~/lib/roles.server";

// Start process background work (job worker and operator-role synchronization). The production server (server.ts) calls this from the server build's entry.server
// immediately after opening its port, rather than waiting for the first request, so queued jobs after a restart run without someone opening the site.
// The development server calls the same function on the first request (app/root.tsx loader). Both run once per process, guarded by startWorker and syncOperatorRolesOnce.
// With signals: false, the worker does not handle SIGTERM or SIGINT itself; server.ts calls Worker.stop together with HTTP server shutdown.
// WORKER_ENABLED=false skips worker startup and returns null. Startup failure does not stop the server.
export function startBackgroundServices(opts: { signals?: boolean } = {}): Worker | null {
  let worker: Worker | null = null;
  try {
    worker = startWorker({ signals: opts.signals });
  } catch (error) {
    console.error("[worker] failed to start:", safeErrorText(error));
  }
  syncOperatorRolesOnce(getDb);
  ensureDevelopmentVillagesOnce(getDb);
  return worker;
}
