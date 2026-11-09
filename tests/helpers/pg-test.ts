import { randomBytes } from "node:crypto";
import { drizzle as drizzleNodePg } from "drizzle-orm/node-postgres";
import type { Logger } from "drizzle-orm/logger";
import { migrate as migrateNodePg } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { migrationsFolder, type Db } from "../../app/lib/db/client.server";
import * as schema from "../../app/lib/db/schema";
import { clockOffsetMs } from "./clock";

// Helpers for full real-PostgreSQL test runs: pnpm test:pg with TOMOLA_TEST_PG=1 and TEST_DATABASE_URL.
// TEST_DATABASE_URL must permit database creation, e.g. postgres://postgres@127.0.0.1:55432/postgres.
// - Before the run, create and migrate a template once (setupPgTemplate in tests/global-setup.ts).
// - Create a fresh database for every test with CREATE DATABASE ... TEMPLATE ... (createPgTestDb), matching one PGlite DB per test.
// - Drop each database afterward (closePgTestDb); remove the template and leftovers at run end (teardownPgTemplate).
// Clock: PGlite now() follows JavaScript Date.now() and the test clock (tests/helpers/clock.ts), but real PostgreSQL now() follows wall time
// and conflicts with fixed October 2026 test dates. Add tomola_clock.now() to the template, subtracting the offset from real time to the pinned date,
// and put it early in search_path, after public and before pg_catalog. Running migrations with this path binds DEFAULT now() to this function too.
// The offset is the per-connection tomola.clock_offset_ms setting, matching JavaScript clockOffsetMs in tests/helpers/clock.ts. Database now() and
// test new Date() then agree. Do not bake it into the template because workers have different offsets.

export const PG_MODE = process.env.TOMOLA_TEST_PG === "1";
const SEARCH_PATH = "public,tomola_clock,pg_catalog";

export type PgTemplate = { adminUrl: string; templateDb: string; prefix: string };

function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

// Once before the run, create the template and run migrations.
export async function setupPgTemplate(adminUrl: string): Promise<PgTemplate> {
  // TOMOLA_TEST_DB_PREFIX defaults to tomola and identifies this run's databases for cleanup when PostgreSQL is shared.
  const base = process.env.TOMOLA_TEST_DB_PREFIX?.trim().replace(/[^A-Za-z0-9_]/g, "") || "tomola";
  const prefix = `${base}_t${process.pid}_${randomBytes(3).toString("hex")}_`;
  const templateDb = `${prefix}template`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${quote(templateDb)}`);
  } finally {
    await admin.end();
  }
  const pool = new pg.Pool({ connectionString: withDatabase(adminUrl, templateDb), max: 1, options: `-c search_path=${SEARCH_PATH}` });
  try {
    await pool.query("CREATE SCHEMA tomola_clock");
    await pool.query(
      `CREATE FUNCTION tomola_clock.now() RETURNS timestamptz LANGUAGE sql STABLE AS $$ SELECT pg_catalog.now() + coalesce(nullif(current_setting('tomola.clock_offset_ms', true), ''), '0')::numeric * interval '1 millisecond' $$`,
    );
    await migrateNodePg(drizzleNodePg({ client: pool, schema }), { migrationsFolder: migrationsFolder() });
  } finally {
    await pool.end();
  }
  return { adminUrl, templateDb, prefix };
}

// At run end, drop the template and any leftover test databases.
export async function teardownPgTemplate(template: PgTemplate): Promise<void> {
  const admin = new pg.Client({ connectionString: template.adminUrl });
  await admin.connect();
  try {
    const { rows } = await admin.query<{ datname: string }>("SELECT datname FROM pg_database WHERE datname LIKE $1", [`${template.prefix.replace(/_/g, "\\_")}%`]);
    for (const { datname } of rows) await admin.query(`DROP DATABASE IF EXISTS ${quote(datname)} WITH (FORCE)`);
  } finally {
    await admin.end();
  }
}

type Entry = { pool: pg.Pool; name: string };
const entries = new WeakMap<Db, Entry>();
let adminPool: pg.Pool | undefined;
let counter = 0;

function admin(template: PgTemplate): pg.Pool {
  return (adminPool ??= new pg.Pool({ connectionString: template.adminUrl, max: 2 }));
}

// Create a fresh database from the template and connect.
export async function createPgTestDb(template: PgTemplate, options: { logger?: Logger } = {}): Promise<Db> {
  const name = `${template.prefix}${process.env.VITEST_POOL_ID ?? "0"}_${counter++}_${randomBytes(2).toString("hex")}`;
  await admin(template).query(`CREATE DATABASE ${quote(name)} TEMPLATE ${quote(template.templateDb)} STRATEGY file_copy`);
  const pool = new pg.Pool({ connectionString: withDatabase(template.adminUrl, name), max: 4, options: `-c search_path=${SEARCH_PATH} -c tomola.clock_offset_ms=${clockOffsetMs()}` });
  pool.on("error", () => {});
  const db: Db = drizzleNodePg({ client: pool, schema, ...options });
  entries.set(db, { pool, name });
  return db;
}

// Close connections and drop the database.
export async function closePgTestDb(template: PgTemplate, db: Db): Promise<void> {
  const entry = entries.get(db);
  if (!entry) return;
  entries.delete(db);
  await entry.pool.end().catch(() => {});
  await admin(template).query(`DROP DATABASE IF EXISTS ${quote(entry.name)} WITH (FORCE)`);
}

export async function closeAdminPool(): Promise<void> {
  const pool = adminPool;
  adminPool = undefined;
  await pool?.end();
}
