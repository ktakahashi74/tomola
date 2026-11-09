import fs from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { TestProject } from "vitest/node";
import { migrationsFolder } from "../app/lib/db/client.server";
import { PGLITE_EXTENSIONS } from "../app/lib/db/pglite.server";
import * as schema from "../app/lib/db/schema";
import { PG_MODE, setupPgTemplate, teardownPgTemplate, type PgTemplate } from "./helpers/pg-test";

declare module "vitest" {
  export interface ProvidedContext {
    // Path to a tar clone of a migrated PGlite data directory; createTestDb in tests/helpers/db.ts creates DBs from it.
    pgliteTemplate: string;
    // Template database for full real-PostgreSQL runs (TOMOLA_TEST_PG=1, tests/helpers/pg-test.ts), otherwise null.
    pgTemplate: PgTemplate | null;
  }
}

// Create a migrated database template once before tests, much faster than migrating every test database.
// Restart tests after editing migrations while running; watch mode does not recreate the template.
export default async function setup(project: TestProject) {
  if (PG_MODE) {
    const adminUrl = process.env.TEST_DATABASE_URL;
    if (!adminUrl) throw new Error("TOMOLA_TEST_PG=1 needs TEST_DATABASE_URL (a postgres:// URL that may create databases)");
    const template = await setupPgTemplate(adminUrl);
    project.provide("pgTemplate", template);
    project.provide("pgliteTemplate", "");
    return () => teardownPgTemplate(template);
  }
  project.provide("pgTemplate", null);
  // .vitest is untracked and absent from a fresh checkout.
  const parent = path.join(project.config.root, ".vitest");
  fs.mkdirSync(parent, { recursive: true });
  const dir = fs.mkdtempSync(path.join(parent, "pglite-"));
  const file = path.join(dir, "template.tar");
  const client = new PGlite({ extensions: PGLITE_EXTENSIONS });
  try {
    await migrate(drizzle({ client, schema }), { migrationsFolder: migrationsFolder() });
    fs.writeFileSync(file, Buffer.from(await (await client.dumpDataDir("none")).arrayBuffer()));
  } finally {
    await client.close();
  }
  project.provide("pgliteTemplate", file);
  return () => fs.rmSync(dir, { recursive: true, force: true });
}
