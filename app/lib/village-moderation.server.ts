import { media } from "./db/schema";
import { mediaPath } from "./media";
import { AVATAR_EDGE } from "./avatar-image.server";
import { avatarAppealUrl } from "./avatar-moderation.server";
import { enqueueReportTriage } from "./moderation-automation.server";
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lt, ne, sql } from "drizzle-orm";
import type { Db } from "~/lib/db/client.server";
import { moderationActions, profiles, reports, villageEvents, villageInvites, villageMembers, villageReportSnapshots, villages } from "~/lib/db/schema";
import { checkInput, MAX_REPORT_NOTE, type Actor, type ModerationError, type ReportSummary } from "~/lib/moderation.server";
import { isReason, type ReportReason } from "~/lib/moderation";
import { createModerationNotification } from "~/lib/notifications.server";
import { villagesEnabled } from "~/lib/villages-enabled.server";
import { isSharedVillageKind, validVillageSlug, villageDescriptionText, villageNameText, villageText } from "~/lib/villages";
import { lockVillageSlugClaims, villageSlugHeld } from "~/lib/village-slugs.server";
import { closeVillageChatConnections } from "~/lib/village-chat-events.server";
import { requestVillageTranslations } from "~/lib/village-translations.server";
import { RETENTION, daysBefore } from "~/lib/retention";
import { drainRetentionRows, type RetentionResults } from "~/lib/retention-batch.server";

export type VillageMetadata = { name: string; description: string; slug: string | null; language: string | null };
export type VillageReportTarget = "information" | "icon";
export type VillageModerationError = ModerationError | "invalid_village" | "slug_taken" | "stale";
export type VillageReportCard = {
  kind: "village";
  entryId?: never;
  hidden?: never;
  // Reports identify forms; internal village IDs never leave the service.
  reportId: number | null;
  version: string;
  owned: boolean;
  iconUrl?: string | null;
  village: VillageMetadata & { kind: string; ended: boolean };
  creatorHandle: string | null;
  ownerHandles: string[];
  reports: Array<ReportSummary & { target: VillageReportTarget; iconUrl?: string | null; snapshot: Omit<VillageMetadata, "language"> | null }>;
};

export async function lockVillageActor(db: Db, id: string) {
  const [actor] = await db.select({ handle: profiles.handle, suspendedUntil: profiles.suspendedUntil }).from(profiles).where(eq(profiles.userId, id)).for("update");
  return actor;
}
export async function lockModeratedVillage(db: Db, id: string) {
  const [village] = await db.select().from(villages).where(eq(villages.id, id)).for("update");
  return village;
}
export async function isVillageOwner(db: Db, id: string, userId: string): Promise<boolean> {
  const [owner] = await db.select({ userId: villageMembers.userId }).from(villageMembers).where(and(eq(villageMembers.villageId, id), eq(villageMembers.userId, userId), eq(villageMembers.role, "owner")));
  return !!owner;
}

export async function createVillageReport(db: Db, reporterId: string, input: { slug: string; reason: unknown; note?: unknown; target?: unknown }, opts: { now?: Date } = {}) {
  if (!villagesEnabled()) return { ok: false as const, error: "not_found" as const };
  if (!isReason(input.reason)) return { ok: false as const, error: "invalid_reason" as const };
  const target = input.target ?? "information";
  if (target !== "information" && target !== "icon") return { ok: false as const, error: "invalid_state" as const };
  const reason = input.reason;
  const note = villageText(input.note ?? "", MAX_REPORT_NOTE);
  if (note === null) return { ok: false as const, error: "invalid_note" as const };
  const now = opts.now ?? new Date();
  return db.transaction(async tx => {
    const actor = await lockVillageActor(tx, reporterId);
    if (!actor || actor.suspendedUntil && actor.suspendedUntil > now) return { ok: false as const, error: "forbidden" as const };
    const [village] = await tx.select().from(villages).where(eq(villages.slug, input.slug)).for("update");
    if (!village || !isSharedVillageKind(village.kind)) return { ok: false as const, error: "not_found" as const };
    if (target === "icon" && !village.iconMediaId) return { ok: false as const, error: "not_found" as const };
    const [row] = await tx.insert(reports).values({ villageId: village.id, villageTarget: target, iconMediaId: target === "icon" ? village.iconMediaId : null, reporterId, reason, note, createdAt: now }).onConflictDoNothing().returning({ id: reports.id });
    if (!row) return { ok: false as const, error: "duplicate" as const };
    await tx.insert(villageReportSnapshots).values({ reportId: row.id, name: village.name, description: village.description, slug: village.slug });
    await enqueueReportTriage(tx, row.id);
    return { ok: true as const, id: row.id };
  });
}

// Only call for village targets selected onto the current queue page.
export async function loadVillageReportCards(db: Db, ids: string[], handled: boolean, viewerId?: string): Promise<Map<string, VillageReportCard>> {
  if (!ids.length) return new Map();
  const [villageRows, reportRows, owners] = await Promise.all([
    db.select({ id: villages.id, name: villages.name, description: villages.description, slug: villages.slug, language: villages.language, kind: villages.kind, endedAt: villages.endedAt, iconMediaId: villages.iconMediaId, version: sql<string>`coalesce((select max(id) from village_events where village_id = ${villages.id}), 0)::text`, creatorHandle: profiles.handle }).from(villages).leftJoin(profiles, eq(profiles.userId, villages.createdBy)).where(inArray(villages.id, ids)),
    db.select({ id: reports.id, target: reports.villageTarget, iconMediaId: reports.iconMediaId, villageId: reports.villageId, reason: reports.reason, note: reports.note, createdAt: reports.createdAt, aiPriority: reports.aiPriority, aiAssessment: reports.aiAssessment, name: villageReportSnapshots.name, description: villageReportSnapshots.description, slug: villageReportSnapshots.slug, prunedAt: villageReportSnapshots.prunedAt }).from(reports).leftJoin(villageReportSnapshots, eq(villageReportSnapshots.reportId, reports.id)).where(and(inArray(reports.villageId, ids), handled ? ne(reports.status, "open") : eq(reports.status, "open"))).orderBy(asc(reports.createdAt), asc(reports.id)),
    db.select({ villageId: villageMembers.villageId, userId: villageMembers.userId, handle: profiles.handle }).from(villageMembers).innerJoin(profiles, eq(profiles.userId, villageMembers.userId)).where(and(inArray(villageMembers.villageId, ids), eq(villageMembers.role, "owner"))).orderBy(asc(profiles.handle)),
  ]);
  const imageIds = [...new Set([...villageRows.flatMap(v => v.iconMediaId ? [v.iconMediaId] : []), ...reportRows.flatMap(r => r.iconMediaId ? [r.iconMediaId] : [])])];
  const available = new Set(imageIds.length ? (await db.select({ id: media.id }).from(media).where(and(inArray(media.id, imageIds), isNull(media.deletedAt)))).map(row => row.id) : []);
  const imageUrl = (id: string | null) => id && available.has(id) ? mediaPath(id, AVATAR_EDGE, AVATAR_EDGE) : null;
  return new Map(villageRows.filter(v => reportRows.some(r => r.villageId === v.id)).map(v => [v.id, {
    kind: "village", reportId: reportRows.find(r => r.villageId === v.id)!.id, version: v.version, owned: owners.some(o => o.villageId === v.id && o.userId === viewerId),
    village: { name: v.name, description: v.description, slug: v.slug, language: v.language, kind: v.kind, ended: !!v.endedAt },
    iconUrl: imageUrl(v.iconMediaId), creatorHandle: v.creatorHandle, ownerHandles: owners.filter(o => o.villageId === v.id).map(o => o.handle),
    reports: reportRows.filter(r => r.villageId === v.id).map(r => ({ id: r.id, target: r.target, iconUrl: imageUrl(r.iconMediaId), reason: r.reason as ReportReason, note: r.note, createdAt: r.createdAt, aiPriority: r.aiPriority, aiAssessment: r.aiAssessment, snapshot: r.prunedAt || r.name === null || r.description === null ? null : { name: r.name, description: r.description, slug: r.slug } })),
  }]));
}

async function notifyOwners(db: Db, villageId: string, actionId: number, now: Date) {
  const owners = await db.select({ userId: villageMembers.userId }).from(villageMembers).where(and(eq(villageMembers.villageId, villageId), eq(villageMembers.role, "owner"))).orderBy(asc(villageMembers.userId));
  for (const owner of owners) await createModerationNotification(db, { userId: owner.userId, entryId: null, villageId, actionId, now });
}
function uniqueViolation(error: unknown): boolean {
  return !!error && typeof error === "object" && ("code" in error && error.code === "23505" || "cause" in error && uniqueViolation(error.cause));
}

// Existing cases remain actionable when new village reports are disabled.
export async function moderateVillage(db: Db, actor: Actor, input: { reportId?: number; slugTarget?: string; version: unknown; intent: "fix" | "end" | "dismiss" | "clear-icon"; reason: unknown; note?: unknown; name?: unknown; description?: unknown; slug?: unknown }, opts: { now?: Date } = {}): Promise<{ ok: true; actionId: number } | { ok: false; error: VillageModerationError }> {
  if (!actor.scope.operator) return { ok: false, error: "forbidden" };
  if ((input.reportId === undefined) === (input.slugTarget === undefined)) return { ok: false, error: "not_found" };
  const checked = checkInput(input, input.intent !== "dismiss");
  if (typeof checked === "string") return { ok: false, error: checked };
  const now = opts.now ?? new Date();
  let endedId: string | undefined;
  try {
    const result = await db.transaction(async tx => {
      const member = await lockVillageActor(tx, actor.id);
      if (!member || member.suspendedUntil && member.suspendedUntil > now) return { ok: false as const, error: "forbidden" as const };
      // Direct actions are new entry points; existing report cases remain actionable when disabled.
      if (input.slugTarget !== undefined && !villagesEnabled()) return { ok: false as const, error: "not_found" as const };
      const [target] = input.slugTarget !== undefined
        ? await tx.select({ villageId: villages.id }).from(villages).where(eq(villages.slug, input.slugTarget))
        : input.reportId !== undefined ? await tx.select({ villageId: reports.villageId }).from(reports).where(eq(reports.id, input.reportId)) : [];
      if (!target?.villageId) return { ok: false as const, error: "not_found" as const };
      await lockVillageSlugClaims(tx);
      const village = await lockModeratedVillage(tx, target.villageId);
      if (!village || !isSharedVillageKind(village.kind)) return { ok: false as const, error: "not_found" as const };
      if (await isVillageOwner(tx, village.id, actor.id)) return { ok: false as const, error: "forbidden" as const };
      if (input.intent === "fix" && village.language) return { ok: false as const, error: "forbidden" as const };
      if (String(input.version) !== await villageModerationVersion(tx, village.id)) return { ok: false as const, error: "stale" as const };
      const [open] = await tx.select({ id: reports.id }).from(reports).where(and(eq(reports.villageId, village.id), eq(reports.status, "open"))).limit(1);
      if (!open && (input.intent === "dismiss" || input.slugTarget === undefined)) return { ok: false as const, error: "invalid_state" as const };
      let eventId: number | undefined;
      if (input.intent === "clear-icon" && (village.language || !village.iconMediaId)) return { ok: false as const, error: "invalid_state" as const };
      if (input.intent === "fix") {
        const description = villageDescriptionText(input.description === undefined ? village.description : input.description);
        const name = villageNameText(input.name === undefined ? village.name : input.name);
        const slug = input.slug === undefined ? village.slug : input.slug;
        if (description === null || name === null) return { ok: false as const, error: "invalid_village" as const };
        if (!validVillageSlug(slug)) return { ok: false as const, error: "invalid_village" as const };
        if (slug !== village.slug && await villageSlugHeld(tx, slug as string, now)) return { ok: false as const, error: "slug_taken" as const };
        if (name === village.name && description === village.description && slug === village.slug) return { ok: false as const, error: "invalid_state" as const };
        const [event] = await tx.insert(villageEvents).values({ villageId: village.id, actorId: actor.id, actorHandle: member.handle, action: "moderation_fix", detail: { oldName: village.name, oldDescription: village.description, oldSlug: village.slug, name, description, slug: slug as string }, createdAt: now }).returning({ id: villageEvents.id });
        eventId = event.id;
        await tx.update(villages).set({ name: name!, description: description!, slug: slug as string }).where(eq(villages.id, village.id));
        await requestVillageTranslations(tx, village.id);
      } else if (input.intent === "end") {
        if (village.language) return { ok: false as const, error: "forbidden" as const };
        if (village.endedAt) return { ok: false as const, error: "invalid_state" as const };
        const [event] = await tx.insert(villageEvents).values({ villageId: village.id, actorId: actor.id, actorHandle: member.handle, action: "moderation_end", detail: { endedAt: now.toISOString() }, createdAt: now }).returning({ id: villageEvents.id });
        eventId = event.id;
        await tx.update(villages).set({ endedAt: now }).where(eq(villages.id, village.id));
        await tx.update(villageInvites).set({ state: "cancelled", respondedAt: now }).where(and(eq(villageInvites.villageId, village.id), eq(villageInvites.state, "pending")));
        endedId = village.id;
      }
      const [action] = await tx.insert(moderationActions).values({ iconMediaIdBefore: input.intent === "clear-icon" ? village.iconMediaId : null, action: input.intent === "clear-icon" ? "clear_village_icon" : input.intent === "fix" ? "fix_village" : input.intent === "end" ? "end_village" : "dismiss_village_report", targetVillageId: village.id, villageEventId: eventId, actorId: actor.id, reportId: input.reportId ?? null, ...checked, createdAt: now }).returning({ id: moderationActions.id });
      if (input.intent === "clear-icon") {
        await tx.update(villages).set({ iconMediaId: null, iconActionId: action.id }).where(eq(villages.id, village.id));
        await tx.insert(villageEvents).values({ villageId: village.id, actorId: actor.id, actorHandle: member.handle, action: "moderation_icon", detail: {}, createdAt: now });
      }
      await tx.update(reports).set({ status: input.intent === "dismiss" ? "dismissed" : "resolved", handledBy: actor.id, handledAt: now }).where(and(eq(reports.villageId, village.id), eq(reports.status, "open")));
      if (input.intent !== "dismiss") await notifyOwners(tx, village.id, action.id, now);
      return { ok: true as const, actionId: action.id };
    });
    if (result.ok && endedId) closeVillageChatConnections(endedId);
    return result;
  } catch (error) {
    if (uniqueViolation(error)) return { ok: false, error: "slug_taken" };
    throw error;
  }
}

export async function villageAppealMetadata(db: Db, id: string, eventId: number | null) {
  const [village] = await db.select({ name: villages.name, description: villages.description, slug: villages.slug, language: villages.language }).from(villages).where(eq(villages.id, id));
  let before: VillageMetadata | null = null;
  if (eventId !== null) {
    const [event] = await db.select({ detail: villageEvents.detail }).from(villageEvents).where(and(eq(villageEvents.id, eventId), eq(villageEvents.villageId, id)));
    if (event && typeof event.detail.oldName === "string" && typeof event.detail.oldDescription === "string") before = { name: event.detail.oldName, description: event.detail.oldDescription, slug: event.detail.oldSlug ?? null, language: village?.language ?? null };
  }
  return { village: village ?? null, villageBefore: before };
}

// Caller holds actor profile -> slug claims -> village -> appeal locks, in that order.
export async function reverseVillageAction(db: Db, action: { id: number; action: string; targetVillageId: string; villageEventId: number | null; iconMediaIdBefore?: string | null }, reviewerId: string, handle: string, appealId: number, now: Date): Promise<boolean> {
  const village = await lockModeratedVillage(db, action.targetVillageId);
  if (!village) return false;
  if (action.action === "clear_village_icon") {
    if (village.iconActionId !== action.id || !await avatarAppealUrl(db, action.iconMediaIdBefore ?? null)) return false;
    await db.update(villages).set({ iconMediaId: action.iconMediaIdBefore, iconActionId: null }).where(eq(villages.id, village.id));
    const [reversal] = await db.insert(moderationActions).values({ action: "restore_village_icon", targetVillageId: village.id, actorId: reviewerId, reason: "other", note: `Appeal #${appealId} overturned`, createdAt: now }).returning({ id: moderationActions.id });
    await db.insert(villageEvents).values({ villageId: village.id, actorId: reviewerId, actorHandle: handle, action: "moderation_restore_icon", detail: {}, createdAt: now });
    await notifyOwners(db, village.id, reversal.id, now);
    return true;
  }
  if (action.villageEventId === null) return false;
  const [event] = await db.select().from(villageEvents).where(and(eq(villageEvents.id, action.villageEventId), eq(villageEvents.villageId, village.id)));
  if (!event) return false;
  if (action.action === "fix_village") {
    // Even an edit that changes the values back prevents overwriting the owner's work.
    const [later] = await db.select({ id: villageEvents.id }).from(villageEvents).where(and(eq(villageEvents.villageId, village.id), gt(villageEvents.id, event.id), inArray(villageEvents.action, ["edit", "moderation_fix", "moderation_unfix"]))).limit(1);
    if (later || village.name !== event.detail.name || village.description !== event.detail.description || village.slug !== event.detail.slug) return false;
    if (typeof event.detail.oldName !== "string" || typeof event.detail.oldDescription !== "string") return false;
    if (event.detail.oldSlug && await villageSlugHeld(db, event.detail.oldSlug, now, village.id)) return false;
    try {
      // A savepoint handles a slug claimed concurrently without aborting the appeal decision.
      await db.transaction(async savepoint => {
        await savepoint.update(villages).set({ name: event.detail.oldName!, description: event.detail.oldDescription!, slug: event.detail.oldSlug }).where(eq(villages.id, village.id));
        await requestVillageTranslations(savepoint, village.id);
      });
    } catch (error) { if (uniqueViolation(error)) return false; throw error; }
  } else if (action.action === "end_village") {
    const [latest] = await db.select({ id: villageEvents.id }).from(villageEvents).where(and(eq(villageEvents.villageId, village.id), inArray(villageEvents.action, ["end", "moderation_end", "moderation_reopen"]))).orderBy(desc(villageEvents.id)).limit(1);
    if (!village.endedAt || latest?.id !== event.id) return false;
    await db.update(villages).set({ endedAt: null }).where(eq(villages.id, village.id));
  } else return false;
  const actionKind = action.action === "fix_village" ? "unfix_village" : "reopen_village";
  const [reversalEvent] = await db.insert(villageEvents).values({ villageId: village.id, actorId: reviewerId, actorHandle: handle, action: actionKind === "unfix_village" ? "moderation_unfix" : "moderation_reopen", detail: { appealId: String(appealId) }, createdAt: now }).returning({ id: villageEvents.id });
  const [reversal] = await db.insert(moderationActions).values({ action: actionKind, targetVillageId: village.id, villageEventId: reversalEvent.id, actorId: reviewerId, reason: "other", note: `Appeal #${appealId} overturned`, createdAt: now }).returning({ id: moderationActions.id });
  await notifyOwners(db, village.id, reversal.id, now);
  return true;
}

// Provisional retention period for handled evidence; open reports are never pruned.
export async function pruneVillageReportSnapshots(db: Db, now: Date, results?: RetentionResults): Promise<number> {
  return (await drainRetentionRows(db, "village_report_snapshots", villageReportSnapshots,
    sql`${villageReportSnapshots.prunedAt} is null and ${villageReportSnapshots.reportId} in
      (select ${reports.id} from ${reports} where ${reports.villageId} is not null and ${reports.status} <> 'open' and ${reports.handledAt} < ${daysBefore(now, RETENTION.villageReportDays)})`,
    results, sql`name = null, description = null, slug = null, pruned_at = ${now}`)).removed;
}

export async function villageModerationVersion(db: Db, villageId: string): Promise<string> {
  const [row] = await db.select({ version: sql<string>`coalesce(max(${villageEvents.id}), 0)::text` }).from(villageEvents).where(eq(villageEvents.villageId, villageId));
  return row.version;
}

// Operator-only route callers supply the authenticated account. No village IDs leave here.
export async function loadVillageModerationView(db: Db, slug: string, viewerId: string): Promise<VillageReportCard | null> {
  const [v] = await db.select({ id: villages.id, name: villages.name, description: villages.description, slug: villages.slug, language: villages.language, kind: villages.kind, endedAt: villages.endedAt, iconMediaId: villages.iconMediaId, version: sql<string>`coalesce((select max(id) from village_events where village_id = ${villages.id}), 0)::text`, creatorHandle: profiles.handle }).from(villages).leftJoin(profiles, eq(profiles.userId, villages.createdBy)).where(eq(villages.slug, slug));
  if (!v || !isSharedVillageKind(v.kind)) return null;
  const reported = (await loadVillageReportCards(db, [v.id], false, viewerId)).get(v.id);
  if (reported) return reported;
  const owners = await db.select({ userId: villageMembers.userId, handle: profiles.handle }).from(villageMembers).innerJoin(profiles, eq(profiles.userId, villageMembers.userId)).where(and(eq(villageMembers.villageId, v.id), eq(villageMembers.role, "owner")));
  return { kind: "village", reportId: null, version: v.version, owned: owners.some(o => o.userId === viewerId), village: { name: v.name, description: v.description, slug: v.slug, language: v.language, kind: v.kind, ended: !!v.endedAt }, iconUrl: await avatarAppealUrl(db, v.iconMediaId), creatorHandle: v.creatorHandle, ownerHandles: owners.map(o => o.handle), reports: [] };
}

export async function openVillageReportTargets(db: Db, villageId: string, reporterId: string): Promise<VillageReportTarget[]> {
  const rows = await db.select({ target: reports.villageTarget }).from(reports).where(and(
    eq(reports.villageId, villageId), eq(reports.status, "open"), eq(reports.reporterId, reporterId),
  ));
  return rows.map(row => row.target);
}

export async function hasOpenVillageReport(db: Db, villageId: string, target: { reportId: number }): Promise<boolean> {
  const rows = await db.select({ id: reports.id }).from(reports).where(and(
    eq(reports.villageId, villageId), eq(reports.status, "open"),
    eq(reports.id, target.reportId),
  )).limit(1);
  return rows.length > 0;
}
