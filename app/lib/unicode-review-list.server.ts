import { enabledLangs } from "./enabled-langs.server";
import { or, notInArray, and, desc, gte, inArray, lt, ne, sql } from "drizzle-orm";
import type { Db } from "~/lib/db/client.server";
import { entries } from "~/lib/db/schema";
import { isSourceLang, type SourceLang } from "~/lib/languages";
import type { ModScope } from "~/lib/roles.server";
import { rootTopic, rootTopicOn, visibleWithTopic } from "~/lib/visibility.server";
import { unicodeReviewCounts, UNICODE_REVIEW_DAYS, UNICODE_REVIEW_PAGE_SIZE, UNICODE_REVIEW_SCAN_LIMIT, type UnicodeReviewCounts } from "~/lib/unicode-review";

// Moderator list of public posts and replies whose original title or body match a rule of lib/unicode-review.ts (a candidate for a person
// to check, never an automatic action). Nothing is stored: each request reads the newest rows in range and judges them with the same
// function the Markdown twins use. Only posts readable to anyone (not deleted, not hidden, topic neither deleted nor hidden, public place)
// are looked at; chat, closed villages and member-only places are not. The moderator's own posts are left out, as in the report list.

// The window (30 days), the matches shown per request (50) and the rows read per request (500; a request that reaches it says so and offers the rest) are in lib/unicode-review.ts.

export type UnicodeReviewItem = { entryId: number; kind: "topic" | "reply"; threadId: number; lang: SourceLang; counts: UnicodeReviewCounts };
export type UnicodeReviewPage = {
  items: UnicodeReviewItem[];
  // The request stopped before the end of the range (500 rows read, or 50 matches shown); `cursor` continues from there.
  cursor: string | null;
  // 500 rows were read: the rows after the cursor have not been looked at, which is not the same as no match.
  scanLimited: boolean;
};

// "<updated-at to the microsecond, UTC>_<id>" of the last row read; the next request continues with older rows. The time keeps full
// precision (not milliseconds) so that rows closer together than a millisecond are neither read twice nor skipped.
const CURSOR = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z)_([1-9]\d{0,15})$/;
export type UnicodeReviewCursor = { at: string; id: number };
export function parseUnicodeReviewCursor(raw: string | null): UnicodeReviewCursor | null {
  const m = raw ? CURSOR.exec(raw) : null;
  if (!m || Number.isNaN(Date.parse(m[1]))) return null;
  return { at: m[1], id: Number(m[2]) };
}

export async function listUnicodeReviewCandidates(
  db: Db,
  scope: ModScope,
  opts: { viewerId?: string; cursor?: UnicodeReviewCursor | null; now?: Date } = {},
): Promise<UnicodeReviewPage> {
  if (!scope.operator && scope.langs.length === 0) return { items: [], cursor: null, scanLimited: false };
  const since = new Date((opts.now ?? new Date()).getTime() - UNICODE_REVIEW_DAYS * 24 * 60 * 60 * 1000);
  const after = opts.cursor
    ? or(sql`${entries.changedAt} < ${opts.cursor.at}::timestamptz`, and(sql`${entries.changedAt} = ${opts.cursor.at}::timestamptz`, lt(entries.id, opts.cursor.id)))
    : undefined;
  const rows = await db
    .select({ id: entries.id, kind: entries.kind, threadId: entries.threadId, lang: entries.lang, title: entries.title, body: entries.body, cursorAt: sql<string>`to_char(${entries.changedAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')` })
    .from(entries)
    .innerJoin(rootTopic, rootTopicOn())
    .where(and(
      visibleWithTopic(),
      gte(entries.changedAt, since),
      scope.operator ? undefined : or(inArray(entries.lang, [...scope.langs]), notInArray(entries.lang, [...enabledLangs()])),
      opts.viewerId ? ne(entries.authorId, opts.viewerId) : undefined,
      after,
    ))
    .orderBy(desc(entries.changedAt), desc(entries.id))
    .limit(UNICODE_REVIEW_SCAN_LIMIT + 1);
  const scanned = rows.slice(0, UNICODE_REVIEW_SCAN_LIMIT);
  const items: UnicodeReviewItem[] = [];
  let last = scanned.at(-1);
  for (const row of scanned) {
    const counts = unicodeReviewCounts(row.title, row.body);
    if (Object.keys(counts).length === 0 || !isSourceLang(row.lang)) continue;
    items.push({ entryId: row.id, kind: row.kind as "topic" | "reply", threadId: row.threadId ?? row.id, lang: row.lang, counts });
    if (items.length === UNICODE_REVIEW_PAGE_SIZE) { last = row; break; }
  }
  const moreRowsExist = rows.length > scanned.length || last !== scanned.at(-1);
  const scanLimited = rows.length > UNICODE_REVIEW_SCAN_LIMIT && last === scanned.at(-1);
  return { items, cursor: moreRowsExist && last ? `${last.cursorAt}_${last.id}` : null, scanLimited };
}
