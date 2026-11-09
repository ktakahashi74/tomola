import { eq } from "drizzle-orm";
import { closeDb, openPgDb, openPgliteDb, resolveDbConfig } from "../app/lib/db/client.server";
import { retentionHold } from "../app/lib/db/schema";
import { runMaintenanceCleanup } from "../app/lib/jobs/maintenance-jobs.server";
import { runCli } from "./cli";

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!["status", "hold", "release", "run"].includes(command) || (command === "hold" ? args.length !== 2 || args[0] !== "--reason" || !args[1].trim() : args.length !== 0)) {
    throw new Error("Usage: retention status | hold --reason TEXT | release | run");
  }
  const config = resolveDbConfig();
  const db = config.kind === "pg" ? await openPgDb(config.url) : await openPgliteDb(config.dataDir, { migrate: false });
  try {
    if (command === "hold" || command === "release") {
      const updated = await db.update(retentionHold).set({ active: command === "hold", reason: command === "hold" ? args[1].trim() : null, updatedAt: new Date() })
        .where(eq(retentionHold.id, 1)).returning({ id: retentionHold.id });
      if (!updated.length) throw new Error("Missing retention hold control row");
    }
    const [hold] = await db.select({ active: retentionHold.active, updatedAt: retentionHold.updatedAt }).from(retentionHold).where(eq(retentionHold.id, 1));
    if (!hold) throw new Error("Missing retention hold control row");
    console.log(JSON.stringify(hold));
    if (command === "run") {
      if (hold.active) throw new Error("Preservation hold active; cleanup stopped");
      const shutdown = new AbortController();
      const stop = () => shutdown.abort();
      process.once("SIGTERM", stop);
      process.once("SIGINT", stop);
      try {
        const categories = await runMaintenanceCleanup(db, new Date(), { signal: shutdown.signal });
        console.log(JSON.stringify({ categories }));
      } finally {
        process.off("SIGTERM", stop);
        process.off("SIGINT", stop);
      }
    }
  } finally { await closeDb(db); }
}

process.exitCode = await runCli(main);
