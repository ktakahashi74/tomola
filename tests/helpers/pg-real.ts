import { randomBytes } from "node:crypto";
import pg from "pg";
import { closeDb, openPgDb, type Db } from "../../app/lib/db/client.server";
import { migrateDatabase } from "../../app/lib/db/migrate.server";

// Real-PostgreSQL test helpers, run only with TEST_DATABASE_URL; otherwise describe.skipIf skips them.
// TEST_DATABASE_URL must allow database creation, e.g. postgres://postgres@127.0.0.1:55432/postgres. For each test file,
// create a disposable database, run actual migrations through migrateDatabase as pnpm db:migrate does, and drop it afterward.
// Separate from full real-PostgreSQL pnpm test:pg (tests/helpers/pg-test.ts); use for two-connection concurrency and simulated multiple processes requiring real PostgreSQL.
export const REAL_PG_URL = process.env.TEST_DATABASE_URL?.trim() || undefined;
const TEST_DB_PREFIX = process.env.TOMOLA_TEST_DB_PREFIX?.trim().replace(/[^A-Za-z0-9_]/g, "") || "tomola";
// Pool connection limit for Db instances opened by open().
export const SCRATCH_POOL_MAX = 4;

function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

export type ScratchDb = {
  url: string;
  name: string;
  // Open a Db with a new pool, allowing second and third independent connections. Cap pools at four to leave headroom below the server's 100-connection limit
  // when pnpm test:pg runs workers in parallel. The caller, closeOpened (per-test bulk close), or drop closes them.
  // applicationName identifies connections in pg_stat_activity, so waitForLockWait can distinguish which connection is blocked.
  // settings supplies libpq options, e.g. -c enable_seqscan=off.
  open(applicationName?: string, settings?: string): Promise<Db>;
  // Close all Db instances opened by open(), retaining the admin() connection and database.
  closeOpened(): Promise<void>;
  // Administrative connection to this database for pg_stat_activity, pg_locks and raw SQL.
  admin(): Promise<pg.Client>;
  // Close connections and drop the database.
  drop(): Promise<void>;
};

export async function createScratchDb(opts: { migrate?: boolean } = {}): Promise<ScratchDb> {
  if (!REAL_PG_URL) throw new Error("TEST_DATABASE_URL is not set");
  // TOMOLA_TEST_DB_PREFIX defaults to tomola and identifies this run's databases for cleanup when multiple runs share PostgreSQL.
  const name = `${TEST_DB_PREFIX}_scratch_${process.pid}_${randomBytes(3).toString("hex")}`;
  const admin = new pg.Client({ connectionString: REAL_PG_URL });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end();
  }
  const url = withDatabase(REAL_PG_URL, name);
  const opened: Db[] = [];
  const clients: pg.Client[] = [];
  const scratch: ScratchDb = {
    url,
    name,
    async open(applicationName, settings) {
      const u = new URL(url);
      if (applicationName) u.searchParams.set("application_name", applicationName);
      if (settings) u.searchParams.set("options", settings);
      const db = await openPgDb(u.toString(), { max: SCRATCH_POOL_MAX });
      opened.push(db);
      return db;
    },
    async closeOpened() {
      await Promise.all(opened.splice(0).map((db) => closeDb(db).catch(() => {})));
    },
    async admin() {
      const client = new pg.Client({ connectionString: url, application_name: "scratch-admin" });
      await client.connect();
      clients.push(client);
      return client;
    },
    async drop() {
      await Promise.all(opened.splice(0).map((db) => closeDb(db).catch(() => {})));
      await Promise.all(clients.splice(0).map((c) => c.end().catch(() => {})));
      const a = new pg.Client({ connectionString: REAL_PG_URL });
      await a.connect();
      try {
        await a.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      } finally {
        await a.end();
      }
    },
  };
  try {
    if (opts.migrate ?? true) await migrateDatabase({ kind: "pg", url });
  } catch (error) {
    await scratch.drop();
    throw error;
  }
  return scratch;
}
