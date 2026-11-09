// Browser/server-shared query validation, also used for UI input cap. Server search is app/lib/search.server.ts.

// Query character cap in code points; query embeddings incur cost.
export const MAX_QUERY_LENGTH = 500;

export type QueryCheck = { ok: true; query: string } | { ok: false; error: "empty" | "too_long" };

// Trim and collapse whitespace; reject empty/over-limit queries.
export function checkQuery(raw: string | null | undefined): QueryCheck {
  const query = (raw ?? "").replace(/\s+/g, " ").trim();
  if (query === "") return { ok: false, error: "empty" };
  if ([...query].length > MAX_QUERY_LENGTH) return { ok: false, error: "too_long" };
  return { ok: true, query };
}
