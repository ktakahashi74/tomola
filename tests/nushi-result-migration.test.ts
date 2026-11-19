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
import { createScratchDb } from "./helpers/pg-real";
import { PG_MODE } from "./helpers/pg-test";

it("removes legacy Nushi result notices and their email jobs during a populated upgrade", { timeout: 60_000 }, async () => {
  const before = migrationsBefore("remove_nushi_result_notifications");
  let scratch: Awaited<ReturnType<typeof createScratchDb>> | null = null;
  let embedded: PGlite | null = null;
  try {
    scratch = PG_MODE ? await createScratchDb({ migrate: false }) : null;
    embedded = scratch ? null : new PGlite({ extensions: PGLITE_EXTENSIONS });
    const client = scratch ? await scratch.admin() : null;
    const query = async (sql: string) => client ? (await client.query(sql)).rows : (await embedded!.query(sql)).rows;
    const migrate = (folder: string) => client
      ? migratePg(drizzlePg(client), { migrationsFolder: folder })
      : migratePglite(drizzlePglite(embedded!), { migrationsFolder: folder });
    await migrate(before);
    const villageId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    await query(`insert into "user" (id,name,email) values
      ('caller','','caller@example.invalid'), ('cited','','cited@example.invalid')`);
    await query(`insert into villages (id,kind,slug) values ('${villageId}','open','migration-village')`);
    await query(`insert into entries (kind,author_id,lang,body,source_hash,village_id)
      values ('topic','caller','en','Call','source','${villageId}')`);
    await query(`insert into nushi_requests (id,entry_id,thread_id,village_id,caller_id,revision,source_hash,expires_at)
      select 'post-call',id,id,village_id,author_id,0,source_hash,now()+interval '1 hour' from entries`);
    await query(`insert into chat_messages (village_id,author_id,lang,body,created_seq,changed_seq)
      values ('${villageId}','caller','en','Chat call',1,1)`);
    await query(`insert into chat_sequences (village_id,seq) values ('${villageId}',1)`);
    await query(`insert into chat_nushi_requests (id,message_id,village_id,caller_id,expires_at)
      select 'chat-call',id,village_id,author_id,now()+interval '1 hour' from chat_messages`);

    // The old triggers create both obsolete notification kinds and their mail handoffs.
    await query("update nushi_requests set state = 'failed'");
    await query("update chat_nushi_requests set state = 'cancelled'");
    await query(`insert into notifications (user_id,kind,nushi_request_id,nushi_day,thread_id)
      select 'cited','nushi_cited',id,'2026-01-01',thread_id from nushi_requests`);
    await query(`insert into notifications (user_id,kind,chat_message_id,nushi_day,village_id)
      select 'cited','chat_nushi_cited',message_id,'2026-01-02',village_id from chat_nushi_requests`);
    await query(`insert into jobs (kind,payload,dedupe_key)
      select 'send_notification_email',jsonb_build_object('notificationId',id),'notification-email:' || id from notifications`);
    expect(await query("select kind from jobs order by kind")).toEqual([
      { kind: "email_chat_nushi_result" }, { kind: "email_nushi_result" },
      ...Array.from({ length: 4 }, () => ({ kind: "send_notification_email" })),
    ]);
    const citations = await query("select * from notifications where user_id = 'cited' order by id");
    const citationMail = await query(`select jobs.* from jobs join notifications
      on jobs.dedupe_key = 'notification-email:' || notifications.id where notifications.user_id = 'cited' order by jobs.id`);

    await migrate(migrationsFolder());
    expect(await query("select * from notifications order by id")).toEqual(citations);
    expect(await query("select * from jobs order by id")).toEqual(citationMail);
    for (const kind of ["nushi_result", "chat_nushi_result"]) {
      await expect(query(`insert into notifications (user_id,kind) values ('caller','${kind}')`))
        .rejects.toThrow(/notifications_kind_check/);
    }
  } finally {
    try { await embedded?.close(); await scratch?.drop(); }
    finally { fs.rmSync(before, { recursive: true, force: true }); }
  }
});
