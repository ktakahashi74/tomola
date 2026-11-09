import { and, asc, eq, inArray } from "drizzle-orm";
import type { Db } from "./db/client.server";
import { moderationActions, profiles, reports } from "./db/schema";
import { checkInput, MAX_REPORT_NOTE, type Actor, type ModerationResult, type ReportError, type ReportSummary } from "./moderation.server";
import { isReason, type ReportReason } from "./moderation";
import { createModerationNotification } from "./notifications.server";
import { displayNamesVersion, type DisplayNames } from "./display-names.server";

export async function createDisplayNameReport(db: Db, reporterId: string, userId: string, input: { reason: unknown; note?: unknown }): Promise<{ ok: true; id: number } | { ok: false; error: ReportError }> {
  if (!isReason(input.reason)) return { ok: false, error: "invalid_reason" };
  const note = typeof input.note === "string" ? input.note.trim() : "";
  if (note.includes("\0") || [...note].length > MAX_REPORT_NOTE) return { ok: false, error: "invalid_note" };
  if (userId === reporterId) return { ok: false, error: "own_entry" };
  const reason = input.reason;
  return db.transaction(async tx => {
    const [profile] = await tx.select().from(profiles).where(eq(profiles.userId, userId)).for("update");
    if (!profile || !profile.displayName && !profile.displayNameLatin) return { ok: false as const, error: "not_found" as const };
    const [report] = await tx.insert(reports).values({ displayNameUserId: userId, displayNamesReported: { displayName: profile.displayName, displayNameLatin: profile.displayNameLatin }, reporterId, reason, note }).onConflictDoNothing().returning({ id: reports.id });
    return report ? { ok: true as const, id: report.id } : { ok: false as const, error: "duplicate" as const };
  });
}

// Profile first, then reports, matching settings changes and account deletion.
export async function moderateDisplayName(db: Db, actor: Actor, input: { userId: string; reportId: number; version: string; dismiss: boolean; reason: unknown; note: unknown }): Promise<ModerationResult> {
  if (!actor.scope.operator) return { ok: false, error: "forbidden" };
  if (actor.id === input.userId) return { ok: false, error: "own_entry" };
  const checked = checkInput(input, !input.dismiss);
  if (typeof checked === "string") return { ok: false, error: checked };
  return db.transaction(async tx => {
    const [profile] = await tx.select().from(profiles).where(eq(profiles.userId, input.userId)).for("update");
    if (!profile) return { ok: false as const, error: "not_found" as const };
    if (!input.dismiss && input.version !== displayNamesVersion(profile)) return { ok: false as const, error: "invalid_state" as const };
    const [report] = await tx.select().from(reports).where(and(eq(reports.id, input.reportId), eq(reports.displayNameUserId, input.userId), eq(reports.status, "open"))).for("update");
    if (!report) return { ok: false as const, error: "invalid_state" as const };
    if (!input.dismiss && !profile.displayName && !profile.displayNameLatin) return { ok: false as const, error: "invalid_state" as const };
    const now = new Date();
    const [action] = await tx.insert(moderationActions).values({ action: input.dismiss ? "dismiss_display_name_report" : "clear_display_name", targetUserId: input.userId, reportId: report.id, actorId: actor.id,
      ...checked, ...(!input.dismiss ? { displayNamesBefore: { displayName: profile.displayName, displayNameLatin: profile.displayNameLatin } } : {}), createdAt: now }).returning({ id: moderationActions.id });
    if (!input.dismiss) await tx.update(profiles).set({ displayName: null, displayNameLatin: null, displayNameActionId: action.id }).where(eq(profiles.userId, input.userId));
    await tx.update(reports).set({ status: input.dismiss ? "dismissed" : "resolved", handledBy: actor.id, handledAt: now }).where(and(eq(reports.displayNameUserId, input.userId), eq(reports.status, "open")));
    if (!input.dismiss) await createModerationNotification(tx, { userId: input.userId, actionId: action.id, entryId: null, now });
    return { ok: true as const, actionId: action.id };
  });
}

export type DisplayNameReportCard = { kind: "display_name"; entryId?: never; hidden?: never; userId: string; handle: string; displayName: string | null; displayNameLatin: string | null; version: string; reports: Array<ReportSummary & { names: DisplayNames | null }> };
export async function loadDisplayNameReportCards(db: Db, ids: string[], handled: boolean): Promise<Map<string, DisplayNameReportCard>> {
  if (!ids.length) return new Map();
  const people = await db.select().from(profiles).where(inArray(profiles.userId, ids));
  const rows = await db.select().from(reports).where(and(inArray(reports.displayNameUserId, ids), handled ? inArray(reports.status, ["dismissed", "resolved"]) : eq(reports.status, "open"))).orderBy(asc(reports.createdAt), asc(reports.id));
  return new Map(people.flatMap(person => {
    const matching = rows.filter(row => row.displayNameUserId === person.userId);
    if (!matching.length) return [];
    return [[person.userId, { kind: "display_name", userId: person.userId, handle: person.handle, displayName: person.displayName, displayNameLatin: person.displayNameLatin, version: displayNamesVersion(person),
      reports: matching.map(row => ({ id: row.id, reason: row.reason as ReportReason, note: row.note, createdAt: row.createdAt, names: row.displayNamesReported })) } satisfies DisplayNameReportCard] as const];
  }));
}
