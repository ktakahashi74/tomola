import { and, count, desc, eq } from "drizzle-orm";
import type { Db } from "./db/client.server";
import { entries, moderationActions, nushiAnswers, nushiReports, nushiRequests } from "./db/schema";
import { readNushiAnswer } from "./nushi.server";
import { reconstructNushiMaterials } from "./nushi-materials.server";
import { isReason } from "./moderation";
import type { Lang } from "./languages";

export const NUSHI_ERROR_REASONS = ["missing_disagreement", "wrong_post", "lost_context", "other"] as const;
export async function reportNushi(db: Db, reporterId: string, input: { answerId: number; kind: string; reason: string; note: string; consent: boolean }) {
  if (!input.note.includes("\0") && input.note.length <= 1000 && (input.kind === "moderation" ? isReason(input.reason) : input.kind === "error" && input.consent && (NUSHI_ERROR_REASONS as readonly string[]).includes(input.reason))) {
    const answer = await readNushiAnswer(db, input.answerId);
    if (!answer || answer.hidden) return false;
    const [question] = await db.select({ body: entries.body }).from(entries).where(eq(entries.id, answer.entryId));
    // Reconstruct only for the explicit error-report opt-in. Ordinary moderation
    // reports have no copy of the question, output or materials.
    const [stored] = await db.select({ scope: nushiAnswers.scope }).from(nushiAnswers).where(eq(nushiAnswers.id, input.answerId));
    const materials = input.kind === "error" ? await reconstructNushiMaterials(db, stored.scope.materialIndex, stored.scope.materialLanguage) : null;
    if (input.kind === "error" && !materials) return false;
    const evidence = input.kind === "error" ? { question: question?.body ?? "", answer: answer.answer,
      materials, scope: answer.scope } : undefined;
    const [saved] = await db.insert(nushiReports).values({ answerId: input.answerId, reporterId, kind: input.kind, reason: input.reason, note: input.note.trim(), evidence }).onConflictDoNothing().returning({ id: nushiReports.id });
    return !!saved;
  }
  return false;
}
export async function listNushiReports(db: Db, options: { reporterId?: string; page?: number; id?: number } = {}) {
  return db.select({ id: nushiReports.id, answerId: nushiReports.answerId, kind: nushiReports.kind, reason: nushiReports.reason, note: nushiReports.note, status: nushiReports.status, resolution: nushiReports.resolution, date: nushiReports.createdAt })
    .from(nushiReports).where(and(options.reporterId ? eq(nushiReports.reporterId, options.reporterId) : undefined, options.id === undefined ? undefined : eq(nushiReports.id, options.id)))
    .orderBy(desc(nushiReports.createdAt), desc(nushiReports.id)).limit(30).offset(((options.page ?? 1) - 1) * 30);
}
export async function resolveNushiReport(db: Db, operatorId: string, reportId: number, hide: boolean, note: string) {
  if (!note.trim() || note.length > 500 || note.includes("\0")) return false;
  return db.transaction(async tx => {
    const [report] = await tx.select().from(nushiReports).where(and(eq(nushiReports.id, reportId), eq(nushiReports.status, "open"))).for("update");
    if (!report) return false;
    if (hide) {
      await tx.update(nushiAnswers).set({ hiddenAt: new Date(), hiddenReason: "moderation" }).where(eq(nushiAnswers.id, report.answerId));
      await tx.insert(moderationActions).values({ action: "hide", targetNushiAnswerId: report.answerId, actorId: operatorId, reason: isReason(report.reason) ? report.reason : "other", note: note.trim() });
    }
    await tx.update(nushiReports).set({ status: hide ? "resolved" : "dismissed", resolution: note.trim(), resolvedBy: operatorId }).where(eq(nushiReports.id, reportId));
    return true;
  });
}

export async function nushiReportEvidence(db: Db, id: number) {
  const [row] = await db.select({ content: nushiReports.evidence }).from(nushiReports).where(and(eq(nushiReports.id, id), eq(nushiReports.kind, "error")));
  return row?.content ? JSON.stringify(row.content, null, 2) : null;
}

// Ordinary moderation reports appear at the existing operator entry point.
export async function pendingNushiReports(db: Db) {
  const condition = and(eq(nushiReports.kind, "moderation"), eq(nushiReports.status, "open"));
  const [total] = await db.select({ n: count() }).from(nushiReports).where(condition);
  const rows = await db.select({ id: nushiReports.id, answerId: nushiReports.answerId, reason: nushiReports.reason, note: nushiReports.note })
    .from(nushiReports).where(condition).orderBy(desc(nushiReports.createdAt), desc(nushiReports.id)).limit(30);
  return { count: total.n, reports: rows };
}
