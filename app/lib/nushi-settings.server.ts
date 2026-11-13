import { and, eq } from "drizzle-orm";
import type { Db } from "./db/client.server";
import { entries, profiles, villageMembers, villages } from "./db/schema";

export async function setVillageNushi(db: Db, userId: string, villageId: string, enabled: boolean) {
  return db.transaction(async tx => {
    const [village] = await tx.select().from(villages).where(eq(villages.id, villageId)).for("update");
    if (!village || village.language || village.endedAt || !["personal", "open", "invite_public"].includes(village.kind)) return false;
    const [owner] = await tx.select().from(villageMembers).where(and(eq(villageMembers.villageId, villageId), eq(villageMembers.userId, userId), eq(villageMembers.role, "owner")));
    if (village.kind === "personal" ? village.ownerId !== userId : !owner) return false;
    await tx.update(villages).set({ nushiEnabled: enabled }).where(eq(villages.id, villageId));
    return true;
  });
}
export async function setTopicNushi(db: Db, userId: string, threadId: number, disabled: boolean) {
  if (!Number.isSafeInteger(threadId) || threadId < 1) return false;
  const rows = await db.update(entries).set({ nushiDisabled: disabled }).where(and(eq(entries.id, threadId), eq(entries.kind, "topic"), eq(entries.authorId, userId))).returning({ id: entries.id });
  return !!rows.length;
}
export async function nushiPreferences(db: Db, userId?: string, request?: Request) {
  const [profile] = userId ? await db.select({ hide: profiles.hideNushi, citations: profiles.nushiCitationNotifications }).from(profiles).where(eq(profiles.userId, userId)) : [];
  return profile ?? { hide: /(?:^|;\s*)nushi_hidden=1(?:;|$)/.test(request?.headers.get("cookie") ?? ""), citations: true };
}

export async function nushiTopicDisabled(db: Db, id: number) {
  const [row] = await db.select({ disabled: entries.nushiDisabled }).from(entries).where(eq(entries.id, id));
  return row?.disabled ?? false;
}
