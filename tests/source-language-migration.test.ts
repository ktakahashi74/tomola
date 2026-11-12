import fs from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { expect, it } from "vitest";
import { migrationsFolder } from "~/lib/db/client.server";
import { PGLITE_EXTENSIONS } from "~/lib/db/pglite.server";
import { migrationsBefore } from "./helpers/migrations";

it("preserves existing originals and notifications while widening source languages only", { timeout: 60_000 }, async () => {
  const before = migrationsBefore("source_languages");
  const client = new PGlite({ extensions: PGLITE_EXTENSIONS });
  try {
    const db = drizzle(client);
    await migrate(db, { migrationsFolder: before });
    await client.exec(`insert into "user" (id,name,email,email_verified) values ('source-upgrade','','source-upgrade@example.invalid',true);
      insert into entries (kind,author_id,lang,body,source_hash) values ('topic','source-upgrade','en','Existing prose','original');
      insert into notifications (user_id,kind,entry_id,thread_id) select 'source-upgrade','mention',id,id from entries;`);
    await migrate(db, { migrationsFolder: migrationsFolder() });
    expect((await client.query("select lang,lang_code,lang_source,body,source_hash from entries")).rows).toEqual([
      { lang: "en", lang_code: null, lang_source: null, body: "Existing prose", source_hash: "original" },
    ]);
    expect((await client.query("select kind,read_at,emailed_at from notifications")).rows).toEqual([{ kind: "mention", read_at: null, emailed_at: null }]);
    await client.exec("update entries set lang='other',lang_code='el',lang_source='detected'");
    await expect(client.exec("update entries set lang='en'")).rejects.toThrow();
    await expect(client.exec("update entries set lang_code='EL'")).rejects.toThrow();
    await expect(client.exec("update entries set lang_source='guess'")).rejects.toThrow();
    await expect(client.exec("insert into translations (entry_id,field,lang,kind,text) select id,'body','other','primary','Invalid target' from entries")).rejects.toThrow();
    for (const kind of ["source_language_mismatch", "entry_translation_unavailable"]) {
      await client.query("insert into notifications (user_id,kind) values ('source-upgrade',$1)", [kind]);
    }
    await migrate(db, { migrationsFolder: migrationsFolder() });
    expect((await client.query("select count(*)::int as n from notifications")).rows).toEqual([{ n: 3 }]);
  } finally {
    await client.close();
    fs.rmSync(before, { recursive: true, force: true });
  }
});
