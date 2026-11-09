import { acceptTrialFixture } from "./trial";
import fs from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { Logger } from "drizzle-orm/logger";
import { migrate } from "drizzle-orm/pglite/migrator";
import { inject, onTestFinished } from "vitest";
import { migrationsFolder, type Db } from "~/lib/db/client.server";
import { PGLITE_EXTENSIONS } from "~/lib/db/pglite.server";
import * as schema from "~/lib/db/schema";
import { user } from "~/lib/db/schema";
import type { Lang } from "~/lib/languages";
import { createProfile } from "~/lib/profiles.server";
import { closePgTestDb, createPgTestDb, PG_MODE } from "./pg-test";

// Clone of a migrated data directory, created once before the run by tests/global-setup.ts. Faster than rerunning migrations, so per-test DB creation
// stays within default timeouts. When run without globalSetup, such as an editor with different configuration,
// create one template per test file.
let template: Promise<Blob> | undefined;
async function migratedTemplate(): Promise<Blob> {
  const file = inject("pgliteTemplate");
  if (file) return new Blob([fs.readFileSync(file)]);
  const client = new PGlite({ extensions: PGLITE_EXTENSIONS });
  try {
    await migrate(drizzle({ client, schema }), { migrationsFolder: migrationsFolder() });
    return await client.dumpDataDir("none");
  } finally {
    await client.close();
  }
}

const clients = new WeakMap<Db, PGlite>();
// Still-open databases created outside tests, such as in beforeAll; tests/setup.ts closes them at file end.
const hookDbs = new Set<Db>();

export async function closeTestDb(db: Db): Promise<void> {
  hookDbs.delete(db);
  const pgTemplate = PG_MODE ? inject("pgTemplate") : null;
  if (pgTemplate) {
    await closePgTestDb(pgTemplate, db);
    return;
  }
  const client = clients.get(db);
  clients.delete(db);
  await client?.close();
}

// Create a migrated in-memory PGlite database. Databases created inside a test close after that test and its afterEach hooks.
// Databases created outside tests, such as beforeAll, close at file end to avoid accumulating WASM memory.
export async function createTestDb(options: { logger?: Logger } = {}): Promise<Db> {
  if (process.env.TOMOLA_TEST_NO_DB === "1") throw new Error("Fast tests must not create a database. Remove this file from tests/fast-files.ts and use the database configuration.");
  // Real PostgreSQL mode (pnpm test:pg) creates a database per test from a template.
  const pgTemplate = PG_MODE ? inject("pgTemplate") : null;
  let db: Db;
  if (pgTemplate) {
    db = await createPgTestDb(pgTemplate, options);
  } else {
    const dump = await (template ??= migratedTemplate());
    const client = new PGlite({ loadDataDir: dump, extensions: PGLITE_EXTENSIONS });
    db = drizzle({ client, schema, ...options });
    clients.set(db, client);
  }
  try {
    onTestFinished(() => closeTestDb(db));
  } catch {
    hookDbs.add(db);
  }
  return db;
}

export async function closeHookDbs(): Promise<void> {
  await Promise.all([...hookDbs].map((db) => closeTestDb(db)));
}

// Create a member (user and profile) for calling services in tests without login.
export async function addMember(
  db: Db,
  id: string,
  handle: string,
  opts: { readLangs?: Lang[]; homeArea?: Lang | "other"; email?: string } = {},
) {
  await db.insert(user).values({ id, name: "", email: opts.email ?? `${id}@example.com`, emailVerified: true });
  const res = await createProfile(db, id, {
    handle,
    homeArea: opts.homeArea ?? "ja",
    readLangs: opts.readLangs ?? ["ja"],
  });
  if (!res.ok) throw new Error(`profile failed: ${res.error}`);
  await acceptTrialFixture(db, id);
}
