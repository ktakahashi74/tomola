import { loadDisplayNames, displayNameFields } from "../display-names.server";
import { retainedAuthorColumn } from "../deleted-member.server";
import { authorLabel } from "../deleted-member";
import { and, asc, eq, gte, isNull, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "~/lib/db/client.server";
import { entries, profiles } from "~/lib/db/schema";
import { joinBlocks, mdBlock, yamlList, type FmValue } from "~/lib/md/frontmatter.server";
import { mdUrl, siteUrl, threadCanonical, twinPreamble } from "~/lib/md/urls.server";
import { versionOf } from "~/lib/md/thread.server";
import { pageCount, REPLIES_PER_PAGE } from "~/lib/pagination";

// Change feed (/changes.md?since=<ISO timestamp> or ?cursor=<timestamp>_<id>): posts created/edited/deleted since the boundary, without body; title/id/URL only.
// - Change time is the latest creation, edit, deletion, moderation-state change (hide/show, operator deletion/restore), or non-title/body metadata change (meta_changed_at: reply mark,
//   or alternative-question list). entries.changed_at is generated and indexed by (changed_at,id). since includes equal timestamps (>=).
// - cursor=<changed-at-ISO-with-milliseconds>_<post-id> returns only strictly later (time,id) changes. Pass response next_cursor unchanged
//   to continue without gaps/duplicates even when over 500 changes share a timestamp; timestamp-only since repeatedly returns the boundary and cannot advance.
//   With cursor, since is optional; if provided, also limit results to since or later.
// - Hidden posts return change:hidden with no title/author, a content-free location like deleted posts. Showing/restoring returns edited with content again.
// - Return at most CHANGES_LIMIT (500), newest first. For overflow, return the earliest 500 nearest since/cursor and has_more:true,
//   allowing gap-free cursor continuation; since continuation repeats boundary-timestamp changes.
// - End with next_since (latest returned timestamp; received since if empty), next_cursor (latest returned time/id; received cursor if empty), and
//   the continuation URL using cursor if available, otherwise since.
// - Omit replies to deleted topics: the topic appears as deleted.

export const CHANGES_LIMIT = 500;
export const DEFAULT_SINCE_DAYS = 7;

const ISO = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2}))?$/;

// ISO 8601 date (UTC midnight) or time with Z/+hh:mm timezone; otherwise null. Invalid dates such as February 30 or invalid times also return null.
// URL `+09:00` arrives with + decoded as space; restore + before parsing.
export function parseSince(raw: string): Date | null {
  const value = raw.replace(/ (\d{2}:\d{2})$/, "+$1");
  const m = ISO.exec(value);
  if (!m) return null;
  const [year, month, day, hour = 0, minute = 0, second = 0] = m.slice(1, 7).map((x) => (x === undefined ? 0 : Number(x)));
  const calendar = new Date(Date.UTC(year, month - 1, day));
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function defaultSince(now: Date = new Date()): Date {
  return new Date(now.getTime() - DEFAULT_SINCE_DAYS * 24 * 60 * 60 * 1000);
}

type ChangeKind = "created" | "edited" | "deleted" | "hidden";

export type Change = {
  kind: ChangeKind;
  entryKind: "topic" | "reply";
  id: number;
  threadId: number;
  title: string | null;
  lang: string;
  handle: string | null;
  changedAt: Date;
  sourceHash: string | null;
  // Reply position (1-based) in thread order (createdAt,id), including deleted replies, to find Markdown page. Topics return null.
  position: number | null;
};

const topic = alias(entries, "topic");

// Cursor: <changed-at-ISO-with-milliseconds>_<post-id>. App timestamps use JavaScript Date millisecond precision, so millisecond formatting exactly matches rows.
const CURSOR = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)_([1-9]\d{0,15})$/;

export type ChangeCursor = { at: Date; id: number };

export function parseCursor(raw: string): ChangeCursor | null {
  const m = CURSOR.exec(raw);
  if (!m) return null;
  const at = new Date(m[1]);
  const id = Number(m[2]);
  return Number.isNaN(at.getTime()) || at.toISOString() !== m[1] || !Number.isSafeInteger(id) ? null : { at, id };
}

export const formatCursor = (c: ChangeCursor): string => `${c.at.toISOString()}_${c.id}`;

// since includes timestamps at or after it; cursor includes strictly greater (time,id) pairs. Absent values add no filter.
export async function loadChanges(db: Db, opts: { since: Date | null; cursor?: ChangeCursor | null }): Promise<{ changes: Change[]; hasMore: boolean }> {
  const { since, cursor = null } = opts;
  // Classify created/edited by whether the creation/deletion event falls within the requested window (since inclusive, cursor exclusive). A later change after a previously received creation counts as edited.
  // Strictly after cursor compares (time,id); higher ids at the same timestamp have not yet been received.
  const inWindow = (time: Date, id: number) =>
    (since === null || time >= since) && (cursor === null || time > cursor.at || (time.getTime() === cursor.at.getTime() && id > cursor.id));
  const filters: SQL[] = [];
  if (since) filters.push(gte(entries.changedAt, since));
  if (cursor) filters.push(sql`(${entries.changedAt}, ${entries.id}) > (${cursor.at.toISOString()}::timestamptz, ${cursor.id})`);
  const rows = await db
    .select({
      id: entries.id,
      kind: entries.kind,
      threadId: entries.threadId,
      title: entries.title,
      lang: entries.lang,
      handle: retainedAuthorColumn(entries.authorId, profiles.handle, "handle"),
      createdAt: entries.createdAt,
      editedAt: entries.editedAt,
      deletedAt: entries.deletedAt,
      hiddenAt: entries.hiddenAt,
      sourceHash: entries.sourceHash,
      changedAt: entries.changedAt,
      // Thread Markdown pages contain 100 replies. Change links target the page containing the reply.
      position: sql<number | null>`case when ${entries.kind} = 'reply' then (select count(*) from entries as sibling where sibling.thread_id = ${entries.threadId} and sibling.kind = 'reply' and (sibling.created_at < ${entries.createdAt} or (sibling.created_at = ${entries.createdAt} and sibling.id <= ${entries.id})))::int end`,
    })
    .from(entries)
    .innerJoin(topic, eq(topic.id, sql`coalesce(${entries.threadId}, ${entries.id})`))
    .leftJoin(profiles, eq(profiles.userId, entries.authorId))
    .where(and(...filters, or(isNull(topic.deletedAt), eq(entries.id, topic.id))))
    .orderBy(asc(entries.changedAt), asc(entries.id))
    .limit(CHANGES_LIMIT + 1);
  const hasMore = rows.length > CHANGES_LIMIT;
  const changes = rows.slice(0, CHANGES_LIMIT).map((r): Change => {
    // Deleted posts always return deleted regardless of event-window membership, without title/author/version. Even if changed_at advances beyond deletion through metadata,
    // never return edited with content. Same rule for hidden posts.
    const kind: ChangeKind = r.deletedAt !== null ? "deleted" : r.hiddenAt !== null ? "hidden" : inWindow(r.createdAt, r.id) ? "created" : "edited";
    return {
      kind,
      entryKind: r.kind as Change["entryKind"],
      id: r.id,
      threadId: r.threadId ?? r.id,
      title: r.title,
      lang: r.lang,
      handle: r.handle,
      changedAt: r.changedAt,
      sourceHash: r.sourceHash,
      position: r.position === null ? null : Number(r.position),
    };
  });
  return { changes, hasMore };
}

const isoMs = (d: Date) => d.toISOString();

export async function buildChangesMarkdown(db: Db, opts: { since: Date | null; cursor?: ChangeCursor | null; k: string | null }): Promise<string> {
  const { since, cursor = null } = opts;
  const { changes, hasMore } = await loadChanges(db, { since, cursor });
  // Reverse oldest-first reads into newest-first output.
  const names = await loadDisplayNames(db, changes.filter(c => c.kind === "created" || c.kind === "edited").map(c => c.handle));
  const items = [...changes].reverse().map((c): { [key: string]: FmValue | undefined } => {
    const base = {
      change: c.kind,
      id: `${c.entryKind === "topic" ? "p" : "c"}-${c.id}`,
      thread: `p-${c.threadId}`,
      changed_at: isoMs(c.changedAt),
      md: mdUrl(`/t/${c.threadId}.md`, { k: opts.k, lang: null, page: c.position === null ? 1 : pageCount(c.position, REPLIES_PER_PAGE) }),
      canonical: threadCanonical(c.threadId),
    };
    // Deleted/hidden posts omit title/author as well as body.
    if (c.kind === "deleted" || c.kind === "hidden") return base;
    return {
      ...base,
      // No title key for a topic without a title (and for a reply).
      title: c.entryKind === "topic" ? (c.title ?? undefined) : undefined,
      lang: c.lang,
      author: authorLabel(c.handle),
      ...displayNameFields(names.get(c.handle ?? "")),
      version: versionOf(c.sourceHash) ?? undefined,
    };
  });
  const last = changes.at(-1);
  // Next position is the latest returned change; if empty, preserve received since/cursor.
  const nextSince = last?.changedAt ?? since;
  const nextCursor: ChangeCursor | null = last ? { at: last.changedAt, id: last.id } : cursor;
  // Continuation URL prefers cursor to advance without repeating changes, otherwise since.
  const next = nextCursor
    ? mdUrl("/changes.md", { k: opts.k, lang: null, extra: { cursor: formatCursor(nextCursor) } })
    : mdUrl("/changes.md", { k: opts.k, lang: null, extra: { since: isoMs(nextSince ?? new Date(0)) } });
  const header = mdBlock(
    {
      type: "index",
      title: "Changes",
      since: since ? isoMs(since) : undefined,
      cursor: cursor ? formatCursor(cursor) : undefined,
      limit: CHANGES_LIMIT,
      canonical: siteUrl("/latest"),
      content_trust: "untrusted_user_content",
    },
    null,
    { preamble: twinPreamble() },
  );
  const body = items.length === 0 ? "No changes.\n" : yamlList(items);
  const footer = mdBlock(
    {
      type: "index",
      count: items.length,
      next_since: nextSince ? isoMs(nextSince) : undefined,
      next_cursor: nextCursor ? formatCursor(nextCursor) : undefined,
      has_more: hasMore,
      next,
      content_trust: "untrusted_user_content",
    },
    `Next: ${next}`,
  );
  return joinBlocks([header, body, footer]);
}
