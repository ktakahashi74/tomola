import { and, eq, sql } from "drizzle-orm";
import type { Db } from "./db/client.server";
import { profiles, villageFollows, villages } from "./db/schema";

// The caller holds the profile lock, or has just created it. Account deletion
// replaces the owner binding with a village-derived marker.
export async function ensurePersonalVillage(db: Db, userId: string) {
  const [member] = await db.select({ id: profiles.userId }).from(profiles).where(eq(profiles.userId, userId));
  if (!member) throw new Error("Personal village requires an existing member");
  await db.insert(villages).values({ kind: "personal", ownerId: userId }).onConflictDoNothing();
  const [village] = await db.select().from(villages).where(and(eq(villages.kind, "personal"), eq(villages.ownerId, userId)));
  return village;
}

export async function personalVillage(db: Db, userId: string) {
  const [village] = await db.select().from(villages).where(and(eq(villages.kind, "personal"), eq(villages.ownerId, userId)));
  return village ?? null;
}

export async function resetPersonalDefault(db: Db, userId: string) {
  const village = await personalVillage(db, userId);
  if (!village || village.endedAt) return null;
  await db.update(profiles).set({ defaultVillageId: village.id, defaultVillageReset: true }).where(eq(profiles.userId, userId));
  return village.id;
}

export async function endPersonalVillage(db: Db, userId: string, now: Date) {
  const rows = await db.update(villages).set({ endedAt: sql`coalesce(${villages.endedAt}, ${now.toISOString()}::timestamptz)`, ownerId: sql`'ended:' || ${villages.id}` })
    .where(and(eq(villages.kind, "personal"), eq(villages.ownerId, userId))).returning({ id: villages.id });
  for (const row of rows) await db.delete(villageFollows).where(eq(villageFollows.villageId, row.id));
}
