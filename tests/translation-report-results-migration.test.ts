import fs from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { expect, it } from "vitest";
import { migrationsFolder } from "~/lib/db/client.server";
import { PGLITE_EXTENSIONS } from "~/lib/db/pglite.server";
import { migrationsBefore } from "./helpers/migrations";

it("upgrades existing reports without inventing outcomes or backfilling notices", { timeout: 60_000 }, async () => {
  const before = migrationsBefore("translation_report_results");
  const client = new PGlite({ extensions: PGLITE_EXTENSIONS });
  try {
    const db = drizzle(client);
    await migrate(db, { migrationsFolder: before });
    await client.exec(`insert into "user" (id,name,email,email_verified) values ('upgrade-result','','upgrade-result@example.invalid',true);
      insert into profiles (user_id,handle,handle_key,home_area) values ('upgrade-result','upgrade_result','upgrade_result','ja');
      insert into entries (kind,author_id,lang,body,source_hash) values ('topic','upgrade-result','ja','Original','original');
      insert into translation_reports (entry_id,reporter_id,lang,field,status,resolved_at) select id,'upgrade-result','en','body','resolved',now() from entries;
      insert into translation_reports (entry_id,reporter_id,lang,field,status) select id,'upgrade-result','en','title','open' from entries;
      insert into notifications (user_id,kind,entry_id,thread_id) select 'upgrade-result','mention',id,id from entries;`);
    await migrate(db, { migrationsFolder: migrationsFolder() });
    expect((await client.query("select status,outcome from translation_reports order by id")).rows).toEqual([{ status: "resolved", outcome: null }, { status: "open", outcome: null }]);
    expect((await client.query("select kind,translation_report_id,read_at,emailed_at from notifications")).rows).toEqual([{ kind: "mention", translation_report_id: null, read_at: null, emailed_at: null }]);
    await client.exec("update notifications set read_at=now(),emailed_at=now()");
    expect((await client.query("select count(*)::int as n from notifications where read_at is not null and emailed_at is not null")).rows).toEqual([{ n: 1 }]);
    await expect(client.exec("insert into notifications (user_id,kind) values ('upgrade-result','unknown')")).rejects.toThrow();
    await migrate(db, { migrationsFolder: migrationsFolder() });
    expect((await client.query("select count(*)::int as n from notifications")).rows).toEqual([{ n: 1 }]);
  } finally {
    await client.close();
    fs.rmSync(before, { recursive: true, force: true });
  }
});
