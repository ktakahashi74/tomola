import { and, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { READING_CHUNK_PARAM, type ReadingCursor, type ReadingPage, type ReadingRequest } from "./reading-page";

type Chunk = { topics: unknown[]; list?: ReadingPage | null };

// Use the same route, middleware and authorization as a document read. A
// separate response lets the browser handle a failed append inside the list.
export function readingChunk<Args extends { request: Request }, Result>(
  loader: (args: Args) => Promise<Result>,
  select: (result: Result, section: string) => Chunk | null | undefined,
) {
  return async (args: Args, next: () => Promise<Response>) => {
    const { request } = args;
    if (request.method !== "GET") return next();
    const section = new URL(request.url).searchParams.get(READING_CHUNK_PARAM);
    if (section !== "list" && section !== "vlist") return next();
    const chunk = select(await loader(args), section);
    const headers = { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex" };
    if (!chunk?.list || chunk.list.param !== section) return new Response(null, { status: 404, headers });
    return Response.json({ topics: chunk.topics, list: chunk.list }, { headers });
  };
}

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
