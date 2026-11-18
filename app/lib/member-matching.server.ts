import { sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { profiles } from "./db/schema";
import { handleKey } from "./handles";

// Keep literal LIKE characters and handle normalization identical across member lookups.
export const escapeLike = (text: string) => text.replace(/[\\%_]/g, (char) => `\\${char}`);

// Names and descriptions are stored as text rather than normalized keys.
export function textSubstringMatch(column: AnyPgColumn, query: string) {
  const pattern = `%${escapeLike(handleKey(query))}%`;
  return sql`normalize(lower(normalize(${column}, NFKC)), NFKC) LIKE ${pattern} ESCAPE '\\'`;
}

export function handlePrefixMatch(query: string) {
  const key = handleKey(query);
  return key ? sql`${profiles.handleKey} LIKE ${`${escapeLike(key)}%`} ESCAPE '\\'` : sql`false`;
}
