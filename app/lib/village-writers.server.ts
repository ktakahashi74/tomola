import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "./db/client.server";
import { entries, profiles, villages } from "./db/schema";
import { selectDisplayName } from "./display-names.server";
import { sharedVillageCondition } from "./villages.server";
import { villagesEnabled } from "./villages-enabled.server";

// Public authorship comes from visible topics, independently of membership.
export async function villageWriters(db: Db, villageId: string) {
  if (!villagesEnabled()) return [];
  const latest = db.select({ authorId: entries.authorId, at: sql<Date>`max(${entries.createdAt})`.as("at") })
    .from(entries).innerJoin(villages, eq(villages.id, entries.villageId))
    .where(and(eq(entries.villageId, villageId), eq(entries.kind, "topic"), isNull(entries.deletedAt), isNull(entries.hiddenAt), sharedVillageCondition()))
    .groupBy(entries.authorId).as("writers");
  const rows = await db.select({ handle: profiles.handle, displayName: profiles.displayName, displayNameLatin: profiles.displayNameLatin, homeArea: profiles.homeArea })
    .from(latest).innerJoin(profiles, eq(profiles.userId, latest.authorId)).orderBy(desc(latest.at), profiles.handle).limit(20);
  return rows.map(({ handle, ...names }) => ({ handle, name: selectDisplayName(names) }));
}
