import { and, eq, gt, ne, sql } from "drizzle-orm";
import type { Db } from "~/lib/db/client.server";
import { villageEvents } from "~/lib/db/schema";

export const VILLAGE_SLUG_HOLD_DAYS = 90;
// Acquire after the actor profile and before any village lock. A common lock
// serializes claims with reservation creation and appeal restoration.
export async function lockVillageSlugClaims(db: Db): Promise<void> {
  await db.execute(sql`select pg_advisory_xact_lock(hashtextextended('village-slug-claims', 0))`);
}
export async function villageSlugHeld(db: Db, slug: string, now: Date, restoringVillageId?: string): Promise<boolean> {
  const [held] = await db.select({ id: villageEvents.id }).from(villageEvents).where(and(
    eq(villageEvents.action, "moderation_fix"),
    sql`${villageEvents.detail}->>'oldSlug' = ${slug} and ${villageEvents.detail}->>'oldSlug' <> ${villageEvents.detail}->>'slug'`,
    gt(villageEvents.createdAt, new Date(now.getTime() - VILLAGE_SLUG_HOLD_DAYS * 86400000)),
    restoringVillageId ? ne(villageEvents.villageId, restoringVillageId) : undefined,
  )).limit(1);
  return !!held;
}
