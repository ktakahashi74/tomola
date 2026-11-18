import { and, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import type { ReadingCursor, ReadingRequest } from "./reading-page";

// Timestamp cursor values come from PostgreSQL text, retaining microseconds.
export const cursorTime = (column: SQLWrapper) => sql<string>`${column}::text`;

export function readingCondition(keys: SQLWrapper[], request?: ReadingRequest): SQL | undefined {
  const boundary = (cursor: ReadingCursor | null, inclusive: boolean) => {
    if (!cursor) return undefined;
    if (cursor.keys.length !== keys.length) throw new Response("Invalid list cursor", { status: 400 });
    return sql`(${sql.join(keys, sql`, `)}) ${inclusive ? sql`<=` : sql`<`} (${sql.join(cursor.keys.map(key => sql`${key}`), sql`, `)})`;
  };
  return request ? and(boundary(request.after, false), boundary(request.start, true)) : undefined;
}
