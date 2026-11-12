import { RETENTION, RETENTION_BATCH_SIZE, daysBefore } from "./retention";
import { recordRetentionResult, drainRetentionBatches, updateRetentionRows, type RetentionResults } from "./retention-batch.server";
import { enqueueReportTriage } from "./moderation-automation.server";
import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, ne, sql } from "drizzle-orm";
import { automaticallyResolvedReport } from "./report-resolution.server";
import type { Db } from "./db/client.server";
import { appeals, chatAccessLog, chatConsents, chatMessages, chatReportSnapshots, moderationActions, notifications, profiles, reports, villageMembers, villages } from "./db/schema";
import { checkInput, madeByOperator, MAX_REPORT_NOTE, type Actor, type ReportSummary } from "./moderation.server";
import { isReason, type ReportReason } from "./moderation";
import { inLanguageScope } from "./roles.server";
import { isLang, type Lang } from "./languages";
import { villageChatEnabled } from "./village-chat-enabled.server";
import { chatVillageCondition } from "./village-chat-villages.server";
import { isSharedVillageKind, villageText } from "./villages";
import { nextChatSequence } from "./village-chat.server";
import { signalVillageChat } from "./village-chat-events.server";
import { createModerationNotification } from "./notifications.server";
import { CHAT_APPEAL_REVIEW_REASON, CHAT_CASE_CONTEXT_COUNT, CHAT_CASE_EXPAND_LIMIT, CHAT_EXPAND_REASON_PREFIX, CHAT_REPORT_REVIEW_REASON } from "./chat-access";
import { CHAT_CONSENT_VERSION } from "./village-chat-consent";

export class ChatReportError extends Error {
  constructor(public code: "not_found" | "forbidden" | "invalid" | "duplicate" | "invalid_state" | "case_closed" | "expand_limit" | "unavailable") { super(code); }
}
export type ChatCase = { kind: "report" | "appeal"; id: number };
export type ChatReportCard = { kind: "chat"; entryId?: never; hidden?: never; reportId: number; lang: Lang; village: { name: string; language: string | null } | null; canUnhide: boolean; reports: ReportSummary[] };
export type ChatEvidenceMessage = { id: string; body: string; lang: string; author: string; createdAt: string; createdSeq: number; changedSeq: number; hidden: boolean };
export type ChatVisibilityChange = { id: string; villageId: string; hidden: boolean; reversed?: boolean };

async function activeActor(db: Db, id: string, now: Date) {
  const [row] = await db.select({ handle: profiles.handle, suspendedUntil: profiles.suspendedUntil }).from(profiles).where(eq(profiles.userId, id));
  if (!row || row.suspendedUntil && row.suspendedUntil > now) throw new ChatReportError("forbidden");
  return row;
}

// This lock order also serializes reporting, author edits/deletion, appeals and evidence pruning.
export async function lockChatReportTarget(db: Db, messageId: string) {
  const [target] = await db.select({ villageId: chatMessages.villageId }).from(chatMessages).where(eq(chatMessages.id, messageId));
  if (!target) throw new ChatReportError("not_found");
  const [village] = await db.select({ id: villages.id }).from(villages).where(eq(villages.id, target.villageId)).for("share");
  if (!village) throw new ChatReportError("not_found");
  const [message] = await db.select().from(chatMessages).where(eq(chatMessages.id, messageId)).for("update");
  if (!message) throw new ChatReportError("not_found");
  return message;
}

export async function createChatReport(db: Db, reporterId: string, input: { slug: string; messageId: string; reason: unknown; note?: unknown }, opts: { now?: Date } = {}) {
  if (!villageChatEnabled()) throw new ChatReportError("not_found");
  if (!isReason(input.reason)) throw new ChatReportError("invalid");
  const reason = input.reason, note = villageText(input.note ?? "", MAX_REPORT_NOTE);
  if (note === null) throw new ChatReportError("invalid");
  const now = opts.now ?? new Date();
  try {
    return await db.transaction(async tx => {
      await activeActor(tx, reporterId, now);
      const [village] = await tx.select({ id: villages.id }).from(villages).where(and(eq(villages.slug, input.slug.toLowerCase()), chatVillageCondition())).for("share");
      if (!village) throw new ChatReportError("not_found");
      const [member] = await tx.select({ id: villageMembers.userId }).from(villageMembers).where(and(eq(villageMembers.villageId, village.id), eq(villageMembers.userId, reporterId))).for("share");
      if (!member) throw new ChatReportError("not_found");
      const [consent] = await tx.select({ version: chatConsents.version }).from(chatConsents).where(and(eq(chatConsents.villageId, village.id), eq(chatConsents.userId, reporterId)));
      if (consent?.version !== CHAT_CONSENT_VERSION) throw new ChatReportError("not_found");
      const [message] = await tx.select().from(chatMessages).where(and(eq(chatMessages.id, input.messageId), eq(chatMessages.villageId, village.id))).for("update");
      if (!message || message.deletedAt || message.hiddenAt) throw new ChatReportError("not_found");
      if (message.authorId === reporterId) throw new ChatReportError("forbidden");
      const [author] = await tx.select({ handle: profiles.handle }).from(profiles).where(eq(profiles.userId, message.authorId));
      await tx.insert(chatReportSnapshots).values({ messageId: message.id, body: message.body, lang: message.lang, authorId: message.authorId, authorHandle: author?.handle ?? "", messageCreatedAt: message.createdAt, createdSeq: message.createdSeq, changedSeq: message.changedSeq, capturedAt: now }).onConflictDoNothing();
      const [snapshot] = await tx.select({ lang: chatReportSnapshots.lang, authorId: chatReportSnapshots.authorId }).from(chatReportSnapshots).where(eq(chatReportSnapshots.messageId, message.id));
      const [row] = await tx.insert(reports).values({ chatMessageId: message.id, chatLang: snapshot.lang, chatAuthorId: snapshot.authorId, reporterId, reason, note, createdAt: now }).onConflictDoNothing().returning({ id: reports.id });
      if (!row) throw new ChatReportError("duplicate");
      await enqueueReportTriage(tx, row.id);
      return { id: row.id };
    });
  } catch (error) {
    if (error instanceof ChatReportError) throw error;
    // Bound SQL parameters can contain private bodies. Never propagate database diagnostics.
    throw new ChatReportError("unavailable");
  }
}

export async function chatHideMadeByOperator(db: Db, messageId: string): Promise<boolean> {
  const [latest] = await db.select({ id: moderationActions.id }).from(moderationActions).where(and(eq(moderationActions.targetChatMessageId, messageId), inArray(moderationActions.action, ["hide_chat", "unhide_chat"]))).orderBy(desc(moderationActions.id)).limit(1);
  return madeByOperator(db, latest?.id);
}

export async function loadChatReportCards(db: Db, ids: string[], handled: boolean, operator = false): Promise<Map<string, ChatReportCard>> {
  if (!ids.length) return new Map();
  const rows = await db.select({ id: reports.id, messageId: reports.chatMessageId, lang: reports.chatLang, reason: reports.reason, note: reports.note, createdAt: reports.createdAt, aiPriority: reports.aiPriority, automaticallyResolved: automaticallyResolvedReport(), status: reports.status, handledAt: reports.handledAt, hiddenAt: chatMessages.hiddenAt, villageName: villages.name, villageLanguage: villages.language, villageKind: villages.kind })
    .from(reports).innerJoin(chatMessages, eq(chatMessages.id, reports.chatMessageId)).innerJoin(villages, eq(villages.id, chatMessages.villageId))
    .where(and(inArray(reports.chatMessageId, ids), handled ? ne(reports.status, "open") : eq(reports.status, "open"))).orderBy(asc(reports.createdAt), asc(reports.id));
  const out = new Map<string, ChatReportCard>();
  const latestResolved = new Map<string, { id: number; time: number }>();
  for (const row of rows) {
    if (!row.messageId || !isLang(row.lang)) continue;
    const card = out.get(row.messageId) ?? { kind: "chat", reportId: row.id, lang: row.lang, village: isSharedVillageKind(row.villageKind) ? { name: row.villageName, language: row.villageLanguage } : null, canUnhide: row.hiddenAt !== null && (operator || !await chatHideMadeByOperator(db, row.messageId)), reports: [] };
    if (handled && row.status === "resolved") {
      const time = (row.handledAt ?? row.createdAt).getTime(), previous = latestResolved.get(row.messageId);
      if (!previous || time > previous.time || time === previous.time && row.id > previous.id) {
        card.reportId = row.id; latestResolved.set(row.messageId, { id: row.id, time });
      }
    }
    card.reports.push({ id: row.id, reason: row.reason as ReportReason, note: row.note, createdAt: row.createdAt, aiPriority: row.aiPriority, automaticallyResolved: row.automaticallyResolved }); out.set(row.messageId, card);
  }
  return out;
}

// Metadata only. Calling this on GET neither reveals evidence nor writes an access record.
export async function chatCaseMetadata(db: Db, actor: Actor, target: ChatCase) {
  let messageId: string | null = null, status = "", reportId: number | null = null;
  if (target.kind === "report") {
    const [row] = await db.select({ messageId: reports.chatMessageId, status: reports.status }).from(reports).where(eq(reports.id, target.id));
    messageId = row?.messageId ?? null; status = row?.status ?? ""; reportId = target.id;
  } else {
    const [row] = await db.select({ messageId: moderationActions.targetChatMessageId, source: moderationActions.reportId, actorId: moderationActions.actorId, appellantId: appeals.appellantId, status: appeals.status }).from(appeals).innerJoin(moderationActions, eq(moderationActions.id, appeals.actionId)).where(eq(appeals.id, target.id));
    if (!row || row.actorId === actor.id || row.appellantId === actor.id) throw new ChatReportError("forbidden");
    messageId = row.messageId; status = row.status; reportId = row.source;
    if (!messageId && row.source !== null) {
      const [source] = await db.select({ messageId: reports.chatMessageId }).from(reports).where(eq(reports.id, row.source)); messageId = source?.messageId ?? null;
    }
  }
  if (!messageId) throw new ChatReportError("not_found");
  const [row] = await db.select({ lang: chatReportSnapshots.lang, authorId: chatReportSnapshots.authorId, createdSeq: chatReportSnapshots.createdSeq, prunedAt: chatReportSnapshots.prunedAt, hiddenAt: chatMessages.hiddenAt, villageId: chatMessages.villageId, villageName: villages.name, villageLanguage: villages.language, villageKind: villages.kind })
    .from(chatReportSnapshots).innerJoin(chatMessages, eq(chatMessages.id, chatReportSnapshots.messageId)).innerJoin(villages, eq(villages.id, chatMessages.villageId)).where(eq(chatReportSnapshots.messageId, messageId));
  if (!row || !inLanguageScope(actor.scope, row.lang) || row.authorId === actor.id) throw new ChatReportError("forbidden");
  // As with post reports, a moderator may handle their own report, but never their own writing.
  if (target.kind === "appeal") {
    const [mine] = await db.select({ id: reports.id }).from(reports).where(and(eq(reports.chatMessageId, messageId), eq(reports.reporterId, actor.id))).limit(1);
    if (mine) throw new ChatReportError("forbidden");
  }
  const openReports = target.kind === "report" ? await db.select({ id: reports.id }).from(reports).where(and(eq(reports.chatMessageId, messageId), eq(reports.status, "open"))).limit(1) : [];
  return { ...target, messageId, reportId, status, hidden: row.hiddenAt !== null, canUnhide: row.hiddenAt !== null && (actor.scope.operator || !await chatHideMadeByOperator(db, messageId)), hasOpenReports: openReports.length > 0, lang: row.lang, authorId: row.authorId, anchor: row.createdSeq, villageId: row.villageId, village: isSharedVillageKind(row.villageKind) ? { name: row.villageName, language: row.villageLanguage } : null, pruned: row.prunedAt !== null };
}

export async function readChatEvidence(db: Db, actor: Actor, target: ChatCase, input: { intent: "open" | "context" | "expand"; previous?: number; reason?: unknown }, opts: { now?: Date } = {}) {
  const reason = input.intent === "expand" ? villageText(input.reason ?? "", 1000) : "";
  if (reason === null || input.intent === "expand" && (!reason || reason.startsWith("chat:"))) throw new ChatReportError("invalid");
  const now = opts.now ?? new Date();
  try {
    return await db.transaction(async tx => {
      const reader = await activeActor(tx, actor.id, now);
      const metadata = await chatCaseMetadata(tx, actor, target);
      // Serialize reads with case decisions and other readers, then recheck committed state.
      await lockChatReportTarget(tx, metadata.messageId);
      const [currentCase] = target.kind === "report"
        ? await tx.select({ status: reports.status }).from(reports).where(eq(reports.id, target.id)).for("share")
        : await tx.select({ status: appeals.status }).from(appeals).where(eq(appeals.id, target.id)).for("share");
      if (currentCase?.status !== "open") throw new ChatReportError("case_closed");
      const caseFilter = target.kind === "report" ? eq(chatAccessLog.reportId, target.id) : eq(chatAccessLog.appealId, target.id);
      let from = metadata.anchor, to = metadata.anchor;
      const versions: typeof chatAccessLog.$inferInsert.versions = [];
      let snapshot: { body: string | null; lang: string; author: string; createdAt: string; changedSeq: number } | null = null;
      let current: ChatEvidenceMessage | null = null, deleted = false;
      let context: ChatEvidenceMessage[] = [];
      let statement: string | null = null, explanation: string | null = null;
      if (input.intent === "open") {
        if (target.kind === "appeal") {
          const [argument] = await tx.select({ text: appeals.text, note: moderationActions.note }).from(appeals).innerJoin(moderationActions, eq(moderationActions.id, appeals.actionId)).where(eq(appeals.id, target.id));
          statement = argument?.text ?? null; explanation = argument?.note ?? null;
        }
        const [saved] = await tx.select().from(chatReportSnapshots).where(eq(chatReportSnapshots.messageId, metadata.messageId));
        const [live] = await tx.select({ message: chatMessages, handle: profiles.handle }).from(chatMessages).leftJoin(profiles, eq(profiles.userId, chatMessages.authorId)).where(eq(chatMessages.id, metadata.messageId));
        snapshot = { body: saved.body, lang: saved.lang, author: saved.authorHandle, createdAt: saved.messageCreatedAt.toISOString(), changedSeq: saved.changedSeq };
        if (saved.body !== null) versions.push({ id: saved.messageId, createdSeq: saved.createdSeq, changedSeq: saved.changedSeq, snapshot: true });
        deleted = !!live?.message.deletedAt;
        if (live && !deleted && (live.message.body !== saved.body || live.message.lang !== saved.lang)) {
          current = evidenceMessage(live.message, live.handle); versions.push({ id: current.id, createdSeq: current.createdSeq, changedSeq: current.changedSeq });
        }
      } else {
        if (input.intent === "expand") {
          if (!Number.isSafeInteger(input.previous) || !input.previous) throw new ChatReportError("invalid");
          const [previous] = await tx.select({ from: chatAccessLog.fromSeq, to: chatAccessLog.toSeq }).from(chatAccessLog).where(and(eq(chatAccessLog.id, input.previous), eq(chatAccessLog.readerId, actor.id), eq(chatAccessLog.kind, "context"), caseFilter, eq(chatAccessLog.villageId, metadata.villageId)));
          if (!previous) throw new ChatReportError("forbidden");
          const [expanded] = await tx.select({ count: sql<number>`count(*)`.mapWith(Number) }).from(chatAccessLog).where(and(caseFilter, eq(chatAccessLog.readerId, actor.id), eq(chatAccessLog.kind, "context"), sql`left(${chatAccessLog.reason}, ${CHAT_EXPAND_REASON_PREFIX.length}) = ${CHAT_EXPAND_REASON_PREFIX}`));
          if (expanded.count >= CHAT_CASE_EXPAND_LIMIT) throw new ChatReportError("expand_limit");
          from = previous.from; to = previous.to;
        }
        const select = () => tx.select({ message: chatMessages, handle: profiles.handle }).from(chatMessages).leftJoin(profiles, eq(profiles.userId, chatMessages.authorId));
        const visible = and(eq(chatMessages.villageId, metadata.villageId), isNull(chatMessages.deletedAt));
        const older = await select().where(and(visible, lt(chatMessages.createdSeq, from))).orderBy(desc(chatMessages.createdSeq)).limit(CHAT_CASE_CONTEXT_COUNT);
        const newer = await select().where(and(visible, sql`${chatMessages.createdSeq} > ${to}`)).orderBy(asc(chatMessages.createdSeq)).limit(CHAT_CASE_CONTEXT_COUNT);
        const anchor = input.intent === "context" ? await select().where(and(visible, eq(chatMessages.id, metadata.messageId))) : [];
        context = [...older.reverse(), ...anchor, ...newer].map(row => evidenceMessage(row.message, row.handle));
        from = Math.min(from, context.at(0)?.createdSeq ?? from); to = Math.max(to, context.at(-1)?.createdSeq ?? to);
        versions.push(...context.map(message => ({ id: message.id, createdSeq: message.createdSeq, changedSeq: message.changedSeq })));
      }
      const ranges: Array<{ from: number; to: number }> = [];
      for (const seq of [...new Set(versions.map(version => version.createdSeq))].sort((a, b) => a - b)) {
        const last = ranges.at(-1);
        if (last && last.to + 1 === seq) last.to = seq;
        else ranges.push({ from: seq, to: seq });
      }
      const loggedReason = input.intent === "expand" ? CHAT_EXPAND_REASON_PREFIX + reason : target.kind === "report" ? CHAT_REPORT_REVIEW_REASON : CHAT_APPEAL_REVIEW_REASON;
      const [logged] = await tx.insert(chatAccessLog).values({ readerId: actor.id, readerHandle: reader.handle, reportId: target.kind === "report" ? target.id : null, appealId: target.kind === "appeal" ? target.id : null, villageId: metadata.villageId, kind: input.intent === "open" ? "snapshot" : "context", fromSeq: from, toSeq: to, ranges, versions, reason: loggedReason, createdAt: now }).returning({ id: chatAccessLog.id });
      // Derived private text follows the same audited read boundary as the evidence.
      const assessments = await tx.select({ id: reports.id, aiPriority: reports.aiPriority, aiAssessment: reports.aiAssessment }).from(reports).where(and(eq(reports.chatMessageId, metadata.messageId), isNotNull(reports.aiAssessment)));
      return { logId: logged.id, intent: input.intent, snapshot, current, deleted, context, from, to, statement, explanation, assessments };
    });
  } catch (error) { if (error instanceof ChatReportError) throw error; throw new ChatReportError("unavailable"); }
}

function evidenceMessage(message: typeof chatMessages.$inferSelect, handle: string | null): ChatEvidenceMessage {
  return { id: message.id, body: message.body, lang: message.lang, author: handle ?? "", createdAt: message.createdAt.toISOString(), createdSeq: message.createdSeq, changedSeq: message.changedSeq, hidden: message.hiddenAt !== null };
}

export async function finishChatVisibility(db: Db, change: ChatVisibilityChange, now = new Date()) {
  const seq = await nextChatSequence(db, change.villageId);
  await db.update(chatMessages).set({ hiddenAt: change.hidden ? now : null, changedSeq: seq }).where(eq(chatMessages.id, change.id));
  return seq;
}

export async function moderateChatReport(db: Db, actor: Actor, input: { reportId: number; intent: "hide" | "unhide" | "dismiss"; reason: unknown; note?: unknown }, opts: { now?: Date } = {}) {
  const checked = checkInput(input, input.intent !== "dismiss");
  if (typeof checked === "string") throw new ChatReportError("invalid");
  const now = opts.now ?? new Date();
  try {
    const result = await db.transaction(async tx => {
      await activeActor(tx, actor.id, now);
      const target = await chatCaseMetadata(tx, actor, { kind: "report", id: input.reportId });
      const message = await lockChatReportTarget(tx, target.messageId);
      const [open] = await tx.select({ id: reports.id }).from(reports).where(and(eq(reports.chatMessageId, message.id), eq(reports.status, "open"))).limit(1);
      if (input.intent === "unhide") {
        const [latest] = await tx.select({ id: moderationActions.id }).from(moderationActions).where(and(eq(moderationActions.targetChatMessageId, message.id), inArray(moderationActions.action, ["hide_chat", "unhide_chat"]))).orderBy(desc(moderationActions.id)).limit(1);
        if (!message.hiddenAt || !actor.scope.operator && await madeByOperator(tx, latest?.id)) throw new ChatReportError("forbidden");
      } else if (!open || input.intent === "hide" && message.hiddenAt) throw new ChatReportError("invalid_state");
      const [action] = await tx.insert(moderationActions).values({ action: input.intent === "hide" ? "hide_chat" : input.intent === "unhide" ? "unhide_chat" : "dismiss_chat_report", targetChatMessageId: message.id, actorId: actor.id, reportId: input.reportId, ...checked, createdAt: now }).returning({ id: moderationActions.id });
      if (input.intent !== "unhide") await tx.update(reports).set({ status: input.intent === "dismiss" ? "dismissed" : "resolved", handledBy: actor.id, handledAt: now }).where(and(eq(reports.chatMessageId, message.id), eq(reports.status, "open")));
      if (input.intent === "hide") await tx.delete(notifications).where(and(eq(notifications.kind, "chat_mention"), eq(notifications.chatMessageId, message.id)));
      if (input.intent !== "dismiss" && target.authorId) await createModerationNotification(tx, { userId: target.authorId, entryId: null, villageId: message.villageId, actionId: action.id, now });
      const seq = input.intent === "dismiss" ? null : await finishChatVisibility(tx, { id: message.id, villageId: message.villageId, hidden: input.intent === "hide" }, now);
      return { actionId: action.id, seq, villageId: message.villageId };
    });
    if (result.seq !== null) signalVillageChat(result.villageId, result.seq);
    return result;
  } catch (error) { if (error instanceof ChatReportError) throw error; throw new ChatReportError("unavailable"); }
}

// Caller has locked village -> message -> appeal. Write every other row before allocating a sequence.
export async function prepareChatReversal(db: Db, action: { id: number; targetChatMessageId: string }, reviewerId: string, appealId: number, now: Date): Promise<ChatVisibilityChange | null> {
  const [message] = await db.select().from(chatMessages).where(eq(chatMessages.id, action.targetChatMessageId));
  const [latest] = await db.select({ id: moderationActions.id }).from(moderationActions).where(and(eq(moderationActions.targetChatMessageId, action.targetChatMessageId), inArray(moderationActions.action, ["hide_chat", "unhide_chat"]))).orderBy(desc(moderationActions.id)).limit(1);
  if (!message?.hiddenAt || latest?.id !== action.id) return null;
  await db.insert(moderationActions).values({ action: "unhide_chat", targetChatMessageId: message.id, actorId: reviewerId, reason: "other", note: `Appeal #${appealId} overturned`, createdAt: now });
  return { id: message.id, villageId: message.villageId, hidden: false, reversed: message.deletedAt === null };
}

export async function pruneChatReportSnapshots(db: Db, now: Date, results?: RetentionResults): Promise<number> {
  const cutoff = daysBefore(now, RETENTION.chatReportDays);
  // Start on public case metadata, including automated cases without a report.
  const targets = sql`(
    select ${reports.chatMessageId} as id from ${reports}
      where ${reports.chatMessageId} is not null and ${reports.status} <> 'open' and ${reports.handledAt} < ${cutoff}
    union
    select ${moderationActions.targetChatMessageId} as id from ${moderationActions}
      where ${moderationActions.targetChatMessageId} is not null and ${moderationActions.automatic} = true
        and ${moderationActions.action} = 'hide_chat' and ${moderationActions.createdAt} < ${cutoff}
  ) as retention_chat_targets`;
  const targetId = sql`retention_chat_targets.id`;
  // Exclude protected cases before LIMIT so they cannot starve later evidence.
  const condition = sql`exists (select 1 from ${chatReportSnapshots} where ${chatReportSnapshots.messageId} = ${targetId} and ${chatReportSnapshots.prunedAt} is null)
    and not exists (select 1 from ${reports} where ${reports.chatMessageId} = ${targetId}
      and (${reports.status} = 'open' or ${reports.handledAt} is null or ${reports.handledAt} >= ${cutoff}))
    and not exists (select 1 from ${appeals} inner join ${moderationActions} on ${moderationActions.id} = ${appeals.actionId}
      where (${moderationActions.targetChatMessageId} = ${targetId} or ${moderationActions.reportId} in (select ${reports.id} from ${reports} where ${reports.chatMessageId} = ${targetId}))
      and (${appeals.status} = 'open' or ${appeals.decidedAt} is null or ${appeals.decidedAt} >= ${cutoff}))`;
  const pending = async () => {
    const { rows } = await db.execute(sql`select coalesce(sum(1 +
      (select count(*) from ${reports} where ${reports.chatMessageId} = ${targetId} and ${reports.aiAssessment} is not null)
    ), 0)::int as count from ${targets} where ${condition}`) as { rows: { count: number }[] };
    return rows[0].count;
  };
  if (await pending() === 0) {
    recordRetentionResult("chat_report_snapshots", { removed: 0, remaining: 0, skipped: 0, batches: 0, stop: "complete" }, results);
    return 0;
  }
  let pruned = 0;
  const deferred = new Set<string>();
  await drainRetentionBatches(db, "chat_report_snapshots", async tx => {
    const { rows: candidates } = await tx.execute(sql`select id from ${targets} where ${condition}
      ${deferred.size ? sql`and ${targetId} not in (${sql.join([...deferred].map(id => sql`${id}`), sql`, `)})` : sql``}
      order by id limit ${RETENTION_BATCH_SIZE}`) as { rows: { id: string }[] };
    let changed = 0;
    for (const candidate of candidates) {
      if (changed === RETENTION_BATCH_SIZE) break;
      await lockChatReportTarget(tx, candidate.id);
      const blocked = await tx.select({ id: reports.id }).from(reports).where(and(eq(reports.chatMessageId, candidate.id), sql`(${reports.status} = 'open' OR ${reports.handledAt} is null OR ${reports.handledAt} >= ${cutoff})`)).limit(1);
      if (blocked.length) { deferred.add(candidate.id); continue; }
      const [appeal] = await tx.select({ id: appeals.id }).from(appeals).innerJoin(moderationActions, eq(moderationActions.id, appeals.actionId))
        .where(and(sql`(${moderationActions.targetChatMessageId} = ${candidate.id} OR ${moderationActions.reportId} in (select r.id from reports r where r.chat_message_id = ${candidate.id}))`, sql`(${appeals.status} = 'open' OR ${appeals.decidedAt} is null OR ${appeals.decidedAt} >= ${cutoff})`)).limit(1);
      if (appeal) { deferred.add(candidate.id); continue; }
      // Clear copied assessments before the snapshot; its eligibility keeps any
      // remaining assessment backlog reachable on the next short transaction.
      changed += await updateRetentionRows(tx, reports, and(eq(reports.chatMessageId, candidate.id), sql`${reports.aiAssessment} is not null`)!, sql`ai_assessment = null`, RETENTION_BATCH_SIZE - changed);
      if (changed === RETENTION_BATCH_SIZE) break;
      const [remainingAssessment] = await tx.select({ id: reports.id }).from(reports)
        .where(and(eq(reports.chatMessageId, candidate.id), sql`${reports.aiAssessment} is not null`)).limit(1);
      if (remainingAssessment) { deferred.add(candidate.id); continue; }
      const removed = (await tx.update(chatReportSnapshots).set({ body: null, prunedAt: now }).where(and(eq(chatReportSnapshots.messageId, candidate.id), isNull(chatReportSnapshots.prunedAt))).returning({ id: chatReportSnapshots.messageId })).length;
      changed += removed;
      pruned += removed;
    }
    return { removed: changed, more: candidates.length > 0 };
  }, pending, results);
  return pruned;
}

export async function listChatAccessLog(db: Db, actor: Actor, page = 1, limit = 50) {
  if (!actor.scope.operator) throw new ChatReportError("forbidden");
  const rows = await db.select({ log: chatAccessLog, name: villages.name, language: villages.language, slug: villages.slug, kind: villages.kind, endedAt: villages.endedAt }).from(chatAccessLog).innerJoin(villages, eq(villages.id, chatAccessLog.villageId)).orderBy(desc(chatAccessLog.createdAt), desc(chatAccessLog.id)).limit(limit + 1).offset((page - 1) * limit);
  const items = rows.slice(0, limit).map(({ log: { villageId: _villageId, ...log }, name, language, slug, kind, endedAt }) => ({ ...log, village: isSharedVillageKind(kind) ? { name, language, slug: endedAt === null ? slug : null, kind } : { name: null, language: null, slug: null, kind } }));
  return { items, page, hasNext: rows.length > limit };
}
