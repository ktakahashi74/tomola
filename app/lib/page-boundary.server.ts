import { sql, type SQL, type SQLWrapper } from "drizzle-orm";

// Numbered URLs cannot carry a seek cursor. Resolve their boundary using only
// indexed keys, then seek when loading the actual page. Keep both reads in one
// SQL statement/snapshot. The narrow boundary still has O(offset) index work.
export function afterPageBoundary(keys: readonly SQLWrapper[], boundary: SQLWrapper | undefined, descending = false): SQL | undefined {
  return boundary ? sql`(${sql.join([...keys], sql`, `)}) ${sql.raw(descending ? "<" : ">")} (${boundary})` : undefined;
}
