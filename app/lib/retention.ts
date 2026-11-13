// Provisional policy values. Keep this module safe to import in public notices.
export const RETENTION = {
  deletedEntryDays: 30,
  chatReportDays: 180,
  aiQuestionReportDays: 90,
  villageReportDays: 180,
  identityReportDays: 180,
  chatAccessYears: 1,
  readNotificationDays: 90,
  unreadNotificationDays: 180,
  sessionDays: 30,
  sessionAbsoluteDays: 90,
  expiredInvitationDays: 30,
  unusedOauthClientDays: 30,
  llmUsageMonths: 13,
  llmMemberLinkDays: 90,
  finishedJobDays: 30,
  finishedPushDays: 30,
  suspendedAccountHashYears: 1,
  backupGenerations: 10,
  accessLogMaxMb: 50,
} as const;

export const RETENTION_BATCH_SIZE = 100;
// Per category and invocation; unfinished work resumes on the next invocation.
export const RETENTION_MAX_BATCHES = 50;
// Shared by all categories in one cleanup invocation; checked between batches.
export const RETENTION_MAX_RUN_MS = 60_000;
// Question rows require a nonempty title even after deletion. Never retain the author's title.
export const PURGED_QUESTION_TITLE = "[deleted]";
export const DAY_MS = 86_400_000;
export const daysBefore = (now: Date, days: number) => new Date(now.getTime() - days * DAY_MS);

// Valid post versions have nonempty bodies. Empty referenced versions are tombstones.
export const isPrunedRevision = (revision: { title: string | null; body: string }) => revision.title === null && revision.body === "";

// Calendar months, clamped to the last day of the target month, in UTC.
export function monthsBefore(now: Date, months: number): Date {
  const result = new Date(now);
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() - months);
  const end = new Date(result);
  end.setUTCMonth(end.getUTCMonth() + 1, 0);
  result.setUTCDate(Math.min(day, end.getUTCDate()));
  return result;
}
