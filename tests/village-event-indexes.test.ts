import { expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDb } from "./helpers/db";

it("installs village history and changed-slug reservation indexes in the migration", async () => {
  const db = await createTestDb();
  const result = await db.execute(sql`select indexname, indexdef from pg_indexes where schemaname='public' and tablename='village_events' and indexname in ('village_events_village_idx', 'village_events_old_slug_idx')`) as { rows: Array<{ indexname: string; indexdef: string }> };
  expect(result.rows).toHaveLength(2);
  const definitions = new Map(result.rows.map(row => [row.indexname, row.indexdef]));
  expect(definitions.get("village_events_village_idx")).toContain("(village_id, id)");
  const heldSlug = definitions.get("village_events_old_slug_idx")!;
  expect(heldSlug).toContain("oldSlug"); expect(heldSlug).toContain("created_at");
  expect(heldSlug).toContain("moderation_fix"); expect(heldSlug).toContain("WHERE");
  expect(heldSlug).toContain("<>"); expect(heldSlug).toContain("'slug'");
});
