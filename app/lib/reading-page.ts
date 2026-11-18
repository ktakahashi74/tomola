// HTML reading lists use frozen sort values, independent of API/Markdown paging.
export const READING_BATCH = 30;
export const READING_RESTORE_MAX = 300;
export type ReadingCursor = { order: string; keys: (string | number)[] };
export type ReadingRequest = { after: ReadingCursor | null; start: ReadingCursor | null; count: number; page: number; param: string };
export type ReadingPage = { after: string | null; start: string | null; next: string | null; count: number; param: string; older: boolean };

export function encodeReadingCursor(cursor: ReadingCursor): string {
  return btoa(JSON.stringify([1, cursor.order, ...cursor.keys])).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function decodeReadingCursor(raw: string, order: string): ReadingCursor {
  try {
    if (raw.length > 600 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw new Error();
    const [version, name, ...keys] = JSON.parse(atob(raw.replaceAll("-", "+").replaceAll("_", "/")));
    if (version !== 1 || name !== order || keys.length < 2 || keys.length > 4 || !keys.every((key: unknown) =>
      typeof key === "number" ? Number.isSafeInteger(key) && key >= 0 : typeof key === "string" && /^\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|[+-]\d\d(?::?\d\d)?)$/.test(key) && Number.isFinite(Date.parse(key)))) throw new Error();
    const timestamp = (value: unknown) => typeof value === "string";
    const positiveId = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
    const valid = name === "insightful" ? keys.length === 3 && typeof keys[0] === "number" && keys[0] <= 2_147_483_647 && timestamp(keys[1]) && positiveId(keys[2])
      : name === "related" ? keys.length === 3 && timestamp(keys[0]) && positiveId(keys[1]) && positiveId(keys[2])
      : keys.length === 2 && timestamp(keys[0]) && positiveId(keys[1]);
    if (!valid) throw new Error();
    return { order, keys };
  } catch { throw new Response("Invalid list cursor", { status: 400 }); }
}

export function readReadingRequest(request: Request, order: string, page = 1, param = "list", legacyBatch = READING_BATCH): ReadingRequest {
  const query = new URL(request.url).searchParams;
  const read = (suffix: string) => { const raw = query.get(`${param}_${suffix}`); return raw !== null ? decodeReadingCursor(raw, order) : null; };
  const raw = query.get(`${param}_count`);
  const legacy = query.has(param === "vlist" ? "vpage" : "page") && !query.has(`${param}_after`) && !query.has(`${param}_start`);
  const count = raw === null ? legacy ? legacyBatch : READING_BATCH : Number(raw);
  if ((raw !== null && !/^[1-9]\d{0,2}$/.test(raw)) || !Number.isSafeInteger(count) || count < 1 || count > READING_RESTORE_MAX) throw new Response("Invalid list size", { status: 400 });
  const after = read("after"), start = read("start");
  if (after && start && after.keys.length !== start.keys.length) throw new Response("Invalid list cursor", { status: 400 });
  return { after, start, count, page: after || start ? 1 : page, param };
}

export function readingPage<T>(rows: T[], request: ReadingRequest, cursor: (row: T) => ReadingCursor, hasNext: boolean): ReadingPage {
  return {
    after: request.after ? encodeReadingCursor(request.after) : null,
    start: request.start ? encodeReadingCursor(request.start) : rows.length ? encodeReadingCursor(cursor(rows[0])) : null,
    next: hasNext && rows.length ? encodeReadingCursor(cursor(rows.at(-1)!)) : null,
    count: rows.length, param: request.param, older: !!request.after || request.page > 1,
  };
}

export function clearReadingParams(params: URLSearchParams, param?: string) {
  for (const key of [...params.keys()]) if (param ? key.startsWith(`${param}_`) : /^(list|vlist)_(after|start|count)$/.test(key)) params.delete(key);
}

export function readingHref(search: string, page: ReadingPage, more: boolean): string {
  const params = new URLSearchParams(search);
  clearReadingParams(params, page.param);
  params.delete(page.param === "vlist" ? "vpage" : "page");
  for (const key of ["review", "manage", "membersPage", "invitesPage", "notice"]) params.delete(key);
  if (more) {
    if (page.next) params.set(`${page.param}_after`, page.next);
  } else {
    if (page.after) params.set(`${page.param}_after`, page.after);
    if (page.start) params.set(`${page.param}_start`, page.start);
    params.set(`${page.param}_count`, String(page.count));
  }
  const query = params.toString();
  return query ? `?${query}` : "";
}

export function appendReadingItems<T extends { id: number }>(current: T[], next: T[]): T[] {
  const seen = new Set(current.map(item => item.id));
  return [...current, ...next.filter(item => { if (seen.has(item.id)) return false; seen.add(item.id); return true; })];
}

export function readingLatestHref(search: string, page: ReadingPage): string {
  const params = new URLSearchParams(readingHref(search, page, true));
  clearReadingParams(params, page.param);
  return params.size ? `?${params}` : "";
}
