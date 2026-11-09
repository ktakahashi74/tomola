import { and, isNotNull, isNull, lt, lte, or } from "drizzle-orm";
import type { Db } from "~/lib/db/client.server";
import { chatAccessLog, llmUsage, notifications, pushDeliveries, session, signingChallenges, suspendedEmailHashes } from "~/lib/db/schema";
import { RETENTION, daysBefore, monthsBefore } from "~/lib/retention";
import { drainRetentionRows, withRetentionRun, type RetentionResults, type RetentionRunOptions } from "~/lib/retention-batch.server";
import { cleanupExpiredLimits } from "~/lib/rate-limit.server";

export function runRetentionCleanup(db: Db, now = new Date(), options: RetentionRunOptions = {}): Promise<RetentionResults> {
  return withRetentionRun(options, async () => {
    const results = await cleanupExpiredLimits(db, now);
    await drainRetentionRows(db, "suspended_email_hashes", suspendedEmailHashes, lte(suspendedEmailHashes.expiresAt, now), results);
    await drainRetentionRows(db, "sessions", session, or(lte(session.expiresAt, now), lte(session.createdAt, daysBefore(now, RETENTION.sessionAbsoluteDays)))!, results);
    await drainRetentionRows(db, "chat_access_log", chatAccessLog, lt(chatAccessLog.createdAt, monthsBefore(now, RETENTION.chatAccessYears * 12)), results);
    await drainRetentionRows(db, "notifications", notifications, or(
      and(isNotNull(notifications.readAt), lt(notifications.readAt, daysBefore(now, RETENTION.readNotificationDays))),
      and(isNull(notifications.readAt), lt(notifications.createdAt, daysBefore(now, RETENTION.unreadNotificationDays))),
    )!, results);
    await drainRetentionRows(db, "push_deliveries", pushDeliveries, and(isNotNull(pushDeliveries.completedAt), lt(pushDeliveries.completedAt, daysBefore(now, RETENTION.finishedPushDays)))!, results);
    // The ledger contains no member identifier or request text; no link to anonymize.
    await drainRetentionRows(db, "llm_usage", llmUsage, lt(llmUsage.createdAt, monthsBefore(now, RETENTION.llmUsageMonths)), results);
    // Short-lived signing requests also contain copies of post text.
    await drainRetentionRows(db, "signing_challenges", signingChallenges, lte(signingChallenges.expiresAt, now), results);
    return results;
  });
}
