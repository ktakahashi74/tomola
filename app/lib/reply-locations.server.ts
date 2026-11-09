import { retainedAuthorColumn } from "./deleted-member.server";
import { and, asc, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "~/lib/db/client.server";
import { entries, notifications, profiles } from "~/lib/db/schema";
import { replyLocationAt } from "~/lib/entries.server";
import { pageCount, REPLIES_PER_PAGE } from "~/lib/pagination";
import { canSeeHidden, type Viewer } from "~/lib/roles.server";
import type { Lang } from "~/lib/languages";
import { notificationColumns } from "~/lib/village-chat-notifications.server";

// Rank all replies before excluding withheld content: deleted and hidden replies
// still occupy positions in the thread. One query covers every topic on a page.
export async function loadLatestReplyLocations(db: Db, threadIds: readonly number[]): Promise<Map<number, { id: number; page: number }>> {
  if (threadIds.length === 0) return new Map();
  const ranked = db.select({
    id: entries.id,
    threadId: entries.threadId,
    deletedAt: entries.deletedAt,
    hiddenAt: entries.hiddenAt,
    position: sql<number>`row_number() over (partition by ${entries.threadId} order by ${entries.createdAt}, ${entries.id})`.as("position"),
  }).from(entries).where(and(eq(entries.kind, "reply"), inArray(entries.threadId, [...threadIds]))).as("ranked");
  const rows = await db.selectDistinctOn([ranked.threadId], { id: ranked.id, threadId: ranked.threadId, position: ranked.position })
    .from(ranked).where(and(isNull(ranked.deletedAt), isNull(ranked.hiddenAt)))
    .orderBy(ranked.threadId, desc(ranked.position));
  return new Map(rows.map(row => [row.threadId!, { id: row.id, page: pageCount(Number(row.position), REPLIES_PER_PAGE) }]));
}

export type ReplyTarget = { state: "visible"; href: string; authorHandle: string } | { state: "deleted" | "unavailable" };

// Rank before filtering: withheld replies still occupy their original pages.
// Only a readable target gets a location and public handle; withheld targets expose neither.
export async function loadReplyLocations(db: Db, threadIds: number[], ids: number[], opts: { viewer?: Viewer; lang?: string | null } = {}): Promise<Map<number, ReplyTarget>> {
  if (!threadIds.length || !ids.length) return new Map();
  const ranked = db.select({
    id: entries.id, threadId: entries.threadId, authorId: entries.authorId, lang: entries.lang,
    deletedAt: entries.deletedAt, hiddenAt: entries.hiddenAt,
    position: sql<number>`row_number() over (partition by ${entries.threadId} order by ${entries.createdAt}, ${entries.id})`.as("position"),
  }).from(entries).where(and(eq(entries.kind, "reply"), inArray(entries.threadId, threadIds))).as("ranked");
  const rows = await db.select({ id: ranked.id, threadId: ranked.threadId, authorId: ranked.authorId, lang: ranked.lang, deletedAt: ranked.deletedAt, hiddenAt: ranked.hiddenAt, position: ranked.position, authorHandle: retainedAuthorColumn(ranked.authorId) }).from(ranked).leftJoin(profiles, eq(profiles.userId, ranked.authorId)).where(inArray(ranked.id, ids));
  return new Map(rows.map(row => [row.id, row.deletedAt
    ? { state: "deleted" }
    : row.hiddenAt && !canSeeHidden(opts.viewer, row)
      ? { state: "unavailable" }
      : { state: "visible", authorHandle: row.authorHandle ?? "?", href: replyLocationAt(row.threadId!, row.id, pageCount(Number(row.position), REPLIES_PER_PAGE), { lang: opts.lang }) }]));
}

type FollowedRow = { id: number; threadId: number | null; entryId: number | null; firstEntryId: number | null };

// The same destination for the notification, its mail, and the following card.
export async function followedThreadHrefs(db: Db, rows: readonly FollowedRow[]): Promise<Map<number, string>> {
  const threadIds = [...new Set(rows.flatMap(r => r.threadId === null ? [] : [r.threadId]))];
  const ids = rows.flatMap(r => [r.firstEntryId, r.entryId].filter((id): id is number => id !== null));
  if (!threadIds.length) return new Map();
  const topics = await db.select({ id: entries.id }).from(entries).where(and(
    inArray(entries.id, threadIds), eq(entries.kind, "topic"), isNull(entries.deletedAt), isNull(entries.hiddenAt),
  ));
  const readable = new Set(topics.map(t => t.id));
  const locations = await loadReplyLocations(db, threadIds, ids);
  // If the first notified reply was withheld, find the next readable reply in
  // that notification's range instead of skipping straight to its last reply.
  // The recipient's own replies never count as new replies for them.
  const first = alias(entries, "first_unread");
  const last = alias(entries, "last_unread");
  const ranges = rows.filter(r => readable.has(r.threadId!) && r.firstEntryId !== null && r.entryId !== null && locations.get(r.firstEntryId)?.state !== "visible");
  const candidates = ranges.length ? await db.selectDistinctOn([notifications.id], { notice: notifications.id, id: entries.id, threadId: entries.threadId })
    .from(notifications)
    .innerJoin(first, and(eq(first.id, notifications.firstEntryId), eq(first.threadId, notifications.threadId)))
    .innerJoin(last, and(eq(last.id, notifications.entryId), eq(last.threadId, notifications.threadId)))
    .innerJoin(entries, and(eq(entries.threadId, first.threadId), eq(entries.kind, "reply"), ne(entries.authorId, notifications.userId), isNull(entries.deletedAt), isNull(entries.hiddenAt),
      sql`(${entries.createdAt}, ${entries.id}) >= (${first.createdAt}, ${first.id})`,
      sql`(${entries.createdAt}, ${entries.id}) <= (${last.createdAt}, ${last.id})`))
    .where(or(...ranges.map(r => and(eq(notifications.id, r.id), eq(first.id, r.firstEntryId!), eq(last.id, r.entryId!), eq(first.threadId, r.threadId!)))))
    .orderBy(notifications.id, asc(entries.createdAt), asc(entries.id)) : [];
  const earliest = new Map(candidates.map(r => [r.notice, r.id]));
  if (candidates.length) for (const [id, target] of await loadReplyLocations(db, [...new Set(candidates.map(r => r.threadId!))], candidates.map(r => r.id))) locations.set(id, target);
  const out = new Map<number, string>();
  for (const row of rows) {
    if (row.threadId === null || !readable.has(row.threadId)) continue;
    let href = `/t/${row.threadId}`;
    for (const id of [earliest.get(row.id) ?? row.firstEntryId, row.entryId]) {
      const target = id === null ? undefined : locations.get(id);
      if (target?.state === "visible" && target.href.split(/[?#]/, 1)[0] === `/t/${row.threadId}`) {
        href = target.href;
        break;
      }
    }
    out.set(row.id, href);
  }
  return out;
}

export async function loadFollowedNewReplies(db: Db, userId: string, threadIds: number[]): Promise<Map<number, { count: number; href: string }>> {
  if (!threadIds.length) return new Map();
  const rows = await db.select(notificationColumns(false)).from(notifications).where(and(eq(notifications.userId, userId),
    eq(notifications.kind, "followed_thread"), isNull(notifications.readAt), inArray(notifications.threadId, threadIds)));
  const hrefs = await followedThreadHrefs(db, rows);
  return new Map(rows.flatMap(row => {
    const href = hrefs.get(row.id);
    return href ? [[row.threadId!, { count: row.mergedCount, href }] as const] : [];
  }));
}
