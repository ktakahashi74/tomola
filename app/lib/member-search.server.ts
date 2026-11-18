import { and, asc, notInArray, or, sql, type SQLWrapper } from "drizzle-orm";
import type { Db } from "./db/client.server";
import { profiles } from "./db/schema";
import { selectDisplayName } from "./display-names.server";
import { handleKey } from "./handles";
import { handlePrefixMatch, textSubstringMatch } from "./member-matching.server";

export async function searchMembers(db: Db, query: string, options: { limit?: number; excludeUserIds?: string[] | SQLWrapper } = {}) {
  const handle = handleKey(query).replace(/^@/, "");
  const prefix = handlePrefixMatch(handle);
  const rows = await db.select({ handle: profiles.handle, displayName: profiles.displayName, displayNameLatin: profiles.displayNameLatin, homeArea: profiles.homeArea })
    .from(profiles)
    .where(and(or(prefix, textSubstringMatch(profiles.displayName, query), textSubstringMatch(profiles.displayNameLatin, query)),
      options.excludeUserIds ? notInArray(profiles.userId, options.excludeUserIds) : undefined))
    .orderBy(sql`case when ${profiles.handleKey} = ${handle} then 0 when ${prefix} then 1 else 2 end`, asc(profiles.handleKey))
    .limit(options.limit ?? 10);
  return rows.map(row => ({ handle: row.handle, name: selectDisplayName(row) }));
}
