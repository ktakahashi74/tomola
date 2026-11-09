import { cancelUnavailableVillageInvites } from "./village-invitations.server";
import { lockVillageSlugClaims, villageSlugHeld } from "~/lib/village-slugs.server";
import { villageChatEnabled } from "./village-chat-enabled.server";
import { closeVillageChatConnections } from "./village-chat-events.server";
import { clearVillageChatMemberState } from "./village-chat-notifications.server";
import { and, asc, count, desc, eq, gt, gte, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { hitMemberLimit } from "~/lib/rate-limit.server";
import type { Db } from "~/lib/db/client.server";
import { notifications, profiles, reports, user, villageDepartures, villageEvents, villageInvites, villageMembers, villages } from "~/lib/db/schema";
import { isOperatorEmail } from "~/lib/operators.server";
import { enqueueImmediateEmails } from "~/lib/notifications.server";
import { villagesEnabled } from "~/lib/villages-enabled.server";
import { handleKey } from "~/lib/handles";
import { checkPagination } from "~/lib/pagination";
import { resetPersonalDefault } from "./personal-villages.server";
import { activeSharedVillageCondition, enrollInVillage, sharedVillageCondition } from "~/lib/villages.server";
import { decideVillageLangOf, memberVillageLang, requestVillageTranslations, villageSourceLang } from "~/lib/village-translations.server";
import { validVillageSlug, villageDescriptionText, villageNameText, villageText, VILLAGE_CREATE_LIMIT, VILLAGE_DECLINE_LIMIT, VILLAGE_INVITE_DAILY_LIMIT, VILLAGE_INVITE_PAUSE_DAYS, VILLAGE_REINVITE_HOURS, VILLAGE_REMOVAL_REASON_MAX, VILLAGE_ROSTER_PAGE_SIZE, type VillageInviteKind } from "~/lib/villages";

export type VillageError = "disabled" | "forbidden" | "not_found" | "invalid" | "slug_taken" | "limit" | "rate_limited" | "paused" | "invite_limit" | "invite_wait" | "pending" | "last_owner" | "self_left";
export type VillageResult = { ok: true; slug: string } | { ok: false; error: VillageError };
const fail = (error: VillageError): VillageResult => ({ ok: false, error });
type Actor = { userId: string; handle: string; suspendedUntil: Date | null };

// All mutations lock involved profiles in ascending user ID, then the village.
// Posting already locks profile -> draft/reference topic -> village. No mutation
// acquires another profile, draft or topic after locking a village.
async function lockActors(db: Db, ids: string[]): Promise<Actor[]> {
  return db.select({ userId: profiles.userId, handle: profiles.handle, suspendedUntil: profiles.suspendedUntil })
    .from(profiles).where(inArray(profiles.userId, [...new Set(ids)].sort())).orderBy(asc(profiles.userId)).for("update");
}
function canWrite(actor: Actor | undefined, now = new Date()): actor is Actor {
  return !!actor && !(actor.suspendedUntil && actor.suspendedUntil > now);
}
async function lockedVillage(db: Db, slug: string) {
  const [village] = await db.select().from(villages).where(and(sharedVillageCondition(), eq(villages.slug, slug))).for("update");
  return village ?? null;
}
async function isOwner(db: Db, villageId: string, userId: string) {
  const [row] = await db.select({ role: villageMembers.role }).from(villageMembers).where(and(eq(villageMembers.villageId, villageId), eq(villageMembers.userId, userId)));
  return row?.role === "owner";
}
async function isOperator(db: Db, userId: string) {
  const [account] = await db.select({ email: user.email }).from(user).where(eq(user.id, userId));
  return !!account && isOperatorEmail(account.email);
}
async function record(db: Db, villageId: string, actor: Actor, action: string, detail: Record<string, string | null> = {}, now = new Date()) {
  const [event] = await db.insert(villageEvents).values({ villageId, actorId: actor.userId, actorHandle: actor.handle, action, detail, createdAt: now }).returning({ id: villageEvents.id });
  return event.id;
}
async function notify(db: Db, userId: string, actorId: string, villageId: string, kind: "village_invite" | "village_removed" | "village_added", extra: { villageInviteId?: string; villageReason?: string } = {}) {
  const [row] = await db.insert(notifications).values({ userId, actorId, villageId, kind, ...extra }).returning({ id: notifications.id, userId: notifications.userId, kind: notifications.kind });
  await enqueueImmediateEmails(db, [{ ...row, kind }]);
}

// Caller holds the sender profile lock. Invitations and direct additions share
// one rolling-day allowance across recipients and villages.
async function dailyInvitationCount(db: Db, userId: string, now: Date) {
  const since = new Date(now.getTime() - 86400000);
  const [{ n: invited }] = await db.select({ n: count() }).from(villageInvites)
    .where(and(eq(villageInvites.invitedBy, userId), gt(villageInvites.createdAt, since)));
  const [{ n: added }] = await db.select({ n: count() }).from(villageEvents)
    .where(and(eq(villageEvents.actorId, userId), eq(villageEvents.action, "add_member"), gt(villageEvents.createdAt, since)));
  return Number(invited) + Number(added);
}

export async function addVillageMember(db: Db, userId: string, slug: string, handle: string, now = new Date()): Promise<VillageResult> {
  if (!villagesEnabled()) return fail("disabled");
  const [target] = await db.select({ userId: profiles.userId, handle: profiles.handle }).from(profiles).where(eq(profiles.handleKey, handleKey(handle.trim().replace(/^@/, ""))));
  if (!target || target.userId === userId) return fail("invalid");
  return db.transaction(async tx => {
    const actors = await lockActors(tx, [userId, target.userId]);
    const actor = actors.find(row => row.userId === userId);
    if (!canWrite(actor, now) || !actors.some(row => row.userId === target.userId)) return fail("forbidden");
    const village = await lockedVillage(tx, slug);
    if (!village || village.endedAt) return fail("not_found");
    if (!await isOwner(tx, village.id, userId)) return fail("forbidden");
    if (village.kind !== "invite_public") return fail("invalid");
    const [member] = await tx.select({ userId: villageMembers.userId }).from(villageMembers).where(and(eq(villageMembers.villageId, village.id), eq(villageMembers.userId, target.userId)));
    if (member) return fail("invalid");
    const [departure] = await tx.select({ userId: villageDepartures.userId }).from(villageDepartures).where(and(eq(villageDepartures.villageId, village.id), eq(villageDepartures.userId, target.userId)));
    if (departure) return fail("self_left");
    if (await dailyInvitationCount(tx, userId, now) >= VILLAGE_INVITE_DAILY_LIMIT) return fail("invite_limit");
    // Direct addition grants posting only: do not change defaults or chat consent.
    await tx.insert(villageMembers).values({ villageId: village.id, userId: target.userId });
    // A previous join invitation is no longer actionable or awaiting a response.
    const cancelled = await tx.update(villageInvites).set({ state: "cancelled", respondedAt: now })
      .where(and(eq(villageInvites.villageId, village.id), eq(villageInvites.userId, target.userId), eq(villageInvites.kind, "join"), eq(villageInvites.state, "pending"))).returning({ id: villageInvites.id });
    if (cancelled.length) await tx.update(notifications).set({ readAt: now }).where(and(eq(notifications.userId, target.userId), inArray(notifications.villageInviteId, cancelled.map(row => row.id)), isNull(notifications.readAt)));
    await notify(tx, target.userId, userId, village.id, "village_added");
    await record(tx, village.id, actor, "add_member", { handle: target.handle }, now);
    return { ok: true, slug };
  });
}

const blank = (value: unknown) => value === undefined || value === null || value === "";

export async function createVillage(db: Db, userId: string, input: { slug: unknown; kind: unknown; name: unknown; description: unknown; sourceLang?: unknown }, opts: { now?: Date } = {}): Promise<VillageResult> {
  if (!villagesEnabled()) return fail("disabled");
  const chosenLang = blank(input.sourceLang) ? null : villageSourceLang(input.sourceLang);
  if (!blank(input.sourceLang) && chosenLang === null) return fail("invalid");
  const name = villageNameText(input.name);
  const description = villageDescriptionText(input.description);
  if (!validVillageSlug(input.slug) || (input.kind !== "open" && input.kind !== "invite_public") || name === null || description === null) return fail("invalid");
  const { slug, kind } = input as { slug: string; kind: string };
  return db.transaction(async tx => {
    const [actor] = await lockActors(tx, [userId]);
    const now = opts.now ?? new Date();
    if (!canWrite(actor, now)) return fail("forbidden");
    const [{ n }] = await tx.select({ n: count() }).from(villages).where(and(eq(villages.createdBy, userId), or(isNull(villages.endedAt), gte(villages.endedAt, new Date(now.getTime() - 30 * 86400_000)))));
    if (Number(n) >= VILLAGE_CREATE_LIMIT) return fail("limit");
    if (!(await hitMemberLimit(tx, "village-create", userId, now)).allowed) return fail("rate_limited");
    await lockVillageSlugClaims(tx);
    if (await villageSlugHeld(tx, slug, opts.now ?? new Date())) return fail("slug_taken");
    // The language of the texts: the one the author named, otherwise their main language.
    const [profile] = await tx.select({ homeArea: profiles.homeArea, uiLocale: profiles.uiLocale, displayLang: profiles.displayLang, readLangs: profiles.readLangs }).from(profiles).where(eq(profiles.userId, userId));
    const sourceLang = chosenLang ?? memberVillageLang(profile);
    const [village] = await tx.insert(villages).values({ slug, kind, name, description, sourceLang, createdBy: userId }).onConflictDoNothing({ target: villages.slug }).returning();
    if (!village) return fail("slug_taken");
    await tx.insert(villageMembers).values({ villageId: village.id, userId, role: "owner" });
    await requestVillageTranslations(tx, village.id);
    await record(tx, village.id, actor, "create", { kind });
    return { ok: true, slug };
  });
}

export async function editVillage(db: Db, userId: string, slug: string, input: { name: unknown; description: unknown; sourceLang?: unknown; resolveReportId?: number }): Promise<VillageResult> {
  if (!villagesEnabled()) return fail("disabled");
  const description = villageDescriptionText(input.description);
  if (description === null) return fail("invalid");
  return db.transaction(async tx => {
    const [actor] = await lockActors(tx, [userId]);
    if (!canWrite(actor)) return fail("forbidden");
    const village = await lockedVillage(tx, slug);
    if (!village) return fail("not_found");
    if (!await isOwner(tx, village.id, userId) && !(village.language && await isOperator(tx, userId))) return fail("forbidden");
    const name = village.language ? village.name : villageNameText(input.name);
    if (name === null) return fail("invalid");
    let resolveReports = false;
    if (input.resolveReportId !== undefined) {
      if (!village.language || !Number.isSafeInteger(input.resolveReportId) || input.resolveReportId <= 0) return fail("invalid");
      if (!await isOperator(tx, userId)) return fail("forbidden");
      const [source] = await tx.select({ id: reports.id }).from(reports).where(and(eq(reports.id, input.resolveReportId), eq(reports.villageId, village.id), eq(reports.status, "open")));
      if (!source) return fail("not_found");
      resolveReports = true;
    }
    // The language of the texts: kept unless the author names another (a language that is closed now may stay); one that was never set is taken from the author, or from the text of a language village.
    let sourceLang = village.sourceLang;
    if (!blank(input.sourceLang) && input.sourceLang !== village.sourceLang) {
      sourceLang = villageSourceLang(input.sourceLang);
      if (sourceLang === null) return fail("invalid");
    } else if (sourceLang === null && (name || description)) {
      // Decided as the operator's preparation would (the author's language, else the text's), not from whoever edits first.
      sourceLang = (await decideVillageLangOf(tx, { name, description, language: village.language, createdBy: village.createdBy })).lang;
    }
    await tx.update(villages).set({ ...(village.language ? { description } : { name, description }), sourceLang }).where(eq(villages.id, village.id));
    await record(tx, village.id, actor, "edit", { oldName: village.name, oldDescription: village.description, name, description });
    if (name !== village.name || description !== village.description || sourceLang !== village.sourceLang) await requestVillageTranslations(tx, village.id);
    if (resolveReports) await tx.update(reports).set({ status: "resolved", handledBy: userId, handledAt: new Date() }).where(and(eq(reports.villageId, village.id), eq(reports.status, "open")));
    return { ok: true, slug };
  });
}

export async function endVillage(db: Db, userId: string, slug: string): Promise<VillageResult> {
  if (!villagesEnabled()) return fail("disabled");
  let changedVillageId: string | undefined;
  const result = await db.transaction<VillageResult>(async tx => {
    const [actor] = await lockActors(tx, [userId]);
    if (!canWrite(actor)) return fail("forbidden");
    const village = await lockedVillage(tx, slug);
    if (!village) return fail("not_found");
    if (village.language) return fail("forbidden");
    if (!await isOwner(tx, village.id, userId)) return fail("forbidden");
    if (village.endedAt) return { ok: true, slug };
    await tx.update(villages).set({ endedAt: new Date() }).where(eq(villages.id, village.id));
    await tx.update(villageInvites).set({ state: "cancelled", respondedAt: new Date() }).where(and(eq(villageInvites.villageId, village.id), eq(villageInvites.state, "pending")));
    // Defaults are repaired at the next writing screen, retaining its one-time notice.
    await record(tx, village.id, actor, "end");
    changedVillageId = village.id;
    return { ok: true, slug };
  });
  if (result.ok && changedVillageId && villageChatEnabled()) closeVillageChatConnections(changedVillageId);
  return result;
}

export async function inviteToVillage(db: Db, userId: string, slug: string, handle: string, kind: VillageInviteKind, now = new Date()): Promise<VillageResult> {
  if (!villagesEnabled()) return fail("disabled");
  if (kind !== "join" && kind !== "owner") return fail("invalid");
  const [target] = await db.select({ userId: profiles.userId, handle: profiles.handle }).from(profiles).where(eq(profiles.handleKey, handleKey(handle.trim().replace(/^@/, ""))));
  if (!target || target.userId === userId) return fail("invalid");
  return db.transaction(async tx => {
    const actors = await lockActors(tx, [userId, target.userId]);
    const actor = actors.find(row => row.userId === userId);
    if (!canWrite(actor) || !actors.some(row => row.userId === target.userId)) return fail("forbidden");
    const village = await lockedVillage(tx, slug);
    if (!village || village.endedAt) return fail("not_found");
    if (!await isOwner(tx, village.id, userId)) return fail("forbidden");
    const [member] = await tx.select({ role: villageMembers.role }).from(villageMembers).where(and(eq(villageMembers.villageId, village.id), eq(villageMembers.userId, target.userId)));
    if (kind === "join" ? village.kind !== "invite_public" || !!member : !member || member.role === "owner") return fail("invalid");
    await cancelUnavailableVillageInvites(tx, village.id, now);
    // The recipient lock serializes this pair's invitations across villages and kinds.
    // Cancelled/pending invitations do not erase a run of actual refusals.
    const history = await tx.select({ state: villageInvites.state, respondedAt: villageInvites.respondedAt }).from(villageInvites)
      .where(and(eq(villageInvites.invitedBy, userId), eq(villageInvites.userId, target.userId), inArray(villageInvites.state, ["accepted", "declined"]), isNotNull(villageInvites.respondedAt)))
      .orderBy(desc(villageInvites.responseEventId)).limit(VILLAGE_DECLINE_LIMIT);
    if (history.length === VILLAGE_DECLINE_LIMIT && history.every(row => row.state === "declined")
      && history[0].respondedAt!.getTime() + VILLAGE_INVITE_PAUSE_DAYS * 86400000 > now.getTime()) return fail("paused");
    const [recentResponse] = await tx.select({ at: villageInvites.respondedAt }).from(villageInvites)
      .where(and(eq(villageInvites.invitedBy, userId), eq(villageInvites.userId, target.userId), inArray(villageInvites.state, ["cancelled", "declined"]), isNotNull(villageInvites.respondedAt)))
      .orderBy(desc(villageInvites.respondedAt)).limit(1);
    if (recentResponse && recentResponse.at!.getTime() + VILLAGE_REINVITE_HOURS * 3600000 > now.getTime()) return fail("invite_wait");
    // The sender profile lock serializes the rolling-day cap across villages,
    // recipients and invitation kinds. Every issued invitation counts.
    if (await dailyInvitationCount(tx, userId, now) >= VILLAGE_INVITE_DAILY_LIMIT) return fail("invite_limit");
    const [invite] = await tx.insert(villageInvites).values({ villageId: village.id, userId: target.userId, invitedBy: userId, kind, createdAt: now }).onConflictDoNothing().returning();
    if (!invite) return fail("pending");
    await notify(tx, target.userId, userId, village.id, "village_invite", { villageInviteId: invite.id });
    await record(tx, village.id, actor, "invite", { handle: target.handle, kind });
    return { ok: true, slug };
  });
}

export async function respondToVillageInvite(db: Db, userId: string, slug: string, inviteId: string, response: "accepted" | "declined", now = new Date()): Promise<VillageResult> {
  if (!villagesEnabled()) return fail("disabled");
  if (response !== "accepted" && response !== "declined") return fail("invalid");
  return db.transaction(async tx => {
    const [actor] = await lockActors(tx, [userId]);
    if (!canWrite(actor, now)) return fail("forbidden");
    const village = await lockedVillage(tx, slug);
    if (!village || village.endedAt) return fail("not_found");
    const [invite] = await tx.select().from(villageInvites).where(and(eq(villageInvites.id, inviteId), eq(villageInvites.userId, userId), eq(villageInvites.villageId, village.id), eq(villageInvites.state, "pending")));
    if (!invite) return fail("not_found");
    if (response === "accepted") {
      if (!invite.invitedBy || !await isOwner(tx, village.id, invite.invitedBy)) return fail("not_found");
      if (invite.kind === "owner") {
        const promoted = await tx.update(villageMembers).set({ role: "owner" }).where(and(eq(villageMembers.villageId, village.id), eq(villageMembers.userId, userId))).returning({ userId: villageMembers.userId });
        if (!promoted.length) return fail("not_found");
      } else {
        if (village.kind !== "invite_public") return fail("not_found");
        await enrollInVillage(tx, userId, village.id);
      }
    }
    // The recipient lock orders responses; the event sequence keeps that order
    // even when timestamps tie or invitations were created in a different order.
    const responseEventId = await record(tx, village.id, actor, response, { kind: invite.kind });
    await tx.update(villageInvites).set({ state: response, respondedAt: now, responseEventId }).where(eq(villageInvites.id, invite.id));
    await tx.update(notifications).set({ readAt: now }).where(and(eq(notifications.villageInviteId, invite.id), eq(notifications.userId, userId), isNull(notifications.readAt)));
    return { ok: true, slug };
  });
}

export async function cancelVillageInvite(db: Db, userId: string, slug: string, inviteId: string, now = new Date()): Promise<VillageResult> {
  if (!villagesEnabled()) return fail("disabled");
  return db.transaction(async tx => {
    const [actor] = await lockActors(tx, [userId]);
    if (!canWrite(actor)) return fail("forbidden");
    const village = await lockedVillage(tx, slug);
    if (!village || village.endedAt) return fail("not_found");
    if (!await isOwner(tx, village.id, userId)) return fail("forbidden");
    const rows = await tx.update(villageInvites).set({ state: "cancelled", respondedAt: now }).where(and(eq(villageInvites.id, inviteId), eq(villageInvites.villageId, village.id), eq(villageInvites.state, "pending"))).returning({ kind: villageInvites.kind });
    if (!rows.length) return fail("not_found");
    await record(tx, village.id, actor, "cancel_invite", { kind: rows[0].kind });
    return { ok: true, slug };
  });
}

export async function removeVillageMember(db: Db, userId: string, slug: string, handle: string, rawReason: unknown): Promise<VillageResult> {
  if (!villagesEnabled()) return fail("disabled");
  const reason = villageText(rawReason ?? "", VILLAGE_REMOVAL_REASON_MAX);
  if (reason === null) return fail("invalid");
  const [target] = await db.select({ userId: profiles.userId, handle: profiles.handle }).from(profiles).where(eq(profiles.handleKey, handleKey(handle.trim().replace(/^@/, ""))));
  if (!target || target.userId === userId) return fail("invalid");
  let changedVillageId: string | undefined;
  const result = await db.transaction<VillageResult>(async tx => {
    const actors = await lockActors(tx, [userId, target.userId]);
    const actor = actors.find(row => row.userId === userId);
    if (!canWrite(actor)) return fail("forbidden");
    const village = await lockedVillage(tx, slug);
    if (!village || village.endedAt) return fail("not_found");
    if (!await isOwner(tx, village.id, userId)) return fail("forbidden");
    if (village.kind !== "invite_public") return fail("invalid");
    if (await isOwner(tx, village.id, target.userId)) return fail("forbidden");
    const removed = await tx.delete(villageMembers).where(and(eq(villageMembers.villageId, village.id), eq(villageMembers.userId, target.userId))).returning({ userId: villageMembers.userId });
    if (!removed.length) return fail("not_found");
    await cancelUnavailableVillageInvites(tx, village.id);
    await clearVillageChatMemberState(tx, village.id, target.userId);
    await tx.update(villageInvites).set({ state: "cancelled", respondedAt: new Date() }).where(and(eq(villageInvites.villageId, village.id), eq(villageInvites.userId, target.userId), eq(villageInvites.state, "pending")));
    const [profile] = await tx.select({ defaultVillageId: profiles.defaultVillageId }).from(profiles).where(eq(profiles.userId, target.userId));
    if (profile?.defaultVillageId === village.id) {
      await resetPersonalDefault(tx, target.userId);
    }
    await notify(tx, target.userId, userId, village.id, "village_removed", { villageReason: reason });
    await record(tx, village.id, actor, "remove_member", { handle: target.handle, reason });
    changedVillageId = village.id;
    return { ok: true, slug };
  });
  if (result.ok && changedVillageId && villageChatEnabled()) closeVillageChatConnections(changedVillageId, target.userId);
  return result;
}

// Only the recipient receives invitations. No village IDs or account IDs leave here.
export async function incomingVillageInvites(db: Db, userId: string) {
  if (!villagesEnabled()) return [];
  return db.select({ id: villageInvites.id, kind: villageInvites.kind, slug: villages.slug, name: villages.name, description: villages.description, language: villages.language, villageKind: villages.kind, inviter: profiles.handle,
    members: sql<number>`(select count(*)::int from village_members where village_id = ${villages.id})` })
    .from(villageInvites).innerJoin(villages, eq(villages.id, villageInvites.villageId)).innerJoin(profiles, eq(profiles.userId, villageInvites.invitedBy))
    .innerJoin(villageMembers, and(eq(villageMembers.villageId, villages.id), eq(villageMembers.userId, villageInvites.invitedBy), eq(villageMembers.role, "owner")))
    .where(and(eq(villageInvites.userId, userId), eq(villageInvites.state, "pending"), activeSharedVillageCondition())).orderBy(desc(villageInvites.createdAt), asc(villageInvites.id));
}

export function emptyVillageManagement() {
  return { roster: [] as Array<{ handle: string; role: string; self: boolean }>, invites: [] as Array<{ id: string; kind: string; handle: string }>, canReadRoster: false, lastOwner: false, rosterPage: 1, rosterHasNext: false, invitesPage: 1, invitesHasNext: false };
}
export async function villageManagement(db: Db, villageId: string, userId: string, page = 1, invitesPage = 1) {
  if (!villagesEnabled()) return emptyVillageManagement();
  const [village] = await db.select({ language: villages.language }).from(villages).where(and(eq(villages.id, villageId), sharedVillageCondition()));
  if (!village || village.language) return emptyVillageManagement();
  const [own] = await db.select({ role: villageMembers.role }).from(villageMembers).where(and(eq(villageMembers.villageId, villageId), eq(villageMembers.userId, userId)));
  const owner = own?.role === "owner", operator = await isOperator(db, userId);
  if (!owner && !operator) return emptyVillageManagement();
  const { offset, limit } = checkPagination({ page, limit: VILLAGE_ROSTER_PAGE_SIZE });
  const readerOwner = sql`exists (select 1 from village_members as roster_reader where roster_reader.village_id = ${villageId} and roster_reader.user_id = ${userId} and roster_reader.role = 'owner')`;
  const rows = await db.select({ handle: profiles.handle, role: villageMembers.role, self: sql<boolean>`${profiles.userId} = ${userId}` })
    .from(villageMembers).innerJoin(profiles, eq(profiles.userId, villageMembers.userId))
    .where(and(eq(villageMembers.villageId, villageId), sql`(${readerOwner} or ${operator})`)).orderBy(asc(profiles.handle)).limit(limit + 1).offset(offset);
  const [{ owners }] = owner ? await db.select({ owners: count() }).from(villageMembers)
    .where(and(eq(villageMembers.villageId, villageId), eq(villageMembers.role, "owner"), readerOwner)) : [{ owners: 0 }];
  const invitationPage = checkPagination({ page: invitesPage, limit: VILLAGE_ROSTER_PAGE_SIZE });
  // Any current owner can cancel pending invitations, including historical orphans.
  const invites = owner ? await db.select({ id: villageInvites.id, kind: villageInvites.kind, handle: profiles.handle }).from(villageInvites).innerJoin(profiles, eq(profiles.userId, villageInvites.userId))
    .where(and(eq(villageInvites.villageId, villageId), eq(villageInvites.state, "pending"), sql`exists (select 1 from village_members as invite_reader where invite_reader.village_id = ${villageId} and invite_reader.user_id = ${userId} and invite_reader.role = 'owner')`)).orderBy(asc(villageInvites.createdAt), asc(villageInvites.id)).limit(invitationPage.limit + 1).offset(invitationPage.offset) : [];
  return { roster: rows.slice(0, limit), invites: invites.slice(0, invitationPage.limit), invitesPage, invitesHasNext: invites.length > invitationPage.limit, canReadRoster: true, lastOwner: owner && Number(owners) === 1, rosterPage: page, rosterHasNext: rows.length > limit };
}
