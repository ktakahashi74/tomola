import type { DisplayNames } from "./display-names.server";
import { avatarAppealUrl } from "./avatar-moderation.server";
import { finishChatVisibility, lockChatReportTarget, prepareChatReversal, type ChatVisibilityChange } from "./village-chat-reports.server";
import { signalVillageChat } from "./village-chat-events.server";
import { and, asc, eq, getTableColumns, gt, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { withMarkdownRestore } from "./markdown-budget.server";
import { isPrunedRevision } from "./retention";
import type { Db, Tx } from "~/lib/db/client.server";
import { appeals, entries, entryRevisions, moderationActions, profiles, reports, chatReportSnapshots, villageMembers, villageEvents, villages } from "~/lib/db/schema";
import { applyEntryEdit, hasNul, recomputeThreadActivity, renderEntryHtml } from "~/lib/entries.server";
import { isSourceLang, type SourceLang } from "~/lib/languages";
import { APPEALABLE_ACTIONS, isReason, type AppealStatus, type ModerationAction, type ReportReason } from "~/lib/moderation";
import { readMentionBindings, resolveSourceMentions } from "~/lib/mentions.server";
import { latestEntryAction, lockEntry, lockMember } from "~/lib/moderation.server";
import { createAppealNotification } from "~/lib/notifications.server";
import { inLanguageScope, isModerator, type ModScope } from "~/lib/roles.server";
import { enqueueEmbedding } from "~/lib/embeddings.server";
import { touchAltOriginal } from "~/lib/questions.server";
import { lockReferenceTopics, touchReferenceTopics } from "~/lib/related-discussions.server";
import { enqueueTranslations, replaceSegments } from "~/lib/translations.server";

import { lockVillageSlugClaims } from "~/lib/village-slugs.server";
import { isVillageOwner, lockVillageActor, lockModeratedVillage, reverseVillageAction, villageAppealMetadata, type VillageMetadata } from "~/lib/village-moderation.server";

// Appeals.
// - The subject of an action (hide, delete, suspend, exclude_reactions, fix_entry) may appeal once per action: the entry author, suspended member, member whose stances and 「なるほど」 are excluded from counts, or author of an edited pinned question.
//   Suspended members may still appeal.
// - A moderator for any language or an operator reviews the appeal. The person who took the action cannot review it, nor can the appellant review their own appeal.
//   Decide upheld or overturned. Overturning automatically reverses the action (unhide, unsuspend, restore deleted entries, and requeue translations)
//   and records a new opposing action (unhide, unsuspend, restore). Reverse only if the original action's effect still persists.
//   Notify the appellant of the result (appeal_decided).

export const MAX_APPEAL_TEXT = 2000;
export const MAX_DECISION_NOTE = 1000;

const isAppealable = (action: string): action is (typeof APPEALABLE_ACTIONS)[number] => (APPEALABLE_ACTIONS as readonly string[]).includes(action);

// reversed: whether overturning actually reversed the action (false if its effect had already ended).
export type AppealSummary = { id: number; status: AppealStatus; text: string; decisionNote: string | null; createdAt: Date; decidedAt: Date | null; reversed: boolean | null };
export type AppealableAction = {
  avatarUrl?: string | null;
  displayNames?: DisplayNames | null;
  automatic?: boolean;
  chat?: { body: string | null; lang: string; createdAt: string; pruned: boolean };
  village?: VillageMetadata | null;
  villageBefore?: VillageMetadata | null;
  actionId: number;
  action: (typeof APPEALABLE_ACTIONS)[number];
  reason: ReportReason;
  // Explanation of the action, shown to its subject.
  note: string;
  createdAt: Date;
  // Suspension deadline, for suspensions.
  until: Date | null;
  // Hidden or deleted entries belonging to the subject; show their content to that member.
  entry: { id: number; threadId: number; kind: "topic" | "reply"; lang: SourceLang; title: string | null; body: string } | null;
  // For fix_entry, the title and body immediately before the edit (entry_revisions at the action's revision_id). entry holds the current title and body. Null for other actions.
  before: PreFixText | null;
  appeal: AppealSummary | null;
  villageAppealOwn?: boolean;
};

// Title and body as they were just before a fix_entry action.
export type PreFixText = { title: string | null; body: string };

// The action and its subject (entry author for hide/delete; the member for suspend/exclude_reactions).
async function loadAction(db: Db, actionId: number) {
  const [row] = await db
    .select({
      id: moderationActions.id,
      action: moderationActions.action,
      reason: moderationActions.reason,
      note: moderationActions.note,
      actorId: moderationActions.actorId,
      automatic: moderationActions.automatic,
      targetEntryId: moderationActions.targetEntryId,
      targetUserId: moderationActions.targetUserId,
      displayNamesBefore: moderationActions.displayNamesBefore,
      avatarMediaIdBefore: moderationActions.avatarMediaIdBefore,
      iconMediaIdBefore: moderationActions.iconMediaIdBefore,
      targetVillageId: moderationActions.targetVillageId,
      targetChatMessageId: moderationActions.targetChatMessageId,
      villageEventId: moderationActions.villageEventId,
      reportId: moderationActions.reportId,
      until: moderationActions.until,
      revisionId: moderationActions.revisionId,
      createdAt: moderationActions.createdAt,
      entryAuthorId: entries.authorId,
    })
    .from(moderationActions)
    .leftJoin(entries, eq(entries.id, moderationActions.targetEntryId))
    .where(eq(moderationActions.id, actionId));
  if (!row || !isAppealable(row.action)) return null;
  let chatMessageId = row.targetChatMessageId;
  if (!chatMessageId && row.action === "suspend" && row.reportId !== null) {
    const [source] = await db.select({ id: reports.chatMessageId }).from(reports).where(eq(reports.id, row.reportId)); chatMessageId = source?.id ?? null;
  }
  const [chat] = chatMessageId ? await db.select({ authorId: chatReportSnapshots.authorId, lang: chatReportSnapshots.lang }).from(chatReportSnapshots).where(eq(chatReportSnapshots.messageId, chatMessageId)) : [];
  const affected = row.action === "clear_avatar" || row.action === "clear_display_name" || row.action === "suspend" || row.action === "exclude_reactions" ? row.targetUserId : chatMessageId ? chat?.authorId ?? null : row.entryAuthorId;
  return affected || row.targetVillageId ? { ...row, action: row.action, affectedUserId: affected, chatMessageId, chatLang: chat?.lang ?? null } : null;
}

type LoadedAction = NonNullable<Awaited<ReturnType<typeof loadAction>>>;

// The text a fix_entry action replaced: the entry_revisions row the action recorded (revision_id). Null for other actions, or when the revision is gone.
async function loadPreFixText(db: Db, action: LoadedAction): Promise<PreFixText | null> {
  if (action.action !== "fix_entry" || action.revisionId === null || action.targetEntryId === null) return null;
  const [revision] = await db
    .select({ title: entryRevisions.title, body: entryRevisions.body })
    .from(entryRevisions)
    .where(and(eq(entryRevisions.id, action.revisionId), eq(entryRevisions.entryId, action.targetEntryId)));
  return revision && !isPrunedRevision(revision) ? revision : null;
}

// Whether this member may appeal the action. Return null for anyone other than its subject, without revealing another person's action.
export async function getAppealableAction(db: Db, userId: string, actionId: number): Promise<AppealableAction | null> {
  const action = await loadAction(db, actionId);
  if (!action) return null;
  if (action.targetVillageId === null && action.affectedUserId !== userId) return null;
  const [appeal] = await db.select().from(appeals).where(and(eq(appeals.actionId, actionId), action.targetVillageId === null ? eq(appeals.appellantId, userId) : undefined));
  if (action.targetVillageId !== null && appeal?.appellantId !== userId && !await isVillageOwner(db, action.targetVillageId, userId)) return null;
  let entry: AppealableAction["entry"] = null;
  if (action.targetEntryId !== null) {
    const [e] = await db
      .select({ id: entries.id, threadId: entries.threadId, kind: entries.kind, lang: entries.lang, title: entries.title, body: entries.body })
      .from(entries)
      .where(eq(entries.id, action.targetEntryId));
    if (e && isSourceLang(e.lang)) entry = { id: e.id, threadId: e.threadId ?? e.id, kind: e.kind as "topic" | "reply", lang: e.lang, title: e.title, body: e.body };
  }
  const [chat] = action.chatMessageId ? await db.select({ body: chatReportSnapshots.body, lang: chatReportSnapshots.lang, createdAt: chatReportSnapshots.messageCreatedAt, prunedAt: chatReportSnapshots.prunedAt }).from(chatReportSnapshots).where(and(eq(chatReportSnapshots.messageId, action.chatMessageId), eq(chatReportSnapshots.authorId, userId))) : [];
  return {
    ...(chat ? { chat: { body: chat.body, lang: chat.lang, createdAt: chat.createdAt.toISOString(), pruned: chat.prunedAt !== null } } : {}),
    ...(action.targetVillageId !== null ? { ...await villageAppealMetadata(db, action.targetVillageId, action.villageEventId), villageAppealOwn: appeal ? appeal.appellantId === userId : true } : {}),
    ...(action.action === "clear_village_icon" ? { avatarUrl: await avatarAppealUrl(db, action.iconMediaIdBefore) } : {}),
    ...(action.action === "clear_avatar" ? { avatarUrl: await avatarAppealUrl(db, action.avatarMediaIdBefore) } : {}),
    ...(action.action === "clear_display_name" ? { displayNames: action.displayNamesBefore } : {}),
    actionId,
    ...(action.automatic ? { automatic: true } : {}),
    action: action.action,
    reason: isReason(action.reason) ? action.reason : "other",
    note: action.note,
    createdAt: action.createdAt,
    until: action.until,
    entry,
    before: await loadPreFixText(db, action),
    appeal: appeal
      ? { id: appeal.id, status: appeal.status as AppealStatus, text: appeal.text, decisionNote: appeal.decisionNote, createdAt: appeal.createdAt, decidedAt: appeal.decidedAt, reversed: appeal.reversed }
      : null,
  };
}

export type AppealError = "not_found" | "invalid_text" | "duplicate";

// File an appeal. Only the subject may do so (not_found for others), once per action (duplicate). An explanation is required, up to 2,000 characters.
export async function createAppeal(db: Db, userId: string, actionId: number, text: unknown, opts: { now?: Date } = {}): Promise<{ ok: true; id: number } | { ok: false; error: AppealError }> {
  const action = await loadAction(db, actionId);
  if (!action || action.targetVillageId === null && action.affectedUserId !== userId) return { ok: false, error: "not_found" };
  const body = typeof text === "string" ? text.trim() : "";
  if (body === "" || [...body].length > MAX_APPEAL_TEXT || hasNul(body)) return { ok: false, error: "invalid_text" };
  if (action.targetVillageId !== null) {
    const villageId = action.targetVillageId;
    return db.transaction(async tx => {
      await lockVillageActor(tx, userId);
      const village = await lockModeratedVillage(tx, villageId);
      if (!village || !await isVillageOwner(tx, villageId, userId)) return { ok: false as const, error: "not_found" as const };
      await tx.select({ id: moderationActions.id }).from(moderationActions).where(eq(moderationActions.id, action.id)).for("update");
      const [existing] = await tx.select({ id: appeals.id }).from(appeals).where(eq(appeals.actionId, action.id)).limit(1);
      if (existing) return { ok: false as const, error: "duplicate" as const };
      const [row] = await tx.insert(appeals).values({ actionId, appellantId: userId, text: body, createdAt: opts.now }).returning({ id: appeals.id });
      return { ok: true as const, id: row.id };
    });
  }
  if (action.chatMessageId) {
    return db.transaction(async tx => {
      await lockChatReportTarget(tx, action.chatMessageId!);
      const fresh = await loadAction(tx, actionId);
      if (!fresh || fresh.affectedUserId !== userId) return { ok: false as const, error: "not_found" as const };
      const [row] = await tx.insert(appeals).values({ actionId, appellantId: userId, text: body, createdAt: opts.now }).onConflictDoNothing({ target: [appeals.actionId, appeals.appellantId] }).returning({ id: appeals.id });
      return row ? { ok: true as const, id: row.id } : { ok: false as const, error: "duplicate" as const };
    });
  }
  return db.transaction(async tx => {
    let entryId = action.targetEntryId;
    let identityUserId = action.action === "clear_avatar" || action.action === "clear_display_name" ? action.targetUserId : null;
    if (entryId === null && action.reportId !== null) {
      const [report] = await tx.select({ entryId: reports.entryId, avatarUserId: reports.avatarUserId, displayNameUserId: reports.displayNameUserId }).from(reports).where(eq(reports.id, action.reportId));
      entryId = report?.entryId ?? null;
      identityUserId ??= report?.avatarUserId ?? report?.displayNameUserId ?? null;
    }
    // Identity evidence pruning uses the same profile lock. A committed appeal
    // protects its copies; filing after pruning remains possible without them.
    if (identityUserId !== null) await tx.select({ id: profiles.userId }).from(profiles).where(eq(profiles.userId, identityUserId)).for("update");
    // Serialize filing with retention. An appeal committed first protects its text;
    // an appeal filed after pruning remains possible, with no text to restore.
    if (entryId !== null) await tx.select({ id: entries.id }).from(entries).where(eq(entries.id, entryId)).for("no key update");
    const [row] = await tx.insert(appeals).values({ actionId, appellantId: userId, text: body, createdAt: opts.now })
      .onConflictDoNothing({ target: [appeals.actionId, appeals.appellantId] }).returning({ id: appeals.id });
    return row ? { ok: true as const, id: row.id } : { ok: false as const, error: "duplicate" as const };
  });
}

// ---- Review screen (/mod/appeals) ----

export type AppealCard = {
  avatarUrl?: string | null;
  displayNames?: DisplayNames | null;
  chat?: { lang: string };
  village?: VillageMetadata | null;
  villageBefore?: VillageMetadata | null;
  id: number;
  createdAt: Date;
  text: string;
  appellantHandle: string;
  action: (typeof APPEALABLE_ACTIONS)[number];
  reason: ReportReason;
  note: string;
  actionDate: Date;
  until: Date | null;
  // The affected entry (hide/delete), with its content shown for review. For suspensions, the reported entry, if any.
  entry: { id: number; threadId: number; kind: "topic" | "reply"; lang: SourceLang; title: string | null; body: string; hidden: boolean; deleted: boolean } | null;
  // For fix_entry, the title and body immediately before the edit (entry holds the current values). Null for other actions.
  before: PreFixText | null;
};

// Pending appeals, oldest first. Return only to authorized reviewers (moderators/operators), omitting appeals where they took the action or are the appellant.
// Do not expose the name of the person who took the action.
export async function listOpenAppeals(db: Db, reviewer: { id: string; scope: ModScope }, opts: { page?: number; limit?: number } = {}): Promise<{ cards: AppealCard[]; page: number; hasNext: boolean }> {
  const page = opts.page ?? 1;
  const limit = opts.limit ?? 20;
  if (!isModerator(reviewer.scope)) return { cards: [], page, hasNext: false };
  const rows = await db
    .select({
      id: appeals.id,
      createdAt: appeals.createdAt,
      text: appeals.text,
      appellantId: appeals.appellantId,
      appellantHandle: profiles.handle,
      actionId: appeals.actionId,
    })
    .from(appeals)
    .innerJoin(moderationActions, eq(moderationActions.id, appeals.actionId))
    .leftJoin(profiles, eq(profiles.userId, appeals.appellantId))
    .where(
      and(
        eq(appeals.status, "open"),
        reviewer.scope.operator ? undefined : isNull(moderationActions.targetVillageId),
        reviewer.scope.operator ? undefined : ne(moderationActions.action, "clear_display_name"),
        reviewer.scope.operator ? undefined : ne(moderationActions.action, "clear_avatar"),
        reviewer.scope.operator ? undefined : sql`(
          (${moderationActions.targetChatMessageId} is null and not exists (select 1 from reports cr where cr.id = ${moderationActions.reportId} and cr.chat_message_id is not null))
          OR exists (select 1 from chat_report_snapshots cs where cs.message_id = ${moderationActions.targetChatMessageId} and cs.lang in (${sql.join(reviewer.scope.langs.map(lang => sql`${lang}`), sql`, `)}))
          OR exists (select 1 from reports cr where (cr.chat_message_id = ${moderationActions.targetChatMessageId} OR cr.id = ${moderationActions.reportId}) and cr.chat_lang in (${sql.join(reviewer.scope.langs.map(lang => sql`${lang}`), sql`, `)}))
        )`,
        or(isNull(moderationActions.actorId), ne(moderationActions.actorId, reviewer.id)),
        or(isNull(appeals.appellantId), ne(appeals.appellantId, reviewer.id)),
        // Anyone who reported the entry cannot review it: they are a party to the report underlying the action. For suspensions, use the entry from the action's report.
        sql`not exists (select 1 from reports as rp where rp.reporter_id = ${reviewer.id} and (rp.entry_id = coalesce(${moderationActions.targetEntryId}, (select r2.entry_id from reports as r2 where r2.id = ${moderationActions.reportId})) OR (${moderationActions.action} = 'clear_display_name' AND rp.display_name_user_id = ${moderationActions.targetUserId}) OR (${moderationActions.action} = 'clear_avatar' AND rp.avatar_user_id = ${moderationActions.targetUserId}) OR rp.village_id = ${moderationActions.targetVillageId} OR rp.chat_message_id = coalesce(${moderationActions.targetChatMessageId}, (select r3.chat_message_id from reports r3 where r3.id = ${moderationActions.reportId}))))`,
      ),
    )
    .orderBy(asc(appeals.createdAt), asc(appeals.id))
    .limit(limit + 1)
    .offset((page - 1) * limit);
  const selected = rows.slice(0, limit);
  if (!selected.length) return { cards: [], page, hasNext: rows.length > limit };
  const actions = await db.select({ ...getTableColumns(moderationActions), entryAuthorId: entries.authorId,
    reportEntryId: reports.entryId, reportChatId: reports.chatMessageId,
  }).from(moderationActions).leftJoin(entries, eq(entries.id, moderationActions.targetEntryId))
    .leftJoin(reports, eq(reports.id, moderationActions.reportId))
    .where(inArray(moderationActions.id, selected.map(r => r.actionId)));
  const chatIdOf = (a: typeof actions[number]) => a.targetChatMessageId ?? (a.action === "suspend" ? a.reportChatId : null);
  const entryIdOf = (a: typeof actions[number]) => a.targetEntryId ?? (a.action === "suspend" ? a.reportEntryId : null);
  const entryIds = actions.flatMap(a => entryIdOf(a) === null ? [] : [entryIdOf(a)!]);
  const villageIds = [...new Set(actions.flatMap(a => a.targetVillageId === null ? [] : [a.targetVillageId]))];
  const eventIds = actions.flatMap(a => a.villageEventId === null ? [] : [a.villageEventId]);
  const chatIds = actions.flatMap(a => chatIdOf(a) === null ? [] : [chatIdOf(a)!]);
  const revisionIds = actions.flatMap(a => a.action === "fix_entry" && a.revisionId !== null ? [a.revisionId] : []);
  const [entryRows, chatRows, ownedRows, villageRows, eventRows, revisionRows] = await Promise.all([
    entryIds.length ? db.select().from(entries).where(inArray(entries.id, entryIds)) : Promise.resolve([]),
    chatIds.length ? db.select({ id: chatReportSnapshots.messageId, authorId: chatReportSnapshots.authorId, lang: chatReportSnapshots.lang }).from(chatReportSnapshots).where(inArray(chatReportSnapshots.messageId, chatIds)) : Promise.resolve([]),
    villageIds.length ? db.select({ id: villageMembers.villageId }).from(villageMembers).where(and(inArray(villageMembers.villageId, villageIds), eq(villageMembers.userId, reviewer.id), eq(villageMembers.role, "owner"))) : Promise.resolve([]),
    villageIds.length ? db.select().from(villages).where(inArray(villages.id, villageIds)) : Promise.resolve([]),
    eventIds.length ? db.select().from(villageEvents).where(inArray(villageEvents.id, eventIds)) : Promise.resolve([]),
    revisionIds.length ? db.select().from(entryRevisions).where(inArray(entryRevisions.id, revisionIds)) : Promise.resolve([]),
  ]);
  const actionById = new Map(actions.map(a => [a.id, a]));
  const entryById = new Map(entryRows.map(e => [e.id, e]));
  const chatById = new Map(chatRows.map(c => [c.id, c]));
  const owned = new Set(ownedRows.map(v => v.id));
  const villageById = new Map(villageRows.map(v => [v.id, v]));
  const eventById = new Map(eventRows.map(e => [e.id, e]));
  const revisionById = new Map(revisionRows.map(r => [r.id, r]));
  const cards: AppealCard[] = [];
  for (const r of selected) {
    const action = actionById.get(r.actionId);
    if (!action || !isAppealable(action.action)) continue;
    const chatId = chatIdOf(action), chat = chatId === null ? undefined : chatById.get(chatId);
    const affected = action.action === "clear_avatar" || action.action === "clear_display_name" || action.action === "suspend" || action.action === "exclude_reactions" ? action.targetUserId : chatId ? chat?.authorId : action.entryAuthorId;
    if (!affected && !action.targetVillageId || action.targetVillageId !== null && owned.has(action.targetVillageId)) continue;
    const e = entryById.get(entryIdOf(action) ?? -1);
    const entry: AppealCard["entry"] = e && isSourceLang(e.lang) ? { id: e.id, threadId: e.threadId ?? e.id, kind: e.kind as "topic" | "reply", lang: e.lang, title: e.title, body: e.body, hidden: e.hiddenAt !== null, deleted: e.deletedAt !== null } : null;
    const v = action.targetVillageId === null ? undefined : villageById.get(action.targetVillageId);
    const event = action.villageEventId === null ? undefined : eventById.get(action.villageEventId);
    const detail = event?.villageId === action.targetVillageId ? event.detail : undefined;
    const revision = action.revisionId === null ? undefined : revisionById.get(action.revisionId);
    cards.push({
      ...(action.action === "clear_village_icon" ? { avatarUrl: await avatarAppealUrl(db, action.iconMediaIdBefore) } : {}),
      ...(action.action === "clear_avatar" ? { avatarUrl: await avatarAppealUrl(db, action.avatarMediaIdBefore) } : {}),
      ...(action.action === "clear_display_name" ? { displayNames: action.displayNamesBefore } : {}),
      ...(chatId && chat?.lang ? { chat: { lang: chat.lang } } : {}),
      ...(action.targetVillageId !== null ? {
        village: v ? { name: v.name, description: v.description, slug: v.slug, language: v.language } : null,
        villageBefore: detail && typeof detail.oldName === "string" && typeof detail.oldDescription === "string" ? { name: detail.oldName, description: detail.oldDescription, slug: detail.oldSlug ?? null, language: v?.language ?? null } : null,
      } : {}),
      id: r.id, createdAt: r.createdAt, text: chatId ? "" : r.text,
      appellantHandle: chatId ? "" : r.appellantHandle ?? "?",
      action: action.action, reason: isReason(action.reason) ? action.reason : "other",
      note: chatId ? "" : action.note, actionDate: action.createdAt, until: action.until, entry,
      before: action.action === "fix_entry" && revision?.entryId === action.targetEntryId && !isPrunedRevision(revision) ? { title: revision.title, body: revision.body } : null,
    });
  }
  return { cards, page, hasNext: rows.length > limit };
}

// ---- Review ----

// reporter: the reviewer reported this entry (the reported entry for suspensions), creating a conflict of interest.
export type DecideError = "not_found" | "forbidden" | "own_action" | "own_appeal" | "reporter" | "already_decided" | "invalid_decision" | "invalid_note" | "note_required";

// Review an appeal. The reviewer must be a moderator/operator (forbidden) and neither the person who took the action nor the appellant. decision_note is required, up to 1,000 characters.
// For overturned, reverse the action only if its effect still persists. Return whether it was reversed in reversed.
export async function decideAppeal(
  db: Db,
  reviewer: { id: string; scope: ModScope },
  appealId: number,
  input: { decision: unknown; note: unknown },
  opts: { now?: Date } = {},
): Promise<{ ok: true; status: "upheld" | "overturned"; reversed: boolean } | { ok: false; error: DecideError }> {
  if (input.decision !== "upheld" && input.decision !== "overturned") return { ok: false, error: "invalid_decision" };
  const decision: "upheld" | "overturned" = input.decision;
  const note = typeof input.note === "string" ? input.note.trim() : "";
  if (hasNul(note) || [...note].length > MAX_DECISION_NOTE) return { ok: false, error: "invalid_note" };
  if (note === "") return { ok: false, error: "note_required" };
  if (!isModerator(reviewer.scope)) return { ok: false, error: "forbidden" };
  const now = opts.now ?? new Date();
  const [target] = await db.select({ villageId: moderationActions.targetVillageId, chatMessageId: moderationActions.targetChatMessageId, reportId: moderationActions.reportId }).from(appeals).innerJoin(moderationActions, eq(moderationActions.id, appeals.actionId)).where(eq(appeals.id, appealId));
  if (target?.villageId && !reviewer.scope.operator) return { ok: false, error: "forbidden" };
  let sourceChatId = target?.chatMessageId ?? null;
  if (!sourceChatId && target?.reportId !== null && target?.reportId !== undefined) {
    const [source] = await db.select({ id: reports.chatMessageId }).from(reports).where(eq(reports.id, target.reportId)); sourceChatId = source?.id ?? null;
  }
  let chatSignal: { villageId: string; seq: number } | undefined;
  const result = await db.transaction(async (tx) => {
    if (sourceChatId) await lockChatReportTarget(tx, sourceChatId);
    let reviewerHandle = "";
    if (target?.villageId) {
      const member = await lockVillageActor(tx, reviewer.id);
      if (!member) return { ok: false as const, error: "forbidden" as const };
      reviewerHandle = member.handle;
      await lockVillageSlugClaims(tx);
      await lockModeratedVillage(tx, target.villageId);
    }
    const [appeal] = await tx.select().from(appeals).where(eq(appeals.id, appealId)).for("update");
    if (!appeal) return { ok: false as const, error: "not_found" as const };
    if (appeal.status !== "open") return { ok: false as const, error: "already_decided" as const };
    const action = await loadAction(tx, appeal.actionId);
    if (!action) return { ok: false as const, error: "not_found" as const };
    // The reviewer must differ from the person who took the action. Appellants cannot review their own appeals.
    if (action.actorId === reviewer.id) return { ok: false as const, error: "own_action" as const };
    if (appeal.appellantId === reviewer.id) return { ok: false as const, error: "own_appeal" as const };
    // The person who reported the entry also cannot review it, keeping the reporting and reviewing parties separate.
    let entryId = action.targetEntryId;
    if (entryId === null && action.reportId !== null) {
      const [report] = await tx.select({ entryId: reports.entryId }).from(reports).where(eq(reports.id, action.reportId));
      entryId = report?.entryId ?? null;
    }
    if (entryId !== null) {
      const [mine] = await tx
        .select({ id: reports.id })
        .from(reports)
        .where(and(eq(reports.entryId, entryId), eq(reports.reporterId, reviewer.id)))
        .limit(1);
      if (mine) return { ok: false as const, error: "reporter" as const };
    }
    if (action.action === "clear_avatar") {
      if (!reviewer.scope.operator) return { ok: false as const, error: "forbidden" as const };
      const [mine] = await tx.select({ id: reports.id }).from(reports).where(and(eq(reports.avatarUserId, action.targetUserId!), eq(reports.reporterId, reviewer.id))).limit(1);
      if (mine) return { ok: false as const, error: "reporter" as const };
    }
    if (action.action === "clear_display_name") {
      if (!reviewer.scope.operator) return { ok: false as const, error: "forbidden" as const };
      const [mine] = await tx.select({ id: reports.id }).from(reports).where(and(eq(reports.displayNameUserId, action.targetUserId!), eq(reports.reporterId, reviewer.id))).limit(1);
      if (mine) return { ok: false as const, error: "reporter" as const };
    }
    if (action.targetVillageId !== null) {
      if (!reviewer.scope.operator || await isVillageOwner(tx, action.targetVillageId, reviewer.id)) return { ok: false as const, error: "forbidden" as const };
      const [mine] = await tx.select({ id: reports.id }).from(reports).where(and(eq(reports.villageId, action.targetVillageId), eq(reports.reporterId, reviewer.id))).limit(1);
      if (mine) return { ok: false as const, error: "reporter" as const };
    }
    if (action.chatMessageId) {
      if (!action.chatLang || !inLanguageScope(reviewer.scope, action.chatLang)) return { ok: false as const, error: "forbidden" as const };
      const [mine] = await tx.select({ id: reports.id }).from(reports).where(and(eq(reports.chatMessageId, action.chatMessageId), eq(reports.reporterId, reviewer.id))).limit(1);
      if (mine) return { ok: false as const, error: "reporter" as const };
    }
    let chatChange: ChatVisibilityChange | null = null;
    let reversed = false;
    if (decision === "overturned" && action.targetChatMessageId !== null) {
      chatChange = await prepareChatReversal(tx, { id: action.id, targetChatMessageId: action.targetChatMessageId }, reviewer.id, appeal.id, now);
      reversed = chatChange?.reversed ?? false;
    } else if (decision === "overturned") reversed = action.targetVillageId !== null
      ? await reverseVillageAction(tx, { ...action, targetVillageId: action.targetVillageId }, reviewer.id, reviewerHandle, appeal.id, now)
      : await withMarkdownRestore(() => reverseAction(tx, action, reviewer.id, appeal.id, now));
    await tx
      .update(appeals)
      .set({ status: decision, decidedBy: reviewer.id, decidedAt: now, decisionNote: note, reversed: decision === "overturned" ? reversed : null })
      .where(eq(appeals.id, appeal.id));
    // Notify the appellant of the result without identifying the reviewer.
    if (appeal.appellantId) await createAppealNotification(tx, { userId: appeal.appellantId, entryId: action.targetEntryId, actionId: action.id, appealId: appeal.id, now, ...(action.targetVillageId ? { villageId: action.targetVillageId } : {}) });
    if (chatChange) chatSignal = { villageId: chatChange.villageId, seq: await finishChatVisibility(tx, chatChange, now) };
    return { ok: true as const, status: decision, reversed };
  });
  if (result.ok && chatSignal) signalVillageChat(chatSignal.villageId, chatSignal.seq);
  return result;
}

// Reverse the action only if its effect still persists, returning whether it was reversed. Record the opposing action under the reviewer, with reason category other and explanation 「異議が通った」.
async function reverseAction(db: Tx, action: LoadedAction, reviewerId: string, appealId: number, now: Date): Promise<boolean> {
  const note = `Appeal #${appealId} overturned`;
  const record = async (type: ModerationAction, target: { entryId?: number; userId?: string }, revisionId?: number) => {
    const [row] = await db
      .insert(moderationActions)
      .values({ action: type, targetEntryId: target.entryId ?? null, targetUserId: target.userId ?? null, reason: "other", note, actorId: reviewerId, revisionId: revisionId ?? null, createdAt: now })
      .returning({ id: moderationActions.id });
    return row.id;
  };
  if (action.action === "clear_avatar" && action.targetUserId) {
    const member = await lockMember(db, action.targetUserId);
    if (!member || member.avatarActionId !== action.id || !await avatarAppealUrl(db, action.avatarMediaIdBefore)) return false;
    await record("restore_avatar", { userId: action.targetUserId });
    await db.update(profiles).set({ avatarMediaId: action.avatarMediaIdBefore, avatarActionId: null }).where(eq(profiles.userId, action.targetUserId));
    return true;
  }
  if (action.action === "clear_display_name" && action.targetUserId) {
    const member = await lockMember(db, action.targetUserId);
    if (!member || member.displayNameActionId !== action.id || !action.displayNamesBefore) return false;
    await record("restore_display_name", { userId: action.targetUserId });
    await db.update(profiles).set({ ...action.displayNamesBefore, displayNameActionId: null }).where(eq(profiles.userId, action.targetUserId));
    return true;
  }
  if (action.action === "suspend" && action.targetUserId) {
    const member = await lockMember(db, action.targetUserId);
    if (!member || member.suspendedActionId !== action.id || member.suspendedUntil === null || member.suspendedUntil <= now) return false;
    await record("unsuspend", { userId: action.targetUserId });
    await db.update(profiles).set({ suspendedUntil: null, suspendedReason: null, suspendedActionId: null }).where(eq(profiles.userId, action.targetUserId));
    return true;
  }
  // Excluded stances and 「なるほど」: restore their counts only if that exclusion still persists, not if a later reversal or another exclusion replaced it.
  if (action.action === "exclude_reactions" && action.targetUserId) {
    const member = await lockMember(db, action.targetUserId);
    if (!member || member.reactionsExcludedActionId !== action.id || member.reactionsExcludedAt === null) return false;
    await record("include_reactions", { userId: action.targetUserId });
    await db.update(profiles).set({ reactionsExcludedAt: null, reactionsExcludedActionId: null }).where(eq(profiles.userId, action.targetUserId));
    return true;
  }
  if (action.targetEntryId === null) return false;
  if (action.action === "fix_entry" && action.revisionId !== null) {
    const [revision] = await db.select({ title: entryRevisions.title, body: entryRevisions.body }).from(entryRevisions).where(eq(entryRevisions.id, action.revisionId));
    if (!revision || isPrunedRevision(revision)) return false;
    await lockReferenceTopics(db, { entryId: action.targetEntryId, body: revision.body });
  }
  const entry = await lockEntry(db, action.targetEntryId);
  if (!entry) return false;
  // Determine whether the action's effect persists from the action history (the latest action on the entry is not an opposing action). Do not use the entry's moderation_action_id,
  // which is overwritten by actions such as restoration.
  if (action.action === "hide") {
    if (entry.deletedAt || !entry.hiddenAt) return false;
    if ((await latestEntryAction(db, entry.id, ["hide", "unhide"]))?.id !== action.id) return false;
    const id = await record("unhide", { entryId: entry.id });
    await db.update(entries).set({ hiddenAt: null, moderatedAt: now, moderationActionId: id }).where(eq(entries.id, entry.id));
    // An alternative framing changes the original question's Markdown (the list of alternative framings); emit a change for the original question too.
    await touchAltOriginal(db, entry.id, now);
    await touchReferenceTopics(db, entry.id, now);
    if (entry.sourceHash) {
      await enqueueTranslations(db, { id: entry.id, lang: entry.lang, sourceHash: entry.sourceHash });
      await enqueueEmbedding(db, { id: entry.id, sourceHash: entry.sourceHash });
    }
    return true;
  }
  // A fix of a locked question (fix_entry). Overturning puts the text back to what the fix replaced (the entry_revisions row the action recorded); the text it replaces
  // goes into a new revision (editor: the reviewer), and the cleanup is the same as for the author's edit (applyEntryEdit). unfix_entry is recorded as the reviewer's action
  // (revision_id: the new row). The lock stays.
  // It is put back only if the text that the appealed fix produced is still the current text: the produced text is what the next revision row of the entry kept (the next edit
  // wrote the text it replaced there), or the current text when there is no later edit. So a chain of fixes A then B can be overturned from the newest (B, then A: after B is put
  // back, the text is A's again), but A cannot be put back while B's text stands (reversed: false: the reviewer and the appellant are told, as for hide and delete that no longer stand).
  if (action.action === "fix_entry") {
    if (action.revisionId === null) return false;
    const [revision] = await db
      .select({ title: entryRevisions.title, body: entryRevisions.body, mentionRevision: entryRevisions.mentionRevision })
      .from(entryRevisions)
      .where(and(eq(entryRevisions.id, action.revisionId), eq(entryRevisions.entryId, entry.id)));
    if (!revision) return false;
    const [later] = await db
      .select({ title: entryRevisions.title, body: entryRevisions.body })
      .from(entryRevisions)
      .where(and(eq(entryRevisions.entryId, entry.id), gt(entryRevisions.id, action.revisionId)))
      .orderBy(asc(entryRevisions.id))
      .limit(1);
    const produced = later ?? { title: entry.title, body: entry.body };
    if (produced.title !== entry.title || produced.body !== entry.body) return false;
    // Nothing to put back when the current text is already the earlier one.
    if (revision.title === entry.title && revision.body === entry.body) return false;
    const bindings = await readMentionBindings(db, entry.id, revision.mentionRevision);
    const mentions = (await resolveSourceMentions(db, entry.body, entry.id)).targets;
    const { revisionId } = await applyEntryEdit(db, {
      entryId: entry.id,
      editorId: reviewerId,
      now,
      before: { title: entry.title, body: entry.body, sourceHash: entry.sourceHash, lang: entry.lang, hiddenAt: entry.hiddenAt, deletedAt: entry.deletedAt },
      after: { title: revision.title, body: revision.body, bindings, ...(await renderEntryHtml("topic", entry.id, revision.body, entry.lang, mentions)) },
    });
    if (revisionId === null) throw new Error("Restoring a correction must preserve a revision");
    await record("unfix_entry", { entryId: entry.id }, revisionId);
    return true;
  }
  if (action.action === "delete") {
    if (!entry.deletedAt) return false;
    if ((await latestEntryAction(db, entry.id, ["delete", "restore"]))?.id !== action.id) return false;
    const id = await record("restore", { entryId: entry.id });
    await db.update(entries).set({ deletedAt: null, moderatedAt: now, moderationActionId: id }).where(eq(entries.id, entry.id));
    // Restoration sets deleted_at to null directly, bypassing softDeleteEntry. For an alternative framing, emit a change for the original question too.
    await touchAltOriginal(db, entry.id, now);
    await touchReferenceTopics(db, entry.id, now);
    // Rebuild derivatives removed on deletion: topic aggregates for replies, sentence boundaries, and translations (do not queue while still hidden; queue when unhidden).
    // The render cache is rebuilt when displayed. Translation jobs recreate translations; manual corrections deleted earlier remain deleted and are not restored.
    if (entry.kind === "reply" && entry.threadId !== null) await recomputeThreadActivity(db, entry.threadId);
    await replaceSegments(db, entry.id, entry.body, entry.lang);
    if (!entry.hiddenAt && entry.sourceHash) {
      await enqueueTranslations(db, { id: entry.id, lang: entry.lang, sourceHash: entry.sourceHash });
      await enqueueEmbedding(db, { id: entry.id, sourceHash: entry.sourceHash });
    }
    return true;
  }
  return false;
}
