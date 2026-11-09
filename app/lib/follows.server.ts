import { publicTopicPlace } from "~/lib/visibility.server";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "~/lib/db/client.server";
import { entries, follows, notifications } from "~/lib/db/schema";
import type { FollowState } from "~/lib/follows";
import { canSeeHidden, type Viewer } from "~/lib/roles.server";

// Shared by the followed-post list and its navigation dot. A leftover unread
// notification never restores a follow or makes an unreadable post appear.
export function unreadFollowedTopicCondition(db: Db, userId: string) {
  return and(
    eq(entries.kind, "topic"), isNull(entries.hiddenAt), isNull(entries.deletedAt), publicTopicPlace(),
    inArray(entries.id, db.select({ id: follows.threadId }).from(follows).where(and(eq(follows.userId, userId), eq(follows.state, "following")))),
    inArray(entries.id, db.select({ id: notifications.threadId }).from(notifications).where(and(eq(notifications.userId, userId), eq(notifications.kind, "followed_thread"), isNull(notifications.readAt)))),
  );
}

// Following a topic.
// - Automatic: a member follows the topics they create and the topics they reply to, in the same transaction as the post (autoFollow). A topic the member took off
//   (`unfollowed`) is never followed again automatically. Choosing a stance, voting and editing do not follow, and there is no backfill.
// - By hand: setFollow (the thread page, POST /follow).
// - Members are not followed, and the number of followers is shown nowhere.

export async function getFollowState(db: Db, userId: string, threadId: number): Promise<FollowState | null> {
  const [row] = await db
    .select({ state: follows.state })
    .from(follows)
    .where(and(eq(follows.userId, userId), eq(follows.threadId, threadId)));
  return (row?.state as FollowState | undefined) ?? null;
}

// Follow or unfollow a topic (a thread or a question) by hand. The topic must exist and not be deleted. Following also needs a topic the viewer may see (a hidden topic
// is visible to its author, the moderators of its language and the operator). Unfollowing a hidden topic works only when the member already has a row for it
// (so the answer does not tell a member who cannot see the topic that it exists). A reply's id is not a topic: not_found.
export async function setFollow(
  db: Db,
  userId: string,
  threadId: number,
  follow: boolean,
  opts: { now?: Date; viewer?: Viewer } = {},
): Promise<{ ok: true; state: FollowState } | { ok: false; error: "not_found" }> {
  const now = opts.now ?? new Date();
  const [topic] = await db
    .select({ authorId: entries.authorId, lang: entries.lang, hiddenAt: entries.hiddenAt })
    .from(entries)
    .where(and(eq(entries.id, threadId), eq(entries.kind, "topic"), isNull(entries.deletedAt), publicTopicPlace()));
  if (!topic) return { ok: false, error: "not_found" };
  const viewer = opts.viewer?.userId === userId ? opts.viewer : undefined;
  if (topic.hiddenAt && !canSeeHidden(viewer, topic)) {
    if (follow) return { ok: false, error: "not_found" };
    if ((await getFollowState(db, userId, threadId)) === null) return { ok: false, error: "not_found" };
  }
  const state: FollowState = follow ? "following" : "unfollowed";
  await db
    .insert(follows)
    .values({ userId, threadId, state, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({ target: [follows.userId, follows.threadId], set: { state, updatedAt: now } });
  return { ok: true, state };
}

// The automatic follow. Call it in the transaction that creates the topic or the reply. Creates the row as `following` when there is none; an existing row
// (`following`, or `unfollowed` that the member chose) is left as it is. The unique key makes it safe against a concurrent setFollow of the same (member, topic):
// whichever commits last wins, and a manual choice that commits first is never overwritten by this. Returns whether a new follow was inserted.
export async function autoFollow(tx: Db, userId: string, threadId: number, now: Date): Promise<boolean> {
  const inserted = await tx
    .insert(follows)
    .values({ userId, threadId, state: "following", createdAt: now, updatedAt: now })
    .onConflictDoNothing({ target: [follows.userId, follows.threadId] })
    .returning({ userId: follows.userId });
  return inserted.length > 0;
}

// The members who follow the topic now, in ascending user id (the order the notifications are made in: see notifyForNewEntry).
export async function followerIds(tx: Db, threadId: number): Promise<string[]> {
  const rows = await tx
    .select({ userId: follows.userId })
    .from(follows)
    .where(and(eq(follows.threadId, threadId), eq(follows.state, "following")))
    .orderBy(asc(follows.userId));
  return rows.map((r) => r.userId);
}

// Mark as read the viewer's unread followed_thread notification of the topic (called when the viewer opens the topic page), so that merging does not continue
// after the member has read the topic. Returns how many rows it marked (0 or 1). Reply and mention notifications are left for the member to mark by hand.
export async function markFollowedThreadRead(db: Db, userId: string, threadId: number, now: Date): Promise<number> {
  const rows = await db
    .update(notifications)
    .set({ readAt: now })
    .where(and(eq(notifications.userId, userId), eq(notifications.threadId, threadId), eq(notifications.kind, "followed_thread"), isNull(notifications.readAt)))
    .returning({ id: notifications.id });
  return rows.length;
}
