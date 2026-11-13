import { enabledLangs } from "./enabled-langs.server";
import { loadDisplayNameReportCards, type DisplayNameReportCard } from "./display-name-moderation.server";
import { loadAvatarReportCards, type AvatarReportCard } from "./avatar-moderation.server";
import { retainedAuthorColumn } from "./deleted-member.server";
import { enqueueReportTriage } from "./moderation-automation.server";
import { afterPageBoundary } from "~/lib/page-boundary.server";
import { loadChatReportCards, type ChatReportCard } from "./village-chat-reports.server";
import { automaticallyResolvedReport } from "./report-resolution.server";
import { withMarkdownScope, MarkdownBudgetError } from "./markdown-budget.server";
import { checkBodyBudget } from "~/lib/markdown.server";
import { notInArray, and, asc, desc, eq, gt, inArray, isNotNull, isNull, min, ne, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "~/lib/db/client.server";
import { entries, moderationActions, profiles, reports, user, villages } from "~/lib/db/schema";
import { enqueueEmbedding, purgeEmbeddings } from "~/lib/embeddings.server";
import { applyEntryEdit, entryIdPrefix, hasNul, parseTopicText, softDeleteEntry, type EntryError } from "~/lib/entries.server";
import { tryRenderEntry } from "~/lib/markdown.server";
import { resolveSourceMentions } from "~/lib/mentions.server";
import { touchAltOriginal } from "~/lib/questions.server";
import { lockReferenceTopics, touchReferenceTopics } from "~/lib/related-discussions.server";
import { isSourceLang, type SourceLang } from "~/lib/languages";
import { isReason, MAX_SUSPEND_DAYS, REPORT_REASONS, type ModerationAction, type ReportReason } from "~/lib/moderation";
import { createModerationNotification } from "~/lib/notifications.server";
import { isOperatorEmail } from "~/lib/operators.server";
import { inScope, type ModScope } from "~/lib/roles.server";
import { enqueueTranslations } from "~/lib/translations.server";

import { villageName } from "~/lib/village-name";
import { isSharedVillageKind } from "~/lib/villages";
import { loadVillageReportCards, type VillageReportCard } from "~/lib/village-moderation.server";

// Reports and moderation actions.
// - Reports: members report another author's visible/undeleted post with reason category and optional note. No duplicate reports by one member on one post.
// - Actions: moderators (assigned original language) and operators (all languages) review reports, hide/show posts and dismiss reports.
//   Member suspension and deletion extend the same action mechanism here. Every action includes reason category/short note, recorded in moderation_actions.
//   Never act on one's own post, even as operator. Never show reporter identities on any screen.

export { isReason, REPORT_REASONS, type ReportReason };

// Character caps for report and action notes.
export const MAX_REPORT_NOTE = 1000;
export const MAX_ACTION_NOTE = 500;

function cleanNote(raw: unknown, max: number): string | null {
  if (raw === undefined || raw === null) return "";
  if (typeof raw !== "string" || hasNul(raw)) return null;
  const note = raw.trim();
  return [...note].length > max ? null : note;
}

// ---- Reports ----

export type ReportError = "not_found" | "own_entry" | "duplicate" | "invalid_reason" | "invalid_note";

// Report a post: own, deleted (including deleted-topic threads) or hidden unreadable posts yield not_found or own_entry.
// A second report by the same person on the same post yields duplicate; unique index also prevents concurrent submissions.
export async function createReport(
  db: Db,
  reporterId: string,
  input: { entryId: number; reason: unknown; note?: unknown },
  opts: { now?: Date } = {},
): Promise<{ ok: true; id: number } | { ok: false; error: ReportError }> {
  if (!isReason(input.reason)) return { ok: false, error: "invalid_reason" };
  const note = cleanNote(input.note, MAX_REPORT_NOTE);
  if (note === null) return { ok: false, error: "invalid_note" };
  const [entry] = await db
    .select({ authorId: entries.authorId, threadId: entries.threadId, hiddenAt: entries.hiddenAt, deletedAt: entries.deletedAt })
    .from(entries)
    .where(eq(entries.id, input.entryId));
  if (!entry || entry.deletedAt || entry.hiddenAt) return { ok: false, error: "not_found" };
  if (entry.threadId !== null) {
    const [topic] = await db.select({ deletedAt: entries.deletedAt }).from(entries).where(eq(entries.id, entry.threadId));
    if (!topic || topic.deletedAt) return { ok: false, error: "not_found" };
  }
  if (entry.authorId === reporterId) return { ok: false, error: "own_entry" };
  const reason = input.reason;
  return db.transaction(async tx => {
    const [row] = await tx
      .insert(reports)
      .values({ entryId: input.entryId, reporterId, reason, note, createdAt: opts.now })
      .onConflictDoNothing({ target: [reports.entryId, reports.reporterId] })
      .returning({ id: reports.id });
    if (!row) return { ok: false as const, error: "duplicate" as const };
    await enqueueReportTriage(tx, row.id);
    return { ok: true as const, id: row.id };
  });
}

// Open reports sent by this viewer, restricted to posts whose content the page shows.
export async function loadOwnOpenReportIds(db: Db, reporterId: string, entryIds: readonly number[]): Promise<Set<number>> {
  if (entryIds.length === 0) return new Set();
  const rows = await db.select({ entryId: reports.entryId }).from(reports)
    .where(and(eq(reports.reporterId, reporterId), eq(reports.status, "open"), inArray(reports.entryId, [...entryIds])));
  return new Set(rows.flatMap((r) => r.entryId === null ? [] : [r.entryId]));
}

// ---- Actions ----

export type ModerationError =
  | "not_found"
  // Post outside assigned languages, or unauthorized action.
  | "forbidden"
  // Action against one's own post.
  | "own_entry"
  // Action unavailable in the current state, such as already hidden, not hidden, or no open report.
  | "invalid_state"
  | "invalid_reason"
  | "invalid_note"
  | "note_required"
  // Invalid suspension duration or exceeded limit: 30 days for moderators, 365 for operators.
  | "invalid_days"
  // Operators cannot be suspended because environment variables determine them; prevent lockout.
  | "target_is_operator";

export type Actor = { id: string; scope: ModScope };
export type ModerationResult = { ok: true; actionId: number } | { ok: false; error: ModerationError };

type ActionInput = {
  entryId: number;
  reason: unknown;
  note?: unknown;
};

const fail = (error: ModerationError) => ({ ok: false as const, error });

// Read post with a row lock to serialize actions with other actions and deletion.
export async function lockEntry(db: Db, entryId: number) {
  await lockReferenceTopics(db, { entryId });
  const [row] = await db
    .select({
      id: entries.id,
      kind: entries.kind,
      lang: entries.lang,
      authorId: entries.authorId,
      threadId: entries.threadId,
      sourceHash: entries.sourceHash,
      title: entries.title,
      body: entries.body,
      asksStance: entries.asksStance,
      stanceLockedAt: entries.stanceLockedAt,
      hiddenAt: entries.hiddenAt,
      deletedAt: entries.deletedAt,
      moderationActionId: entries.moderationActionId,
    })
    .from(entries)
    .where(eq(entries.id, entryId))
    // FOR NO KEY UPDATE does not conflict with the KEY SHARE lock taken on the reply target for foreign-key validation during reply insertion. This prevents deletion and a reply to that post
    // from deadlocking while each waits for the other's topic-row or entry-row lock.
    .for("no key update");
  return row;
}

export type Checked = { reason: ReportReason; note: string };

// Validate reason category/note. needNote marks actions requiring a note shown to the affected member.
export function checkInput(input: { reason: unknown; note?: unknown }, needNote: boolean): Checked | ModerationError {
  if (!isReason(input.reason)) return "invalid_reason";
  const note = cleanNote(input.note, MAX_ACTION_NOTE);
  if (note === null) return "invalid_note";
  if (needNote && note === "") return "note_required";
  return { reason: input.reason, note };
}

// Shared post-action validation: assigned scope and own-post restriction; return the corresponding error.
function checkEntryAccess(actor: Actor, entry: { lang: string; authorId: string }): ModerationError | null {
  if (!inScope(actor.scope, entry.lang)) return "forbidden";
  if (entry.authorId === actor.id) return "own_entry";
  return null;
}

// Whether the actor was an operator by OPERATOR_EMAILS. false if the action is absent.
// Moderators cannot reverse operator actions (hide/suspend), preserving distinct authority.
export async function madeByOperator(db: Db, actionId: number | null | undefined): Promise<boolean> {
  if (actionId === null || actionId === undefined) return false;
  const [row] = await db
    .select({ email: user.email })
    .from(moderationActions)
    .innerJoin(user, eq(user.id, moderationActions.actorId))
    .where(eq(moderationActions.id, actionId));
  return row ? isOperatorEmail(row.email) : false;
}

// Latest action on the post among specified kinds, or null. Determine the action behind the current state from history,
// rather than moderation_action_id, which restoration and other actions overwrite.
export async function latestEntryAction(db: Db, entryId: number, kinds: readonly ModerationAction[]): Promise<{ id: number; action: ModerationAction; reason: ReportReason } | null> {
  const [row] = await db
    .select({ id: moderationActions.id, action: moderationActions.action, reason: moderationActions.reason })
    .from(moderationActions)
    .where(and(eq(moderationActions.targetEntryId, entryId), inArray(moderationActions.action, [...kinds])))
    .orderBy(desc(moderationActions.id))
    .limit(1);
  return row ? { id: row.id, action: row.action as ModerationAction, reason: isReason(row.reason) ? row.reason : "other" } : null;
}

// Resolve every open report on the post, retaining actor/time. Return resolved count.
export async function closeOpenReports(db: Db, entryId: number, status: "resolved" | "dismissed", handledBy: string | null, now: Date): Promise<number> {
  const rows = await db
    .update(reports)
    .set({ status, handledBy, handledAt: now })
    .where(and(eq(reports.entryId, entryId), eq(reports.status, "open")))
    .returning({ id: reports.id });
  return rows.length;
}

// Hide another author's undeleted, visible post within assigned scope. Resolve all open reports on it.
export async function hideEntry(db: Db, actor: Actor, input: ActionInput, opts: { now?: Date } = {}): Promise<ModerationResult> {
  const checked = checkInput(input, true);
  if (typeof checked === "string") return fail(checked);
  const now = opts.now ?? new Date();
  return db.transaction(async (tx) => {
    const entry = await lockEntry(tx, input.entryId);
    if (!entry || entry.deletedAt) return fail("not_found");
    const denied = checkEntryAccess(actor, entry);
    if (denied) return fail(denied);
    if (entry.hiddenAt) return fail("invalid_state");
    const [action] = await tx
      .insert(moderationActions)
      .values({ action: "hide", targetEntryId: entry.id, reason: checked.reason, note: checked.note, actorId: actor.id, createdAt: now })
      .returning({ id: moderationActions.id });
    await tx.update(entries).set({ hiddenAt: now, moderatedAt: now, moderationActionId: action.id }).where(eq(entries.id, entry.id));
    // Hiding an alternative question changes the original question's alternatives twin; mark the original changed too.
    await touchAltOriginal(tx, entry.id, now);
    await touchReferenceTopics(tx, entry.id, now);
    await closeOpenReports(tx, entry.id, "resolved", actor.id, now);
    // Hidden content has no embedding, excluding it from search/observations; regenerate when shown again.
    await purgeEmbeddings(tx, entry.id);
    // Notify the author without identifying the actor.
    await createModerationNotification(tx, { userId: entry.authorId, entryId: entry.id, actionId: action.id, now });
    return { ok: true as const, actionId: action.id };
  });
}

// Show another author's hidden post within assigned scope. Requeue translations not enqueued while hidden.
export async function unhideEntry(db: Db, actor: Actor, input: ActionInput, opts: { now?: Date } = {}): Promise<ModerationResult> {
  const checked = checkInput(input, false);
  if (typeof checked === "string") return fail(checked);
  const now = opts.now ?? new Date();
  return db.transaction(async (tx) => {
    const entry = await lockEntry(tx, input.entryId);
    if (!entry || entry.deletedAt) return fail("not_found");
    const denied = checkEntryAccess(actor, entry);
    if (denied) return fail(denied);
    if (!entry.hiddenAt) return fail("invalid_state");
    // Moderators cannot show a post hidden by an operator.
    if (!actor.scope.operator) {
      const current = await latestEntryAction(tx, entry.id, ["hide", "unhide"]);
      if (current?.action === "hide" && (await madeByOperator(tx, current.id))) return fail("forbidden");
    }
    const [action] = await tx
      .insert(moderationActions)
      .values({ action: "unhide", targetEntryId: entry.id, reason: checked.reason, note: checked.note, actorId: actor.id, createdAt: now })
      .returning({ id: moderationActions.id });
    await tx.update(entries).set({ hiddenAt: null, moderatedAt: now, moderationActionId: action.id }).where(eq(entries.id, entry.id));
    await touchAltOriginal(tx, entry.id, now);
    await touchReferenceTopics(tx, entry.id, now);
    if (entry.sourceHash) {
      await enqueueTranslations(tx, { id: entry.id, lang: entry.lang, sourceHash: entry.sourceHash });
      await enqueueEmbedding(tx, { id: entry.id, sourceHash: entry.sourceHash });
    }
    return { ok: true as const, actionId: action.id };
  });
}

// Operator-only delete action on posts. Operators cannot delete their own through moderation; authors can delete themselves.
// Same as author deletion via softDeleteEntry: recount totals, remove translations/segments/divergences/caches, cancel jobs.
// Resolve the post's open reports with the acting moderator/operator recorded.
export async function deleteEntry(db: Db, actor: Actor, input: ActionInput, opts: { now?: Date } = {}): Promise<ModerationResult> {
  const checked = checkInput(input, true);
  if (typeof checked === "string") return fail(checked);
  if (!actor.scope.operator) return fail("forbidden");
  const now = opts.now ?? new Date();
  return db.transaction(async (tx) => {
    const entry = await lockEntry(tx, input.entryId);
    if (!entry || entry.deletedAt) return fail("not_found");
    if (entry.authorId === actor.id) return fail("own_entry");
    const [action] = await tx
      .insert(moderationActions)
      .values({ action: "delete", targetEntryId: entry.id, reason: checked.reason, note: checked.note, actorId: actor.id, createdAt: now })
      .returning({ id: moderationActions.id });
    const res = await softDeleteEntry(tx, entry.id, { now, reports: { status: "resolved", by: actor.id }, moderationActionId: action.id });
    if (!res.ok) return fail("not_found");
    await createModerationNotification(tx, { userId: entry.authorId, entryId: entry.id, actionId: action.id, now });
    return { ok: true as const, actionId: action.id };
  });
}

// Dismiss all open reports on another author's post in assigned scope, leaving the post unchanged.
export async function dismissReports(db: Db, actor: Actor, input: ActionInput, opts: { now?: Date } = {}): Promise<ModerationResult> {
  const checked = checkInput(input, false);
  if (typeof checked === "string") return fail(checked);
  const now = opts.now ?? new Date();
  return db.transaction(async (tx) => {
    const entry = await lockEntry(tx, input.entryId);
    if (!entry || entry.deletedAt) return fail("not_found");
    const denied = checkEntryAccess(actor, entry);
    if (denied) return fail(denied);
    const closed = await closeOpenReports(tx, entry.id, "dismissed", actor.id, now);
    if (closed === 0) return fail("invalid_state");
    const [action] = await tx
      .insert(moderationActions)
      .values({ action: "dismiss_report", targetEntryId: entry.id, reason: checked.reason, note: checked.note, actorId: actor.id, createdAt: now })
      .returning({ id: moderationActions.id });
    return { ok: true as const, actionId: action.id };
  });
}

// ---- Member suspension ----

export { MAX_SUSPEND_DAYS };
const DAY_MS = 24 * 60 * 60 * 1000;
// Rolling period, in days, for the moderator's 30-day suspension cap.
const SUSPEND_BUDGET_WINDOW_DAYS = 90;

// Select report for an action by reportId or entryId; with entryId the server chooses from that post's reports.
type UserActionInput = { userId: string; reportId?: number | null; entryId?: number | null; reason: unknown; note?: unknown };

// Choose usable report for suspension/unsuspension by explicit reportId or from the specified entryId's reports.
// - In either case, the reported post's author must be the affected member.
// - Suspension reports must not be dismissed: open or resolved by hiding/deletion is acceptable.
// - Moderators additionally need a report on a post in their assigned language that they did not submit themselves, preventing self-report/self-suspension.
//   Moderators cannot act without a report. Operators may; resolve an eligible report if one exists.
// - For suspension, do not reuse a report already used to suspend.
async function usableReport(
  db: Db,
  actor: Actor,
  userId: string,
  input: { reportId?: number | null; entryId?: number | null },
  purpose: "suspend" | "unsuspend",
): Promise<{ ok: true; reportId: number | null } | { ok: false }> {
  const operator = actor.scope.operator;
  const okFor = (r: { authorId: string; lang: string; reporterId: string | null; status: string }) =>
    r.authorId === userId && (purpose !== "suspend" || r.status !== "dismissed") && (operator || (r.reporterId !== actor.id && inScope(actor.scope, r.lang)));
  const columns = { id: reports.id, status: reports.status, reporterId: reports.reporterId, entryId: reports.entryId, authorId: entries.authorId, lang: entries.lang };
  if (input.reportId !== null && input.reportId !== undefined) {
    const [chat] = await db.select({ id: reports.id, messageId: reports.chatMessageId, authorId: reports.chatAuthorId, status: reports.status }).from(reports).where(eq(reports.id, input.reportId));
    if (chat?.messageId) return operator && chat.authorId === userId && (purpose !== "suspend" || chat.status !== "dismissed") ? { ok: true, reportId: chat.id } : { ok: false };
    const [row] = await db.select(columns).from(reports).innerJoin(entries, eq(entries.id, reports.entryId)).where(eq(reports.id, input.reportId));
    return row && okFor(row) ? { ok: true, reportId: row.id } : { ok: false };
  }
  if (input.entryId !== null && input.entryId !== undefined) {
    const rows = await db
      .select(columns)
      .from(reports)
      .innerJoin(entries, eq(entries.id, reports.entryId))
      .where(eq(reports.entryId, input.entryId))
      // Open reports first, then oldest first.
      .orderBy(sql`(${reports.status} = 'open') desc`, asc(reports.createdAt), asc(reports.id));
    const candidates = rows.filter(okFor);
    const used =
      purpose === "suspend" && candidates.length > 0
        ? new Set(
            (
              await db
                .select({ reportId: moderationActions.reportId })
                .from(moderationActions)
                .where(and(eq(moderationActions.action, "suspend"), inArray(moderationActions.reportId, candidates.map((c) => c.id))))
            ).map((r) => r.reportId),
          )
        : new Set<number | null>();
    const picked = candidates.find((c) => !used.has(c.id));
    if (picked) return { ok: true, reportId: picked.id };
  }
  return operator ? { ok: true, reportId: null } : { ok: false };
}

// Read and row-lock the member, including suspension, reaction exclusion and operator status.
export async function lockMember(db: Db, userId: string) {
  const [row] = await db
    .select({
      userId: profiles.userId,
      suspendedUntil: profiles.suspendedUntil,
      suspendedActionId: profiles.suspendedActionId,
      displayNameActionId: profiles.displayNameActionId,
      avatarActionId: profiles.avatarActionId,
      reactionsExcludedAt: profiles.reactionsExcludedAt,
      reactionsExcludedActionId: profiles.reactionsExcludedActionId,
      email: user.email,
    })
    .from(profiles)
    .innerJoin(user, eq(user.id, profiles.userId))
    .where(eq(profiles.userId, userId))
    .for("update", { of: profiles });
  return row;
}

// Temporary suspension blocks writing but allows login/reading.
// Moderators: up to 30 days, only from scoped usableReport. Operators: any member up to 365 days.
// Cannot suspend oneself or an operator.
// - Only operators may extend/replace an active suspension, so moderators cannot overwrite an operator's suspension and erase its appeal target.
//   Even operators cannot shorten a longer existing suspension (invalid_state); use unsuspend instead.
// - Moderator suspensions: sum prior-90-day durations (expiry minus action time) for this member plus proposed days must not exceed 30,
//   preventing chained 30-day suspensions from repeated reports. Exceeding returns forbidden; operators are exempt.
// - One suspension per report, though different actions such as hiding then suspension can follow from the same report.
export async function suspendMember(
  db: Db,
  actor: Actor,
  input: UserActionInput & { days: unknown },
  opts: { now?: Date } = {},
): Promise<ModerationResult & { until?: Date }> {
  const checked = checkInput(input, true);
  if (typeof checked === "string") return fail(checked);
  const max = actor.scope.operator ? MAX_SUSPEND_DAYS.operator : MAX_SUSPEND_DAYS.moderator;
  const days = typeof input.days === "number" ? input.days : typeof input.days === "string" && /^\d{1,4}$/.test(input.days.trim()) ? Number(input.days) : NaN;
  if (!Number.isInteger(days) || days < 1 || days > max) return fail("invalid_days");
  if (input.userId === actor.id) return fail("own_entry");
  const now = opts.now ?? new Date();
  const until = new Date(now.getTime() + days * DAY_MS);
  return db.transaction(async (tx) => {
    const target = await lockMember(tx, input.userId);
    if (!target) return fail("not_found");
    if (isOperatorEmail(target.email)) return fail("target_is_operator");
    const suspended = target.suspendedUntil !== null && target.suspendedUntil > now;
    if (actor.scope.operator) {
      if (target.suspendedUntil !== null && target.suspendedUntil >= until) return fail("invalid_state");
    } else if (suspended) {
      return fail("invalid_state");
    }
    const report = await usableReport(tx, actor, input.userId, input, "suspend");
    if (!report.ok) return fail("forbidden");
    if (report.reportId !== null) {
      const [used] = await tx
        .select({ id: moderationActions.id })
        .from(moderationActions)
        .where(and(eq(moderationActions.reportId, report.reportId), eq(moderationActions.action, "suspend")))
        .limit(1);
      if (used) return fail("invalid_state");
    }
    if (!actor.scope.operator) {
      const since = new Date(now.getTime() - SUSPEND_BUDGET_WINDOW_DAYS * DAY_MS);
      const past = await tx
        .select({ createdAt: moderationActions.createdAt, until: moderationActions.until })
        .from(moderationActions)
        .where(and(eq(moderationActions.targetUserId, input.userId), eq(moderationActions.action, "suspend"), gt(moderationActions.createdAt, since)));
      const spent = past.reduce((sum, a) => sum + (a.until ? Math.max(0, a.until.getTime() - a.createdAt.getTime()) : 0), 0);
      if (spent + days * DAY_MS > MAX_SUSPEND_DAYS.moderator * DAY_MS) return fail("forbidden");
    }
    const [action] = await tx
      .insert(moderationActions)
      .values({
        action: "suspend",
        targetUserId: input.userId,
        reason: checked.reason,
        note: checked.note,
        actorId: actor.id,
        reportId: report.reportId,
        until,
        createdAt: now,
      })
      .returning({ id: moderationActions.id });
    await tx.update(profiles).set({ suspendedUntil: until, suspendedReason: checked.reason, suspendedActionId: action.id }).where(eq(profiles.userId, input.userId));
    // Resolve the supporting report if still open.
    if (report.reportId !== null) {
      await tx
        .update(reports)
        .set({ status: "resolved", handledBy: actor.id, handledAt: now })
        .where(and(eq(reports.id, report.reportId), eq(reports.status, "open")));
    }
    await createModerationNotification(tx, { userId: input.userId, entryId: null, actionId: action.id, now });
    return { ok: true as const, actionId: action.id, until };
  });
}

// Unsuspend only currently suspended members. Moderators need a scoped report on the member's post and cannot reverse operator suspensions. Operators may unsuspend any member.
export async function unsuspendMember(db: Db, actor: Actor, input: UserActionInput, opts: { now?: Date } = {}): Promise<ModerationResult> {
  const checked = checkInput(input, false);
  if (typeof checked === "string") return fail(checked);
  if (input.userId === actor.id) return fail("own_entry");
  const now = opts.now ?? new Date();
  return db.transaction(async (tx) => {
    const target = await lockMember(tx, input.userId);
    if (!target) return fail("not_found");
    const report = await usableReport(tx, actor, input.userId, input, "unsuspend");
    if (!report.ok) return fail("forbidden");
    if (target.suspendedUntil === null || target.suspendedUntil <= now) return fail("invalid_state");
    // Moderators cannot reverse operator suspensions, preserving authority boundaries, nor suspensions with no action record.
    if (!actor.scope.operator && (target.suspendedActionId === null || (await madeByOperator(tx, target.suspendedActionId)))) return fail("forbidden");
    const [action] = await tx
      .insert(moderationActions)
      .values({ action: "unsuspend", targetUserId: input.userId, reason: checked.reason, note: checked.note, actorId: actor.id, reportId: report.reportId, createdAt: now })
      .returning({ id: moderationActions.id });
    await tx.update(profiles).set({ suspendedUntil: null, suspendedReason: null, suspendedActionId: null }).where(eq(profiles.userId, input.userId));
    // Notify the member of unsuspension, paired with suspension mail, without actor identity.
    await createModerationNotification(tx, { userId: input.userId, entryId: null, actionId: action.id, now });
    return { ok: true as const, actionId: action.id };
  });
}

// ---- Typo correction on locked questions ----

export type FixEntryError = ModerationError | EntryError | "no_change";
export type FixEntryResult = { ok: true; actionId: number; revisionId: number } | { ok: false; error: FixEntryError };

// Assigned-original-language moderators/operators fix typos on locked asks_stance topics (first non-author stance registered): fix_entry.
// Before lock, authors can edit: invalid_state. Deleted questions give not_found; replies/non-questions invalid_state; own questions own_entry.
// Fix reason category to other and require an explanation of the correction. Same length/single-line-title validation as editEntry; unchanged content gives no_change.
// UI: 「誤字の修正だけを行ってください」. Code cannot enforce typo-only edits; revisions, author notification, public records and appeals restoring the previous version provide checks (cores 3,6).
// Lock order: question entry (FOR NO KEY UPDATE), then translation/report cleanup rows (entry → reports). Reversal deadlocked deletion/retranslation jobs.
// Do not lock member-profile rows.
// Transaction: lock question → save prior title/body in entry_revisions with moderator editor_id → update title/body and edited_at, leaving stance_locked_at and stance rows
// unchanged → cleanup segments, translation/embedding jobs, render cache, divergences and original question for alternatives (applyEntryEdit) → record moderation_actions.fix_entry with revision_id
// → moderation notification to author, without a new notification kind or mention notifications.
// sourceHash: the base of the edit form, the source_hash of the text the moderator was looking at. If it is not the current one, someone else changed the text in the meantime
// (another moderator's fix, or an appeal that put the earlier text back): invalid_state, nothing is written, so a stale form cannot overwrite that change.
async function fixEntryImplementation(
  db: Db,
  actor: Actor,
  input: { entryId: number; title?: unknown; body: unknown; note: unknown; sourceHash: unknown },
  opts: { now?: Date } = {},
): Promise<FixEntryResult> {
  const failFix = (error: FixEntryError) => ({ ok: false as const, error });
  const checked = checkInput({ reason: "other", note: input.note }, true);
  if (typeof checked === "string") return failFix(checked);
  const text = parseTopicText({ title: input.title, body: input.body });
  if (!text.ok) return failFix(text.error);
  // A fix is only for a locked question, and a question keeps its title (the proposition): a fix cannot empty it.
  if (text.title === null) return failFix("invalid_title");
  const bodyError = await checkBodyBudget(text.body, actor.id);
  if (bodyError) return failFix(bodyError);
  const now = opts.now ?? new Date();
  return db.transaction(async (tx) => {
    await lockReferenceTopics(tx, { entryId: input.entryId, body: text.body });
    const entry = await lockEntry(tx, input.entryId);
    if (!entry || entry.deletedAt) return failFix("not_found");
    const denied = checkEntryAccess(actor, entry);
    if (denied) return failFix(denied);
    if (entry.kind !== "topic" || !entry.asksStance || entry.stanceLockedAt === null) return failFix("invalid_state");
    // A form that was opened before the latest change to the text (its base is not the current text) is refused, whatever it contains.
    if (typeof input.sourceHash !== "string" || input.sourceHash !== (entry.sourceHash ?? "")) return failFix("invalid_state");
    if (entry.title === text.title && entry.body === text.body) return failFix("no_change");
    // The fix is shown with mentions emphasized, but it never notifies: a mention in a moderator's fix is not the author's call.
    const rendered = (await tryRenderEntry(text.body, { idPrefix: entryIdPrefix("topic", entry.id), lang: entry.lang, mentions: (await resolveSourceMentions(tx, entry.body, entry.id)).targets }));
    if (rendered === null) return failFix("body_unrenderable");
    const { revisionId } = await applyEntryEdit(tx, {
      entryId: entry.id,
      editorId: actor.id,
      now,
      before: { title: entry.title, body: entry.body, sourceHash: entry.sourceHash, lang: entry.lang, hiddenAt: entry.hiddenAt },
      after: { title: text.title, body: text.body, html: rendered.html, cardHtml: rendered.cardHtml },
    });
    if (revisionId === null) throw new Error("Moderator corrections must preserve a revision");
    const [action] = await tx
      .insert(moderationActions)
      .values({ action: "fix_entry", targetEntryId: entry.id, reason: "other", note: checked.note, actorId: actor.id, revisionId, createdAt: now })
      .returning({ id: moderationActions.id });
    await createModerationNotification(tx, { userId: entry.authorId, entryId: entry.id, actionId: action.id, now });
    return { ok: true as const, actionId: action.id, revisionId };
  });
}

// ---- Exclude stances and Insightful (「なるほど」): operators only ----

type ReactionsInput = { userId: string; reason: unknown; note?: unknown };

// Exclude stances and Insightful (「なるほど」) from accounts deemed fake/manipulative (exclude_reactions). Mere agreement is not manipulation. Operators only; cannot target operators or oneself.
// Note required. Excludes all that member's stances and Insightful (「なるほど」), including earlier reactions, by checking profiles.reactions_excluded_at on every read: distributions (totals/language counts), reason candidates,
// objection panel, metrics and observation exports. Preserve the member's own 「押した」 state and export. Notify via moderation, publish in records and allow appeal.
// FOR UPDATE-lock the member, matching stance-write order: profile row first.
export async function excludeReactions(db: Db, actor: Actor, input: ReactionsInput, opts: { now?: Date } = {}): Promise<ModerationResult> {
  const checked = checkInput(input, true);
  if (typeof checked === "string") return fail(checked);
  if (!actor.scope.operator) return fail("forbidden");
  if (input.userId === actor.id) return fail("own_entry");
  const now = opts.now ?? new Date();
  return db.transaction(async (tx) => {
    const target = await lockMember(tx, input.userId);
    if (!target) return fail("not_found");
    if (isOperatorEmail(target.email)) return fail("target_is_operator");
    if (target.reactionsExcludedAt !== null) return fail("invalid_state");
    const [action] = await tx
      .insert(moderationActions)
      .values({ action: "exclude_reactions", targetUserId: input.userId, reason: checked.reason, note: checked.note, actorId: actor.id, createdAt: now })
      .returning({ id: moderationActions.id });
    await tx.update(profiles).set({ reactionsExcludedAt: now, reactionsExcludedActionId: action.id }).where(eq(profiles.userId, input.userId));
    await createModerationNotification(tx, { userId: input.userId, entryId: null, actionId: action.id, now });
    return { ok: true as const, actionId: action.id };
  });
}

// Reverse exclusion with include_reactions, only for currently excluded members. Restore everything and notify the member.
export async function includeReactions(db: Db, actor: Actor, input: ReactionsInput, opts: { now?: Date } = {}): Promise<ModerationResult> {
  const checked = checkInput(input, false);
  if (typeof checked === "string") return fail(checked);
  if (!actor.scope.operator) return fail("forbidden");
  if (input.userId === actor.id) return fail("own_entry");
  const now = opts.now ?? new Date();
  return db.transaction(async (tx) => {
    const target = await lockMember(tx, input.userId);
    if (!target) return fail("not_found");
    if (target.reactionsExcludedAt === null) return fail("invalid_state");
    const [action] = await tx
      .insert(moderationActions)
      .values({ action: "include_reactions", targetUserId: input.userId, reason: checked.reason, note: checked.note, actorId: actor.id, createdAt: now })
      .returning({ id: moderationActions.id });
    await tx.update(profiles).set({ reactionsExcludedAt: null, reactionsExcludedActionId: null }).where(eq(profiles.userId, input.userId));
    await createModerationNotification(tx, { userId: input.userId, entryId: null, actionId: action.id, now });
    return { ok: true as const, actionId: action.id };
  });
}

// ---- Moderator screen (/mod) ----

// Topic containing a post; a topic contains itself.
const topicOf = alias(entries, "report_topic");

export type ReportSummary = { id: number; reason: ReportReason; note: string; createdAt: Date; automaticallyResolved?: boolean; aiPriority?: string | null; aiAssessment?: { en: string; ja: string } | null };
export type ReportCard = {
  entryId: number;
  kind: "topic" | "reply";
  threadId: number;
  lang: SourceLang;
  title: string | null;
  body: string;
  hidden: boolean;
  authorId: string;
  authorHandle: string;
  // Current suspension expiry of the author, for displaying unsuspend controls.
  authorSuspendedUntil: Date | null;
  // Never expose reporter; reason/note only.
  reports: ReportSummary[];
};
export type ReportCardPage = { cards: Array<ReportCard | VillageReportCard | ChatReportCard | DisplayNameReportCard | AvatarReportCard>; page: number; hasNext: boolean };

export const CARDS_PER_PAGE = 20;

// Open reports in assigned scope, grouped per post, oldest first report first. status:handled lists posts with handled reports, newest action first.
// viewerId hides reports on the viewer's own posts, which they cannot moderate and whose notes may reveal reporter identity.
export async function listReportCards(
  db: Db,
  scope: ModScope,
  opts: { page?: number; handled?: boolean; limit?: number; viewerId?: string } = {},
): Promise<ReportCardPage> {
  const page = opts.page ?? 1;
  const limit = opts.limit ?? CARDS_PER_PAGE;
  if (!scope.operator && scope.langs.length === 0) return { cards: [], page, hasNext: false };
  const inRange = and(scope.operator ? undefined : or(inArray(entries.lang, [...scope.langs]), notInArray(entries.lang, [...enabledLangs()])), opts.viewerId ? ne(entries.authorId, opts.viewerId) : undefined);
  const statusFilter = opts.handled ? sql`${reports.status} <> 'open'` : eq(reports.status, "open");
  const grouped = await db
    .select({ entryId: reports.entryId, villageId: reports.villageId, chatMessageId: reports.chatMessageId, displayNameUserId: reports.displayNameUserId, avatarUserId: reports.avatarUserId, first: min(reports.createdAt), latest: sql<Date>`max(coalesce(${reports.handledAt}, ${reports.createdAt}))`.mapWith(reports.createdAt) })
    .from(reports)
    .leftJoin(entries, eq(entries.id, reports.entryId))
    // Omit posts within deleted topics because their threads cannot be opened.
    .leftJoin(topicOf, eq(topicOf.id, sql`coalesce(${entries.threadId}, ${entries.id})`))
    .where(and(statusFilter, or(and(isNotNull(reports.entryId), isNull(entries.deletedAt), isNull(topicOf.deletedAt), inRange), scope.operator ? isNotNull(reports.villageId) : undefined, scope.operator ? and(isNotNull(reports.avatarUserId), opts.viewerId ? ne(reports.avatarUserId, opts.viewerId) : undefined) : undefined, scope.operator ? and(isNotNull(reports.displayNameUserId), opts.viewerId ? ne(reports.displayNameUserId, opts.viewerId) : undefined) : undefined, and(isNotNull(reports.chatMessageId), scope.operator ? undefined : inArray(reports.chatLang, [...scope.langs]), opts.viewerId ? sql`${reports.chatAuthorId} is distinct from ${opts.viewerId}` : undefined))))
    .groupBy(reports.entryId, reports.villageId, reports.chatMessageId, reports.displayNameUserId, reports.avatarUserId)
    .orderBy(opts.handled ? sql`max(coalesce(${reports.handledAt}, ${reports.createdAt})) desc` : asc(min(reports.createdAt)), asc(reports.entryId), asc(reports.villageId), asc(reports.chatMessageId), asc(reports.displayNameUserId), asc(reports.avatarUserId))
    .limit(limit + 1)
    .offset((page - 1) * limit);
  const pageRows = grouped.slice(0, limit);
  if (pageRows.length === 0) return { cards: [], page, hasNext: false };
  const ids = pageRows.flatMap(r => r.entryId === null ? [] : [r.entryId]);
  const villageCards = await loadVillageReportCards(db, pageRows.flatMap(r => r.villageId === null ? [] : [r.villageId]), !!opts.handled, opts.viewerId);
  const chatCards = await loadChatReportCards(db, pageRows.flatMap(r => r.chatMessageId === null ? [] : [r.chatMessageId]), !!opts.handled, scope.operator);
  const nameCards = await loadDisplayNameReportCards(db, pageRows.flatMap(r => r.displayNameUserId === null ? [] : [r.displayNameUserId]), !!opts.handled);
  const avatarCards = await loadAvatarReportCards(db, pageRows.flatMap(r => r.avatarUserId === null ? [] : [r.avatarUserId]), !!opts.handled);
  const [entryRows, reportRows] = await Promise.all([
    db
      .select({
        id: entries.id,
        kind: entries.kind,
        threadId: entries.threadId,
        lang: entries.lang,
        title: entries.title,
        body: entries.body,
        hiddenAt: entries.hiddenAt,
        authorId: entries.authorId,
        authorHandle: retainedAuthorColumn(entries.authorId),
        suspendedUntil: profiles.suspendedUntil,
      })
      .from(entries)
      .leftJoin(profiles, eq(profiles.userId, entries.authorId))
      .where(inArray(entries.id, ids)),
    db
      .select({ id: reports.id, entryId: reports.entryId, reason: reports.reason, note: reports.note, createdAt: reports.createdAt, automaticallyResolved: automaticallyResolvedReport(), aiPriority: reports.aiPriority, aiAssessment: reports.aiAssessment })
      .from(reports)
      .where(and(inArray(reports.entryId, ids), statusFilter))
      .orderBy(asc(reports.createdAt), asc(reports.id)),
  ]);
  const byId = new Map(entryRows.map((e) => [e.id, e]));
  const cards = pageRows.flatMap<ReportCard | VillageReportCard | ChatReportCard | DisplayNameReportCard | AvatarReportCard>((g) => {
    if (g.avatarUserId !== null) { const card = avatarCards.get(g.avatarUserId); return card ? [card] : []; }
    if (g.displayNameUserId !== null) { const card = nameCards.get(g.displayNameUserId); return card ? [card] : []; }
    if (g.chatMessageId !== null) { const card = chatCards.get(g.chatMessageId); return card ? [card] : []; }
    if (g.villageId !== null) { const card = villageCards.get(g.villageId); return card && !card.owned ? [card] : []; }
    const e = g.entryId === null ? undefined : byId.get(g.entryId);
    if (!e || !isSourceLang(e.lang)) return [];
    return [
      {
        entryId: e.id,
        kind: e.kind as "topic" | "reply",
        threadId: e.threadId ?? e.id,
        lang: e.lang,
        title: e.title,
        body: e.body,
        hidden: e.hiddenAt !== null,
        authorId: e.authorId,
        authorHandle: e.authorHandle ?? "?",
        authorSuspendedUntil: e.suspendedUntil !== null && e.suspendedUntil > new Date() ? e.suspendedUntil : null,
        reports: reportRows.filter((r) => r.entryId === e.id).map((r) => ({ id: r.id, reason: r.reason as ReportReason, note: r.note, createdAt: r.createdAt, automaticallyResolved: r.automaticallyResolved, aiPriority: r.aiPriority, aiAssessment: r.aiAssessment })),
      },
    ];
  });
  return { cards, page, hasNext: grouped.length > limit };
}

// ---- Public moderation record (/moderation) ----

// One public record row: action kind, reason category, original post language (null for member actions), UTC date only.
// No actor, reporter, note, affected display name or human post link/id. Nushi actions include the AI answer number.
export type PublicLogEntry = { automatic?: boolean; action: ModerationAction; reason: ReportReason; date: string; nushiAnswerId?: number } & ({ lang: SourceLang | null; village?: never } | { village: { name: string; slug: string | null } | null; lang?: never } | { place: "village_chat"; lang?: never; village?: never });
export const PUBLIC_LOG_PER_PAGE = 50;

// Newest first; page starts at 1.
export async function listPublicLog(db: Db, opts: { page?: number; limit?: number } = {}): Promise<{ entries: PublicLogEntry[]; page: number; hasNext: boolean }> {
  const page = opts.page ?? 1;
  const limit = opts.limit ?? PUBLIC_LOG_PER_PAGE;
  const condition = ne(moderationActions.action, "dismiss_chat_report");
  const offset = (page - 1) * limit;
  const boundary = offset ? db.select({ createdAt: moderationActions.createdAt, id: moderationActions.id }).from(moderationActions)
    .where(condition).orderBy(desc(moderationActions.createdAt), desc(moderationActions.id)).limit(1).offset(offset - 1) : undefined;
  const rows = await db
    .select({ automatic: moderationActions.automatic, action: moderationActions.action, reason: moderationActions.reason, lang: entries.lang, createdAt: moderationActions.createdAt, nushiAnswerId: moderationActions.targetNushiAnswerId, targetVillageId: moderationActions.targetVillageId, targetChatMessageId: moderationActions.targetChatMessageId })
    .from(moderationActions)
    .leftJoin(entries, eq(entries.id, moderationActions.targetEntryId))
    .where(and(condition, afterPageBoundary([moderationActions.createdAt, moderationActions.id], boundary, true)))
    .orderBy(desc(moderationActions.createdAt), desc(moderationActions.id))
    .limit(limit + 1);
  const pageRows = rows.slice(0, limit);
  const villageIds = pageRows.flatMap(r => r.targetVillageId === null || r.action === "dismiss_village_report" ? [] : [r.targetVillageId]);
  const villageRows = villageIds.length ? await db.select({ id: villages.id, name: villages.name, slug: villages.slug, language: villages.language, kind: villages.kind }).from(villages).where(inArray(villages.id, villageIds)) : [];
  const villageById = new Map(villageRows.map(v => [v.id, v]));
  return {
    entries: pageRows.map((r): PublicLogEntry => ({
      ...(r.automatic ? { automatic: true } : {}),
      action: r.action as ModerationAction,
      reason: r.reason as ReportReason,
      ...(r.nushiAnswerId === null ? {} : { nushiAnswerId: r.nushiAnswerId }),
      ...(r.targetChatMessageId !== null ? { place: "village_chat" as const } : r.targetVillageId === null ? { lang: r.lang !== null && isSourceLang(r.lang) ? r.lang : null } : { village: (() => { const v = r.action === "dismiss_village_report" ? undefined : villageById.get(r.targetVillageId); return v && isSharedVillageKind(v.kind) ? { name: villageName(v), slug: v.slug } : null; })() }),
      date: r.createdAt.toISOString().slice(0, 10),
    })),
    page,
    hasNext: rows.length > limit,
  };
}

// The write phase owns a transaction, or a savepoint when db is already transactional (such as in withSignedWrite).
// MarkdownBudgetError becomes a result: from the write phase only after that boundary rolls back, and from
// rendering before the write phase while nothing has been written yet. Other exceptions propagate.
export async function fixEntry(...args: Parameters<typeof fixEntryImplementation>): Promise<Awaited<ReturnType<typeof fixEntryImplementation>>> {
  return withMarkdownScope("write", args[1].id, async () => {
    try { return await fixEntryImplementation(...args); }
    catch (error) { if (error instanceof MarkdownBudgetError) return { ok: false, error: "body_too_complex" }; throw error; }
  });
}
