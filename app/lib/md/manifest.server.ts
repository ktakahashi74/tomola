import { publicTopicPlace } from "~/lib/visibility.server";
import { createHash } from "node:crypto";
import { and, asc, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "~/lib/db/client.server";
import { entries } from "~/lib/db/schema";
import { mdUrl, threadCanonical } from "~/lib/md/urls.server";

// Manifest /manifest.json: each undeleted topic's Markdown URL, latest update time and content hash.
// Incremental synchronization: refetch topics whose hash changed. Ascending id, MANIFEST_LIMIT per page (?after=<topic-id>).
//
// content_hash definition, also documented in /llms.txt: hex SHA-256 of the thread's original-content state.
//   Includes topic and all replies, including deleted ones, ordered by id.
//   Input: UTF-8 lines 「<p|c>-<id> <state>\n」, one per post.
//   State is "deleted", "hidden" for moderation hiding, or current entries.source_hash for visible posts:
//   64-character hex SHA-256 of the source revision (title/body/language for new writes).
//   Visible rows append " lang:<language tag>" after the state and optional mark; alternatives append it after the title hash.
//   Reply rows with stance_tag append space and mark: 「<c>-<id> <state> <tag>」. Omit marks on deleted/hidden replies, matching Markdown twins.
//   For question threads, add a line per alternatives frontmatter entry (undeleted, unhidden alternative questions):
//   「alt p-<id> <title-SHA-256-in-hex>\n」, ascending id after thread rows. Omit when topic is hidden, since its twin is only a placeholder.
//   Thus changes for body/title edits, added replies, deletion, hiding/showing, reply-mark changes, and creating/retitling/hiding/showing/deleting/restoring alternatives,
//   but not new translations or votes. Exclude unnamed stance distributions.
//   Include hidden topics so importers can discard previously ingested content after reading a placeholder twin. Exclude deleted topics.
// updated_at: latest creation/edit/deletion/hide/show or metadata time (reply marks, alternatives list: meta_changed_at) across thread posts.
export const MANIFEST_LIMIT = 1000;

// Hex SHA-256 of alternative-question titles. Only titles occur in the original question's twin, so body edits do not change content_hash.
export const titleHash = (title: string): string => createHash("sha256").update(title, "utf8").digest("hex");

export type HashRow = { id: number; kind: string; deleted: boolean; hidden?: boolean; sourceHash: string | null; stanceTag?: string | null; lang?: string };
export type HashAlternative = { id: number; title: string; lang?: string };

export function contentHash(rows: readonly HashRow[], alternatives: readonly HashAlternative[] = []): string {
  const state = (r: HashRow) => (r.deleted ? "deleted" : r.hidden ? "hidden" : (r.sourceHash ?? "unknown"));
  const lines = [...rows]
    .sort((a, b) => a.id - b.id)
    .map((r) => `${r.kind === "topic" ? "p" : "c"}-${r.id} ${state(r)}${!r.deleted && !r.hidden && r.stanceTag ? ` ${r.stanceTag}` : ""}${!r.deleted && !r.hidden && r.lang ? ` lang:${r.lang}` : ""}\n`);
  const alts = [...alternatives].sort((a, b) => a.id - b.id).map((a) => `alt p-${a.id} ${titleHash(a.title)}${a.lang ? ` lang:${a.lang}` : ""}\n`);
  return createHash("sha256").update([...lines, ...alts].join("")).digest("hex");
}

export type Manifest = {
  generated_at: string;
  topics: Array<{ id: string; md: string; canonical: string; updated_at: string; content_hash: string }>;
  next: string | null;
};

export async function buildManifest(db: Db, opts: { after: number; k: string | null; now?: Date }): Promise<Manifest> {
  const topicRows = await db
    .select({ id: entries.id })
    .from(entries)
    .where(and(eq(entries.kind, "topic"), isNull(entries.deletedAt), gt(entries.id, opts.after), publicTopicPlace()))
    .orderBy(asc(entries.id))
    .limit(MANIFEST_LIMIT + 1);
  const hasMore = topicRows.length > MANIFEST_LIMIT;
  const ids = topicRows.slice(0, MANIFEST_LIMIT).map((t) => t.id);
  const rows =
    ids.length === 0
      ? []
      : await db
          .select({
            id: entries.id,
            kind: entries.kind,
            threadId: entries.threadId,
            sourceHash: entries.sourceHash,
            lang: entries.lang,
            deletedAt: entries.deletedAt,
            hiddenAt: entries.hiddenAt,
            changedAt: entries.changedAt,
            stanceTag: entries.stanceTag,
          })
          .from(entries)
          .where(inArray(sql`coalesce(${entries.threadId}, ${entries.id})`, ids));
  // Undeleted, unhidden alternative questions grouped by original question.
  const altRows =
    ids.length === 0
      ? []
      : await db
          .select({ id: entries.id, altOf: entries.altOf, title: entries.title, lang: entries.lang })
          .from(entries)
          .where(and(inArray(entries.altOf, ids), eq(entries.kind, "topic"), isNull(entries.deletedAt), isNull(entries.hiddenAt), publicTopicPlace()))
          .orderBy(desc(entries.id));
  const altsOf = new Map<number, HashAlternative[]>();
  for (const a of altRows) {
    const list = altsOf.get(a.altOf as number);
    const item = { id: a.id, title: a.title ?? "", lang: a.lang };
    if (list) list.push(item);
    else altsOf.set(a.altOf as number, [item]);
  }
  const byThread = new Map<number, typeof rows>();
  for (const r of rows) {
    const tid = r.threadId ?? r.id;
    const list = byThread.get(tid);
    if (list) list.push(r);
    else byThread.set(tid, [r]);
  }
  const topics = ids.map((id) => {
    const thread = byThread.get(id) ?? [];
    const updated = thread.reduce((max, r) => (r.changedAt > max ? r.changedAt : max), new Date(0));
    return {
      id: `p-${id}`,
      md: mdUrl(`/t/${id}.md`, { k: opts.k, lang: null }),
      canonical: threadCanonical(id),
      updated_at: updated.toISOString(),
      content_hash: contentHash(
        thread.map((r) => ({ id: r.id, kind: r.kind, deleted: r.deletedAt !== null, hidden: r.hiddenAt !== null, sourceHash: r.sourceHash, stanceTag: r.stanceTag, lang: r.lang })),
        // Hidden topic twins are placeholders, so omit the alternatives list.
        thread.some((r) => r.id === id && r.hiddenAt !== null) ? [] : (altsOf.get(id) ?? []),
      ),
    };
  });
  const next = hasMore ? mdUrl("/manifest.json", { k: opts.k, lang: null, extra: { after: String(ids.at(-1)) } }) : null;
  return { generated_at: (opts.now ?? new Date()).toISOString(), topics, next };
}
