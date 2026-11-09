import { and, eq, inArray, isNull, ne, type SQL } from "drizzle-orm";
import type { Db } from "./db/client.server";
import { entries, notifications, profiles, translationReports } from "./db/schema";
import { DELETED_MEMBER_ID } from "./deleted-member";
import { enqueueImmediateEmails } from "./notifications.server";
import { rootTopic, rootTopicOn, visibleWithTopic } from "./visibility.server";
import { villagesEnabled } from "./villages-enabled.server";
import type { TranslationReportOutcome } from "./translation-report-results";

// The caller holds the post lock, then acquires reports through this conditional
// update. Only rows actually closed here may create a result notification.
export async function completeTranslationReports(db: Db, condition: SQL, outcome: TranslationReportOutcome, now: Date, opts: { resolvedBy?: string | null; correctedAt?: Date | null } = {}) {
  const closed = await db.update(translationReports).set({ status: "resolved", outcome, resolvedBy: opts.resolvedBy ?? null, resolvedAt: now,
    ...(opts.correctedAt !== undefined ? { correctedAt: opts.correctedAt } : {}),
  }).where(and(condition, eq(translationReports.status, "open"))).returning();
  const reporterIds = [...new Set(closed.flatMap(report => report.reporterId ? [report.reporterId] : []))];
  if (!reporterIds.length) return;
  const members = new Set((await db.select({ id: profiles.userId }).from(profiles).where(and(inArray(profiles.userId, reporterIds), ne(profiles.userId, DELETED_MEMBER_ID)))).map(row => row.id));
  const readable = await db.select({ id: entries.id, threadId: entries.threadId }).from(entries).innerJoin(rootTopic, rootTopicOn())
    .where(and(inArray(entries.id, closed.map(report => report.entryId)), visibleWithTopic(), villagesEnabled() ? undefined : isNull(rootTopic.villageId)));
  const destinations = new Map(readable.map(entry => [entry.id, entry.threadId ?? entry.id]));
  const eligible = closed.filter(report => report.reporterId && members.has(report.reporterId) && destinations.has(report.entryId));
  if (!eligible.length) return;
  const created = await db.insert(notifications).values(eligible.map(report => ({ kind: "translation_report_result", userId: report.reporterId!, entryId: report.entryId,
    threadId: destinations.get(report.entryId)!, translationReportId: report.id, createdAt: now,
  }))).onConflictDoNothing({ target: notifications.translationReportId }).returning({ id: notifications.id, userId: notifications.userId });
  await enqueueImmediateEmails(db, created.map(row => ({ ...row, kind: "translation_report_result" as const })), { now });
}
