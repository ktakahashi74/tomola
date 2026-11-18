// HTML reading lists use frozen sort values, independent of API/Markdown paging.
export const READING_BATCH = 30;
export const READING_RESTORE_MAX = 300;
export const READING_CHUNK_PARAM = "_reading_chunk";
export type ReadingCursor = { order: string; keys: (string | number)[] };
export type ReadingRequest = { after: ReadingCursor | null; start: ReadingCursor | null; count: number; page: number; param: string; legacyParam: string };
export type ReadingPage = { after: string | null; start: string | null; next: string | null; count: number; param: string; legacyParam: string; older: boolean; restored: boolean };
export type ReadingChunk<T> = { topics: T[]; list: ReadingPage };

export function encodeReadingCursor(cursor: ReadingCursor): string {
  return btoa(JSON.stringify([1, cursor.order, ...cursor.keys])).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function validCursorTimestamp(value: string): boolean {
  const parts = /^(\d{4})-(\d\d)-(\d\d)[T ](\d\d):(\d\d):(\d\d)(?:\.\d{1,6})?(?:Z|[+-](\d\d)(?::?(\d\d))?)$/.exec(value);
  if (!parts) return false;
  const [, y, m, d, h, min, s, offsetHour = "0", offsetMinute = "0"] = parts;
  const year = Number(y), month = Number(m), day = Number(d);
  // Shift into a full Gregorian cycle so Date.UTC handles even years 1–99 literally.
  const days = new Date(Date.UTC(2000 + year % 400, month, 0)).getUTCDate();
  return year > 0 && month >= 1 && month <= 12 && day >= 1 && day <= days
    && Number(h) < 24 && Number(min) < 60 && Number(s) < 60
    && Number(offsetHour) <= 15 && Number(offsetMinute) < 60;
}

export function decodeReadingCursor(raw: string, order: string): ReadingCursor {
  try {
    if (raw.length > 600 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw new Error();
    const [version, name, ...keys] = JSON.parse(atob(raw.replaceAll("-", "+").replaceAll("_", "/")));
    if (version !== 1 || name !== order || keys.length < 2 || keys.length > 4 || !keys.every((key: unknown) =>
      typeof key === "number" ? Number.isSafeInteger(key) && key >= 0 : typeof key === "string" && validCursorTimestamp(key))) throw new Error();
    const timestamp = (value: unknown) => typeof value === "string";
    const positiveId = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
    const valid = name === "insightful" ? keys.length === 3 && typeof keys[0] === "number" && keys[0] <= 2_147_483_647 && timestamp(keys[1]) && positiveId(keys[2])
      : name === "related" ? keys.length === 3 && timestamp(keys[0]) && positiveId(keys[1]) && positiveId(keys[2])
      : keys.length === 2 && timestamp(keys[0]) && positiveId(keys[1]);
    if (!valid) throw new Error();
    return { order, keys };
  } catch { throw new Response("Invalid list cursor", { status: 400 }); }
}

export function readReadingRequest(request: Request, order: string, page = 1, param = "list", legacyBatch = READING_BATCH, legacyParam = param === "vlist" ? "vpage" : "page"): ReadingRequest {
  const query = new URL(request.url).searchParams;
  const read = (suffix: string) => { const raw = query.get(`${param}_${suffix}`); return raw !== null ? decodeReadingCursor(raw, order) : null; };
  const raw = query.get(`${param}_count`);
  const after = read("after"), start = read("start");
  const hasRange = after || start || raw !== null;
  const legacy = query.has(legacyParam) && !hasRange;
  const count = raw === null ? legacy ? legacyBatch : READING_BATCH : Number(raw);
  if ((raw !== null && !/^[1-9]\d{0,2}$/.test(raw)) || !Number.isSafeInteger(count) || count < 1 || count > READING_RESTORE_MAX) throw new Response("Invalid list size", { status: 400 });
  if (after && start && after.keys.length !== start.keys.length) throw new Response("Invalid list cursor", { status: 400 });
  return { after, start, count, page: hasRange ? 1 : page, param, legacyParam };
}

export function readingPage<T>(rows: T[], request: ReadingRequest, cursor: (row: T) => ReadingCursor, hasNext: boolean): ReadingPage {
  return {
    after: request.after ? encodeReadingCursor(request.after) : null,
    start: request.start ? encodeReadingCursor(request.start) : rows.length ? encodeReadingCursor(cursor(rows[0])) : null,
    next: hasNext && rows.length ? encodeReadingCursor(cursor(rows.at(-1)!)) : null,
    count: rows.length, param: request.param, legacyParam: request.legacyParam,
    older: !!request.after || request.page > 1, restored: !!request.start && !request.after,
  };
}

export function clearReadingParams(params: URLSearchParams, param?: string) {
  for (const key of [...params.keys()]) if (param ? key.startsWith(`${param}_`) : /^(list|vlist)_(after|start|count)$/.test(key)) params.delete(key);
}

function writeRange(params: URLSearchParams, page: ReadingPage) {
  if (page.after) params.set(`${page.param}_after`, page.after);
  if (page.start) params.set(`${page.param}_start`, page.start);
  params.set(`${page.param}_count`, String(page.count));
}

export function readingHref(search: string, page: ReadingPage, more: boolean, companion?: ReadingPage): string {
  const params = new URLSearchParams(search);
  clearReadingParams(params, page.param);
  const sharedLegacy = companion && params.has(page.legacyParam) && !["after", "start", "count"].some(suffix => params.has(`${companion.param}_${suffix}`));
  // An empty legacy section has no cursor. Keep its offset until it can be addressed independently.
  if (!sharedLegacy || companion.start) params.delete(page.legacyParam);
  if (sharedLegacy && companion.start) writeRange(params, companion);
  for (const key of ["review", "manage", "membersPage", "invitesPage", "notice"]) params.delete(key);
  if (more) {
    if (page.next) params.set(`${page.param}_after`, page.next);
  } else {
    writeRange(params, page);
  }
  const query = params.toString();
  return query ? `?${query}` : "";
}

export function appendReadingItems<T extends { id: number }>(current: T[], next: T[]): T[] {
  const seen = new Set(current.map(item => item.id));
  return [...current, ...next.filter(item => { if (seen.has(item.id)) return false; seen.add(item.id); return true; })];
}

export function readingLatestHref(search: string, page: ReadingPage, companion?: ReadingPage): string {
  const params = new URLSearchParams(readingHref(search, page, true, companion));
  clearReadingParams(params, page.param);
  if (params.has(page.legacyParam)) params.set(`${page.param}_count`, String(READING_BATCH));
  return params.size ? `?${params}` : "";
}
