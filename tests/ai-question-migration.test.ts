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

it("preserves populated records while adding consented reports and two usage purposes, then migrates idempotently", { timeout: 60_000 }, async () => {
  const before = migrationsBefore("ai_question_reports");
  let scratch: Awaited<ReturnType<typeof createScratchDb>> | null = null;
  let embedded: PGlite | null = null;
  try {
    scratch = PG_MODE ? await createScratchDb({ migrate: false }) : null;
    embedded = scratch ? null : new PGlite({ extensions: PGLITE_EXTENSIONS });
    const client = scratch ? await scratch.admin() : null;
    const query = async (sql: string) => client ? (await client.query(sql)).rows : (await embedded!.query(sql)).rows;
    const migrate = async (folder: string) => client
      ? migratePg(drizzlePg(client), { migrationsFolder: folder })
      : migratePglite(drizzlePglite(embedded!), { migrationsFolder: folder });
    await migrate(before);
    await query(`insert into "user" (id,name,email,email_verified) values ('question-upgrade','','question-upgrade@example.invalid',true)`);
    await query(`insert into entries (kind,author_id,lang,body,source_hash) values ('topic','question-upgrade','en','Existing authored text','fixed-source')`);
    for (const purpose of ["translate", "retry", "judge", "embed", "chat", "moderation"]) {
      await query(`insert into llm_usage (engine,model,purpose,input_tokens,output_tokens,cost_usd_micro) values ('fake','fixture','${purpose}',3,4,7)`);
    }
    const original = await query("select id,body,source_hash,author_id from entries");
    const ledger = await query("select purpose,input_tokens,output_tokens,cost_usd_micro,reserved from llm_usage order by id");
    await migrate(migrationsFolder());
    expect(await query("select id,body,source_hash,author_id from entries")).toEqual(original);
    expect(await query("select purpose,input_tokens,output_tokens,cost_usd_micro,reserved from llm_usage order by id")).toEqual(ledger);
    for (const purpose of ["ask", "ask_village"]) {
      await query(`insert into llm_usage (engine,model,purpose) values ('fake','fixture','${purpose}')`);
    }
    await expect(query("insert into llm_usage (engine,model,purpose) values ('fake','fixture','unsupported')")).rejects.toThrow();
    await query(`insert into ai_question_reports (reporter_id,topic_id,question,answer) select 'question-upgrade',id,'A consented question','{}'::jsonb from entries`);
    expect(await query("select question from ai_question_reports")).toEqual([{ question: "A consented question" }]);
    const applied = await query("select count(*)::int as n from drizzle.__drizzle_migrations");
    await migrate(migrationsFolder());
    expect(await query("select count(*)::int as n from drizzle.__drizzle_migrations")).toEqual(applied);
    expect(await query("select id,body,source_hash,author_id from entries")).toEqual(original);
  } finally {
    try { await embedded?.close(); await scratch?.drop(); }
    finally { fs.rmSync(before, { recursive: true, force: true }); }
  }
});
