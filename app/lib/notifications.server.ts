import { isChatNotification } from "./notifications";
import { enqueuePush } from "./push/enqueue.server";
import type { TranslationReportResult } from "./translation-report-results";
import { selectDisplayName } from "./display-names.server";
import { selectMentionRecipients } from "./mention-notifications";
import { DELETED_MEMBER_HANDLE, DELETED_MEMBER_ID } from "./deleted-member";
import { publicTopicPlace } from "./visibility.server";
import { enqueueNotificationTranslations } from "./notification-translations.server";
import { and, asc, count, desc, eq, gt, inArray, isNull, ne, notInArray, or, lte, sql } from "drizzle-orm";
import type { Db } from "~/lib/db/client.server";
import { appeals, entries, moderationActions, notifications, notifiedMentions, profiles, jobs, villages, villageInvites, chatMessages, topicListingStats, translationReports } from "~/lib/db/schema";
import { followerIds, unreadFollowedTopicCondition } from "~/lib/follows.server";
import { afterPageBoundary } from "~/lib/page-boundary.server";
import { isReason, type AppealStatus, type ModerationAction, type ReportReason } from "~/lib/moderation";
import { loadPickedTranslations, loadTitleDisplays } from "~/lib/entry-display.server";
import { wantsTranslation } from "~/lib/display";
import { DEFAULT_MAX_ATTEMPTS } from "~/lib/jobs/queue.server";
import { SEND_NOTIFICATION_EMAIL_JOB } from "~/lib/jobs/mail-kinds";
import { LANGS, type Lang, type SourceLang } from "~/lib/languages";
import { effectiveEmailMode, isContentKind, isInAppOnlyKind, type EmailPref, type NotificationKind } from "~/lib/notifications";
import { followedThreadHrefs } from "~/lib/reply-locations.server";
import { villagesEnabled } from "~/lib/villages-enabled.server";
import { sharedVillageCondition } from "~/lib/villages.server";
import { localizeVillages } from "~/lib/village-translations.server";
import { villageChatEnabled } from "~/lib/village-chat-enabled.server";
import { chatNotificationCondition, chatNotificationLocations, type ChatNotificationLocation } from "~/lib/village-chat-notifications.server";
import { markdownToPlainText } from "~/lib/plain-text.server";
import { parseResponsePost } from "~/lib/response-post.server";

// In-app notifications.
// - Reply notifications, created in createReply's transaction: reply_to_topic to topic author; reply_to_reply to parent-reply author.
//   Never notify oneself. If one recipient qualifies for both, one reply_to_reply only. At most one per recipient per reply.
// - mention: a post names a member with @handle. notifyMentions tells each named member once per post (the record is notified_mentions), at most 10 members per post.
// - notifyForNewEntry decides all the notifications of one new post at once: reply > mention > follow (followed_thread).
// - moderation: affected member, i.e. author for hide/delete, suspended member for suspension. No actor identity.
// - /notifications omits hidden/deleted content.

// Notification-mail job kind; handler in app/lib/jobs/notification-jobs.server.ts.
export { SEND_NOTIFICATION_EMAIL_JOB, SEND_DIGEST_JOB } from "~/lib/jobs/mail-kinds";
export const notificationEmailDedupeKey = (id: number) => `notification-email:${id}`;

export type CreatedNotification = { id: number; userId: string; kind: NotificationKind };

// Keep statement parameters bounded without changing recipient lock order.
function* notificationBatches<T>(rows: readonly T[]) {
  for (let offset = 0; offset < rows.length; offset += 1000) yield rows.slice(offset, offset + 1000);
}

// Immediate-mail delay, default 300 seconds (5 minutes), so recipient display-language translation usually finishes before delivery. If the post becomes
// hidden/deleted while waiting, do not send; job checks immediately before delivery. NOTIFICATION_EMAIL_DELAY_SECONDS is a nonnegative integer; E2E shortens it.
export const DEFAULT_NOTIFICATION_EMAIL_DELAY_SECONDS = 300;
export function notificationEmailDelaySeconds(env: Record<string, string | undefined> = process.env): number {
  const raw = env.NOTIFICATION_EMAIL_DELAY_SECONDS?.trim();
  return raw !== undefined && /^\d{1,6}$/.test(raw) ? Number(raw) : DEFAULT_NOTIFICATION_EMAIL_DELAY_SECONDS;
}

// Right after notifications are made (call it inside the same transaction), queue the immediate-email job of each one whose actual mode is `immediate`
// (the recipient's preference `immediate`, or `auto` with a kind that auto sends at once: effectiveEmailMode). One job per notification id; a job that is already
// waiting (or running) for the same notification is kept, not doubled (dedupe). The job runs after the delay (notificationEmailDelaySeconds) counted from `now`.
// Recipients are handled in ascending user id so that concurrent transactions queue in the same order.
export async function enqueueImmediateEmails(
  db: Db,
  created: ReadonlyArray<{ id: number; userId: string; kind: NotificationKind }>,
  opts: { now?: Date } = {},
): Promise<number> {
  if (created.length === 0) return 0;
  await enqueuePush(db, created.filter(item => item.kind !== "chat_nushi_result" && item.kind !== "chat_nushi_cited"), opts.now);
  // Result notices describe the outcome and use available topic titles; they do not need new excerpt translations.
  await enqueueNotificationTranslations(db, created.filter(item => item.kind !== "translation_report_result" && item.kind !== "nushi_result" && item.kind !== "nushi_cited" && item.kind !== "chat_nushi_result" && item.kind !== "chat_nushi_cited" && !isInAppOnlyKind(item.kind)).map(item => item.id));
  const runAt = new Date((opts.now ?? new Date()).getTime() + notificationEmailDelaySeconds() * 1000);
  const prefOf = new Map<string, EmailPref>();
  for (const ids of notificationBatches([...new Set(created.map(c => c.userId))])) {
    const rows = await db.select({ userId: profiles.userId, emailPref: profiles.emailPref }).from(profiles)
      .where(and(inArray(profiles.userId, ids), inArray(profiles.emailPref, ["auto", "immediate"])));
    for (const row of rows) prefOf.set(row.userId, row.emailPref as EmailPref);
  }
  const eligible = [...created].sort((a, b) => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : a.id - b.id))
    .filter(c => { const pref = prefOf.get(c.userId); return pref !== undefined && effectiveEmailMode(pref, c.kind) === "immediate"; });
  if (!eligible.length) return 0;
  for (const batch of notificationBatches(eligible)) {
    const followedKeys = batch.filter(c => c.kind === "followed_thread").map(c => notificationEmailDedupeKey(c.id));
    await db.insert(jobs).values(batch.map(c => ({ kind: SEND_NOTIFICATION_EMAIL_JOB, payload: { notificationId: c.id },
      dedupeKey: notificationEmailDedupeKey(c.id), runAt, priority: 0, maxAttempts: DEFAULT_MAX_ATTEMPTS,
    }))).onConflictDoUpdate({
      target: jobs.dedupeKey,
      targetWhere: sql`${jobs.status} in ('queued', 'running')`,
      // A running followed-thread email must run again after a concurrent reply.
      // Taking the conflict lock also prevents a queued email overtaking this write.
      set: { runAt: followedKeys.length ? sql`case when ${jobs.status} = 'running' and ${inArray(jobs.dedupeKey, followedKeys)}
        then greatest(${jobs.runAt} + interval '1 millisecond', excluded.run_at) else ${jobs.runAt} end` : jobs.runAt },
    });
  }
  return eligible.length;
}

// Reply notification recipients: { userId → kind }; exclude actor/replier.
export function replyRecipients(input: { actorId: string; topicAuthorId: string; parentAuthorId: string | null }): Map<string, NotificationKind> {
  const out = new Map<string, NotificationKind>();
  out.set(input.topicAuthorId, "reply_to_topic");
  // Parent-reply author gets the more specific reply_to_reply, merged if also the topic author.
  if (input.parentAuthorId !== null) out.set(input.parentAuthorId, "reply_to_reply");
  out.delete(input.actorId);
  return out;
}

// ---- One decision per new post: reply > mention > follow ----

// Who is told about one new post, and how. At most one notification per recipient: a reply notification takes precedence over a mention.
//   reply:             recipients of reply_to_topic / reply_to_reply (replyRecipients; replies only)
//   mention: mentioned members that get a `mention` notification (not the author, not already in `reply`)
//   mentionRecordOnly: mentioned members that already get a reply notification; only the record of "told" is kept for them
//   follow:            followers of the topic that get followed_thread (replies only; not the author, not in `reply`, not mentioned)
// Pure (no database): `mentioned` contains the members selected for a mention after applying the post's quota. New posts apply that quota in notifyMentions first.
export type NotificationPlan = {
  reply: Map<string, NotificationKind>;
  mention: string[];
  mentionRecordOnly: string[];
  follow: string[];
};

export function planNewEntryNotifications(input: {
  authorId: string;
  kind: "topic" | "reply";
  topicAuthorId?: string;
  parentAuthorId?: string | null;
  mentioned: readonly string[];
  followers: readonly string[];
}): NotificationPlan {
  const reply = input.kind === "reply" && input.topicAuthorId !== undefined
    ? replyRecipients({ actorId: input.authorId, topicAuthorId: input.topicAuthorId, parentAuthorId: input.parentAuthorId ?? null })
    : new Map<string, NotificationKind>();
  const mention: string[] = [];
  const mentionRecordOnly: string[] = [];
  for (const id of new Set(input.mentioned)) {
    if (id === input.authorId) continue;
    if (reply.has(id)) mentionRecordOnly.push(id);
    else mention.push(id);
  }
  const taken = new Set<string>([input.authorId, ...reply.keys(), ...mention]);
  const follow = input.kind === "reply" ? [...new Set(input.followers)].filter((id) => !taken.has(id)).sort() : [];
  return { reply, mention, mentionRecordOnly, follow };
}

export type NewEntryNotifyInput = {
  entry: { id: number; kind: "topic" | "reply"; threadId: number; authorId: string };
  responseTo?: number | null;
  // For a reply: the author of the topic, and the author of the reply that is replied to (null when it replies to the topic itself).
  topicAuthorId?: string;
  parentAuthorId?: string | null;
  // All members mentioned outside quotes in the body, in source order, already resolved to user ids. notifyMentions applies the quota before sorting the writes.
  mentioned: readonly string[];
  now: Date;
};

// followed_thread is not made for a post that is hidden or deleted (nothing to read), nor for an author who is suspended now.
async function followNotificationsAllowed(tx: Db, input: NewEntryNotifyInput): Promise<boolean> {
  const rows = await tx
    .select({ id: entries.id, hiddenAt: entries.hiddenAt, deletedAt: entries.deletedAt })
    .from(entries)
    .where(inArray(entries.id, [...new Set([input.entry.id, input.entry.threadId])]));
  if (rows.length === 0 || rows.some((r) => r.hiddenAt !== null || r.deletedAt !== null)) return false;
  const [author] = await tx.select({ suspendedUntil: profiles.suspendedUntil }).from(profiles).where(eq(profiles.userId, input.entry.authorId));
  return !(author?.suspendedUntil != null && author.suspendedUntil > input.now);
}

// Decide and make the notifications of one new post, in the same transaction as the post (createTopic, createReply). Returns the notifications it made or merged.
// 1. reply notifications (replies only), 2. mention notifications, 3. followed_thread for the followers of the topic (replies only).
// A followed_thread notification is merged while the member has not read it: one unread row per (member, topic), with the latest reply and a count.
// Recipients are handled in ascending user id (notifications and email jobs), so that concurrent posts do not take locks in opposite orders.
export async function notifyForNewEntry(tx: Db, input: NewEntryNotifyInput): Promise<CreatedNotification[]> {
  const { entry, now } = input;
  const followers = entry.kind === "reply" ? await followerIds(tx, entry.threadId) : [];
  let plan = planNewEntryNotifications({
    authorId: entry.authorId,
    kind: entry.kind,
    topicAuthorId: input.topicAuthorId,
    parentAuthorId: input.parentAuthorId,
    mentioned: [],
    followers,
  });
  const contentAllowed = (plan.follow.length > 0 || input.mentioned.length > 0) ? await followNotificationsAllowed(tx, input) : true;
  if (!contentAllowed) plan = { ...plan, follow: [] };

  const created: CreatedNotification[] = [];
  if (entry.kind === "topic" && input.responseTo != null) {
    const [source] = await tx.select({ authorId: entries.authorId }).from(entries)
      .innerJoin(profiles, eq(profiles.userId, entries.authorId))
      .where(and(eq(entries.id, input.responseTo), eq(entries.kind, "topic"),
        isNull(entries.hiddenAt), isNull(entries.deletedAt), publicTopicPlace(),
        ne(entries.authorId, entry.authorId), ne(entries.authorId, DELETED_MEMBER_ID),
        ne(profiles.handle, DELETED_MEMBER_HANDLE), or(isNull(profiles.suspendedUntil), lte(profiles.suspendedUntil, now))));
    const [response] = source ? await tx.select({ id: entries.id }).from(entries)
      .where(and(eq(entries.id, entry.id), publicTopicPlace(), isNull(entries.hiddenAt), isNull(entries.deletedAt))) : [];
    if (source && response) {
      const [row] = await tx.insert(notifications).values({ userId: source.authorId, kind: "response_to_topic", entryId: entry.id, threadId: input.responseTo, actorId: entry.authorId, createdAt: now })
        .returning({ id: notifications.id, userId: notifications.userId, kind: notifications.kind });
      created.push({ ...row, kind: "response_to_topic" });
    }
  }
  // 1. Reply notifications.
  const replyRows = [...plan.reply].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (replyRows.length > 0) {
    const rows = await tx
      .insert(notifications)
      .values(replyRows.map(([userId, kind]) => ({ userId, kind, entryId: entry.id, threadId: entry.threadId, actorId: entry.authorId, createdAt: now })))
      .returning({ id: notifications.id, userId: notifications.userId, kind: notifications.kind });
    for (const r of rows) created.push({ id: r.id, userId: r.userId, kind: r.kind as NotificationKind });
  }
  // 2. Mention notifications.
  // Keep all targets in source order: separating reply recipients would change which members fit the ten-member quota. Only actual mention notifications suppress follows.
  const mentions = await notifyMentions(tx, {
    entry: { ...entry, hidden: !contentAllowed },
    mentioned: input.mentioned,
    subsumed: new Set(plan.reply.keys()),
    now,
    enqueueEmails: false,
  });
  created.push(...mentions.created);
  const mentionedRecipients = new Set(mentions.created.map((n) => n.userId));
  plan = { ...plan, follow: plan.follow.filter((id) => !mentionedRecipients.has(id)) };
  // 3. followed_thread (merged while unread).
  for (const batch of notificationBatches(plan.follow)) {
    const rows = await tx.insert(notifications)
      .values(batch.map(userId => ({ userId, kind: "followed_thread", entryId: entry.id, firstEntryId: entry.id, threadId: entry.threadId, actorId: entry.authorId, createdAt: now, mergedCount: 1 })))
      .onConflictDoUpdate({
        target: [notifications.userId, notifications.threadId],
        targetWhere: sql`${notifications.kind} = 'followed_thread' AND ${notifications.readAt} IS NULL`,
        set: { entryId: entry.id, actorId: entry.authorId, createdAt: now, mergedCount: sql`${notifications.mergedCount} + 1`, emailedAt: null },
      }).returning({ id: notifications.id, userId: notifications.userId, kind: notifications.kind });
    // A fresh statement after this batch's upsert locks sees a concurrent producer's
    // committed first reply even when it was outside the INSERT snapshot.
    const firstEntryId = sql`(select e.id from entries e
      where e.id = ${notifications.firstEntryId} or e.id = ${entry.id}
      order by e.created_at, e.id limit 1)`;
    await tx.update(notifications).set({ firstEntryId }).where(and(
      inArray(notifications.id, rows.map(r => r.id)),
      sql`${notifications.firstEntryId} is distinct from ${firstEntryId}`,
    ));
    created.push(...rows.map(r => ({ ...r, kind: r.kind as NotificationKind })));
  }
  await enqueueImmediateEmails(tx, created, { now });
  return created;
}

// ---- Mentions ----

// One post notifies at most this many members of its mentions (the rows of notified_mentions of the post are what is counted).
// The notifications of the mentions of one post. Called inside the transaction of the post, by createTopic and createReply (the post is new) and by editEntry (the author's edit of
// the body; not the moderator's fix of a typo, which is not the author's call). The caller has the row of the post locked.
// Rules, in this order:
// 1. A post that is hidden (or deleted) tells nobody and records nothing; showing it again does not tell afterwards.
// 2. An author who is suspended now tells nobody. (A notification made before a suspension is checked again when its email goes out.)
// 3. The author is not told of their own mention.
// 4. A member who is already in notified_mentions for this post is not told again (an edit that removes a mention and writes it again).
// 5. At most MENTION_NOTIFY_LIMIT members per post in all (the rows already recorded count): in the order of appearance, the members after the limit get no record and no
//    notification. They are still shown as a mention.
// 6. The members that are left, in ascending user id: recorded; and, unless they get a reply notification for the same post (`subsumed`: reply > mention), a `mention` notification.
// `mentioned` is the members of the body in order of appearance, without the ones that appear only inside a block quote (a quote is not a call).
export async function notifyMentions(
  tx: Db,
  input: {
    entry: { id: number; kind: "topic" | "reply"; threadId: number; authorId: string; hidden: boolean };
    mentioned: readonly string[];
    subsumed: ReadonlySet<string>;
    now: Date;
    enqueueEmails?: boolean;
  },
): Promise<{ created: CreatedNotification[]; recorded: string[] }> {
  const { entry, now } = input;
  const nothing = { created: [] as CreatedNotification[], recorded: [] as string[] };
  if (entry.hidden || input.mentioned.length === 0) return nothing;
  const [author] = await tx.select({ suspendedUntil: profiles.suspendedUntil }).from(profiles).where(and(eq(profiles.userId, entry.authorId), gt(profiles.suspendedUntil, now)));
  if (author) return nothing;
  const told = new Set((await tx.select({ userId: notifiedMentions.userId }).from(notifiedMentions).where(eq(notifiedMentions.entryId, entry.id))).map((r) => r.userId));
  const responseRecipients = entry.kind === "topic" ? new Set((await tx.select({ userId: notifications.userId }).from(notifications)
    .where(and(eq(notifications.entryId, entry.id), eq(notifications.kind, "response_to_topic")))).map(row => row.userId)) : new Set<string>();
  const picked = selectMentionRecipients(input.mentioned, entry.authorId, told).sort();
  const created: CreatedNotification[] = [];
  const recorded: string[] = [];
  for (const userId of picked) {
    // The record is what makes the member told once: a member that another transaction recorded in the meantime is skipped.
    const inserted = await tx.insert(notifiedMentions).values({ entryId: entry.id, userId, createdAt: now }).onConflictDoNothing().returning({ userId: notifiedMentions.userId });
    if (inserted.length === 0) continue;
    recorded.push(userId);
    if (input.subsumed.has(userId) || responseRecipients.has(userId)) continue;
    const [row] = await tx
      .insert(notifications)
      .values({ userId, kind: "mention", entryId: entry.id, threadId: entry.threadId, actorId: entry.authorId, createdAt: now })
      .returning({ id: notifications.id, userId: notifications.userId, kind: notifications.kind });
    created.push({ id: row.id, userId: row.userId, kind: row.kind as NotificationKind });
  }
  if (input.enqueueEmails !== false) await enqueueImmediateEmails(tx, created, { now });
  return { created, recorded };
}

// Notify the affected member within the moderation transaction, without actor identity.
export async function createModerationNotification(
  db: Db,
  input: { userId: string; entryId: number | null; villageId?: string; actionId: number; now: Date },
): Promise<CreatedNotification> {
  const [row] = await db
    .insert(notifications)
    .values({ userId: input.userId, kind: "moderation", entryId: input.entryId, actionId: input.actionId, createdAt: input.now, ...(input.villageId ? { villageId: input.villageId } : {}) })
    .returning({ id: notifications.id, userId: notifications.userId, kind: notifications.kind });
  const created = { id: row.id, userId: row.userId, kind: row.kind as NotificationKind };
  await enqueueImmediateEmails(db, [created]);
  return created;
}

// Notify the appellant of the decision within the appeal transaction, without reviewer identity.
export async function createAppealNotification(
  db: Db,
  input: { userId: string; entryId: number | null; villageId?: string; actionId: number; appealId: number; now: Date },
): Promise<CreatedNotification> {
  const [row] = await db
    .insert(notifications)
    .values({ userId: input.userId, kind: "appeal_decided", entryId: input.entryId, actionId: input.actionId, appealId: input.appealId, createdAt: input.now, ...(input.villageId ? { villageId: input.villageId } : {}) })
    .returning({ id: notifications.id, userId: notifications.userId, kind: notifications.kind });
  const created = { id: row.id, userId: row.userId, kind: row.kind as NotificationKind };
  await enqueueImmediateEmails(db, [created]);
  return created;
}

// The number shown on the bell: only what is addressed to the member (a reply, a mention, an invitation, a moderation notice). A new reply in a followed post is not counted here;
// it is told by a dot (hasUnreadFollowedThread) on the place for following.
export async function countUnreadNotifications(db: Db, userId: string): Promise<number> {
  const rows = await db.select({ id: notifications.id }).from(notifications)
    .where(and(eq(notifications.userId, userId), isNull(notifications.readAt), notInArray(notifications.kind, villagesEnabled() ? ["followed_thread"] : ["followed_thread", "village_invite", "village_added", "village_removed", "village_owner_changed"]), chatNotificationCondition()))
    .limit(100);
  return rows.length;
}

// Whether any new reply in a followed post is still unread.
export async function hasUnreadFollowedThread(db: Db, userId: string): Promise<boolean> {
  const [row] = await db.select({ id: entries.id }).from(entries).innerJoin(topicListingStats, eq(topicListingStats.topicId, entries.id))
    .where(unreadFollowedTopicCondition(db, userId)).limit(1);
  return !!row;
}

// Mark one own notification read. No-op if already read; true if newly read.
export async function markNotificationRead(db: Db, userId: string, id: number, opts: { now?: Date } = {}): Promise<boolean> {
  const rows = await db
    .update(notifications)
    .set({ readAt: opts.now ?? new Date() })
    .where(and(eq(notifications.id, id), eq(notifications.userId, userId), isNull(notifications.readAt)))
    .returning({ id: notifications.id });
  return rows.length > 0;
}

// Mark every unread notification about one post (replies, mentions, new replies in it) read. Opening a grouped row does this.
export async function markThreadNotificationsRead(db: Db, userId: string, threadId: number, opts: { now?: Date } = {}): Promise<number> {
  const rows = await db.update(notifications).set({ readAt: opts.now ?? new Date() })
    .where(and(eq(notifications.userId, userId), eq(notifications.threadId, threadId), isNull(notifications.readAt), inArray(notifications.kind, ["reply_to_topic", "reply_to_reply", "mention", "followed_thread"])))
    .returning({ id: notifications.id });
  return rows.length;
}

// Mark all own notifications read; return newly-read count.
export async function markAllNotificationsRead(db: Db, userId: string, opts: { now?: Date } = {}): Promise<number> {
  const rows = await db
    .update(notifications)
    .set({ readAt: opts.now ?? new Date() })
    .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)))
    .returning({ id: notifications.id });
  return rows.length;
}

// ---- Listing (/notifications) ----

// One screen item. Deleted/hidden post content (body/title/author) is unavailable and omitted.
export type NotificationItem = {
  nushiRequestId?: string;
  translationResult?: TranslationReportResult;
  automatic?: boolean;
  chat?: { id: string; slug: string; name: string; originalName?: string; language: string | null };
  village?: { slug: string; name: string; originalName?: string; language: string | null; reason: string | null; pending: boolean; inviteKind: string | null };
  followedHref: string | null;
  id: number;
  kind: NotificationKind;
  createdAt: Date;
  read: boolean;
  // A reply notification: the display name of the replier, and the one line that names the topic (its title, or the beginning of its body when it has no title; only when the topic is neither deleted nor hidden).
  // If the reply or the topic is deleted or hidden, unavailable. For a topic whose body has no text (an image without alt text, for example) the line is an empty string (the screen shows its own words).
  unavailable: boolean;
  actorHandle: string | null;
  actorName?: string | null;
  topicTitle: string | null;
  // Reply location (thread/reply ids) for reply notifications and author-post moderation, only when content may be shown.
  threadId: number | null;
  entryId: number | null;
  // followed_thread: how many replies are merged into the notification (1 for the other kinds).
  count: number;
  // followed_thread: the latest reply is hidden or deleted but the topic can be read. The text then leaves out the author and the link goes to the topic (entryId is null).
  latestUnavailable: boolean;
  // moderation: action/reason, note shown to affected member, suspension expiry and action id.
  action: ModerationAction | null;
  reason: ReportReason | null;
  note: string | null;
  until: Date | null;
  actionId: number | null;
  // appeal_decided: upheld/overturned and review note; action also contains action kind.
  appealStatus: AppealStatus | null;
  decisionNote: string | null;
  // For overturned, whether the action was actually reverted. false when no ongoing result remained: 「取り消されたが、戻すものはなかった」.
  appealReversed: boolean | null;
  // A reply, a mention or a new reply in a followed post that can be shown (only when the list asks for excerpts): the first line of the post in the reader's language,
  // and the language it was written in. null when the post cannot be shown.
  excerpt: string | null;
  // The language the excerpt is written in: the reader's own when the excerpt is a translation, else the language of the original.
  excerptLang: SourceLang | null;
  entryLang: SourceLang | null;
  entryLangCode?: string | null;
};

export const NOTIFICATIONS_PER_PAGE = 30;

// Whether a response notification may show its posts. With villages off, the legacy pages read no
// village tables, so only posts outside any village count (fail closed).
const notificationPlace = () => (villagesEnabled() ? publicTopicPlace() : isNull(entries.villageId));

// display: the languages the recipient reads and the display language (the rule that shows the one line of a topic by the translation of its title or of its body; the same as loadTitleDisplays). Without it, the original is used as it is.
export async function listNotifications(
  db: Db,
  userId: string,
  opts: { ids?: number[]; id?: number; page?: number; limit?: number; display?: { readLangs: readonly Lang[]; displayLang: Lang }; typesetTitles?: boolean; excerpts?: boolean } = {},
): Promise<{ items: NotificationItem[]; page: number; hasNext: boolean }> {
  const page = opts.page ?? 1;
  const limit = opts.limit ?? NOTIFICATIONS_PER_PAGE;
  const condition = and(eq(notifications.userId, userId), opts.ids ? inArray(notifications.id, opts.ids) : undefined, opts.id === undefined ? undefined : eq(notifications.id, opts.id), villagesEnabled() ? undefined : notInArray(notifications.kind, ["village_invite", "village_added", "village_removed", "village_owner_changed"]), chatNotificationCondition());
  const offset = (page - 1) * limit;
  const boundary = offset ? db.select({ createdAt: notifications.createdAt, id: notifications.id }).from(notifications)
    .where(condition).orderBy(desc(notifications.createdAt), desc(notifications.id)).limit(1).offset(offset - 1) : undefined;
  const rows = await db
    .select({
      id: notifications.id,
      kind: notifications.kind,
      createdAt: notifications.createdAt,
      readAt: notifications.readAt,
      entryId: notifications.entryId,
      nushiRequestId: notifications.nushiRequestId,
      translationReportId: notifications.translationReportId,
      firstEntryId: notifications.firstEntryId,
      actorId: notifications.actorId,
      actionId: notifications.actionId,
      appealId: notifications.appealId,
      threadId: notifications.threadId,
      mergedCount: notifications.mergedCount,
      villageId: notifications.villageId,
      ...(villagesEnabled() ? { villageInviteId: notifications.villageInviteId, villageReason: notifications.villageReason } : {}),
      ...(villageChatEnabled() ? { chatMessageId: notifications.chatMessageId } : {}),
    })
    .from(notifications)
    .where(and(condition, afterPageBoundary([notifications.createdAt, notifications.id], boundary, true)))
    .orderBy(desc(notifications.createdAt), desc(notifications.id))
    .limit(limit + 1);
  const pageRows = rows.slice(0, limit);
  const resultIds = pageRows.flatMap(row => row.translationReportId === null ? [] : [row.translationReportId]);
  const resultRows = resultIds.length ? await db.select({ id: translationReports.id, outcome: translationReports.outcome, lang: translationReports.lang, field: translationReports.field, sourceHash: translationReports.sourceHash })
    .from(translationReports).innerJoin(profiles, eq(profiles.userId, translationReports.reporterId))
    .where(and(inArray(translationReports.id, resultIds), eq(translationReports.reporterId, userId))) : [];
  const results = new Map(resultRows.map(row => [row.id, row]));
  const chatRows = pageRows.filter(row => isChatNotification(row.kind));
  const chatLocations = chatRows.length ? await chatNotificationLocations(db, chatRows.map(row => ({ id: row.id, kind: row.kind, villageId: row.villageId ?? null, chatMessageId: row.chatMessageId ?? null })), userId) : new Map<number, ChatNotificationLocation>();
  const chatAuthors = chatLocations.size ? await db.select({ id: chatMessages.id, handle: profiles.handle }).from(chatMessages)
    .leftJoin(profiles, eq(profiles.userId, chatMessages.authorId)).where(inArray(chatMessages.id, [...chatLocations.values()].map(location => location.id))) : [];
  const chatHandles = new Map(chatAuthors.map(row => [row.id, row.handle]));
  const villageIds = [...new Set(pageRows.filter(row => !isChatNotification(row.kind)).map(row => row.villageId).filter((id): id is string => !!id))];
  const inviteIds = [...new Set(pageRows.map(row => row.villageInviteId).filter((id): id is string => !!id))];
  const [villageRows, inviteRows] = await Promise.all([
    villageIds.length ? db.select({ id: villages.id, slug: villages.slug, name: villages.name, language: villages.language, endedAt: villages.endedAt }).from(villages).where(and(inArray(villages.id, villageIds), sharedVillageCondition())) : [],
    inviteIds.length ? db.select({ id: villageInvites.id, state: villageInvites.state, kind: villageInvites.kind }).from(villageInvites).where(and(inArray(villageInvites.id, inviteIds), eq(villageInvites.userId, userId))) : [],
  ]);
  // Village names are shown in the reader's language when the village was named in another (the page's reader; mail has its own).
  const translatedNames = new Map((await localizeVillages(db, [...villageRows, ...[...chatLocations.values()].map(location => ({ slug: location.slug, name: location.name, language: location.language }))], opts.display)).flatMap(row => row.slug ? [[row.slug, row.name] as const] : []));
  // `originalName` is set only when the name shown is a translation, for a tooltip with the original.
  const originalIfTranslated = (shown: string, original: string) => ({ originalName: shown !== original ? original : undefined });
  const villageById = new Map(villageRows.map(row => { const name = row.slug ? translatedNames.get(row.slug) ?? row.name : row.name; return [row.id, { ...row, name, ...originalIfTranslated(name, row.name) }]; }));
  const invitesById = new Map(inviteRows.map(row => [row.id, row]));
  const followedHrefs = await followedThreadHrefs(db, pageRows.filter(r => r.kind === "followed_thread"));
  const entryIds = [...new Set(pageRows.map((r) => r.entryId).filter((v): v is number => v !== null))];
  const actorIds = [...new Set(pageRows.map((r) => r.actorId).filter((v): v is string => v !== null))];
  const actionIds = [...new Set(pageRows.map((r) => r.actionId).filter((v): v is number => v !== null))];
  const appealIds = [...new Set(pageRows.map((r) => r.appealId).filter((v): v is number => v !== null))];
  const [entryRows, actorRows, actionRows, appealRows] = await Promise.all([
    entryIds.length === 0
      ? []
      : db
          .select({ id: entries.id, authorId: entries.authorId, kind: entries.kind, threadId: entries.threadId, title: entries.title, hiddenAt: entries.hiddenAt, deletedAt: entries.deletedAt, publicPlace: notificationPlace().as("public_place"), lang: entries.lang, langCode: entries.langCode, sourceHash: entries.sourceHash, ...(opts.excerpts ? { body: entries.body } : {}) })
          .from(entries)
          .where(inArray(entries.id, entryIds)),
    actorIds.length === 0 ? [] : db.select({ userId: profiles.userId, handle: profiles.handle, displayName: profiles.displayName, displayNameLatin: profiles.displayNameLatin, homeArea: profiles.homeArea }).from(profiles).where(inArray(profiles.userId, actorIds)),
    actionIds.length === 0
      ? []
      : db
          .select({ id: moderationActions.id, automatic: moderationActions.automatic, action: moderationActions.action, reason: moderationActions.reason, note: moderationActions.note, until: moderationActions.until,
            chatSource: sql<boolean>`${moderationActions.targetChatMessageId} is not null or exists (select 1 from reports cr where cr.id = ${moderationActions.reportId} and cr.chat_message_id is not null)` })
          .from(moderationActions)
          .where(inArray(moderationActions.id, actionIds)),
    appealIds.length === 0
      ? []
      : db.select({ id: appeals.id, status: appeals.status, decisionNote: appeals.decisionNote, reversed: appeals.reversed }).from(appeals).where(inArray(appeals.id, appealIds)),
  ]);
  // Topic of a reply: title and deleted/hidden state.
  const threadIds = [...new Set([...entryRows.map((e) => e.threadId ?? e.id), ...pageRows.map((r) => r.threadId).filter((v): v is number => v !== null)])];
  const topicRows =
    threadIds.length === 0
      ? []
      : await db
          .select({ id: entries.id, authorId: entries.authorId, lang: entries.lang, title: entries.title, sourceHash: entries.sourceHash, hiddenAt: entries.hiddenAt, deletedAt: entries.deletedAt, publicPlace: notificationPlace().as("public_place") })
          .from(entries)
          .where(inArray(entries.id, threadIds));
  // The line that names a topic: its title, or (for a topic without a title) the beginning of its body, in the reader's language.
  const lines = await loadTitleDisplays(
    db,
    topicRows.filter((t) => !t.deletedAt && !t.hiddenAt).map((t) => ({ id: t.id, lang: t.lang as Lang, title: t.title, sourceHash: t.sourceHash })),
    opts.display ?? { readLangs: LANGS, displayLang: "en" },
    opts.typesetTitles ?? false,
  );
  const responseIds = new Set(pageRows.filter(row => row.kind === "response_to_topic").map(row => row.entryId));
  const excerpts = opts.excerpts ? await notificationExcerpts(db, entryRows.filter(e => !e.deletedAt && !e.hiddenAt && (e.kind === "reply" || e.kind === "topic")).map(e => ({ id: e.id, kind: e.kind as "topic" | "reply", lang: e.lang as Lang, sourceHash: e.sourceHash, body: (e as { body?: string }).body ?? "", response: responseIds.has(e.id) })), opts.display ?? { readLangs: LANGS, displayLang: "en" }) : new Map<number, { text: string; lang: SourceLang }>();
  const entryById = new Map(entryRows.map((e) => [e.id, e]));
  const topicById = new Map(topicRows.map((t) => [t.id, t]));
  const handles = new Map(actorRows.map((a) => [a.userId, a.handle]));
  const actions = new Map(actionRows.map((a) => [a.id, a]));
  const appealById = new Map(appealRows.map((a) => [a.id, a]));

  const items = pageRows.filter(r => !isChatNotification(r.kind) || chatLocations.has(r.id)).map((r): NotificationItem => {
    const kind = r.kind as NotificationKind;
    const result = r.translationReportId === null ? undefined : results.get(r.translationReportId);
    const village = r.villageId ? villageById.get(r.villageId) : undefined;
    const invite = r.villageInviteId ? invitesById.get(r.villageInviteId) : undefined;
    const entry = r.entryId !== null ? entryById.get(r.entryId) : undefined;
    const topic = entry ? topicById.get(entry.threadId ?? entry.id) : undefined;
    // The content kinds (CONTENT_KINDS) tell about a post. The topic comes from the notification's own thread_id when it has one (followed_thread always does).
    const isContent = isContentKind(kind) || isInAppOnlyKind(kind) || kind === "translation_report_result";
    const contentTopic = r.threadId !== null ? topicById.get(r.threadId) : topic;
    const topicReadable = contentTopic !== undefined && !contentTopic.deletedAt && !contentTopic.hiddenAt && (!["response_to_topic", "translation_report_result"].includes(kind) || !!contentTopic.publicPlace);
    const entryReadable = entry !== undefined && !entry.deletedAt && !entry.hiddenAt && (!["response_to_topic", "translation_report_result"].includes(kind) || !!entry.publicPlace);
    // Reply notifications show content only if reply/topic are undeleted and visible. followed_thread needs readable topic; if latest reply is unreadable, show topic only.
    const latestUnavailable = kind === "followed_thread" && topicReadable && !entryReadable;
    const replyShown = isContent && topicReadable && (entryReadable || latestUnavailable) && (kind !== "translation_report_result" || !!result?.outcome);
    const shownEntry = replyShown && entryReadable;
    const action = r.actionId !== null ? actions.get(r.actionId) : undefined;
    // Hide/fix notices point to the affected author's undeleted post, even when the post is hidden.
    // A reply inside somebody else's hidden topic still has no readable thread destination.
    const moderationPost = kind === "moderation" && (action?.action === "hide" || action?.action === "fix_entry")
      && entry?.authorId === userId && !entry.deletedAt && topic !== undefined && !topic.deletedAt
      && (!topic.hiddenAt || topic.authorId === userId);
    const appeal = r.appealId !== null ? appealById.get(r.appealId) : undefined;
    const villageReversal = kind === "moderation" && (action?.action === "unfix_village" || action?.action === "reopen_village" || action?.action === "restore_village_icon");
    return {
      id: r.id,
      ...(r.nushiRequestId ? { nushiRequestId: r.nushiRequestId } : {}),
      ...(replyShown && result?.outcome ? { translationResult: { outcome: result.outcome, lang: result.lang, field: result.field, sourceHash: result.sourceHash } as TranslationReportResult } : {}),
      ...(chatLocations.has(r.id) ? { chat: { id: chatLocations.get(r.id)!.id, slug: chatLocations.get(r.id)!.slug, name: translatedNames.get(chatLocations.get(r.id)!.slug) ?? chatLocations.get(r.id)!.name, ...originalIfTranslated(translatedNames.get(chatLocations.get(r.id)!.slug) ?? chatLocations.get(r.id)!.name, chatLocations.get(r.id)!.name), language: chatLocations.get(r.id)!.language } } : {}),
      ...(village?.slug ? { village: { slug: village.slug, name: village.name, originalName: village.originalName, language: village.language, reason: r.villageReason ?? null, pending: !village.endedAt && invite?.state === "pending", inviteKind: invite?.kind ?? null } } : {}),
      followedHref: followedHrefs.get(r.id) ?? null,
      kind,
      createdAt: r.createdAt,
      read: r.readAt !== null,
      unavailable: isContent && !replyShown,
      ...(kind === "village_added" ? { actorName: selectDisplayName(actorRows.find(actor => actor.userId === r.actorId)) } : {}),
      actorHandle: kind === "village_added" ? (r.actorId ? handles.get(r.actorId) : null) ?? DELETED_MEMBER_HANDLE : isChatNotification(kind) ? chatHandles.get(chatLocations.get(r.id)!.id) ?? null : (shownEntry || kind === "village_invite") && r.actorId ? (handles.get(r.actorId) ?? null) : null,
      topicTitle: replyShown && contentTopic ? (lines.get(contentTopic.id)?.text ?? null) : null,
      threadId: moderationPost ? (entry.threadId ?? entry.id) : replyShown ? (r.threadId ?? (entry ? (entry.threadId ?? entry.id) : null)) : null,
      entryId: shownEntry || moderationPost ? r.entryId : null,
      count: r.mergedCount,
      latestUnavailable,
      ...(action?.automatic ? { automatic: true } : {}),
      action: action ? (action.action as ModerationAction) : null,
      reason: !villageReversal && action && isReason(action.reason) ? action.reason : null,
      note: !villageReversal && action && !action.chatSource ? action.note : null,
      until: action?.until ?? null,
      actionId: r.actionId,
      appealStatus: appeal ? (appeal.status as AppealStatus) : null,
      decisionNote: action?.chatSource ? null : appeal?.decisionNote ?? null,
      appealReversed: appeal?.reversed ?? null,
      excerpt: kind !== "translation_report_result" && shownEntry && r.entryId !== null ? excerpts.get(r.entryId)?.text ?? null : null,
      excerptLang: kind !== "translation_report_result" && shownEntry && r.entryId !== null ? excerpts.get(r.entryId)?.lang ?? null : null,
      entryLang: kind !== "translation_report_result" && shownEntry && entry ? entry.lang as SourceLang : null,
      entryLangCode: shownEntry && entry ? entry.langCode : null,
    };
  });
  return { items, page, hasNext: rows.length > limit };
}

// The first line of a post, in the language the reader reads it in (the translation if the reader wants one and it exists, else the original), without markup and cut short.
const EXCERPT_LENGTH = 120;
async function notificationExcerpts(db: Db, rows: ReadonlyArray<{ id: number; kind: "topic" | "reply"; lang: SourceLang; sourceHash: string | null; body: string; response: boolean }>, display: { readLangs: readonly Lang[]; displayLang: Lang }): Promise<Map<number, { text: string; lang: SourceLang }>> {
  const out = new Map<number, { text: string; lang: SourceLang }>();
  if (!rows.length) return out;
  const wanting = rows.filter(row => wantsTranslation(row.lang, display.readLangs, display.displayLang));
  const picked = wanting.length ? await loadPickedTranslations(db, wanting.map(({ id, kind, lang, sourceHash }) => ({ id, kind, lang, sourceHash })), display.displayLang, ["body"]) : new Map();
  const excerpts = await Promise.all(rows.map(async row => {
    const translated: string | undefined = picked.get(row.id)?.body?.text;
    const lang = translated !== undefined ? display.displayLang : row.lang;
    const body: string = translated ?? row.body;
    const text = row.response ? parseResponsePost(body)?.body ?? body : body;
    // Keep the first non-image line, but parse its markup so escaped link labels
    // retain their literal punctuation rather than leaving escape characters.
    const source = text.split("\n").map(part => part.replace(/!\[[^\]]*\]\([^)]*\)/g, "")).find(part => part.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/^[\s>#*\-+\d.]+/, "").replace(/[*_`~]/g, "").trim());
    const line = source ? await markdownToPlainText(source) : "";
    return { id: row.id, line, lang };
  }));
  for (const { id, line, lang } of excerpts) if (line) out.set(id, { text: line.length > EXCERPT_LENGTH ? `${[...line].slice(0, EXCERPT_LENGTH).join("")}…` : line, lang });
  return out;
}
