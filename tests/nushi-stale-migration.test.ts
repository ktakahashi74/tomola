import { createHash } from "node:crypto";
import fs from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import { migrate as migratePg } from "drizzle-orm/node-postgres/migrator";
import { expect, it } from "vitest";
import { migrationsFolder } from "~/lib/db/client.server";
import { PGLITE_EXTENSIONS } from "~/lib/db/pglite.server";
import { migrationsBefore } from "./helpers/migrations";
import { PG_MODE } from "./helpers/pg-test";
import { createScratchDb } from "./helpers/pg-real";

it("preserves existing requests and answers when permitting new calls on the same post", { timeout: 60_000 }, async () => {
  const before = migrationsBefore("nushi_stale_answers");
  let scratch: Awaited<ReturnType<typeof createScratchDb>> | null = null, embedded: PGlite | null = null;
  try {
    scratch = PG_MODE ? await createScratchDb({ migrate: false }) : null;
    embedded = scratch ? null : new PGlite({ extensions: PGLITE_EXTENSIONS });
    const client = scratch ? await scratch.admin() : null;
    const query = async (sql: string) => client ? (await client.query(sql)).rows : (await embedded!.query(sql)).rows;
    const migrate = async (folder: string) => client ? migratePg(drizzlePg(client), { migrationsFolder: folder }) : migratePglite(drizzlePglite(embedded!), { migrationsFolder: folder });
    await migrate(before);
    await query(`insert into "user" (id,name,email,email_verified) values ('11111111111141118111111111111111','','11111111111141118111111111111111@example.invalid',true)`);
    await query(`insert into villages (id,kind,slug) values ('11111111111141118111111111111111','open','11111111111141118111111111111111')`);
    await query(`insert into entries (kind,author_id,lang,body,source_hash,village_id) values ('topic','11111111111141118111111111111111','en','Existing call','fixed-source','11111111111141118111111111111111')`);
    await query(`insert into nushi_requests (id,entry_id,thread_id,village_id,caller_id,revision,source_hash,state,expires_at) select 'old',id,id,'11111111111141118111111111111111','11111111111141118111111111111111',0,'fixed-source','answered',now()+interval '1 hour' from entries`);
    await query(`insert into nushi_answers (request_id,answer,scope,lang,engine,model,prompt_version) values ('old','{"status":"not_confirmed","readings":[],"citations":[]}','{"posts":0,"materialIndex":[]}','en','fake','fake','original')`);
    await query(`insert into nushi_sources (answer_id,entry_id,revision,source_hash,author_id,author,created_at) select a.id,r.entry_id,0,'fixed-source',r.caller_id,'@writer',now() from nushi_answers a join nushi_requests r on r.id=a.request_id`);
    const sources = await query("select * from nushi_sources");
    const requests = await query("select * from nushi_requests");
    const answers = await query("select * from nushi_answers");
    await migrate(migrationsFolder());
    expect(await query("select * from nushi_requests")).toEqual(requests.map(row => ({ ...row as object, replaces_answer_id: null })));
    expect(await query("select * from nushi_answers")).toEqual(answers.map(row => ({ ...row as object, sources_changed: false, superseded_by_id: null })));
    expect(await query("select * from nushi_sources")).toEqual(sources.map(row => ({ ...row as object, text_hash: createHash("sha256").update("\0Existing call").digest("hex") })));
    await query(`insert into nushi_requests (id,entry_id,thread_id,village_id,caller_id,revision,source_hash,expires_at,replaces_answer_id) select 'new',r.entry_id,r.thread_id,r.village_id,r.caller_id,r.revision,r.source_hash,now()+interval '1 hour',a.id from nushi_requests r join nushi_answers a on a.request_id=r.id where r.id='old'`);
    expect(await query("select id from nushi_requests")).toHaveLength(2);
    await expect(query(`insert into nushi_requests (id,entry_id,thread_id,village_id,revision,source_hash,expires_at) select 'duplicate',entry_id,thread_id,village_id,revision,source_hash,expires_at from nushi_requests where id='new'`)).rejects.toThrow();
    await migrate(migrationsFolder());
    expect(await query("select * from nushi_answers")).toEqual(answers.map(row => ({ ...row as object, sources_changed: false, superseded_by_id: null })));
  } finally {
    try { await embedded?.close(); await scratch?.drop(); }
    finally { fs.rmSync(before, { recursive: true, force: true }); }
  }
});
