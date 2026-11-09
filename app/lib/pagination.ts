// Pure list/thread pagination functions, shared by server services and routes.

// List topics/page, thread replies/page, maximum requested page size and maximum page number.
export const TOPICS_PER_PAGE = 30;
export const REPLIES_PER_PAGE = 100;
export const MAX_PAGE_SIZE = 100;
// Without a cap, callers could send enormous DB offsets.
export const MAX_PAGE = 10_000;

export type Pagination = { page: number; limit: number; offset: number };

// Validate page>=1 and limit in 1..MAX_PAGE_SIZE. Reject nonintegers, negatives, zero and excessive values with RangeError, never silently repair.
export function checkPagination(input: { page?: number; limit?: number } = {}, defaultLimit: number = TOPICS_PER_PAGE): Pagination {
  const page = input.page ?? 1;
  const limit = input.limit ?? defaultLimit;
  if (!Number.isSafeInteger(page) || page < 1 || page > MAX_PAGE) throw new RangeError(`invalid page: ${page}`);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) throw new RangeError(`invalid limit: ${limit}`);
  return { page, limit, offset: (page - 1) * limit };
}

// Read URL ?page=: absent means 1; null for non-positive-decimal notation or out-of-range values, letting callers return 404.
export function parsePageParam(raw: string | null): number | null {
  if (raw === null) return 1;
  if (!/^[1-9]\d{0,5}$/.test(raw)) return null;
  const page = Number(raw);
  return page <= MAX_PAGE ? page : null;
}

export function pageCount(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / pageSize));
}

// Replace page in the current query, omitting page 1 and preserving ?lang= etc.
// Drop one-use ?review= from 「立場を見直す」 so later pages cannot reuse its trigger candidate.
export function pageSearch(currentSearch: string, page: number, pageParam = "page"): string {
  const params = new URLSearchParams(currentSearch);
  params.delete(pageParam);
  params.delete("review");
  if (page > 1) params.set(pageParam, String(page));
  const search = params.toString();
  return search ? `?${search}` : "";
}
