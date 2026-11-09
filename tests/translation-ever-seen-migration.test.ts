import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { entries, translations } from "~/lib/db/schema";
import { addMember, createTestDb } from "./helpers/db";
import { migrationStatements } from "./helpers/migrations";

it("backfills lifetime display markers only from existing first-display timestamps", async () => {
  const db = await createTestDb();
  await addMember(db, "reach_migration", "reach_migration");
  const [entry] = await db.insert(entries).values({ kind: "topic", authorId: "reach_migration", lang: "ja", body: "Original", sourceHash: "current" }).returning();
  const seen = new Date("2026-10-01T00:00:00Z");
  const base = { entryId: entry.id, field: "body", kind: "primary", text: "Translation" };
  const rows = await db.insert(translations).values([
    { ...base, lang: "en", sourceHash: "old", firstSeenAt: seen },
    { ...base, lang: "fr", sourceHash: "current", firstSeenAt: null },
    { ...base, lang: "de", sourceHash: "old", firstSeenAt: null },
  ]).returning();
  await db.execute("alter table translations drop column ever_seen");
  for (const statement of migrationStatements("translation_ever_seen")) await db.execute(statement);
  const migrated = await db.select().from(translations).orderBy(translations.id);
  expect(migrated.map(row => row.everSeen)).toEqual([true, false, false]);
  expect(migrated.map(row => row.firstSeenAt)).toEqual([seen, null, null]);
  expect(migrated.map(row => row.id)).toEqual(rows.map(row => row.id));
  const [created] = await db.insert(translations).values({ ...base, lang: "ko" }).returning();
  expect(created.everSeen).toBe(false);
  await db.update(translations).set({ firstSeenAt: null }).where(eq(translations.id, rows[0].id));
  expect((await db.select().from(translations).where(eq(translations.id, rows[0].id)))[0].everSeen).toBe(true);
});
