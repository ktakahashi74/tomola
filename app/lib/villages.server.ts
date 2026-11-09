import { personalVillage, resetPersonalDefault } from "./personal-villages.server";
import { safeErrorText } from "~/lib/error-text.server";
import { cancelUnavailableVillageInvites } from "./village-invitations.server";
import { villageChatEnabled } from "./village-chat-enabled.server";
import { closeVillageChatConnections } from "./village-chat-events.server";
import { clearVillageChatMemberState } from "./village-chat-notifications.server";
import { and, asc, count, eq, inArray, isNotNull, isNull, or, exists, sql } from "drizzle-orm";
import type { Db } from "~/lib/db/client.server";
import { entries, profiles, villageDepartures, villageMembers, villages } from "~/lib/db/schema";
import { enabledLangs } from "~/lib/enabled-langs.server";
import { villagesEnabled } from "~/lib/villages-enabled.server";
import { SHARED_VILLAGE_KINDS } from "~/lib/villages";
import { localizeVillages } from "~/lib/village-translations.server";
import type { VillageReader, WithVillageTranslation } from "~/lib/village-translation-view";

type Env = Record<string, string | undefined>;
export type Village = typeof villages.$inferSelect;
export type PublicVillage = Pick<Village, "slug" | "kind" | "name" | "description" | "language">;
export const publicVillage = ({ slug, kind, name, description, language }: Village): PublicVillage => ({ slug, kind, name, description, language });
export const sharedVillageCondition = () => and(inArray(villages.kind, [...SHARED_VILLAGE_KINDS]), isNotNull(villages.slug));
export const publicPostVillageCondition = () => or(sharedVillageCondition(), eq(villages.kind, "personal"));
export const activePublicPostVillageCondition = () => and(publicPostVillageCondition(), isNull(villages.endedAt));
export const activeSharedVillageCondition = () => and(sharedVillageCondition(), isNull(villages.endedAt));

// Independent of VILLAGES: also used by the operator's preparation command.
export async function ensureLanguageVillages(db: Db, env: Env = process.env): Promise<void> {
  const langs = enabledLangs(env);
  await db.insert(villages).values(langs.map(language => ({ language, slug: language.toLowerCase(), kind: "open", system: true })))
    .onConflictDoNothing();
}

export async function languageVillage(db: Db, language: string): Promise<Village | null> {
  const [row] = await db.select().from(villages).where(and(activeSharedVillageCondition(), eq(villages.language, language))).limit(1);
  return row ?? null;
}

export async function villageBySlug(db: Db, slug: string): Promise<Village | null> {
  const [row] = await db.select().from(villages).where(and(sharedVillageCondition(), eq(villages.slug, slug.toLowerCase()))).limit(1);
  return row ?? null;
}

export async function listVillages(db: Db, userId?: string): Promise<Array<PublicVillage & { members?: number; joined?: boolean }>> {
  const columns = { slug: villages.slug, kind: villages.kind, name: villages.name, description: villages.description, language: villages.language };
  if (!userId) return db.select(columns).from(villages).where(activeSharedVillageCondition()).orderBy(asc(villages.slug));
  const rows = await db.select({ ...columns, members: count(villageMembers.userId), joined: sql<boolean>`coalesce(bool_or(${villageMembers.userId} = ${userId}), false)` })
    .from(villages).leftJoin(villageMembers, eq(villageMembers.villageId, villages.id))
    .where(activeSharedVillageCondition()).groupBy(villages.id).orderBy(asc(villages.slug));
  return rows.map(row => ({ ...row, members: Number(row.members) })).sort((a, b) => Number(b.joined) - Number(a.joined));
}

export async function listJoinedVillages(db: Db, userId: string): Promise<PublicVillage[]> {
  return db.select({ slug: villages.slug, kind: villages.kind, name: villages.name, description: villages.description, language: villages.language })
    .from(villageMembers).innerJoin(villages, eq(villages.id, villageMembers.villageId))
    .where(and(eq(villageMembers.userId, userId), activeSharedVillageCondition())).orderBy(asc(villages.slug));
}

// No roster, and anonymous reads never fetch or return membership counts.
export async function villageMembership(db: Db, villageId: string, userId: string) {
  const [[{ members }], [own]] = await Promise.all([
    db.select({ members: count() }).from(villageMembers).where(eq(villageMembers.villageId, villageId)),
    db.select({ role: villageMembers.role }).from(villageMembers).where(and(eq(villageMembers.villageId, villageId), eq(villageMembers.userId, userId))),
  ]);
  return { members: Number(members), joined: !!own, owner: own?.role === "owner" };
}

// Caller owns the profile lock (or has just inserted it in this transaction).
export async function enrollInVillage(db: Db, userId: string, villageId: string): Promise<void> {
  await db.insert(villageMembers).values({ userId, villageId, role: "member" }).onConflictDoNothing();
  await db.update(profiles).set({
    villagePreparedAt: sql`coalesce(${profiles.villagePreparedAt}, now())`,
  }).where(eq(profiles.userId, userId));
}

export async function changeVillageMembership(db: Db, userId: string, slug: string, intent: "join" | "leave"): Promise<boolean> {
  return (await changeVillageMembershipResult(db, userId, slug, intent)).ok;
}

type MembershipChange = { ok: true } | { ok: false; error: "not_found" | "last_owner" };

// The action needs the rejection reason captured under the village lock, rather
// than a later read that could disagree with a concurrent departure or ending.
export async function changeVillageMembershipResult(db: Db, userId: string, slug: string, intent: "join" | "leave"): Promise<MembershipChange> {
  let changedVillageId: string | undefined;
  const changed = await db.transaction(async (tx): Promise<MembershipChange> => {
    const [profile] = await tx.select({ defaultVillageId: profiles.defaultVillageId }).from(profiles).where(eq(profiles.userId, userId)).for("update");
    if (!profile) return { ok: false, error: "not_found" };
    const [village] = await tx.select().from(villages).where(and(sharedVillageCondition(), eq(villages.slug, slug.toLowerCase()))).for("update");
    if (!village) return { ok: false, error: "not_found" };
    if (intent === "join") {
      if (village.endedAt || village.kind !== "open") return { ok: false, error: "not_found" };
      await enrollInVillage(tx, userId, village.id);
    } else {
      const [own] = await tx.select({ role: villageMembers.role }).from(villageMembers).where(and(eq(villageMembers.userId, userId), eq(villageMembers.villageId, village.id)));
      if (!village.endedAt && own?.role === "owner") {
        const [{ owners }] = await tx.select({ owners: count() }).from(villageMembers).where(and(eq(villageMembers.villageId, village.id), eq(villageMembers.role, "owner")));
        if (Number(owners) <= 1) return { ok: false, error: "last_owner" };
      }
      await tx.delete(villageMembers).where(and(eq(villageMembers.userId, userId), eq(villageMembers.villageId, village.id)));
      if (own && village.kind === "invite_public") await tx.insert(villageDepartures).values({ villageId: village.id, userId }).onConflictDoNothing();
      if (villagesEnabled()) await cancelUnavailableVillageInvites(tx, village.id);
      await clearVillageChatMemberState(tx, village.id, userId);
      if (profile.defaultVillageId === village.id) {
        await resetPersonalDefault(tx, userId);
      }
    }
    changedVillageId = village.id;
    return { ok: true };
  });
  if (changed.ok && intent === "leave" && changedVillageId && villageChatEnabled()) closeVillageChatConnections(changedVillageId, userId);
  return changed;
}

// Serialize posting with join/leave through the profile lock. Only called when enabled.
export async function lockVillageProfile(db: Db, userId: string) {
  const [profile] = await db.select({ defaultVillageId: profiles.defaultVillageId, homeArea: profiles.homeArea, handle: profiles.handle }).from(profiles)
    .where(eq(profiles.userId, userId)).for("update");
  return profile ?? null;
}

const postingMemberCondition = (userId: string) => or(
  and(eq(villages.kind, "personal"), eq(villages.ownerId, userId)),
  and(sharedVillageCondition(), exists(sql`(select 1 from ${villageMembers} where ${villageMembers.userId} = ${userId} and ${villageMembers.villageId} = ${villages.id})`)),
);

// Caller is in the write transaction. Explicit invalid targets never fall back to the default.
export async function villageForTopic(db: Db, userId: string, slug?: unknown, storedId?: string | null): Promise<(PublicVillage & { id: string }) | null> {
  const profile = await lockVillageProfile(db, userId);
  if (!profile) return null;
  const explicit = slug !== undefined && slug !== null;
  if (explicit && (typeof slug !== "string" || !slug.trim())) return null;
  const target = explicit ? (slug as string).trim().toLowerCase() : undefined;
  if (target?.startsWith("@") && target !== `@${profile.handle}`) return null;
  const id = storedId ?? profile.defaultVillageId ?? (await personalVillage(db, userId))?.id;
  if (!explicit && !id) return null;
  const [village] = await db.select().from(villages).where(and(
    activePublicPostVillageCondition(),
    explicit ? target!.startsWith("@") ? eq(villages.ownerId, userId) : eq(villages.slug, target!) : eq(villages.id, id!),
    postingMemberCondition(userId),
  )).for("share");
  if (!village && !explicit && storedId == null && profile.defaultVillageId !== null) {
    const reset = await resetPersonalDefault(db, userId);
    return reset ? villageForTopic(db, userId, undefined, reset) : null;
  }
  return village ? { ...publicVillage(village), slug: village.kind === "personal" ? `@${profile.handle}` : village.slug, id: village.id } : null;
}

export async function setDefaultVillage(db: Db, userId: string, slug: unknown): Promise<boolean> {
  return db.transaction(async tx => {
    // An empty selection cannot silently preserve or substitute a different default.
    if (typeof slug !== "string" || !slug.trim()) return false;
    const village = await villageForTopic(tx, userId, slug);
    if (!village) return false;
    await tx.update(profiles).set({ defaultVillageId: village.id, defaultVillageReset: false }).where(eq(profiles.userId, userId));
    return true;
  });
}

// Repair lazily at the next writing screen, where the returned change can be shown once.
export async function restoreEndedDefaultVillage(db: Db, userId: string): Promise<{ changed: boolean; defaultVillageId: string | null }> {
  const [current] = await db.select().from(profiles).where(eq(profiles.userId, userId));
  if (!current) return { changed: false, defaultVillageId: null };
  if (!current.defaultVillageReset) {
    if (current.defaultVillageId === null) return { changed: false, defaultVillageId: null };
    const [available] = await db.select({ id: villages.id }).from(villages).where(and(eq(villages.id, current.defaultVillageId), activePublicPostVillageCondition(), postingMemberCondition(userId)));
    if (available) return { changed: false, defaultVillageId: current.defaultVillageId };
  }
  return db.transaction(async tx => {
    const [profile] = await tx.select().from(profiles).where(eq(profiles.userId, userId)).for("update");
    if (!profile) return { changed: false, defaultVillageId: null };
    const valid = profile.defaultVillageId === null || await villageForTopic(tx, userId, undefined, profile.defaultVillageId);
    const repaired = !valid ? await resetPersonalDefault(tx, userId) : null;
    const changed = !!repaired || profile.defaultVillageReset;
    if (changed) await tx.update(profiles).set({ defaultVillageReset: false }).where(eq(profiles.userId, userId));
    return { changed, defaultVillageId: repaired ?? profile.defaultVillageId };
  });
}

export async function villageSlug(db: Db, villageId: string | null): Promise<string | null> {
  if (villageId === null) return null;
  const [row] = await db.select({ slug: villages.slug, kind: villages.kind, handle: profiles.handle }).from(villages)
    .leftJoin(profiles, eq(profiles.userId, villages.ownerId)).where(eq(villages.id, villageId));
  return row?.kind === "personal" ? row.handle ? `@${row.handle}` : null : row?.slug ?? null;
}

export type PostingVillages = { choices: Array<PublicVillage & WithVillageTranslation>; selected: string; explicit: boolean; changed: boolean; error: "village_required" | null };
export async function postingVillages(db: Db, userId: string, selected?: string | null, opts: { repair?: boolean; reader?: VillageReader } = {}): Promise<PostingVillages> {
  // Settings must not consume the notice promised for the next writing screen.
  const restored = opts.repair === false
    ? { changed: false, defaultVillageId: (await db.select({ id: profiles.defaultVillageId }).from(profiles).where(eq(profiles.userId, userId)))[0]?.id ?? null }
    : await restoreEndedDefaultVillage(db, userId);
  const choices = await localizeVillages(db, await listJoinedVillages(db, userId), opts.reader);
  const personal = await personalVillage(db, userId);
  const ownTarget = personal && !personal.endedAt ? await villageSlug(db, personal.id) : null;
  if (ownTarget) choices.unshift({ ...publicVillage(personal!), slug: ownTarget });
  const target = selected?.trim().toLowerCase() ?? await villageSlug(db, restored.defaultVillageId) ?? ownTarget ?? "";
  return { choices, selected: target, explicit: selected != null, changed: restored.changed, error: target && !choices.some(row => row.slug === target) ? "village_required" : null };
}

export async function topicVillage(db: Db, topicId: number): Promise<PublicVillage | null> {
  const [row] = await db.select({ village: villages }).from(entries).innerJoin(villages, eq(villages.id, entries.villageId))
    .where(and(eq(entries.id, topicId), eq(entries.kind, "topic"), publicPostVillageCondition()));
  return row ? { ...publicVillage(row.village), slug: await villageSlug(db, row.village.id) } : null;
}

export async function topicVillageNames(db: Db, ids: readonly number[]): Promise<Map<number, { slug: string; name: string }>> {
  if (!villagesEnabled() || !ids.length) return new Map();
  const rows = await db.select({ id: entries.id, slug: villages.slug, name: villages.name, language: villages.language }).from(entries).innerJoin(villages, eq(villages.id, entries.villageId))
    .where(and(inArray(entries.id, [...ids]), sharedVillageCondition(), isNull(villages.language)));
  return new Map(rows.filter(row => row.slug !== null).map(row => [row.id, { slug: row.slug!, name: row.name }]));
}

export async function assertVillagesReady(db: Db, env: Env = process.env): Promise<void> {
  if (!villagesEnabled(env)) return;
  const present = await db.select({ language: villages.language }).from(villages).where(activeSharedVillageCondition());
  const missing = enabledLangs(env).filter(lang => !present.some(row => row.language === lang));
  const [{ n }] = await db.select({ n: count() }).from(entries).where(and(eq(entries.kind, "topic"), isNull(entries.villageId)));
  if (missing.length || Number(n)) throw new Error(`Villages are not ready: missing language villages [${missing.join(", ")}]; ${n} topics without a village. Stop writes. If startup is blocked, empty VILLAGES and restart the app (docker compose up -d --force-recreate app). Run pnpm villages:prepare, then pnpm villages:prepare --write before enabling it again. Keep writes stopped until the enabled app is healthy.`);
}

const g = globalThis as { __tomolaLanguageVillages?: Promise<void> };
export function ensureDevelopmentVillagesOnce(getDb: () => Promise<Db>): void {
  if (!villagesEnabled() || (process.env.NODE_ENV !== "development" && process.env.NODE_ENV !== "test")) return;
  if (g.__tomolaLanguageVillages) return;
  const pending = getDb().then(db => ensureLanguageVillages(db));
  g.__tomolaLanguageVillages = pending;
  pending.catch(error => {
    if (g.__tomolaLanguageVillages === pending) g.__tomolaLanguageVillages = undefined;
    console.error("[villages] could not prepare language villages:", safeErrorText(error));
  });
}
