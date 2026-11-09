import { expect, it } from "vitest";
import { createTestDb } from "./helpers/db";
import { migrationStatements } from "./helpers/migrations";

it("backfills pre-existing jobs with exactly the former claim tiers", async () => {
  const db = await createTestDb();
  await db.execute("alter table jobs drop column priority cascade");
  await db.execute("create index jobs_due_idx on jobs(status, run_at)");
  await db.execute("insert into jobs(kind) values ('send_notification_email'), ('send_digest'), ('send_passkey_notice'), ('translate_title'), ('translate_entry'), ('embed_entry'), ('rebuild_render_cache')");
  for (const statement of migrationStatements("job_priorities")) await db.execute(statement);
  const result = await db.execute("select kind, priority from jobs order by id") as { rows: Array<{ kind: string; priority: number }> };
  expect(result.rows.map(r => r.priority)).toEqual([0, 0, 0, 1, 2, 2, 2]);
  const index = await db.execute("select indexdef from pg_indexes where indexname = 'jobs_due_idx'") as { rows: Array<{ indexdef: string }> };
  expect(index.rows[0].indexdef).toContain("(status, priority, run_at, id)");
});
