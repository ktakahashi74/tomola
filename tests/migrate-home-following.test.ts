import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { expect, it } from "vitest";
import { migrationsFolder } from "~/lib/db/client.server";
import { migrateDatabase } from "~/lib/db/migrate.server";
import { DELETED_MEMBER_EMAIL, DELETED_MEMBER_ID } from "~/lib/deleted-member";
import { createScratchDb, REAL_PG_URL } from "./helpers/pg-real";

it.skipIf(!REAL_PG_URL)("moves valid personal follows and backfills shared membership only once", { tags: ["postgres"], timeout: 60_000 }, async () => {
  const scratch = await createScratchDb({ migrate: false });
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "tomola-home-migrations-"));
  try {
    const client = await scratch.admin();
    const source = migrationsFolder();
    const journal = JSON.parse(fs.readFileSync(path.join(source, "meta/_journal.json"), "utf8"));
    const index = journal.entries.findIndex((entry: { tag: string }) => entry.tag.endsWith("_remove_nushi_result_notifications"));
    expect(index).toBeGreaterThan(0);
    const previous = journal.entries.slice(0, index + 1);
    fs.mkdirSync(path.join(folder, "meta"));
    fs.writeFileSync(path.join(folder, "meta/_journal.json"), JSON.stringify({ ...journal, entries: previous }));
    for (const { tag } of previous) fs.copyFileSync(path.join(source, `${tag}.sql`), path.join(folder, `${tag}.sql`));
    await migrate(drizzle(client), { migrationsFolder: folder });
    await client.query(`INSERT INTO "user" (id, name, email) VALUES
      ('legacy-reader', '', 'reader@example.invalid'), ('legacy-owner', '', 'owner@example.invalid'),
      ('no-profile', '', 'pending@example.invalid'), ($1, '', $2)`, [DELETED_MEMBER_ID, DELETED_MEMBER_EMAIL]);
    await client.query(`INSERT INTO profiles (user_id, handle, handle_key, home_area)
      VALUES ('legacy-reader', 'legacy_reader', 'legacy_reader', 'en'),
             ('legacy-owner', 'legacy_owner', 'legacy_owner', 'en'),
             ($1, 'legacy_deleted', 'legacy_deleted', 'other')`, [DELETED_MEMBER_ID]);
    await client.query(`INSERT INTO villages (kind, owner_id, ended_at)
      VALUES ('personal', 'legacy-owner', null), ('personal', 'legacy-reader', null),
             ('personal', 'ended:fixture', now()), ('personal', 'no-profile', null),
             ('personal', $1, null)`, [DELETED_MEMBER_ID]);
    await client.query(`INSERT INTO villages (kind, slug, ended_at) VALUES
      ('open', 'backfill', null), ('invite_public', 'existing-follow', null),
      ('open', 'ended-fixture', now()), ('closed', 'closed-fixture', null), ('open', null, null)`);
    const start = new Date("2026-01-01T00:00:00.000Z");
    const joined = new Date("2026-02-01T00:00:00.000Z");
    await client.query(`INSERT INTO village_follows (user_id, village_id, created_at)
      SELECT 'legacy-reader', id, $1 FROM villages
      WHERE kind = 'personal' OR slug IN ('existing-follow', 'closed-fixture') OR (kind = 'open' AND slug IS NULL)`, [start]);
    await client.query(`INSERT INTO village_follows (user_id, village_id, created_at)
      SELECT 'no-profile', id, $1 FROM villages WHERE owner_id = 'legacy-owner'`, [start]);
    await client.query(`INSERT INTO village_members (user_id, village_id, joined_at)
      SELECT 'legacy-reader', id, $1 FROM villages WHERE kind <> 'personal'`, [joined]);
    await migrateDatabase({ kind: "pg", url: scratch.url });
    expect((await client.query("SELECT follower_id, followed_id, created_at FROM member_follows")).rows).toEqual([
      { follower_id: "legacy-reader", followed_id: "legacy-owner", created_at: start },
    ]);
    const follows = () => client.query(`SELECT v.slug, vf.created_at FROM village_follows vf
      JOIN villages v ON v.id = vf.village_id ORDER BY v.slug`);
    expect((await follows()).rows).toEqual([{ slug: "backfill", created_at: joined }, { slug: "existing-follow", created_at: start }]);
    expect((await client.query("SELECT home_scope FROM profiles WHERE user_id = 'legacy-reader'")).rows).toEqual([{ home_scope: "all" }]);
    await expect(client.query("UPDATE profiles SET home_scope = 'invalid' WHERE user_id = 'legacy-reader'")).rejects.toMatchObject({ code: "23514" });
    await client.query("INSERT INTO list_seen (user_id, scope, seen_at) VALUES ('legacy-reader', '/?scope=following', now())");
    await expect(client.query("UPDATE list_seen SET scope = '/?scope=unknown'")).rejects.toMatchObject({ code: "23514" });
    await client.query("DELETE FROM village_follows USING villages WHERE village_follows.village_id = villages.id AND villages.slug = 'backfill'");
    await migrateDatabase({ kind: "pg", url: scratch.url });
    expect((await follows()).rows).toEqual([{ slug: "existing-follow", created_at: start }]);
  } finally {
    await scratch.drop();
    fs.rmSync(folder, { recursive: true, force: true });
  }
});
