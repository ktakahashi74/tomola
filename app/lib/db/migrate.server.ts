import pg from "pg";
import { recomputeHandleKeys, type RecomputedHandleKeys } from "~/lib/handle-keys.server";
import { closeDb, openPgDb, openPgliteDb, type DbConfig } from "./client.server";

// Apply migrations (`pnpm db:migrate`, scripts/migrate.ts). For PostgreSQL:
//   1. Acquire an advisory lock (pg_advisory_lock) on a dedicated connection. If two processes start together (for example, two Docker entrypoints applying migrations on deployment),
//      the second waits until the first finishes. Drizzle migrations have no lock of their own; concurrent runs would execute each statement twice and fail.
//   2. Run migrations.
//   3. Recompute profiles.handle_key using the app's handleKey, since backfill 0025 uses collation-dependent lower (app/lib/handle-keys.server.ts).
//      Fail on collisions and report the conflicting names.
// Locks belong to a connection (session). Keep the dedicated lock connection separate from the migration pool and retain it until completion.
// PGlite allows only one process to open the data directory via its lock file, so no advisory lock is needed.

// ASCII for 'tomola' (0x746f6d6f6c61). Any value not conflicting with keys used by other apps in the same database would suffice.
export const MIGRATE_LOCK_KEY = 0x746f6d6f6c61;

export type MigrateResult = RecomputedHandleKeys & { target: string; waited: boolean };

export type MigrateOptions = {
  log?: (message: string) => void;
};

// Add remediation hints when extension creation fails because pgvector is unavailable or extension privileges are missing.
export function explainMigrationError(message: string): string | null {
  if (/permission denied to create extension/i.test(message)) {
    return 'The database user may not create the extension "vector" (migration 0036). Create it once as a superuser (psql -d <database> -c "CREATE EXTENSION IF NOT EXISTS vector;"), or give the user the right to, and run the migration again.';
  }
  if (/extension "vector" is not available|could not open extension control file/i.test(message)) {
    return "This PostgreSQL has no pgvector installed. Use a pgvector build (for example the pgvector/pgvector:pg18 image), or install the pgvector package for your server.";
  }
  return null;
}

export async function migrateDatabase(config: DbConfig, opts: MigrateOptions = {}): Promise<MigrateResult> {
  const log = opts.log ?? (() => {});
  if (config.kind === "pglite") {
    const db = await openPgliteDb(config.dataDir, { migrate: true });
    try {
      return { ...(await recomputeHandleKeys(db)), target: `PGlite (${config.dataDir ?? "memory"})`, waited: false };
    } finally {
      await closeDb(db);
    }
  }
  const lock = new pg.Client({ connectionString: config.url, connectionTimeoutMillis: 10_000, lock_timeout: 10_000 });
  // A dropped connection (such as a database restart) also loses its lock. Only log it and treat it as migration failure; pool errors are rethrown.
  lock.on("error", (error) => log(`lock connection error: ${error.message}`));
  await lock.connect();
  let waited = false;
  try {
    const got = await lock.query<{ locked: boolean }>("SELECT pg_try_advisory_lock($1) AS locked", [MIGRATE_LOCK_KEY]);
    if (!got.rows[0].locked) {
      waited = true;
      log("another process is migrating this database; waiting for it to finish");
      await lock.query("SELECT pg_advisory_lock($1)", [MIGRATE_LOCK_KEY]);
    }
    const db = await openPgDb(config.url, { migrate: true, max: 2 });
    try {
      return { ...(await recomputeHandleKeys(db)), target: "PostgreSQL", waited };
    } finally {
      await closeDb(db);
    }
  } finally {
    await lock.query("SELECT pg_advisory_unlock($1)", [MIGRATE_LOCK_KEY]).catch(() => {});
    await lock.end().catch(() => {});
  }
}
