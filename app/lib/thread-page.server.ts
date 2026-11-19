import { and, asc, count, eq, isNull, sql } from "drizzle-orm";
import type { SelectedFieldsFlat } from "drizzle-orm/pg-core";
import type { SelectResultFields } from "drizzle-orm/query-builders/select.types";
import type { Db } from "~/lib/db/client.server";
import { entries, profiles } from "~/lib/db/schema";
import { afterPageBoundary } from "~/lib/page-boundary.server";
import type { Pagination } from "~/lib/pagination";
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

// Count every slot on an unfiltered page before omitting unreferenced deletions.
// A stance filter instead defines a sequence of visible replies before paging.
export async function readThreadReplyPage<T extends SelectedFieldsFlat>(
  db: Db, threadId: number, { limit, offset }: Pagination, columns: T,
  opts: { stanceTag?: StanceTag; viewer?: Viewer } = {},
) {
  const filter = and(eq(entries.threadId, threadId), eq(entries.kind, "reply"),
    opts.stanceTag ? and(eq(entries.stanceTag, opts.stanceTag), isNull(entries.deletedAt), isNull(entries.hiddenAt)) : undefined);
  const order = [asc(entries.createdAt), asc(entries.id)];
  const boundary = offset ? db.select({ createdAt: entries.createdAt, id: entries.id }).from(entries)
    .where(filter).orderBy(...order).limit(1).offset(offset - 1) : undefined;
  const page = db.select({ id: entries.id, createdAt: entries.createdAt }).from(entries)
    .where(and(filter, afterPageBoundary([entries.createdAt, entries.id], boundary)))
    .orderBy(...order).limit(limit).as("thread_reply_page");
  const total = db.select({ replyTotal: count().as("reply_total") }).from(entries).where(filter).as("thread_reply_total");
  // A left join returns the count even for an empty page, in the same snapshot.
  const rows = await db.select({
    replyTotal: total.replyTotal,
    slot: { id: entries.id, ...visibilityColumns },
    retained: sql<boolean>`case when ${entries.deletedAt} is null then true else ${hasUndeletedReply()} end`,
    content: { id: entries.id, ...columns },
  }).from(total).leftJoin(page, sql`true`).leftJoin(entries, eq(entries.id, page.id))
    .leftJoin(profiles, eq(profiles.userId, entries.authorId)).orderBy(asc(page.createdAt), asc(page.id));
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
