import { readPostAiMaterial } from "./post-ai-materials.server";
import { visibleUnicode } from "./ai-visible-text.server";
import { and, asc, desc, eq, gt, inArray, isNull, lt, ne } from "drizzle-orm";
import type { Db } from "./db/client.server";
import { chatAccessLog, chatConsents, chatMessages, chatReportSnapshots, entries, reports, villageReportSnapshots, villages } from "./db/schema";
import { ABUSE_THRESHOLDS } from "./abuse";
import { lockChatReportTarget } from "./village-chat-reports.server";
import { CHAT_AI_TRIAGE_REASON } from "./chat-access";

export const AI_CHAT_CONSENT_VERSION = 2;
export type ModerationEvidence = { target: unknown; context: unknown; report: { reason: string; note: string }; audit?: typeof chatAccessLog.$inferInsert };

// Only the stated target and a bounded local window enter the provider request.
export async function reportEvidence(db: Db, reportId: number, model: string, now: Date): Promise<ModerationEvidence | null> {
  const [report] = await db.select().from(reports).where(and(eq(reports.id, reportId), eq(reports.status, "open")));
  if (!report) return null;
  const reported = { reason: report.reason, note: report.note };
  if (report.entryId !== null) {
    const [target] = await db.select({ id: entries.id, title: entries.title, body: entries.body, lang: entries.lang, threadId: entries.threadId, parentId: entries.parentId, deletedAt: entries.deletedAt }).from(entries).where(eq(entries.id, report.entryId));
    if (!target || target.deletedAt) return null;
    const supplementReport = /^AI supplement: \/t\/([1-9]\d*)\/ai-materials \(version ([1-9]\d*)\)\. /.exec(report.note);
    if (supplementReport && Number(supplementReport[1]) === target.id && target.threadId === null) {
      const supplement = await readPostAiMaterial(db, target.id);
      if (!supplement || supplement.version !== Number(supplementReport[2])) return null;
      return { report: reported, target: { id: target.id, kind: "ai_supplement", version: supplement.version, body: supplement.text, lang: supplement.lang },
        context: { topicId: target.id, title: target.title === null ? null : visibleUnicode(target.title) } };
    }
    const [topic] = await db.select({ title: entries.title, body: entries.body, deletedAt: entries.deletedAt }).from(entries).where(eq(entries.id, target.threadId ?? target.id));
    if (!topic || topic.deletedAt) return null;
    const [parent] = target.parentId === null ? [] : await db.select({ id: entries.id, body: entries.body, lang: entries.lang }).from(entries).where(and(eq(entries.id, target.parentId), isNull(entries.deletedAt)));
    const columns = { id: entries.id, body: entries.body, lang: entries.lang };
    const local = and(eq(entries.threadId, target.threadId ?? target.id), isNull(entries.deletedAt));
    const before = target.threadId === null ? [] : await db.select(columns).from(entries).where(and(local, lt(entries.id, target.id))).orderBy(desc(entries.id)).limit(ABUSE_THRESHOLDS.entryContext);
    const after = target.threadId === null ? [] : await db.select(columns).from(entries).where(and(local, gt(entries.id, target.id))).orderBy(asc(entries.id)).limit(ABUSE_THRESHOLDS.entryContext);
    return { report: reported, target: { id: target.id, title: target.title, body: target.body, lang: target.lang }, context: { topicTitle: topic.title, parent: parent ?? null, before: before.reverse(), after } };
  }
  if (report.villageId !== null) {
    const [snapshot] = await db.select({ name: villageReportSnapshots.name, description: villageReportSnapshots.description, slug: villageReportSnapshots.slug }).from(villageReportSnapshots).where(and(eq(villageReportSnapshots.reportId, report.id), isNull(villageReportSnapshots.prunedAt)));
    const [current] = await db.select({ name: villages.name, description: villages.description, slug: villages.slug }).from(villages).where(eq(villages.id, report.villageId));
    return snapshot && snapshot.name !== null ? { report: reported, target: snapshot, context: { current } } : null;
  }
  if (!report.chatMessageId) return null;
  return db.transaction(async tx => {
    // Read consent before touching frozen or live message bodies. The per-message
    // joins below also exclude context by members who have not accepted version 2.
    const [location] = await tx.select({ villageId: chatMessages.villageId }).from(chatMessages).where(eq(chatMessages.id, report.chatMessageId!));
    if (!location || report.chatAuthorId === null) return null;
    const [consent] = await tx.select({ version: chatConsents.version }).from(chatConsents).where(and(eq(chatConsents.villageId, location.villageId), eq(chatConsents.userId, report.chatAuthorId), gt(chatConsents.version, AI_CHAT_CONSENT_VERSION - 1))).for("share");
    if (!consent) return null;
    await lockChatReportTarget(tx, report.chatMessageId!);
    const [open] = await tx.select({ id: reports.id }).from(reports).where(and(eq(reports.id, report.id), eq(reports.status, "open"))).for("share");
    if (!open) return null;
    const [snapshot] = await tx.select().from(chatReportSnapshots).where(and(eq(chatReportSnapshots.messageId, report.chatMessageId!), isNull(chatReportSnapshots.prunedAt)));
    if (!snapshot || snapshot.body === null || snapshot.authorId !== report.chatAuthorId) return null;
    const local = and(eq(chatMessages.villageId, location.villageId), isNull(chatMessages.deletedAt));
    // Select the same ten neighbors as a human, then filter consent. Do not reach
    // further into the village to replace neighbors without consent.
    const before = await tx.select({ id: chatMessages.id }).from(chatMessages).where(and(local, lt(chatMessages.createdSeq, snapshot.createdSeq))).orderBy(desc(chatMessages.createdSeq)).limit(ABUSE_THRESHOLDS.chatContext);
    const after = await tx.select({ id: chatMessages.id }).from(chatMessages).where(and(local, gt(chatMessages.createdSeq, snapshot.createdSeq))).orderBy(asc(chatMessages.createdSeq)).limit(ABUSE_THRESHOLDS.chatContext);
    const ids = [snapshot.messageId, ...before.map(r => r.id), ...after.map(r => r.id)];
    const context = await tx.select({ id: chatMessages.id, body: chatMessages.body, lang: chatMessages.lang, createdSeq: chatMessages.createdSeq, changedSeq: chatMessages.changedSeq }).from(chatMessages)
      .innerJoin(chatConsents, and(eq(chatConsents.villageId, chatMessages.villageId), eq(chatConsents.userId, chatMessages.authorId), gt(chatConsents.version, AI_CHAT_CONSENT_VERSION - 1)))
      .where(and(local, ne(chatMessages.id, snapshot.messageId), inArray(chatMessages.id, ids))).orderBy(asc(chatMessages.createdSeq));
    const versions: typeof chatAccessLog.$inferInsert.versions = [{ id: snapshot.messageId, createdSeq: snapshot.createdSeq, changedSeq: snapshot.changedSeq, snapshot: true }, ...context.map(({ id, createdSeq, changedSeq }) => ({ id, createdSeq, changedSeq }))];
    const seqs = [...new Set(versions.map(v => v.createdSeq))].sort((a, b) => a - b);
    const ranges: Array<{ from: number; to: number }> = [];
    for (const seq of seqs) { const last = ranges.at(-1); if (last && last.to + 1 === seq) last.to = seq; else ranges.push({ from: seq, to: seq }); }
    const audit: typeof chatAccessLog.$inferInsert = { readerId: null, readerKind: "ai", readerHandle: model, reportId: report.id, villageId: location.villageId, kind: "context", fromSeq: seqs[0], toSeq: seqs.at(-1)!, ranges, versions, reason: CHAT_AI_TRIAGE_REASON, createdAt: now };
    return { audit, report: reported, target: { body: snapshot.body, lang: snapshot.lang, createdSeq: snapshot.createdSeq }, context };
  });
}

// Persist immediately before the provider call, after budget admission. Consent
// and live context versions are checked again after waiting for admission.
// The reported target is a retained snapshot; its live deletion does not erase evidence.
export class ModerationEvidenceUnavailable extends Error {}
export async function auditModerationEvidence(db: Db, audit: typeof chatAccessLog.$inferInsert) {
  await db.transaction(async tx => {
    const ids = [...new Set(audit.versions.map(v => v.id))];
    const allowed = await tx.select({ id: chatMessages.id, deletedAt: chatMessages.deletedAt, createdSeq: chatMessages.createdSeq, changedSeq: chatMessages.changedSeq }).from(chatMessages)
      .innerJoin(chatConsents, and(eq(chatConsents.villageId, chatMessages.villageId), eq(chatConsents.userId, chatMessages.authorId), gt(chatConsents.version, AI_CHAT_CONSENT_VERSION - 1)))
      .where(and(eq(chatMessages.villageId, audit.villageId), inArray(chatMessages.id, ids))).for("share");
    const [report] = await tx.select({ id: reports.id }).from(reports).where(and(eq(reports.id, audit.reportId!), eq(reports.status, "open"))).for("share");
    if (!report || !audit.versions.every(version => allowed.some(row => row.id === version.id && (version.snapshot || row.deletedAt === null && row.createdSeq === version.createdSeq && row.changedSeq === version.changedSeq)))) throw new ModerationEvidenceUnavailable();
    await tx.insert(chatAccessLog).values(audit);
  });
}
