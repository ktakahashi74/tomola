import fs from "node:fs";
import path from "node:path";
import { PGlite, type PGliteOptions } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import * as schema from "./schema";
import { migrationsFolder } from "./client.server";

// Extensions loaded into PGlite: pgvector for embedding search. Migration 0036's CREATE EXTENSION uses this loaded extension.
// In the 0.5 series, pgvector is a separate package, `@electric-sql/pglite-pgvector`, rather than `@electric-sql/pglite/vector` in the main package.
// Supply extensions whenever opening an instance, including instances restored with loadDataDir: their shared libraries are not included in the data.
// Direct PGlite constructors (tests/helpers/db.ts, tests/global-setup.ts) also obtain extensions here.
export const PGLITE_EXTENSIONS = { vector } satisfies PGliteOptions["extensions"];

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but we lack permission to signal it.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readLockPid(lockPath: string): number | null {
  try {
    const pid = Number.parseInt(fs.readFileSync(lockPath, "utf8").trim(), 10);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

// PGlite silently allows another process to open the same data directory, potentially losing writes or corrupting data.
// Exclusively create <dataDir>.lock containing our pid. Throw if it already exists and its process is alive.
// Replace locks whose pid is dead (left by an abnormal exit) or whose contents cannot be read.
// Return a release function. Release automatically on process exit too; signal termination leaves the lock, but the next startup replaces it as above.
// Ignore races between two processes replacing an old lock, since this is for manual startup.
export function acquireLock(dataDir: string): () => void {
  const lockPath = `${dataDir}.lock`;
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < 3; attempt++) {
    let fd: number;
    try {
      fd = fs.openSync(lockPath, "wx");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const holder = readLockPid(lockPath);
      if (holder !== null && isProcessAlive(holder)) {
        throw new Error(`PGlite data directory is in use by process ${holder}: ${dataDir}`);
      }
      fs.rmSync(lockPath, { force: true });
      continue;
    }
    try {
      fs.writeSync(fd, String(process.pid));
    } finally {
      fs.closeSync(fd);
    }
    const release = () => {
      process.off("exit", release);
      // Do not delete a lock that has been replaced.
      if (readLockPid(lockPath) === process.pid) fs.rmSync(lockPath, { force: true });
    };
    process.once("exit", release);
    return release;
  }
  throw new Error(`Could not acquire the lock for the PGlite data directory: ${dataDir}`);
}

// migrate: run migrations immediately after opening. Defaults to true for PGlite (development/tests).
export async function openPglite(dataDir?: string, opts: { migrate?: boolean } = {}) {
  // In-memory test databases are separate per process and need no lock.
  const release = dataDir ? acquireLock(dataDir) : undefined;
  let client: PGlite | undefined;
  try {
    client = dataDir ? new PGlite(dataDir, { extensions: PGLITE_EXTENSIONS }) : new PGlite({ extensions: PGLITE_EXTENSIONS });
    const db = drizzlePglite({ client, schema });
    if (opts.migrate ?? true) {
      // Migration 0042 stops if author-translation rows exist without the verification marker ("Pre-check for 0042" in docs/deploy.md). For development PGlite data, TOMOLA_ALLOW_AUTHOR_DELETE=1 permits deletion.
      if (process.env.TOMOLA_ALLOW_AUTHOR_DELETE?.trim() === "1") await client.exec("SET tomola.allow_author_delete = 'on'");
      // Migration 0047 likewise refuses to delete the old votes (which meant agreement) unless the session setting is on; TOMOLA_ALLOW_VOTE_DELETE=1 sets it for development PGlite data.
      if (process.env.TOMOLA_ALLOW_VOTE_DELETE?.trim() === "1") await client.exec("SET tomola.allow_vote_delete = 'on'");
      await migratePglite(db, { migrationsFolder: migrationsFolder() });
      await (await import("~/lib/mentions.server")).backfillMentionSnapshots(db);
    }
    const opened = client;
    return { db, close: async () => {
      await opened.close();
      release?.();
    } };
  } catch (error) {
    // Do not leave a lock after opening fails, so getDb retries are not blocked by their own lock.
    await client?.close().catch(() => {});
    release?.();
    throw error;
  }
}
