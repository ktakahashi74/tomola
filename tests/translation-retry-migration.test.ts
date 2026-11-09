import fs from "node:fs";
import { eq, sql } from "drizzle-orm";
import { expect, it } from "vitest";
import { addMember, createTestDb } from "./helpers/db";
import { entries, translationReports } from "~/lib/db/schema";

it("preserves a consumed body retry while adding an independent title slot", async () => {
  const db = await createTestDb();
  await addMember(db, "retry_migration", "retry_migration");
  const [entry] = await db.insert(entries).values({ kind: "topic", authorId: "retry_migration", lang: "ja", title: "Title", body: "Body", sourceHash: "current" }).returning();
  await db.execute(sql`drop index translation_reports_retry_once_idx`);
  await db.execute(sql`create unique index translation_reports_retry_once_idx on translation_reports(entry_id, lang, source_hash) where retry_slot`);
  const base = { entryId: entry.id, lang: "en", sourceHash: "current", reporterId: "retry_migration", route: "retry", retrySlot: true };
  const [old] = await db.insert(translationReports).values({ ...base, field: "body" }).returning();
  const migration = fs.readFileSync("drizzle/0073_translation_retry_fields.sql", "utf8");
  for (const statement of migration.split("--> statement-breakpoint")) await db.execute(sql.raw(statement));
  expect((await db.select().from(translationReports).where(eq(translationReports.id, old.id)))[0]).toEqual(old);
  await db.insert(translationReports).values({ ...base, field: "title" });
  await expect(db.insert(translationReports).values({ ...base, field: "body" })).rejects.toThrow();
  expect(await db.select().from(translationReports)).toHaveLength(2);
});
