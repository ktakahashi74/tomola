import { and, asc, eq, inArray, isNull, lt, ne, sql } from "drizzle-orm";
import type { Db } from "./db/client.server";
import { chatAccessLog, chatConsents, chatMessages, chatMessageTranslations, chatTranslationReports, profiles, villageMembers, villages } from "./db/schema";
import { CHAT_CONSENT_VERSION } from "./village-chat-consent";
import { lockChatReportTarget } from "./village-chat-reports.server";
import { RETENTION, daysBefore } from "./retention";
import { drainRetentionRows, type RetentionResults } from "./retention-batch.server";
import { chatSourceHash } from "./village-chat-translations.server";
import { villageChatEnabled } from "./village-chat-enabled.server";
import { chatVillageCondition } from "./village-chat-villages.server";
import { villageText } from "./villages";
import { hitRateLimit } from "./rate-limit.server";
import { inScope } from "./roles.server";
import type { Actor } from "./moderation.server";
import { isEnabledLang } from "./enabled-langs.server";
import { isLang } from "./languages";
import { enqueue } from "./jobs/queue.server";
import { nextChatSequence } from "./village-chat-sequence.server";
import { signalVillageChat } from "./village-chat-events.server";

export const CHAT_TRANSLATION_REPORT_LIMIT = { limit: 30, windowSeconds: 3600 } as const;
export const CHAT_TRANSLATION_REPORT_RETAIN_DAYS = RETENTION.chatReportDays;
export const CHAT_TRANSLATION_REPORT_JOB = "retranslate_chat_report";
export class ChatTranslationReportError extends Error {
  constructor(public code: "not_found" | "forbidden" | "invalid" | "duplicate" | "limit" | "closed" | "unavailable") { super(code); }
}
// SQL diagnostics can contain private snapshots and notes. Never propagate them.
async function safe<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); } catch (error) {
    if (error instanceof ChatTranslationReportError) throw error;
    throw new ChatTranslationReportError("unavailable");
  }
}
async function active(db: Db, id: string, now: Date) {
  const [profile] = await db.select().from(profiles).where(eq(profiles.userId, id));
  if (!profile || profile.suspendedUntil && profile.suspendedUntil > now) throw new ChatTranslationReportError("forbidden");
  return profile;
}
export async function createChatTranslationReport(db: Db, reporterId: string, input: { slug: string; messageId: string; lang: unknown; note?: unknown }, now = new Date()) {
  if (!villageChatEnabled()) throw new ChatTranslationReportError("not_found");
  if (typeof input.lang !== "string" || !isEnabledLang(input.lang)) throw new ChatTranslationReportError("invalid");
  const lang = input.lang, note = villageText(input.note ?? "", 2000);
  if (note === null) throw new ChatTranslationReportError("invalid");
  return safe(() => db.transaction(async tx => {
    await active(tx, reporterId, now);
    const [village] = await tx.select({ id: villages.id }).from(villages).where(and(eq(villages.slug, input.slug), chatVillageCondition())).for("share");
    if (!village) throw new ChatTranslationReportError("not_found");
    const [member] = await tx.select().from(villageMembers).where(and(eq(villageMembers.villageId, village.id), eq(villageMembers.userId, reporterId))).for("share");
    const [consent] = await tx.select().from(chatConsents).where(and(eq(chatConsents.villageId, village.id), eq(chatConsents.userId, reporterId), eq(chatConsents.version, CHAT_CONSENT_VERSION)));
    if (!member || !consent) throw new ChatTranslationReportError("not_found");
    const [message] = await tx.select().from(chatMessages).where(and(eq(chatMessages.id, input.messageId), eq(chatMessages.villageId, village.id))).for("update");
    if (!message || message.deletedAt || message.hiddenAt) throw new ChatTranslationReportError("not_found");
    if (message.authorId === reporterId || message.lang === lang) throw new ChatTranslationReportError("forbidden");
    const sourceHash = chatSourceHash(message.body);
    const [translation] = await tx.select().from(chatMessageTranslations).where(and(eq(chatMessageTranslations.messageId, message.id), eq(chatMessageTranslations.lang, lang), eq(chatMessageTranslations.sourceHash, sourceHash), eq(chatMessageTranslations.state, "ready")));
    if (!translation?.text) throw new ChatTranslationReportError("not_found");
    const translationHash = chatSourceHash(translation.text);
    const [duplicate] = await tx.select({ id: chatTranslationReports.id }).from(chatTranslationReports).where(and(eq(chatTranslationReports.messageId, message.id), eq(chatTranslationReports.lang, lang), eq(chatTranslationReports.reporterId, reporterId), eq(chatTranslationReports.translationHash, translationHash)));
    if (duplicate) throw new ChatTranslationReportError("duplicate");
    const rate = await hitRateLimit(tx, { key: `chat-translation-report:${reporterId}`, ...CHAT_TRANSLATION_REPORT_LIMIT, now });
    if (!rate.allowed) throw new ChatTranslationReportError("limit");
    const [previous] = await tx.select({ id: chatTranslationReports.id }).from(chatTranslationReports).where(and(eq(chatTranslationReports.messageId, message.id), eq(chatTranslationReports.lang, lang))).limit(1);
    const retry = !previous;
    const [report] = await tx.insert(chatTranslationReports).values({ messageId: message.id, reporterId, lang, sourceLang: message.lang, sourceHash, translationHash, original: message.body, translation: translation.text, note, createdSeq: message.createdSeq, changedSeq: message.changedSeq, status: retry ? "retry" : "open", createdAt: now }).returning({ id: chatTranslationReports.id });
    if (retry) await enqueue(tx, CHAT_TRANSLATION_REPORT_JOB, { reportId: report.id }, { dedupeKey: `chat-translation-report:${report.id}`, maxAttempts: 1 });
    return { id: report.id, retry };
  }));
}

// Translation review uses the target-language scope, as public post translation reports do.
// No private evidence, note, author identity or closed-village metadata on GET.
export async function listChatTranslationReports(db: Db, actor: Actor, page = 1, limit = 30) {
  if (!actor.scope.operator && !actor.scope.langs.length) return { items: [], page, hasNext: false };
  const rows = await db.select({ id: chatTranslationReports.id, lang: chatTranslationReports.lang, sourceLang: chatTranslationReports.sourceLang, createdAt: chatTranslationReports.createdAt }).from(chatTranslationReports)
    .innerJoin(chatMessages, eq(chatMessages.id, chatTranslationReports.messageId))
    .where(and(eq(chatTranslationReports.status, "open"), ne(chatMessages.authorId, actor.id), actor.scope.operator ? undefined : inArray(chatTranslationReports.lang, [...actor.scope.langs])))
    .orderBy(asc(chatTranslationReports.createdAt), asc(chatTranslationReports.id)).limit(limit + 1).offset((page - 1) * limit);
  return { items: rows.slice(0, limit), page, hasNext: rows.length > limit };
}
export async function chatTranslationReportMetadata(db: Db, actor: Actor, id: number) {
  const [row] = await db.select({ id: chatTranslationReports.id, messageId: chatTranslationReports.messageId, sourceLang: chatTranslationReports.sourceLang, lang: chatTranslationReports.lang, status: chatTranslationReports.status, authorId: chatMessages.authorId }).from(chatTranslationReports)
    .innerJoin(chatMessages, eq(chatMessages.id, chatTranslationReports.messageId)).where(eq(chatTranslationReports.id, id));
  if (!row || !inScope(actor.scope, row.lang) || row.authorId === actor.id) throw new ChatTranslationReportError("not_found");
  return row;
}
export async function readChatTranslationReport(db: Db, actor: Actor, id: number, now = new Date()) {
  return safe(() => db.transaction(async tx => {
    const reader = await active(tx, actor.id, now);
    const metadata = await chatTranslationReportMetadata(tx, actor, id);
    const message = await lockChatReportTarget(tx, metadata.messageId);
    const [row] = await tx.select().from(chatTranslationReports).where(eq(chatTranslationReports.id, id)).for("share");
    if (row.status !== "open" || row.prunedAt) throw new ChatTranslationReportError("closed");
    await tx.insert(chatAccessLog).values({ readerId: actor.id, readerHandle: reader.handle, translationReportId: id, villageId: message.villageId, kind: "snapshot", fromSeq: row.createdSeq, toSeq: row.createdSeq, ranges: [{ from: row.createdSeq, to: row.createdSeq }], versions: [{ id: message.id, createdSeq: row.createdSeq, changedSeq: row.changedSeq, snapshot: true }], reason: "chat:translation-review", createdAt: now });
    return { original: row.original, translation: row.translation, note: row.note, sourceLang: row.sourceLang, lang: row.lang };
  }));
}
export async function moderateChatTranslationReport(db: Db, actor: Actor, id: number, intent: "hide" | "dismiss", now = new Date()) {
  if (intent !== "hide" && intent !== "dismiss") throw new ChatTranslationReportError("invalid");
  const result = await safe(() => db.transaction(async tx => {
    await active(tx, actor.id, now);
    const metadata = await chatTranslationReportMetadata(tx, actor, id);
    const message = await lockChatReportTarget(tx, metadata.messageId);
    const [row] = await tx.select().from(chatTranslationReports).where(eq(chatTranslationReports.id, id)).for("update");
    if (row.status !== "open") throw new ChatTranslationReportError("closed");
    let seq: number | null = null;
    if (intent === "hide" && chatSourceHash(message.body) === row.sourceHash) {
      // Only hide the reported output; an edit or a replacement must survive.
      const changed = await tx.update(chatMessageTranslations).set({ text: null, state: "failed", errorCode: "moderator_hidden", updatedAt: now }).where(and(eq(chatMessageTranslations.messageId, message.id), eq(chatMessageTranslations.lang, row.lang), eq(chatMessageTranslations.sourceHash, row.sourceHash), eq(chatMessageTranslations.text, row.translation ?? ""))).returning();
      if (changed.length) { seq = await nextChatSequence(tx, message.villageId); await tx.update(chatMessages).set({ changedSeq: seq }).where(eq(chatMessages.id, message.id)); }
    }
    await tx.update(chatTranslationReports).set({ status: intent === "hide" ? "resolved" : "dismissed", handledBy: actor.id, handledAt: now }).where(eq(chatTranslationReports.id, id));
    return { villageId: message.villageId, seq };
  }));
  if (result.seq !== null) signalVillageChat(result.villageId, result.seq);
}
export async function pruneChatTranslationReports(db: Db, now: Date, results?: RetentionResults): Promise<number> {
  return (await drainRetentionRows(db, "chat_translation_reports", chatTranslationReports,
    sql`${chatTranslationReports.status} in ('resolved', 'dismissed') and ${chatTranslationReports.handledAt} < ${daysBefore(now, RETENTION.chatReportDays)} and ${chatTranslationReports.prunedAt} is null`,
    results, sql`original = null, translation = null, note = null, pruned_at = ${now}`)).removed;
}
