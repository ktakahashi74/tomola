import { memberAvatarUrl } from "./member-avatar.server";
import { selectDisplayName } from "./display-names.server";
import { inspectChatSpam, lockAbuseWriter } from "./moderation-automation.server";
import { chatVillageCondition } from "./village-chat-villages.server";
import { randomBytes } from "node:crypto";
import { chatMentionTargets, resolveChatMentions, saveChatMentions } from "./village-chat-mentions.server";
import { normalizeNewlines } from "./text";
import { and, asc, desc, eq, gt, isNull, lt, lte, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "./db/client.server";
import { chatConsents, chatMessages, chatReads, chatSequences, notifications, profiles, villageMembers, villages } from "./db/schema";
import { CHAT_CONSENT_VERSION } from "./village-chat-consent";
import { villageChatEnabled } from "./village-chat-enabled.server";
import { publicVillage } from "./villages.server";
import { detectLang } from "./lang-detect.core.server";
import { defaultUiLocale, isEnabledLang } from "./enabled-langs.server";
import { getWriter } from "./members.server";
import { signalVillageChat } from "./village-chat-events.server";
import { CHAT_BODY_MAX, ChatError, chatParts, type ChatMessage, type ChatMentionTarget } from "./village-chat";
import { nextChatSequence } from "./village-chat-sequence.server";
import { deleteChatRows } from "./village-chat-delete.server";
import { addChatTopicCards, type ChatTopicOptions } from "./village-chat-topics.server";
import { chatTranslationsFor, clearChatTranslations, enqueueChatTranslations } from "./village-chat-translations.server";

export { ChatError } from "./village-chat";
export { nextChatSequence } from "./village-chat-sequence.server";
const bodySchema = z.preprocess(value => typeof value === "string" ? normalizeNewlines(value) : value, z.string().trim().min(1).max(CHAT_BODY_MAX));
const scope = (villageId: string, userId: string) => and(eq(villageMembers.villageId, villageId), eq(villageMembers.userId, userId));
export async function chatAccess(db: Db, slug: string, userId: string) {
  if (!villageChatEnabled()) return null;
  const [row] = await db.select({ village: villages, version: chatConsents.version }).from(villageMembers).innerJoin(villages, eq(villages.id, villageMembers.villageId))
    .innerJoin(profiles, eq(profiles.userId, villageMembers.userId))
    .leftJoin(chatConsents, and(eq(chatConsents.villageId, villages.id), eq(chatConsents.userId, villageMembers.userId)))
    .where(and(eq(villageMembers.userId, userId), eq(villages.slug, slug.toLowerCase()), chatVillageCondition()));
  return row ? { village: row.village, consented: row.version === CHAT_CONSENT_VERSION, previousConsentVersion: row.version } : null;
}

// Lock the village before the member, matching lifecycle operations. Never lock profiles.
async function lockAccess(db: Db, slug: string, userId: string, intent?: { consentVersion: unknown }) {
  if (!villageChatEnabled()) throw new ChatError("not_found");
  const [village] = await db.select().from(villages).where(and(eq(villages.slug, slug.toLowerCase()), chatVillageCondition())).for("share");
  if (!village) throw new ChatError("not_found");
  const [member] = await db.select().from(villageMembers).where(scope(village.id, userId)).for("share");
  if (!member) throw new ChatError("not_found");
  if (intent) {
    // A form opened before the wording changes cannot consent to the new version.
    if (intent.consentVersion !== String(CHAT_CONSENT_VERSION)) throw new ChatError("invalid");
    await db.insert(chatConsents).values({ villageId: village.id, userId, version: CHAT_CONSENT_VERSION })
      .onConflictDoUpdate({ target: [chatConsents.villageId, chatConsents.userId], set: { version: CHAT_CONSENT_VERSION, consentedAt: new Date() } });
  } else {
    const [consent] = await db.select({ version: chatConsents.version }).from(chatConsents)
      .where(and(eq(chatConsents.villageId, village.id), eq(chatConsents.userId, userId)));
    if (consent?.version !== CHAT_CONSENT_VERSION) throw new ChatError("not_found");
  }
  return village;
}

export async function acceptChatConsent(db: Db, userId: string, slug: string, version: unknown = String(CHAT_CONSENT_VERSION)): Promise<void> {
  await db.transaction(async tx => { await lockAccess(tx, slug, userId, { consentVersion: version }); });
}

export async function currentChatSequence(db: Db, villageId: string): Promise<number> {
  const [row] = await db.select({ seq: chatSequences.seq }).from(chatSequences).where(eq(chatSequences.villageId, villageId));
  return row?.seq ?? 0;
}
async function lockRead(db: Db, villageId: string, userId: string) {
  await db.insert(chatReads).values({ villageId, userId }).onConflictDoNothing();
  await db.select({ seq: chatReads.seq }).from(chatReads).where(and(eq(chatReads.villageId, villageId), eq(chatReads.userId, userId))).for("update");
}
async function advanceRead(db: Db, villageId: string, userId: string, seq: number) {
  await db.update(chatReads).set({ seq: sql`greatest(${chatReads.seq}, ${seq})` }).where(and(eq(chatReads.villageId, villageId), eq(chatReads.userId, userId)));
  // Read cursors and mention notices describe the same member's progress in this village.
  const cleared = await db.update(notifications).set({ readAt: new Date() }).where(and(
    eq(notifications.userId, userId), eq(notifications.kind, "chat_mention"), eq(notifications.villageId, villageId), isNull(notifications.readAt),
    sql`exists (select 1 from ${chatMessages} where ${chatMessages.id} = ${notifications.chatMessageId}
      and ${chatMessages.villageId} = ${villageId} and ${chatMessages.createdSeq} <= ${seq})`,
  )).returning({ id: notifications.id });
  return cleared.length;
}

export async function mutateChat(db: Db, userId: string, slug: string, intent: "send" | "edit" | "delete", input: { body?: unknown; id?: unknown }) {
  const body = intent === "delete" ? null : bodySchema.safeParse(input.body);
  if (body && !body.success) throw new ChatError("invalid");
  const result = await db.transaction(async tx => {
    await lockAbuseWriter(tx, userId);
    const village = await lockAccess(tx, slug, userId);
    const writer = await getWriter(tx, userId);
    if (!writer.ok && (intent !== "delete" || writer.reason === "not_a_member")) throw new ChatError("forbidden");
    if (intent !== "delete" && village.endedAt) throw new ChatError("ended");
    let message: typeof chatMessages.$inferSelect | undefined;
    if (intent !== "send") {
      if (typeof input.id !== "string") throw new ChatError("invalid");
      [message] = await tx.select().from(chatMessages).where(and(eq(chatMessages.villageId, village.id), eq(chatMessages.id, input.id), eq(chatMessages.authorId, userId))).for("update");
      if (!message || (intent === "edit" && (message.deletedAt || message.hiddenAt))) throw new ChatError("not_found");
      if (message.deletedAt) return { villageId: village.id, seq: message.changedSeq, id: message.id };
    }
    if (intent === "delete") {
      const result = await deleteChatRows(tx, village.id, userId, message!.id);
      return { villageId: village.id, seq: result.seq, id: message!.id };
    }
    const text = body?.success ? body.data : "";
    if (!writer.ok) throw new ChatError("forbidden");
    const detected = detectLang(text, writer.profile.homeArea);
    const lang = isEnabledLang(detected) ? detected : isEnabledLang(writer.profile.homeArea) ? writer.profile.homeArea : defaultUiLocale();
    const id = message?.id ?? randomBytes(16).toString("hex");
    const now = new Date();
    const targets = await resolveChatMentions(tx, village.id, text);
    await saveChatMentions(tx, { messageId: id, villageId: village.id, authorId: userId, targets, now, isNew: intent === "send" });
    if (message && (message.body !== text || message.lang !== lang)) {
      await clearChatTranslations(tx, [id]);
      await enqueueChatTranslations(tx, { ...message, body: text, lang: lang! });
    }
    const seq = await nextChatSequence(tx, village.id);
    if (intent === "send") {
      const [sent] = await tx.insert(chatMessages).values({ id, villageId: village.id, authorId: userId, lang: lang!, body: text, createdSeq: seq, changedSeq: seq }).returning();
      const hidden = await inspectChatSpam(tx, sent, now);
      if (!hidden) await enqueueChatTranslations(tx, sent);
      return { villageId: village.id, seq, id };
    }
    const [edited] = await tx.update(chatMessages).set({ body: text, lang, editedAt: new Date(), changedSeq: seq }).where(eq(chatMessages.id, message!.id)).returning();
    if (await inspectChatSpam(tx, edited, now)) await clearChatTranslations(tx, [edited.id]);
    return { villageId: village.id, seq, id: message!.id };
  }).catch(error => {
    if (error instanceof ChatError) throw error;
    // SQL errors may contain bound message text; never propagate it to request logs.
    throw new Error("Village chat write failed");
  });
  signalVillageChat(result.villageId, result.seq);
  return result;
}

export async function markChatRead(db: Db, userId: string, slug: string, seq: number): Promise<number> {
  if (!Number.isSafeInteger(seq) || seq < 0) throw new ChatError("invalid");
  return db.transaction(async tx => {
    const village = await lockAccess(tx, slug, userId);
    // A forged cursor cannot mark future messages as read.
    const [last] = await tx.select({ seq: chatMessages.createdSeq }).from(chatMessages)
      .where(and(eq(chatMessages.villageId, village.id), lte(chatMessages.createdSeq, seq))).orderBy(desc(chatMessages.createdSeq)).limit(1);
    await lockRead(tx, village.id, userId);
    return advanceRead(tx, village.id, userId, last?.seq ?? 0);
  });
}

function messagesQuery(db: Db) {
  return db.select({ message: chatMessages, author: profiles.handle, publicId: profiles.publicId, avatarMediaId: profiles.avatarMediaId, displayName: profiles.displayName, displayNameLatin: profiles.displayNameLatin, homeArea: profiles.homeArea }).from(chatMessages)
    .leftJoin(profiles, eq(profiles.userId, chatMessages.authorId)).$dynamic();
}
function present(row: { message: typeof chatMessages.$inferSelect; author: string | null; publicId: string | null; avatarMediaId: string | null; displayName: string | null; displayNameLatin: string | null; homeArea: string | null }, userId: string, targets?: ReadonlyMap<string, ChatMentionTarget>): ChatMessage {
  const m = row.message;
  if (m.deletedAt) return { id: m.id, createdSeq: m.createdSeq, changedSeq: m.changedSeq, deleted: true };
  const name = selectDisplayName(row), handle = row.author ?? "";
  return { id: m.id, author: handle, authorName: name, avatarUrl: memberAvatarUrl(row), own: m.authorId === userId, lang: m.lang,
    parts: m.hiddenAt ? [] : chatParts(m.body, targets), createdSeq: m.createdSeq, changedSeq: m.changedSeq,
    createdAt: m.createdAt.toISOString(), edited: !!m.editedAt, deleted: false, hidden: !!m.hiddenAt, translation: null };
}

async function hasLaterMessages(db: Db, villageId: string, after: number): Promise<boolean> {
  const rows = await db.select({ id: chatMessages.id }).from(chatMessages)
    .where(and(eq(chatMessages.villageId, villageId), isNull(chatMessages.deletedAt), gt(chatMessages.createdSeq, after))).limit(1);
  return rows.length > 0;
}

// Count only this conversation on ordinary polls; the joined-village scan is opt-in.
async function windowUnread(db: Db, villageId: string, userId: string, after: number) {
  const countAfter = (cursor: number) => sql<number>`(select count(*)::int from
    (select 1 from chat_messages cm where cm.village_id = ${villageId}
      and cm.created_seq > greatest(${cursor}, coalesce((select cr.seq from chat_reads cr where cr.village_id = ${villageId} and cr.user_id = ${userId}), 0))
      and cm.author_id <> ${userId} and cm.deleted_at is null and cm.hidden_at is null limit 100) capped)`;
  const [row] = await db.select({ unread: countAfter(0), unreadAfter: countAfter(after) }).from(villages).where(eq(villages.id, villageId));
  return { unread: Number(row?.unread ?? 0), unreadAfter: Number(row?.unreadAfter ?? 0) };
}

export async function chatPage(db: Db, userId: string, slug: string, opts: { before?: number; after?: number; at?: string; unread?: boolean; topics?: ChatTopicOptions } = {}) {
  const access = await chatAccess(db, slug, userId);
  if (!access) return null;
  const { village } = access;
  if (!access.consented) return { consentRequired: true as const, consentVersion: CHAT_CONSENT_VERSION, previousConsentVersion: access.previousConsentVersion, village: publicVillage(village) };
  const seq = await currentChatSequence(db, village.id);
  const [read] = await db.select({ seq: chatReads.seq }).from(chatReads).where(and(eq(chatReads.villageId, village.id), eq(chatReads.userId, userId)));
  const visible = and(eq(chatMessages.villageId, village.id), isNull(chatMessages.deletedAt));
  const firstUnread = async () => (await db.select({ seq: chatMessages.createdSeq }).from(chatMessages).where(and(visible,
    isNull(chatMessages.hiddenAt), sql`${chatMessages.authorId} <> ${userId}`, gt(chatMessages.createdSeq, read?.seq ?? 0),
  )).orderBy(asc(chatMessages.createdSeq)).limit(1))[0];
  let target: { seq: number } | undefined = opts.at ? (await db.select({ seq: chatMessages.createdSeq }).from(chatMessages).where(and(visible, eq(chatMessages.id, opts.at))))[0] : undefined;
  let readFrom: number | null = null;
  const unreadOpening = !target && opts.unread && opts.before === undefined && opts.after === undefined && !opts.at;
  if (unreadOpening) {
    // Include the first unread even when it has fallen outside the newest fifty messages.
    target = await firstUnread();
    const newest = await db.select({ seq: chatMessages.createdSeq }).from(chatMessages).where(visible).orderBy(desc(chatMessages.createdSeq)).limit(50);
    if (target && target.seq >= (newest.at(-1)?.seq ?? 0)) target = undefined;
  }
  let rows;
  if (opts.after !== undefined) {
    rows = await messagesQuery(db).where(and(visible, gt(chatMessages.createdSeq, opts.after))).orderBy(asc(chatMessages.createdSeq)).limit(50);
  } else if (target) {
    const older = await messagesQuery(db).where(and(visible, lte(chatMessages.createdSeq, target.seq))).orderBy(desc(chatMessages.createdSeq)).limit(26);
    const newer = await messagesQuery(db).where(and(visible, gt(chatMessages.createdSeq, target.seq))).orderBy(asc(chatMessages.createdSeq)).limit(25);
    rows = [...older.reverse(), ...newer];
  } else {
    rows = (await messagesQuery(db).where(and(visible, opts.before === undefined ? undefined : lt(chatMessages.createdSeq, opts.before))).orderBy(desc(chatMessages.createdSeq)).limit(50)).reverse();
  }
  if (unreadOpening) {
    // Recheck after fetching: an arrival or restored message may have moved outside the window.
    const unread = await firstUnread();
    if (!unread || rows.some(row => row.message.createdSeq === unread.seq && !row.message.hiddenAt)) readFrom = read?.seq ?? 0;
  }
  const first = rows[0]?.message.createdSeq;
  const previous = first ? await db.select({ id: chatMessages.id }).from(chatMessages).where(and(visible, lt(chatMessages.createdSeq, first))).limit(1) : [];
  const historical = opts.before !== undefined || opts.after !== undefined || !!target;
  const hasNewer = historical ? await hasLaterMessages(db, village.id, rows.at(-1)?.message.createdSeq ?? opts.after ?? 0) : false;
  const targets = await chatMentionTargets(db, rows.filter(row => !row.message.hiddenAt).map(row => row.message.id));
  const translations = await chatTranslationsFor(db, village.id, userId, rows.map(row => row.message));
  const messages = await addChatTopicCards(db, rows.map(row => {
    const message = present(row, userId, targets.get(row.message.id));
    return message.deleted ? message : { ...message, translation: translations.get(message.id) ?? null };
  }), opts.topics);
  const { unreadAfter } = await windowUnread(db, village.id, userId, rows.at(-1)?.message.createdSeq ?? opts.after ?? 0);
  return { consentRequired: false as const, historical, hasNewer, unreadAfter, village: publicVillage(village), ended: !!village.endedAt, messages, seq, readSeq: read?.seq ?? 0, readFrom, before: previous.length ? first : null };
}

export async function chatChanges(db: Db, userId: string, slug: string, opts: { since: number; before?: number; after?: number; forward?: number; counts?: boolean; topics?: ChatTopicOptions }) {
  const access = await chatAccess(db, slug, userId);
  if (!access?.consented) throw new ChatError("not_found");
  const { village } = access;
  // Read the committed horizon first. Never advance past a write omitted by the row query.
  const horizon = await currentChatSequence(db, village.id);
  const older = opts.before !== undefined;
  const forward = opts.forward !== undefined;
  const rows = await messagesQuery(db).where(and(eq(chatMessages.villageId, village.id), older
    ? and(lt(chatMessages.createdSeq, opts.before!), isNull(chatMessages.deletedAt))
    : forward ? and(gt(chatMessages.createdSeq, opts.forward!), lte(chatMessages.createdSeq, horizon), isNull(chatMessages.deletedAt))
    : and(gt(chatMessages.changedSeq, opts.since), lte(chatMessages.changedSeq, horizon))))
    .orderBy(older ? desc(chatMessages.createdSeq) : forward ? asc(chatMessages.createdSeq) : asc(chatMessages.changedSeq)).limit(older || forward ? 51 : 101);
  const limit = older || forward ? 50 : 100;
  const more = rows.length > limit;
  const selected = rows.slice(0, limit);
  const targets = await chatMentionTargets(db, selected.filter(row => !row.message.deletedAt && !row.message.hiddenAt).map(row => row.message.id));
  const translations = await chatTranslationsFor(db, village.id, userId, selected.map(row => row.message));
  const end = forward ? selected.at(-1)?.message.createdSeq ?? opts.forward! : opts.after;
  const hasNewer = end === undefined ? {} : { hasNewer: await hasLaterMessages(db, village.id, end) };
  const counts = await windowUnread(db, village.id, userId, end ?? horizon);
  const allCounts = opts.counts ? { unreadCounts: Object.fromEntries(await chatUnreadCounts(db, userId, { excludeEnded: true })) } : {};
  const messages = await addChatTopicCards(db, (older ? [...selected].reverse() : selected).map(row => {
    const message = present(row, userId, targets.get(row.message.id));
    return message.deleted ? message : { ...message, translation: translations.get(message.id) ?? null };
  }), opts.topics);
  return { ...hasNewer, messages, ...counts, ...allCounts,
    next: older || forward ? opts.since : more ? selected.at(-1)!.message.changedSeq : Math.max(opts.since, horizon),
    more, before: older && more ? selected.at(-1)?.message.createdSeq ?? null : null, ended: !!village.endedAt };
}

// One query for every joined village, with each correlated scan capped at 100 rows.
async function loadChatUnreadCounts(db: Db, userId: string, options: { excludeEnded?: boolean; villageId?: string }): Promise<Map<string, number>> {
  if (!villageChatEnabled()) return new Map();
  const rows = await db.select({ slug: villages.slug, unread: sql<number>`(select count(*)::int from
    (select 1 from chat_messages cm where cm.village_id = ${villages.id}
      and cm.created_seq > coalesce((select cr.seq from chat_reads cr where cr.village_id = ${villages.id} and cr.user_id = ${userId}), 0)
      and cm.author_id <> ${userId} and cm.deleted_at is null and cm.hidden_at is null limit 100) capped)` })
    .from(villageMembers).innerJoin(villages, eq(villages.id, villageMembers.villageId))
    .innerJoin(chatConsents, and(eq(chatConsents.villageId, villages.id), eq(chatConsents.userId, villageMembers.userId), eq(chatConsents.version, CHAT_CONSENT_VERSION)))
    .where(and(eq(villageMembers.userId, userId), chatVillageCondition(), options.villageId !== undefined ? eq(villages.id, options.villageId) : undefined, options.excludeEnded ? isNull(villages.endedAt) : undefined));
  return new Map(rows.map(row => [row.slug!, Number(row.unread)]));
}

export function chatUnreadCounts(db: Db, userId: string, options: { excludeEnded?: boolean } = {}): Promise<Map<string, number>> {
  return loadChatUnreadCounts(db, userId, options);
}

// Match membership, consent and visibility rules while scanning just the requested village.
export async function chatUnreadCount(db: Db, userId: string, villageId: string): Promise<number> {
  const counts = await loadChatUnreadCounts(db, userId, { villageId });
  return counts.values().next().value ?? 0;
}
