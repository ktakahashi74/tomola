import { siteUrl } from "./site-url";
import { and, desc, eq, gte, ne, sql } from "drizzle-orm";
import type { Db } from "./db/client.server";
import { chatMessages, chatReportSnapshots, entries, moderationActions, notifications, profiles, reports } from "./db/schema";
import { ABUSE_THRESHOLDS, scoreAbuse } from "./abuse";
import { enqueue } from "./jobs/queue.server";
import { lockEntry, closeOpenReports } from "./moderation.server";
import { purgeEmbeddings } from "./embeddings.server";
import { touchAltOriginal } from "./questions.server";
import { touchReferenceTopics } from "./related-discussions.server";
import { createModerationNotification } from "./notifications.server";
import { spamEnabled, aiSpamEnabled, triageEnabled } from "./moderation-ai-config.server";

// Serialize the history check with writes by this author, across topics and chat villages.
export async function lockAbuseWriter(db: Db, authorId: string) {
  if (spamEnabled()) await db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`moderation-writer:${authorId}`}, 0))`);
}
export async function enqueueReportTriage(db: Db, reportId: number) {
  if (triageEnabled()) await enqueue(db, "moderation_triage", { reportId }, { dedupeKey: `moderation-triage:${reportId}` });
}

// Caller holds the entry/topic locks. A source hash prevents delayed verdicts hiding an edited post.
export async function automaticallyHideEntry(db: Db, id: number, note: string, now: Date, sourceHash?: string) {
  const entry = await lockEntry(db, id);
  if (!entry || entry.deletedAt || entry.hiddenAt || sourceHash !== undefined && entry.sourceHash !== sourceHash) return false;
  // A human review protects that source revision from a queued verdict. A later author edit is inspected again.
  const [reviewed] = await db.select({ id: moderationActions.id }).from(moderationActions).innerJoin(entries, eq(entries.id, moderationActions.targetEntryId)).where(and(eq(moderationActions.targetEntryId, id), eq(moderationActions.automatic, false), gte(moderationActions.createdAt, entries.updatedAt))).limit(1);
  if (reviewed) return false;
  const [action] = await db.insert(moderationActions).values({ action: "hide", targetEntryId: id, reason: "spam", note, actorId: null, automatic: true, createdAt: now }).returning({ id: moderationActions.id });
  await db.update(entries).set({ hiddenAt: now, moderatedAt: now, moderationActionId: action.id }).where(eq(entries.id, id));
  await touchAltOriginal(db, id, now);
  await touchReferenceTopics(db, id, now);
  await closeOpenReports(db, id, "resolved", null, now);
  await purgeEmbeddings(db, id);
  await createModerationNotification(db, { userId: entry.authorId, entryId: id, actionId: action.id, now });
  return true;
}

export async function inspectEntrySpam(db: Db, entry: { id: number; authorId: string; body: string; sourceHash: string | null }, now: Date) {
  if (!spamEnabled()) return false;
  const since = new Date(now.getTime() - ABUSE_THRESHOLDS.windowMs);
  const duplicateSince = new Date(now.getTime() - ABUSE_THRESHOLDS.duplicateWindowMs);
  const previous = await db.select({ body: entries.body, createdAt: entries.createdAt }).from(entries).where(and(eq(entries.authorId, entry.authorId), ne(entries.id, entry.id), gte(entries.createdAt, duplicateSince))).orderBy(desc(entries.createdAt), desc(entries.id)).limit(ABUSE_THRESHOLDS.history);
  const signal = scoreAbuse({ body: entry.body, previous: previous.map(r => r.body), recentCount: previous.filter(r => r.createdAt >= since).length + 1, ownOrigin: new URL(siteUrl()).origin });
  if (signal.score >= ABUSE_THRESHOLDS.hide) return automaticallyHideEntry(db, entry.id, `spam: ${signal.signals.join(", ")}`, now);
  if (aiSpamEnabled() && entry.sourceHash) {
    const [count] = await db.select({ n: sql<number>`count(*)`.mapWith(Number) }).from(entries).where(eq(entries.authorId, entry.authorId));
    if (signal.score >= ABUSE_THRESHOLDS.suspicious || signal.links > 0 && count.n < ABUSE_THRESHOLDS.newAuthorPosts) {
      await enqueue(db, "moderation_spam", { entryId: entry.id, sourceHash: entry.sourceHash }, { dedupeKey: `moderation-spam:${entry.id}:${entry.sourceHash}` });
    }
  }
  return false;
}

// No AI calls or AI jobs: private chat spam uses only local signals.
// Called inside the writing transaction. Remove pending mention notifications before commit.
export async function inspectChatSpam(db: Db, message: typeof chatMessages.$inferSelect, now: Date) {
  if (!spamEnabled()) return false;
  const since = new Date(now.getTime() - ABUSE_THRESHOLDS.windowMs);
  const duplicateSince = new Date(now.getTime() - ABUSE_THRESHOLDS.duplicateWindowMs);
  const previous = await db.select({ body: chatMessages.body, createdAt: chatMessages.createdAt }).from(chatMessages).where(and(eq(chatMessages.authorId, message.authorId), ne(chatMessages.id, message.id), gte(chatMessages.createdAt, duplicateSince))).orderBy(desc(chatMessages.createdAt), desc(chatMessages.createdSeq)).limit(ABUSE_THRESHOLDS.history);
  const signal = scoreAbuse({ body: message.body, previous: previous.map(r => r.body), recentCount: previous.filter(r => r.createdAt >= since).length + 1, ownOrigin: new URL(siteUrl()).origin, chat: true });
  if (signal.score < ABUSE_THRESHOLDS.hide || message.hiddenAt || message.deletedAt) return false;
  const [author] = await db.select({ handle: profiles.handle }).from(profiles).where(eq(profiles.userId, message.authorId));
  // An automatic action's appeal must show the revision that triggered hiding.
  const snapshot = { body: message.body, lang: message.lang, authorId: message.authorId, authorHandle: author?.handle ?? "", messageCreatedAt: message.createdAt, createdSeq: message.createdSeq, changedSeq: message.changedSeq, capturedAt: now, prunedAt: null };
  await db.insert(chatReportSnapshots).values({ messageId: message.id, ...snapshot }).onConflictDoUpdate({ target: chatReportSnapshots.messageId, set: snapshot });
  const [action] = await db.insert(moderationActions).values({ action: "hide_chat", targetChatMessageId: message.id, reason: "spam", note: `spam: ${signal.signals.join(", ")}`, actorId: null, automatic: true, createdAt: now }).returning({ id: moderationActions.id });
  await db.update(chatMessages).set({ hiddenAt: now }).where(eq(chatMessages.id, message.id));
  await db.update(reports).set({ status: "resolved", handledBy: null, handledAt: now }).where(and(eq(reports.chatMessageId, message.id), eq(reports.status, "open")));
  await db.delete(notifications).where(eq(notifications.chatMessageId, message.id));
  await createModerationNotification(db, { userId: message.authorId, entryId: null, villageId: message.villageId, actionId: action.id, now });
  return true;
}
