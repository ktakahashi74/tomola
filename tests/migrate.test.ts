import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { migrationsFolder } from "~/lib/db/client.server";
import { explainMigrationError, migrateDatabase, MIGRATE_LOCK_KEY } from "~/lib/db/migrate.server";
import { profiles, user } from "~/lib/db/schema";
import { handleKey } from "~/lib/handles";
import { createScratchDb, REAL_PG_URL, type ScratchDb } from "./helpers/pg-real";

describe("migrateDatabase on PGlite", () => {
  // Running all migrations from the first one can exceed five seconds under CPU load.
  it("applies the migrations and reports nothing to fix on a new database", { timeout: 60_000 }, async () => {
    const result = await migrateDatabase({ kind: "pglite", dataDir: undefined });
    expect(result).toMatchObject({ checked: 0, fixed: [], waited: false });
    expect(result.target).toContain("PGlite");
  });
});

describe("explainMigrationError", () => {
  it("points at the CREATE EXTENSION privilege and at a PostgreSQL without pgvector", () => {
    expect(explainMigrationError('permission denied to create extension "vector"')).toContain("superuser");
    expect(explainMigrationError('extension "vector" is not available')).toContain("pgvector/pgvector:pg18");
    expect(explainMigrationError('could not open extension control file "/usr/share/postgresql/18/extension/vector.control"')).toContain("pgvector");
    expect(explainMigrationError("syntax error")).toBeNull();
  });
});

const journalCount = () => (JSON.parse(fs.readFileSync(path.join(migrationsFolder(), "meta", "_journal.json"), "utf8")) as { entries: unknown[] }).entries.length;

// Real PostgreSQL advisory locking and search-key recomputation.
describe.skipIf(!REAL_PG_URL)("pnpm db:migrate on PostgreSQL (TEST_DATABASE_URL)", { tags: ["postgres"] }, () => {
  const scratch: ScratchDb[] = [];
  afterEach(async () => {
    await Promise.all(scratch.splice(0).map((s) => s.drop()));
  });

  async function appliedMigrations(url: string): Promise<number> {
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      const res = await client.query<{ n: string }>("SELECT count(*)::text AS n FROM drizzle.__drizzle_migrations");
      return Number(res.rows[0].n);
    } finally {
      await client.end();
    }
  }

  it("applies every migration to a new database, and a second run does nothing", async () => {
    const s = await createScratchDb({ migrate: false });
    scratch.push(s);
    const first = await migrateDatabase({ kind: "pg", url: s.url });
    expect(first).toMatchObject({ target: "PostgreSQL", fixed: [], waited: false });
    expect(await appliedMigrations(s.url)).toBe(journalCount());
    await migrateDatabase({ kind: "pg", url: s.url });
    expect(await appliedMigrations(s.url)).toBe(journalCount());
  });

  it("waits for another process that holds the lock, and then migrates", async () => {
    const s = await createScratchDb({ migrate: false });
    scratch.push(s);
    const holder = new pg.Client({ connectionString: s.url });
    await holder.connect();
    await holder.query("SELECT pg_advisory_lock($1)", [MIGRATE_LOCK_KEY]);
    const logs: string[] = [];
    let finished = false;
    const running = migrateDatabase({ kind: "pg", url: s.url }, { log: (m) => logs.push(m) }).then((r) => {
      finished = true;
      return r;
    });
    // While the lock is held, create nothing and log that it is waiting.
    await expect.poll(() => logs.length, { timeout: 10_000 }).toBeGreaterThan(0);
    expect(finished).toBe(false);
    const probe = new pg.Client({ connectionString: s.url });
    await probe.connect();
    try {
      await expect.poll(async () => (await probe.query("SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND wait_event = 'advisory' LIMIT 1")).rowCount, { timeout: 10_000 }).toBe(1);
      expect(finished).toBe(false);
      expect((await probe.query("SELECT to_regclass('public.profiles') AS t")).rows[0].t).toBeNull();
    } finally {
      await probe.end();
    }
    await holder.query("SELECT pg_advisory_unlock($1)", [MIGRATE_LOCK_KEY]);
    await holder.end();
    const result = await running;
    expect(result.waited).toBe(true);
    expect(await appliedMigrations(s.url)).toBe(journalCount());
  });

  it("is safe when two processes start at once: both finish, every migration is applied once", async () => {
    const s = await createScratchDb({ migrate: false });
    scratch.push(s);
    const results = await Promise.all([migrateDatabase({ kind: "pg", url: s.url }), migrateDatabase({ kind: "pg", url: s.url }), migrateDatabase({ kind: "pg", url: s.url })]);
    expect(results).toHaveLength(3);
    expect(await appliedMigrations(s.url)).toBe(journalCount());
  });

  it("recomputes a stale handle_key after migrating, and fails naming the names when two names collide", async () => {
    const s = await createScratchDb();
    scratch.push(s);
    const db = await s.open();
    await db.insert(user).values([
      { id: "u1", name: "", email: "u1@example.com", emailVerified: true },
      { id: "u2", name: "", email: "u2@example.com", emailVerified: true },
    ]);
    // Reproduce legacy Unicode rows only in this disposable database. New signups remain ASCII-only.
    await db.execute(sql`alter table profiles drop constraint profiles_handle_check`);
    // ICU lowercases İ to i plus a combining dot.
    await db.insert(profiles).values({ userId: "u1", handle: "İstanbul", handleKey: "i̇stanbul", homeArea: "ja" });
    const fixed = await migrateDatabase({ kind: "pg", url: s.url });
    expect(fixed.fixed).toEqual(["İstanbul"]);
    expect((await db.select({ key: profiles.handleKey }).from(profiles))[0].key).toBe(handleKey("İstanbul"));
    // Case-sensitive handles permit two rows whose old keys collide under the current computation.
    await db.insert(profiles).values({ userId: "u2", handle: "ISTANBUL", handleKey: "ISTANBUL-old", homeArea: "ja" });
    await expect(migrateDatabase({ kind: "pg", url: s.url })).rejects.toThrow(/handle_key collision.*"İstanbul".*"ISTANBUL"|handle_key collision.*"ISTANBUL".*"İstanbul"/);
    // Release the lock after failure; the next attempt reaches the same error without delay.
    await expect(migrateDatabase({ kind: "pg", url: s.url }, { log: () => {} })).rejects.toThrow(/handle_key collision/);
    await db.execute(sql`update profiles set handle = 'ISTANBUL-2' where user_id = 'u2'`);
    expect((await migrateDatabase({ kind: "pg", url: s.url })).fixed).toEqual(["ISTANBUL-2"]);
  });
});
