import { asc, or, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import type { Db } from "./db/client.server";
import { profiles } from "./db/schema";
import { selectDisplayName } from "./display-names.server";
import { handleKey } from "./handles";
import { escapeLike, handlePrefixMatch } from "./member-matching.server";

export async function searchMembers(db: Db, query: string) {
  const handle = handleKey(query).replace(/^@/, "");
  const prefix = handlePrefixMatch(handle);
  const namePattern = `%${escapeLike(handleKey(query))}%`;
  // Names are not stored as keys. Normalize both stored forms just like the query.
  const nameMatch = (column: AnyPgColumn) => sql`normalize(lower(normalize(${column}, NFKC)), NFKC) LIKE ${namePattern} ESCAPE '\\'`;
  const rows = await db.select({ handle: profiles.handle, displayName: profiles.displayName, displayNameLatin: profiles.displayNameLatin, homeArea: profiles.homeArea })
    .from(profiles)
    .where(or(prefix, nameMatch(profiles.displayName), nameMatch(profiles.displayNameLatin)))
    .orderBy(sql`case when ${profiles.handleKey} = ${handle} then 0 when ${prefix} then 1 else 2 end`, asc(profiles.handleKey))
    .limit(10);
  return rows.map(row => ({ handle: row.handle, name: selectDisplayName(row) }));
}
