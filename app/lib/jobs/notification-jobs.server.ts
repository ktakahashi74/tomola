import { webPushEnabled } from "../push/config.server";
import { immediateNotifications } from "../notification-access.server";
import { notificationHref } from "../notification-opening.server";
import { selectDisplayName } from "~/lib/display-names.server";
import { DELETED_MEMBER_HANDLE } from "~/lib/deleted-member";
import { and, asc, eq, gt, inArray, isNull, lt, notInArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "~/lib/db/client.server";
import { chatMessages, villageInvites, villages, appeals, entries, jobs, moderationActions, notifications, profiles, user } from "~/lib/db/schema";
import { resolveDisplayLang } from "~/lib/display";
import { loadPickedTranslations, loadTitleDisplays } from "~/lib/entry-display.server";
import { followedThreadHrefs, loadReplyLocations } from "~/lib/reply-locations.server";
import type { Lang } from "~/lib/languages";
import { digestMail, DIGEST_MAX_ITEMS, EXCERPT_CHARS, notificationMail, type MailItem } from "~/lib/mail/notification.server";
import { plainExcerpt } from "~/lib/plain-text.server";
import { getMailer, type Mailer } from "~/lib/mail/mail.server";
import { enabledLangs, isEnabledLang } from "~/lib/enabled-langs.server";
import { localizeVillage, localizeVillages, villageReaderOfMember } from "~/lib/village-translations.server";
import { memberMailLocale } from "~/lib/mail/magic-link.server";
import { siteUrl } from "~/lib/md/urls.server";
import { isReason, type AppealStatus, type ModerationAction } from "~/lib/moderation";
import { AUTO_IMMEDIATE_KINDS, effectiveEmailMode, isContentKind, type NotificationKind } from "~/lib/notifications";
import { listNotifications, notificationEmailDelaySeconds, SEND_DIGEST_JOB, SEND_NOTIFICATION_EMAIL_JOB } from "~/lib/notifications.server";
import { getProfile, type Profile } from "~/lib/profiles.server";
import { dateOf, ensureDailyJob, nextDailyAt } from "./daily.server";
import { DeferJob, enqueue, type JobHandler, type JobHandlers } from "./queue.server";
import { SEND_MEMBER_DIGEST_JOB } from "./mail-kinds";
import { activeSharedVillageCondition } from "~/lib/villages.server";
import { villagesEnabled } from "~/lib/villages-enabled.server";
import { chatNotificationLocations, notificationColumns, type ChatNotificationLocation } from "~/lib/village-chat-notifications.server";
import { chatMailVillageName } from "~/lib/village-chat-villages.server";
import { villageChatEnabled } from "~/lib/village-chat-enabled.server";
import { publicTopicPlace } from "~/lib/visibility.server";
import { parseResponsePost } from "~/lib/response-post.server";

// Notification emails.
// - send_notification_email ({ notificationId }; dedupe: notification-email:<id>): one email per notification for members with immediate preference.
//   Queue within the notification-creation transaction (app/lib/notifications.server.ts).
// - send_digest ({ date }; dedupe: digest:<YYYY-MM-DD>): daily UTC 00:00, combine unemailed unread notifications into one email per member with daily preference.
//   Workers maintain exactly one future digest job (ensureDigestScheduled). Each job also queues the next day's job.
// "immediate" and "daily" are the actual mode of one notification (effectiveEmailMode: the preference `auto` sends replies at once and everything else in the digest).
// A followed_thread row goes back to emailed_at = NULL whenever another reply is merged into it while it is unread. So that a reply merged while the job is sending is not lost,
// the mark after sending is conditional on the latest reply that was read (entry_id), and when it does not take, the job is deferred and sends once more (DeferJob). The digest
// marks its rows the same way.
// Job names/immediate-email enqueue function are in app/lib/notifications.server.ts; this file provides handlers and digest scheduling.
// Set emailed_at after sending. For deleted/hidden reply content, suppress email and set emailed_at so it is never checked again.
// Reply-email excerpts use the recipient's display-language translation if available, otherwise the source. Email language uses the recipient's interface locale (profiles.ui_locale).

// ---- Digest scheduling ----

// Include only notifications created within this many days, avoiding a backlog when preferences change from none.
export const DIGEST_WINDOW_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

export const digestDate = dateOf;
export const digestDedupeKey = (date: string) => `digest:${date}`;

// First UTC midnight strictly after now.
export const nextDigestAt = (now: Date): Date => nextDailyAt(now, 0);

// Keep exactly one future digest job, doing nothing if present; dedupe_key uses the date. created indicates whether newly queued.
// Avoid requeuing a completed day or one covered by a later day, so slow-clock processes cannot requeue finished digest:D (daily.server.ts).
export async function ensureDigestScheduled(db: Db, now: Date = new Date()): Promise<{ date: string; runAt: Date; created: boolean }> {
  return ensureDailyJob(db, { kind: SEND_DIGEST_JOB, keyPrefix: "digest", hourUtc: 0 }, now);
}

// Called before each worker iteration (app/lib/jobs/worker.server.ts). Throttle per-process checks to this one-minute interval.
const ENSURE_INTERVAL_MS = 60_000;
const lastEnsured = new WeakMap<Db, number>();
export async function ensureDigestScheduledThrottled(db: Db, now: Date = new Date()): Promise<void> {
  const last = lastEnsured.get(db) ?? 0;
  if (now.getTime() - last < ENSURE_INTERVAL_MS) return;
  lastEnsured.set(db, now.getTime());
  await ensureDigestScheduled(db, now);
}

// ---- Build email items ----

type NotificationRow = Omit<typeof notifications.$inferSelect, "chatMessageId"> & { chatMessageId?: string | null };
type Recipient = { profile: Profile; email: string };

// Convert notification rows into email items. Suppress reply notifications if the reply or topic is deleted/hidden.
async function buildItems(db: Db, rows: readonly NotificationRow[], recipient: Recipient, now: Date): Promise<{ items: Map<number, MailItem>; suppressed: Set<number> }> {
  const items = new Map<number, MailItem>();
  const suppressed = new Set<number>();
  const { profile } = recipient;
  const displayLang = resolveDisplayLang({ profile, uiLocale: profile.uiLocale, enabled: enabledLangs() });
  const replyRows = rows.filter((r) => isContentKind(r.kind));
  const followedHrefs = await followedThreadHrefs(db, replyRows.filter(r => r.kind === "followed_thread"));
  const entryIds = [...new Set(replyRows.map((r) => r.entryId).filter((v): v is number => v !== null))];
  const entryRows =
    entryIds.length === 0
      ? []
      : await db
          .select({ id: entries.id, kind: entries.kind, threadId: entries.threadId, lang: entries.lang, body: entries.body, sourceHash: entries.sourceHash, hiddenAt: entries.hiddenAt, deletedAt: entries.deletedAt, publicPlace: publicTopicPlace().as("public_place") })
          .from(entries)
          .where(inArray(entries.id, entryIds));
  const topicIds = [...new Set([...entryRows.map((e) => e.threadId ?? e.id), ...replyRows.map((r) => r.threadId).filter((v): v is number => v !== null)])];
  const topicRows =
    topicIds.length === 0
      ? []
      : await db
          .select({ id: entries.id, kind: entries.kind, lang: entries.lang, title: entries.title, sourceHash: entries.sourceHash, hiddenAt: entries.hiddenAt, deletedAt: entries.deletedAt, publicPlace: publicTopicPlace().as("public_place") })
          .from(entries)
          .where(inArray(entries.id, topicIds));
  const replyLocations = await loadReplyLocations(db, topicIds, entryRows.filter(e => e.threadId !== null).map(e => e.id));
  const actorIds = [...new Set(rows.filter(row => isContentKind(row.kind) || row.kind === "village_added").map((r) => r.actorId).filter((v): v is string => v !== null))];
  const actorRows = actorIds.length === 0 ? [] : await db.select({ userId: profiles.userId, handle: profiles.handle, displayName: profiles.displayName, displayNameLatin: profiles.displayNameLatin, homeArea: profiles.homeArea }).from(profiles).where(inArray(profiles.userId, actorIds));
  // The translation in the display language: the body for a reply, the one line for a topic (its title, or the beginning of its body when it has no title; the rule of loadTitleDisplays). A mail cannot be switched
  // like a screen, so a translation is used even for an original in a language the reader reads (readLangs is empty: if the original language is not the display language, look for a translation; if there is none, the original).
  const [bodyPicks, lines] = await Promise.all([
    loadPickedTranslations(db, entryRows.map((e) => ({ id: e.id, kind: e.kind as "topic" | "reply", lang: e.lang as Lang, sourceHash: e.sourceHash })), displayLang, ["body"]),
    loadTitleDisplays(db, topicRows.map((t) => ({ id: t.id, lang: t.lang as Lang, title: t.title, sourceHash: t.sourceHash })), { readLangs: [], displayLang }, false),
  ]);
  const entryById = new Map(entryRows.map((e) => [e.id, e]));
  const topicById = new Map(topicRows.map((t) => [t.id, t]));
  const handles = new Map(actorRows.map((a) => [a.userId, a.handle]));
  // A mention is not told from a post whose author is suspended now (this also covers a notification that was made before the suspension began).
  const suspendedActors = new Set(
    actorIds.length === 0 ? [] : (await db.select({ userId: profiles.userId }).from(profiles).where(and(inArray(profiles.userId, actorIds), gt(profiles.suspendedUntil, now)))).map((r) => r.userId),
  );

  const actionIds = [...new Set(rows.map((r) => r.actionId).filter((v): v is number => v !== null))];
  const actions = actionIds.length === 0 ? [] : await db.select({ id: moderationActions.id, automatic: moderationActions.automatic, action: moderationActions.action, reason: moderationActions.reason, until: moderationActions.until, targetChatMessageId: moderationActions.targetChatMessageId }).from(moderationActions).where(inArray(moderationActions.id, actionIds));
  const moderatedChatIds = actions.flatMap(action => action.targetChatMessageId === null ? [] : [action.targetChatMessageId]);
  const moderatedVillages = moderatedChatIds.length ? await db.select({ messageId: chatMessages.id, slug: villages.slug, name: villages.name, language: villages.language, kind: villages.kind }).from(chatMessages).innerJoin(villages, eq(villages.id, chatMessages.villageId)).where(inArray(chatMessages.id, moderatedChatIds)) : [];
  // A village named in another language is named in the mail's language (the recipient's).
  const mailLocale: string = localeOf(profile);
  const mailReader = { displayLang: isEnabledLang(mailLocale) ? mailLocale : villageReaderOfMember(profile).displayLang, readLangs: [] };
  const moderatedVillageByMessage = new Map((await localizeVillages(db, moderatedVillages, mailReader)).map(row => [row.messageId, row]));
  const appealIds = [...new Set(rows.map((r) => r.appealId).filter((v): v is number => v !== null))];
  const appealRows = appealIds.length === 0 ? [] : await db.select({ id: appeals.id, status: appeals.status, reversed: appeals.reversed }).from(appeals).where(inArray(appeals.id, appealIds));
  const actionById = new Map(actions.map((a) => [a.id, a]));
  const appealById = new Map(appealRows.map((a) => [a.id, a]));
  const chatRows = rows.filter(row => row.kind === "chat_mention");

  for (const row of rows) {
    const kind = row.kind as NotificationKind;
    if (kind === "chat_mention" || kind === "village_invite" || kind === "translation_report_result") continue;
    if (kind === "village_added" || kind === "village_removed" || kind === "village_owner_changed") {
      if (!villagesEnabled()) { suppressed.add(row.id); continue; }
      // The detailed reason and invitation remain on the authenticated screen.
      items.set(row.id, { kind, url: siteUrl("/notifications"), ...(kind === "village_added" ? { handle: (row.actorId ? handles.get(row.actorId) : null) ?? DELETED_MEMBER_HANDLE, name: selectDisplayName(actorRows.find(actor => actor.userId === row.actorId), localeOf(profile)) } : {}) });
      continue;
    }
    if (kind === "followed_thread") {
      // The topic must be readable (a hidden or deleted topic is not mailed: nothing may be shown). When only the latest reply is hidden or deleted, the mail says how many
      // replies there are without the author and the excerpt; its destination still starts at the first readable unread reply.
      const topic = row.threadId !== null ? topicById.get(row.threadId) : undefined;
      if (!topic || topic.deletedAt || topic.hiddenAt) {
        suppressed.add(row.id);
        continue;
      }
      const entry = row.entryId !== null ? entryById.get(row.entryId) : undefined;
      // The one line that names the topic (its title, or the beginning of its body when it has no title), in the recipient's display language.
      const title = lines.get(topic.id)?.text;
      if (!entry || entry.deletedAt || entry.hiddenAt) {
        items.set(row.id, { kind, count: row.mergedCount, title, url: siteUrl(followedHrefs.get(row.id) ?? `/t/${topic.id}`) });
        continue;
      }
      const bodyText = bodyPicks.get(entry.id)?.body?.text;
      items.set(row.id, {
        kind,
        count: row.mergedCount,
        handle: row.actorId ? (handles.get(row.actorId) ?? "?") : "?",
        title,
        excerpt: (await plainExcerpt(bodyText ?? entry.body, EXCERPT_CHARS)),
        url: siteUrl(followedHrefs.get(row.id) ?? `/t/${topic.id}`),
      });
      continue;
    }
    if (kind === "reply_to_topic" || kind === "reply_to_reply" || kind === "mention" || kind === "response_to_topic") {
      const entry = row.entryId !== null ? entryById.get(row.entryId) : undefined;
      const topic = kind === "response_to_topic" && row.threadId !== null ? topicById.get(row.threadId) : entry ? topicById.get(entry.threadId ?? entry.id) : undefined;
      // Suppress email if either reply or topic is deleted/hidden, exposing no content.
      if (!entry || !topic || entry.deletedAt || entry.hiddenAt || topic.deletedAt || topic.hiddenAt || kind === "response_to_topic" && (!entry.publicPlace || !topic.publicPlace)) {
        suppressed.add(row.id);
        continue;
      }
      if (kind === "mention" && row.actorId !== null && suspendedActors.has(row.actorId)) {
        suppressed.add(row.id);
        continue;
      }
      const threadId = entry.threadId ?? entry.id;
      // A mention in a topic points at the topic itself; everything else at the reply.
      const target = replyLocations.get(entry.id);
      const location = entry.id === threadId ? `/t/${threadId}` : target?.state === "visible" ? target.href : `/t/${threadId}`;
      // Use a current-source translation in the recipient's display language if present, otherwise the source (also source if its language matches display language). Prefer translations even for readable source languages,
      // since email cannot toggle like the UI and prioritizes the display language.
      const bodyText = bodyPicks.get(entry.id)?.body?.text;
      const body = bodyText ?? entry.body;
      const excerptBody = kind === "response_to_topic" ? parseResponsePost(body)?.body ?? body : body;
      items.set(row.id, {
        kind,
        handle: row.actorId ? (handles.get(row.actorId) ?? "?") : "?",
        title: lines.get(topic.id)?.text,
        ...(kind !== "mention" && entry.lang !== profile.homeArea ? { replyLanguage: entry.lang as Lang } : {}),
        excerpt: (await plainExcerpt(excerptBody, EXCERPT_CHARS)),
        url: siteUrl(location),
      });
      continue;
    }
    const action = row.actionId !== null ? actionById.get(row.actionId) : undefined;
    const appeal = row.appealId !== null ? appealById.get(row.appealId) : undefined;
    items.set(row.id, {
      kind,
      url: siteUrl(action?.action === "hide_chat" ? `/appeal/${action.id}` : "/notifications"),
      ...(action?.targetChatMessageId ? { villageName: (() => { const village = moderatedVillageByMessage.get(action.targetChatMessageId); return village ? chatMailVillageName(village, localeOf(profile)) : undefined; })() } : {}),
      ...(action?.automatic ? { automatic: true } : {}),
      action: action ? (action.action as ModerationAction) : null,
      reason: action && isReason(action.reason) ? action.reason : null,
      until: action?.until ?? null,
      appealStatus: appeal ? (appeal.status as AppealStatus) : null,
      appealReversed: appeal?.reversed ?? null,
    });
  }
  // Recheck chat after any asynchronous post excerpt work, immediately before delivery.
  const chatLocations = chatRows.length ? await chatNotificationLocations(db, chatRows.map(row => ({ id: row.id, villageId: row.villageId, chatMessageId: row.chatMessageId ?? null })), profile.userId, now) : new Map<number, ChatNotificationLocation>();
  for (const row of chatRows) {
    const location = chatLocations.get(row.id);
    if (!location) { suppressed.add(row.id); continue; }
    items.set(row.id, { kind: "chat_mention", url: siteUrl(`/v/${location.slug}/chat?at=${location.id}#chat-${location.id}`), villageName: chatMailVillageName(await localizeVillage(db, location, mailReader), localeOf(profile)) });
  }
  // Recheck invitations after asynchronous content work, immediately before delivery.
  const inviteRows = rows.filter(row => row.kind === "village_invite");
  const inviteIds = inviteRows.flatMap(row => row.villageInviteId === null ? [] : [row.villageInviteId]);
  const pendingInvites = villagesEnabled() && inviteIds.length ? await db.select({ id: villageInvites.id, villageId: villageInvites.villageId }).from(villageInvites)
    .innerJoin(villages, eq(villages.id, villageInvites.villageId))
    .where(and(inArray(villageInvites.id, inviteIds), eq(villageInvites.userId, profile.userId), eq(villageInvites.state, "pending"), activeSharedVillageCondition(),
      sql`exists (select 1 from village_members as mail_inviter where mail_inviter.village_id = ${villageInvites.villageId} and mail_inviter.user_id = ${villageInvites.invitedBy} and mail_inviter.role = 'owner')`)) : [];
  const pendingById = new Map(pendingInvites.map(invite => [invite.id, invite.villageId]));
  for (const row of inviteRows) {
    if (row.villageInviteId === null || !pendingById.has(row.villageInviteId) || pendingById.get(row.villageInviteId) !== row.villageId) { suppressed.add(row.id); continue; }
    items.set(row.id, { kind: "village_invite", url: siteUrl("/notifications") });
  }
  // Result notices contain no report text or reviewer identity. Reload their
  // permissions after all other asynchronous assembly, immediately before mail.
  for (const row of rows.filter(row => row.kind === "translation_report_result")) {
    const [notice] = (await listNotifications(db, profile.userId, { id: row.id, limit: 1, display: { readLangs: [], displayLang } })).items;
    const href = notice && !notice.unavailable ? await notificationHref(db, notice) : null;
    if (!notice?.translationResult || !href) { suppressed.add(row.id); continue; }
    items.set(row.id, { kind: "translation_report_result", translationResult: notice.translationResult, title: notice.topicTitle ?? undefined, url: siteUrl(href) });
  }
  if (webPushEnabled()) {
    const immediate = rows.filter(row => items.has(row.id) && (AUTO_IMMEDIATE_KINDS as readonly string[]).includes(row.kind));
    const allowed = await immediateNotifications(db, profile.userId, immediate.map(row => row.id), now);
    for (const row of immediate) if (!allowed.has(row.id)) { items.delete(row.id); suppressed.add(row.id); }
  }
  return { items, suppressed };
}

async function loadRecipient(db: Db, userId: string): Promise<Recipient | null> {
  const profile = await getProfile(db, userId);
  if (!profile) return null;
  const [account] = await db.select({ email: user.email }).from(user).where(eq(user.id, userId));
  return account ? { profile, email: account.email } : null;
}

const localeOf = (profile: Profile) => memberMailLocale(profile.uiLocale, profile.homeArea);
const settingsUrl = () => siteUrl("/settings");

// ---- Jobs ----

const emailPayload = z.object({ notificationId: z.number().int().positive() });
const digestPayload = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });
const memberDigestPayload = digestPayload.extend({ userId: z.string().min(1) });

export type NotificationJobDeps = { mailer?: () => Mailer };

export function createNotificationHandlers(deps: NotificationJobDeps = {}): JobHandlers {
  const mailer = deps.mailer ?? getMailer;

  // Immediate email: skip already emailed notifications and members no longer preferring immediate. Digests pick them up if the preference changed to daily.
  // Immediate email of one notification. It is not sent when the notification was already mailed, or when its actual mode is no longer `immediate` (the preference changed; a
  // member who moved to `daily` gets it in the digest).
  const sendOne: JobHandler = async (job, ctx) => {
    const { db } = ctx;
    const parsed = emailPayload.safeParse(job.payload);
    if (!parsed.success) throw new Error(`Invalid ${job.kind} payload`);
    const [row] = await db.select(notificationColumns()).from(notifications).where(eq(notifications.id, parsed.data.notificationId));
    if (!row || row.emailedAt || (row.kind === "followed_thread" && row.readAt)) return;
    const recipient = await loadRecipient(db, row.userId);
    if (!recipient || effectiveEmailMode(recipient.profile.emailPref, row.kind as NotificationKind) !== "immediate") return;
    const { items, suppressed } = await buildItems(db, [row], recipient, ctx.now);
    const item = items.get(row.id);
    if (item) {
      await mailer().send(notificationMail({ to: recipient.email, locale: localeOf(recipient.profile), item, settingsUrl: settingsUrl() }));
    }
    if (item || suppressed.has(row.id)) {
      // Mark only if the notification still points at the reply that was read: a reply merged into a followed_thread row while this job was sending moves entry_id on and sets
      // emailed_at back to NULL, and the mark must not swallow that reply.
      await db
        .update(notifications)
        .set({ emailedAt: ctx.now })
        .where(and(eq(notifications.id, row.id), isNull(notifications.emailedAt), sql`${notifications.entryId} is not distinct from ${row.entryId}`));
      // Look at the notification again, whether or not the mark took: if another reply was merged into it while this job was sending (the mark did not take), or right after
      // the mark, then emailed_at is NULL again and entry_id has moved on. Re-enqueueing while this job is running persists a new run_at revision, including after this check:
      // run this same job again after the delay, which reads the latest reply and sends it (attempts do not grow: this is not a failure).
      // (A member who already read the topic in the meantime does not need another email.)
      const [again] = await db
        .select({ emailedAt: notifications.emailedAt, readAt: notifications.readAt, entryId: notifications.entryId })
        .from(notifications)
        .where(eq(notifications.id, row.id));
      if (again && again.emailedAt === null && again.readAt === null && again.entryId !== row.entryId) {
        throw new DeferJob(new Date(ctx.now.getTime() + notificationEmailDelaySeconds() * 1000), "followed_thread merged while sending");
      }
    }
  };

  const pendingConditions = (date: string, now: Date) => {
    const before = new Date(`${date}T00:00:00Z`);
    const since = new Date(now.getTime() - DIGEST_WINDOW_DAYS * DAY_MS);
    const autoImmediateKinds = villageChatEnabled() ? [...AUTO_IMMEDIATE_KINDS] : AUTO_IMMEDIATE_KINDS.filter(kind => kind !== "chat_mention");
    return and(
      or(eq(profiles.emailPref, "daily"), and(eq(profiles.emailPref, "auto"), notInArray(notifications.kind, autoImmediateKinds))),
      isNull(notifications.emailedAt), isNull(notifications.readAt),
      gt(notifications.createdAt, since), lt(notifications.createdAt, before),
    );
  };

  // Fan out in bounded pages of member IDs, never loading everyone's content or
  // sending mail in this job. Completed child keys also prevent duplicate fanout.
  const sendDigest: JobHandler = async (job, ctx) => {
    const { db, now } = ctx;
    const payload = digestPayload.parse(job.payload);
    await ensureDigestScheduled(db, now);
    let cursor: string | undefined;
    for (;;) {
      const members = await db.selectDistinct({ userId: notifications.userId }).from(notifications)
        .innerJoin(profiles, eq(profiles.userId, notifications.userId))
        .where(and(pendingConditions(payload.date, now), cursor === undefined ? undefined : gt(notifications.userId, cursor),
          sql`not exists (select 1 from ${jobs} as digest_job where digest_job.kind = ${SEND_MEMBER_DIGEST_JOB} and digest_job.dedupe_key = ${`digest:${payload.date}:`} || ${notifications.userId})`))
        .orderBy(asc(notifications.userId)).limit(200);
      if (!members.length) break;
      for (const { userId } of members) {
        await enqueue(db, SEND_MEMBER_DIGEST_JOB, { date: payload.date, userId }, { dedupeKey: `digest:${payload.date}:${userId}`, runAt: now });
      }
      cursor = members[members.length - 1].userId;
    }
  };

  const sendMemberDigest: JobHandler = async (job, ctx) => {
    const { db, now } = ctx;
    const parsed = memberDigestPayload.safeParse(job.payload);
    if (!parsed.success) throw Object.assign(new Error(`Invalid ${job.kind} payload`), { retryable: false });
    const { date, userId } = parsed.data;
    const rows = await db.select(notificationColumns()).from(notifications)
      .innerJoin(profiles, eq(profiles.userId, notifications.userId))
      .where(and(eq(notifications.userId, userId), pendingConditions(date, now)))
      .orderBy(asc(notifications.createdAt), asc(notifications.id));
    if (!rows.length) return;
    const recipient = await loadRecipient(db, userId);
    if (!recipient) return;
    const { items, suppressed } = await buildItems(db, rows, recipient, now);
    const ordered = rows.filter((r) => items.has(r.id)).map((r) => items.get(r.id)!);
    if (ordered.length > 0) {
      const shown = ordered.slice(0, DIGEST_MAX_ITEMS);
      await mailer().send(
        digestMail({
          to: recipient.email,
          locale: localeOf(recipient.profile),
          items: shown,
          more: ordered.length - shown.length,
          allUrl: siteUrl("/notifications"),
          settingsUrl: settingsUrl(),
        }),
      );
    }
    // Mark both sent and suppressed notifications, whose content was hidden/deleted.
    // A followed_thread row is marked only while it still points at the reply that was mailed (another reply may have been merged into it since it was read: it then
    // stays unsent for the next digest). The other kinds never change after they are made.
    const done = rows.filter((r) => items.has(r.id) || suppressed.has(r.id));
    const plain = done.filter((r) => r.kind !== "followed_thread").map((r) => r.id);
    if (plain.length > 0) await db.update(notifications).set({ emailedAt: now }).where(and(inArray(notifications.id, plain), isNull(notifications.emailedAt)));
    for (const r of done.filter((x) => x.kind === "followed_thread")) {
      await db
        .update(notifications)
        .set({ emailedAt: now })
        .where(and(eq(notifications.id, r.id), isNull(notifications.emailedAt), sql`${notifications.entryId} is not distinct from ${r.entryId}`));
    }
  };

  return { [SEND_NOTIFICATION_EMAIL_JOB]: sendOne, [SEND_DIGEST_JOB]: sendDigest, [SEND_MEMBER_DIGEST_JOB]: sendMemberDigest };
}
