import { and, count, eq, inArray, isNull, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import type { SelectedFieldsFlat } from "drizzle-orm/pg-core";
import type { SelectResultFields } from "drizzle-orm/query-builders/select.types";
import type { Db } from "~/lib/db/client.server";
import { entries, profiles } from "~/lib/db/schema";
import { afterPageBoundary } from "~/lib/page-boundary.server";
import { pageCount, REPLIES_PER_PAGE, type Pagination } from "~/lib/pagination";
import { hasUndeletedReply } from "~/lib/reply-placeholders.server";
import { canSeeHidden, type Viewer } from "~/lib/roles.server";
import type { StanceTag } from "~/lib/stances";

// Hidden content is shown only to an authorized screen viewer. Both redacted
// states retain the reply's location while withholding its content.
export type EntryVisibility = "visible" | "hidden" | "hidden-redacted" | "deleted";

const visibilityColumns = {
  authorId: entries.authorId,
  lang: entries.lang,
  hiddenAt: entries.hiddenAt,
  deletedAt: entries.deletedAt,
};

export function entryVisibility(row: { authorId: string; lang: string; hiddenAt: Date | null; deletedAt: Date | null }, viewer?: Viewer): EntryVisibility {
  if (row.deletedAt !== null) return "deleted";
  if (row.hiddenAt === null) return "visible";
  return canSeeHidden(viewer, row) ? "hidden" : "hidden-redacted";
}

function replySlots(threads: SQL, stanceTag?: StanceTag) {
  return and(threads, eq(entries.kind, "reply"),
    stanceTag ? and(eq(entries.stanceTag, stanceTag), isNull(entries.deletedAt), isNull(entries.hiddenAt)) : undefined);
}

function replyOrderColumns<Time extends SQLWrapper, Id extends SQLWrapper>(row: { createdAt: Time; id: Id }) {
  return { createdAt: row.createdAt, id: row.id };
}

// Apply target and visibility predicates outside this sequence so withheld replies
// still occupy their slots. Only an explicit stance filter changes the sequence.
export function rankedThreadReplies(db: Db, threads: SQL, stanceTag?: StanceTag) {
  return db.select({
    id: entries.id,
    threadId: entries.threadId,
    ...visibilityColumns,
    createdAt: entries.createdAt,
    stanceTag: entries.stanceTag,
    position: sql<number>`row_number() over (partition by ${entries.threadId} order by ${sql.join(Object.values(replyOrderColumns(entries)), sql`, `)})`.mapWith(Number).as("position"),
  }).from(entries).where(replySlots(threads, stanceTag)).as("ranked_thread_replies");
}

export function replyPageAt(position: number | null, limit = REPLIES_PER_PAGE): number {
  return position === null ? 1 : pageCount(position, limit);
}

export async function replyPagesOf(
  db: Db, targets: readonly { threadId: number; id: number }[], opts: { limit?: number; stanceTag?: StanceTag } = {},
): Promise<Map<number, number>> {
  if (!targets.length) return new Map();
  const expected = new Map(targets.map(t => [t.id, t.threadId]));
  const ranked = rankedThreadReplies(db, inArray(entries.threadId, [...new Set(targets.map(t => t.threadId))]), opts.stanceTag);
  const rows = await db.select({ id: ranked.id, threadId: ranked.threadId, position: ranked.position })
    .from(ranked).where(inArray(ranked.id, [...expected.keys()]));
  return new Map(rows.filter(r => expected.get(r.id) === r.threadId).map(r => [r.id, replyPageAt(r.position, opts.limit)]));
}

// Count every slot on an unfiltered page before omitting unreferenced deletions.
// A stance filter instead defines a sequence of visible replies before paging.
export async function readThreadReplyPage<T extends SelectedFieldsFlat>(
  db: Db, threadId: number, { limit, offset }: Pagination, columns: T,
  opts: { stanceTag?: StanceTag; viewer?: Viewer } = {},
) {
  const filter = replySlots(eq(entries.threadId, threadId), opts.stanceTag);
  const orderColumns = replyOrderColumns(entries);
  const keys = Object.values(orderColumns);
  const boundary = offset ? db.select(orderColumns).from(entries)
    .where(filter).orderBy(...keys).limit(1).offset(offset - 1) : undefined;
  const page = db.select(orderColumns).from(entries)
    .where(and(filter, afterPageBoundary(keys, boundary)))
    .orderBy(...keys).limit(limit).as("thread_reply_page");
  const total = db.select({ replyTotal: count().as("reply_total") }).from(entries).where(filter).as("thread_reply_total");
  // A left join returns the count even for an empty page, in the same snapshot.
  const rows = await db.select({
    replyTotal: total.replyTotal,
    slot: { id: entries.id, ...visibilityColumns },
    retained: sql<boolean>`case when ${entries.deletedAt} is null then true else ${hasUndeletedReply()} end`,
    content: { id: entries.id, ...columns },
  }).from(total).leftJoin(page, sql`true`).leftJoin(entries, eq(entries.id, page.id))
    .leftJoin(profiles, eq(profiles.userId, entries.authorId)).orderBy(...Object.values(replyOrderColumns(page)));
  return {
    replyTotal: rows[0].replyTotal,
    replies: rows.flatMap(({ slot, retained, content }) => {
      if (!slot || !retained) return [];
      // The slot and projected fields come from the same joined entry. The
      // entry ID guarantees the content projection is present on this row.
      const projected = content as SelectResultFields<T>;
      return [{ ...projected, ...slot, visibility: entryVisibility(slot, opts.viewer) }];
    }),
  };
}
