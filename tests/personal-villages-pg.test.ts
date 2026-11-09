import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { createScratchDb, REAL_PG_URL } from "./helpers/pg-real";
import { migrateDatabase } from "~/lib/db/migrate.server";
import { migrationsFolder } from "~/lib/db/client.server";
import { createProfile } from "~/lib/profiles.server";
import { villages, user } from "~/lib/db/schema";

describe.skipIf(!REAL_PG_URL)("personal village PostgreSQL boundaries", { tags: ["postgres"] }, () => {
  it("backfills every historical member without changing either null or chosen defaults", async () => {
    const scratch = await createScratchDb({ migrate: false });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "personal-villages-migrations-"));
    const pool = new pg.Pool({ connectionString: scratch.url, max: 2 });
    try {
      const folder = migrationsFolder();
      const journal = JSON.parse(fs.readFileSync(path.join(folder, "meta/_journal.json"), "utf8"));
      const entries = journal.entries.filter((entry: { idx: number }) => entry.idx < 93);
      fs.mkdirSync(path.join(dir, "meta"));
      fs.writeFileSync(path.join(dir, "meta/_journal.json"), JSON.stringify({ ...journal, entries }));
      for (const entry of entries) fs.copyFileSync(path.join(folder, entry.tag + ".sql"), path.join(dir, entry.tag + ".sql"));
      await migrate(drizzle(pool), { migrationsFolder: dir });
      await pool.query(`INSERT INTO "user" (id, name, email, email_verified) VALUES ('old-person', '', 'old-person@example.invalid', true), ('old-organization', '', 'old-organization@example.invalid', false)`);
      const village = (await pool.query(`INSERT INTO villages (kind, slug, name) VALUES ('invite_public', 'historic-group', 'Historic group') RETURNING id`)).rows[0].id;
      await pool.query(`INSERT INTO profiles (user_id, handle, handle_key, home_area, default_village_id) VALUES ('old-person', 'old_person', 'old_person', 'en', null), ('old-organization', 'old_organization', 'old_organization', 'en', $1)`, [village]);
      const before = (await pool.query(`SELECT user_id, default_village_id FROM profiles ORDER BY user_id`)).rows;
      await migrateDatabase({ kind: "pg", url: scratch.url });
      expect((await pool.query(`SELECT user_id, default_village_id FROM profiles ORDER BY user_id`)).rows).toEqual(before);
      expect((await pool.query(`SELECT owner_id FROM villages WHERE kind = 'personal' ORDER BY owner_id`)).rows).toEqual([{ owner_id: "old-organization" }, { owner_id: "old-person" }]);
      await migrateDatabase({ kind: "pg", url: scratch.url });
      expect(Number((await pool.query(`SELECT count(*) FROM villages WHERE kind = 'personal'`)).rows[0].count)).toBe(2);
    } finally { await pool.end(); fs.rmSync(dir, { recursive: true, force: true }); await scratch.drop(); }
  });

  it("serializes duplicate registration across independent connections into one owner and village", async () => {
    vi.stubEnv("VILLAGES", "");
    const scratch = await createScratchDb();
    try {
      const first = await scratch.open(); const second = await scratch.open();
      await first.insert(user).values({ id: "racing-owner", name: "", email: "racing-owner@example.invalid", emailVerified: true });
      const results = await Promise.all([first, second].map(db => createProfile(db, "racing-owner", { handle: "racing_owner", homeArea: "en" })));
      expect(results.filter(result => result.ok)).toHaveLength(1);
      expect(await first.select().from(villages).where(eq(villages.ownerId, "racing-owner"))).toHaveLength(1);
    } finally { vi.unstubAllEnvs(); await scratch.drop(); }
  });
});
