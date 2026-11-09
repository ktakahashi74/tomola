import { and, desc, eq, isNull } from "drizzle-orm";
import type { Db } from "~/lib/db/client.server";
import { entries, profiles, savedTopics } from "~/lib/db/schema";
import { retainedAuthorColumn } from "~/lib/deleted-member.server";
import { visibleTo, type TopicPage } from "~/lib/entries.server";
import type { Lang } from "~/lib/languages";
import { checkPagination } from "~/lib/pagination";
import type { Viewer } from "~/lib/roles.server";
import { publicTopicPlace } from "~/lib/visibility.server";

export async function isTopicSaved(db: Db, userId: string, topicId: number): Promise<boolean> {
  const [row] = await db.select({ id: savedTopics.topicId }).from(savedTopics)
    .where(and(eq(savedTopics.userId, userId), eq(savedTopics.topicId, topicId)));
  return !!row;
}

// Explicit target states make duplicate requests harmless. Unsave never looks
// up the post: losing access must not prevent erasing one's own private record.
export async function setTopicSaved(db: Db, userId: string, topicId: number, saved: boolean, opts: { viewer?: Viewer; now?: Date } = {}) {
  if (!saved) {
    await db.delete(savedTopics).where(and(eq(savedTopics.userId, userId), eq(savedTopics.topicId, topicId)));
    return { ok: true as const, saved: false };
  }
  const viewer = opts.viewer?.userId === userId ? opts.viewer : undefined;
  const [topic] = await db.select({ id: entries.id }).from(entries).where(and(
    eq(entries.id, topicId), eq(entries.kind, "topic"), isNull(entries.deletedAt), publicTopicPlace(), visibleTo(viewer),
  ));
  if (!topic) return { ok: false as const, error: "not_found" as const };
  await db.insert(savedTopics).values({ userId, topicId, createdAt: opts.now ?? new Date() })
    .onConflictDoNothing({ target: [savedTopics.userId, savedTopics.topicId] });
  return { ok: true as const, saved: true };
}

export async function listSavedTopics(db: Db, userId: string, opts: { page?: number; limit?: number; viewer?: Viewer } = {}): Promise<TopicPage> {
  const { page, limit, offset } = checkPagination(opts);
  const viewer = opts.viewer?.userId === userId ? opts.viewer : undefined;
  const rows = await db.select({
    id: entries.id, lang: entries.lang, title: entries.title, sourceHash: entries.sourceHash,
    authorId: entries.authorId, authorHandle: retainedAuthorColumn(entries.authorId),
    replyCount: entries.replyCount, createdAt: entries.createdAt, lastActivityAt: entries.lastActivityAt,
    hiddenAt: entries.hiddenAt, asksStance: entries.asksStance,
  }).from(savedTopics).innerJoin(entries, eq(entries.id, savedTopics.topicId))
    .leftJoin(profiles, eq(profiles.userId, entries.authorId))
    .where(and(eq(savedTopics.userId, userId), eq(entries.kind, "topic"), isNull(entries.deletedAt), publicTopicPlace(), visibleTo(viewer)))
    .orderBy(desc(savedTopics.createdAt), desc(savedTopics.topicId)).limit(limit + 1).offset(offset);
  return { page, limit, hasNext: rows.length > limit, topics: rows.slice(0, limit).map(row => ({
    ...row, lang: row.lang as Lang, authorHandle: row.authorHandle ?? "?", hidden: row.hiddenAt !== null,
  })) };
}
