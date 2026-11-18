import { sql } from "drizzle-orm";
import { profiles } from "./db/schema";
import { handleKey } from "./handles";

// Keep literal LIKE characters and handle normalization identical across member lookups.
export const escapeLike = (text: string) => text.replace(/[\\%_]/g, (char) => `\\${char}`);

export function handlePrefixMatch(query: string) {
  const key = handleKey(query);
  return key ? sql`${profiles.handleKey} LIKE ${`${escapeLike(key)}%`} ESCAPE '\\'` : sql`false`;
}
