import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "./db/client.server";
import { media, moderationActions, profiles, reports } from "./db/schema";
import { checkInput, MAX_REPORT_NOTE, type Actor, type ModerationResult, type ReportError, type ReportSummary } from "./moderation.server";
import { isReason, type ReportReason } from "./moderation";
import { createModerationNotification } from "./notifications.server";
import { memberAvatarUrl } from "./member-avatar.server";
import { AVATAR_EDGE } from "./avatar-image.server";
import { mediaPath } from "./media";

export async function createAvatarReport(db: Db, reporterId: string, userId: string, input: { reason: unknown; note?: unknown }): Promise<{ ok: true; id: number } | { ok: false; error: ReportError }> {
  if (!isReason(input.reason)) return { ok: false, error: "invalid_reason" };
  const note = typeof input.note === "string" ? input.note.trim() : "";
  if (note.includes("\0") || [...note].length > MAX_REPORT_NOTE) return { ok: false, error: "invalid_note" };
  if (userId === reporterId) return { ok: false, error: "own_entry" };
  const reason = input.reason;
  return db.transaction(async tx => {
    const [person] = await tx.select().from(profiles).where(eq(profiles.userId, userId)).for("update");
    if (!person?.avatarMediaId) return { ok: false as const, error: "not_found" as const };
    const [report] = await tx.insert(reports).values({ avatarUserId: userId, avatarMediaId: person.avatarMediaId, reporterId, reason, note }).onConflictDoNothing().returning({ id: reports.id });
    return report ? { ok: true as const, id: report.id } : { ok: false as const, error: "duplicate" as const };
  });
}

export async function moderateAvatar(db: Db, actor: Actor, input: { userId: string; reportId: number; version: string; dismiss: boolean; reason: unknown; note: unknown }): Promise<ModerationResult> {
  if (!actor.scope.operator) return { ok: false, error: "forbidden" };
  if (actor.id === input.userId) return { ok: false, error: "own_entry" };
  const checked = checkInput(input, !input.dismiss);
  if (typeof checked === "string") return { ok: false, error: checked };
  return db.transaction(async tx => {
    const [person] = await tx.select().from(profiles).where(eq(profiles.userId, input.userId)).for("update");
    if (!person) return { ok: false as const, error: "not_found" as const };
    if (!input.dismiss && (!person.avatarMediaId || input.version !== person.avatarMediaId)) return { ok: false as const, error: "invalid_state" as const };
    const [report] = await tx.select().from(reports).where(and(eq(reports.id, input.reportId), eq(reports.avatarUserId, input.userId), eq(reports.status, "open"))).for("update");
    if (!report) return { ok: false as const, error: "invalid_state" as const };
    const now = new Date();
    const [action] = await tx.insert(moderationActions).values({ action: input.dismiss ? "dismiss_avatar_report" : "clear_avatar", targetUserId: input.userId, reportId: report.id, actorId: actor.id,
      ...checked, avatarMediaIdBefore: input.dismiss ? null : person.avatarMediaId, createdAt: now }).returning({ id: moderationActions.id });
    if (!input.dismiss) await tx.update(profiles).set({ avatarMediaId: null, avatarActionId: action.id }).where(eq(profiles.userId, input.userId));
    await tx.update(reports).set({ status: input.dismiss ? "dismissed" : "resolved", handledBy: actor.id, handledAt: now }).where(and(eq(reports.avatarUserId, input.userId), eq(reports.status, "open")));
    if (!input.dismiss) await createModerationNotification(tx, { userId: input.userId, actionId: action.id, entryId: null, now });
    return { ok: true as const, actionId: action.id };
  });
}

export type AvatarReportCard = { kind: "avatar"; entryId?: never; hidden?: never; userId: string; handle: string; url: string; version: string; reports: Array<ReportSummary & { url: string | null }> };
export async function loadAvatarReportCards(db: Db, ids: string[], handled: boolean): Promise<Map<string, AvatarReportCard>> {
  if (!ids.length) return new Map();
  const people = await db.select().from(profiles).where(inArray(profiles.userId, ids));
  const rows = await db.select().from(reports).where(and(inArray(reports.avatarUserId, ids), handled ? inArray(reports.status, ["dismissed", "resolved"]) : eq(reports.status, "open"))).orderBy(asc(reports.createdAt), asc(reports.id));
  const imageIds = rows.flatMap(row => row.avatarMediaId ? [row.avatarMediaId] : []);
  const available = new Set(imageIds.length ? (await db.select({ id: media.id }).from(media).where(and(inArray(media.id, imageIds), isNull(media.deletedAt)))).map(row => row.id) : []);
  return new Map(people.flatMap(person => {
    const matching = rows.filter(row => row.avatarUserId === person.userId);
    if (!matching.length) return [];
    return [[person.userId, { kind: "avatar", userId: person.userId, handle: person.handle, url: memberAvatarUrl(person)!, version: person.avatarMediaId ?? "",
      reports: matching.map(row => ({ id: row.id, reason: row.reason as ReportReason, note: row.note, createdAt: row.createdAt, url: row.avatarMediaId && available.has(row.avatarMediaId) ? mediaPath(row.avatarMediaId, AVATAR_EDGE, AVATAR_EDGE) : null })) } satisfies AvatarReportCard] as const];
  }));
}

export async function avatarAppealUrl(db: Db, id: string | null): Promise<string | null> {
  if (!id) return null;
  const [image] = await db.select({ id: media.id }).from(media).where(and(eq(media.id, id), eq(media.avatar, true), isNull(media.deletedAt)));
  return image ? mediaPath(image.id, AVATAR_EDGE, AVATAR_EDGE) : null;
}
