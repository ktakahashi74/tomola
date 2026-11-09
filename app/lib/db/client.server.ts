import fs from "node:fs";
import { safeErrorText } from "../error-text.server";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle as drizzleNodePg } from "drizzle-orm/node-postgres";
import { migrate as migrateNodePg } from "drizzle-orm/node-postgres/migrator";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import pg from "pg";
import * as schema from "./schema";
import { pgPoolOptions, resolveDbConfig, type DbConfig } from "./config.server";
export { DEFAULT_PGLITE_DATA_DIR, resolveDbConfig, type DbConfig } from "./config.server";

// A common type accepting both PGlite instances (development/tests) and node-postgres instances (production).
// Each driver's return value is assignable to this type without casts.
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

// The callback value of an open transaction or savepoint; a standalone Db does not satisfy this type.
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

// Find the migration directory by walking upward from this file, rather than from the runtime working directory,
// so imports from source, tests, or built build/server do not depend on the deployment's startup directory.
let migrationsFolderCache: string | undefined;
export function migrationsFolder(): string {
  if (migrationsFolderCache) return migrationsFolderCache;
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = path.join(dir, "drizzle");
    if (fs.existsSync(path.join(candidate, "meta", "_journal.json"))) return (migrationsFolderCache = candidate);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("Could not find the drizzle migrations folder (searched upward from the db client module)");
}

// For close: drivers close differently (PGlite close plus lock release; pg Pool end).
const closers = new WeakMap<object, () => Promise<void>>();

export async function closeDb(db: Db): Promise<void> {
  const close = closers.get(db);
  closers.delete(db);
  await close?.();
}

// Load the embedded driver, extensions, lock and migrator only for PGlite.
export async function openPgliteDb(dataDir?: string, opts: { migrate?: boolean } = {}): Promise<Db> {
  const { openPglite } = await import("./pglite.server");
  const { db, close } = await openPglite(dataDir, opts);
  closers.set(db, close);
  return db;
}

// migrate: defaults to false. Apply production PostgreSQL migrations separately with `pnpm db:migrate` to avoid races between simultaneous web and worker startup.
// max: pool connection limit (pg's default of 10 if absent). Reduce it so tests do not exhaust the server's max_connections.
export async function openPgDb(url: string, opts: { migrate?: boolean; max?: number; statementTimeoutMs?: number; lockTimeoutMs?: number } = {}): Promise<Db> {
  const settings = pgPoolOptions(process.env, {
    ...opts,
    ...(opts.migrate ? { statementTimeoutMs: 0, lockTimeoutMs: opts.lockTimeoutMs ?? 10_000 } : {}),
  });
  // pg omits a numeric zero startup parameter. Use libpq options to explicitly
  // override a role/database statement_timeout for long operator work as well.
  const connection = new URL(url);
  if (settings.statement_timeout === 0) connection.searchParams.set("options", [connection.searchParams.get("options"), "-c statement_timeout=0"].filter(Boolean).join(" "));
  // allowExitOnIdle: idle connections must not prevent process exit. After SIGTERM, idle connections allow immediate exit, as required by worker shutdown.
  const pool = new pg.Pool({ connectionString: connection.toString(), allowExitOnIdle: true, ...settings });
  // Only log when an idle connection drops (for example, a DB restart), avoiding process termination.
  pool.on("error", (error) => console.error("[db] idle client error:", safeErrorText(error)));
  try {
    const db = drizzleNodePg({ client: pool, schema });
    if (opts.migrate) {
      await migrateNodePg(db, { migrationsFolder: migrationsFolder() });
      await (await import("~/lib/mentions.server")).backfillMentionSnapshots(db);
    }
    closers.set(db, () => pool.end());
    return db;
  } catch (error) {
    await pool.end().catch(() => {});
    throw error;
  }
}

// Open according to configuration. migrate defaults to true for PGlite and false for PostgreSQL.
export function openDb(config: DbConfig, opts: { migrate?: boolean } = {}): Promise<Db> {
  if (config.kind === "pg") return openPgDb(config.url, opts);
  return openPgliteDb(config.dataDir, opts);
}

// Dedicated connection lifetime for operator commands; never changes the web/worker singleton.
export function getOperatorDb(): Promise<Db> {
  const config = resolveDbConfig();
  return config.kind === "pg" ? openPgDb(config.url, { statementTimeoutMs: 0 }) : openPgliteDb(config.dataDir);
}

const g = globalThis as { __tomolaDb?: Promise<Db> };

// Retain on globalThis so development-server hot reload does not open the database twice.
// Do not retain rejected promises, avoiding unavailability until restart after a transient failure.
export function getDb(): Promise<Db> {
  if (!g.__tomolaDb) {
    const config = resolveDbConfig();
    if (config.kind === "pglite" && config.legacy) {
      console.warn("[db] DATABASE_URL as a PGlite data directory is deprecated; set PGLITE_DATA_DIR instead.");
    }
    const opening = openDb(config);
    g.__tomolaDb = opening;
    opening.catch(() => {
      if (g.__tomolaDb === opening) g.__tomolaDb = undefined;
    });
  }
  return g.__tomolaDb;
}
