import { and, eq, isNull, lte, ne, or, sql } from "drizzle-orm";
import type { Db } from "./db/client.server";
import { entries, notifications, profiles, villageFollows, villageMembers } from "./db/schema";
import { resolveDisplayLang } from "./display";
import { enabledLangs } from "./enabled-langs.server";
import { DELETED_MEMBER_ID } from "./deleted-member";
import type { Lang } from "./languages";

import { translationEagerConfig } from "./translation-eager-config.server";

// Resolve the existing preference rule once per distinct preference tuple, rather
// than loading the membership of the site for each published post.
export async function eagerBodyLangs(db: Db, entryId: number, now = new Date()): Promise<Lang[]> {
  const enabled = enabledLangs();
  const config = translationEagerConfig();
  if (config.scope === "all") return [...enabled];
  const [entry] = await db.select({ villageId: entries.villageId, threadId: entries.threadId }).from(entries).where(eq(entries.id, entryId));
  const [topic] = entry?.threadId ? await db.select({ villageId: entries.villageId }).from(entries).where(eq(entries.id, entry.threadId)) : [];
  const villageId = entry?.villageId ?? topic?.villageId;
  const interested = villageId ? or(
    sql`exists (select 1 from ${villageMembers} where ${villageMembers.userId} = ${profiles.userId} and ${villageMembers.villageId} = ${villageId})`,
    sql`exists (select 1 from ${villageFollows} where ${villageFollows.userId} = ${profiles.userId} and ${villageFollows.villageId} = ${villageId})`,
  ) : sql`false`;
  const recipient = sql`exists (select 1 from ${notifications} where ${notifications.userId} = ${profiles.userId} and ${notifications.entryId} = ${entryId})`;
  const rows = await db.select({ displayLang: profiles.displayLang, readLangs: profiles.readLangs, uiLocale: profiles.uiLocale,
    count: sql<number>`count(*)::int`, interested: sql<boolean>`bool_or(${interested} or ${recipient})` })
    .from(profiles).where(and(ne(profiles.userId, DELETED_MEMBER_ID), or(isNull(profiles.suspendedUntil), lte(profiles.suspendedUntil, now))))
    .groupBy(profiles.displayLang, profiles.readLangs, profiles.uiLocale);
  const counts = new Map<Lang, number>();
  const required = new Set<Lang>();
  for (const row of rows) {
    const lang = resolveDisplayLang({ profile: { displayLang: row.displayLang as Lang | null, readLangs: row.readLangs as Lang[] }, uiLocale: row.uiLocale, enabled });
    counts.set(lang, (counts.get(lang) ?? 0) + Number(row.count));
    if (row.interested) required.add(lang);
  }
  return enabled.filter(lang => required.has(lang) || (counts.get(lang) ?? 0) >= config.minReaders);
}
