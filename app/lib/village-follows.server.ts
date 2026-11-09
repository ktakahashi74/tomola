import { m } from "~/paraglide/messages.js";
import { withVillageIcons } from "./village-icon.server";
import { and, desc, eq, inArray, notExists, sql, isNull, isNotNull, or } from "drizzle-orm";
import type { Db } from "~/lib/db/client.server";
import { profiles, topicListingStats, villageFollows, villageMembers, villages } from "~/lib/db/schema";
import { activePublicPostVillageCondition, activeSharedVillageCondition, publicPostVillageCondition, type PublicVillage } from "~/lib/villages.server";
import { FOLLOWED_NAVIGATION_VISIBLE, FOLLOWED_VILLAGES_MAX } from "~/lib/village-follow-limits";
import { localizeVillages } from "~/lib/village-translations.server";
import type { VillageReader, WithVillageTranslation } from "~/lib/village-translation-view";

// Following a village: a way to choose what the home shows, nothing more. It does not let the member write or chat there, no count of
// followers is kept or shown anywhere, and a new post in a followed village is not announced (no notification, no mail).
// Only a village that anyone may read can be followed: a public kind that has not ended. A closed village answers like a village that does not exist.

export type VillageFollowResult = { ok: true } | { ok: false; error: "not_found" };

// Follow (`follow`) or take off (`!follow`) a village. Following needs a public village that has not ended. Taking off also works on an ended village (so that an old follow can
// be removed), and never on a village that is not public (it answers not_found, the same as for a village that does not exist).
export async function setVillageFollow(db: Db, userId: string, slug: string, follow: boolean): Promise<VillageFollowResult> {
  return db.transaction(async tx => {
    const [village] = await tx.select({ id: villages.id, endedAt: villages.endedAt }).from(villages)
    .leftJoin(profiles, eq(profiles.userId, villages.ownerId))
    .where(and(publicPostVillageCondition(), slug.startsWith("@") ? and(eq(villages.kind, "personal"), eq(profiles.handle, slug.slice(1).toLowerCase())) : eq(villages.slug, slug.toLowerCase()))).limit(1).for("share", { of: villages });
    if (!village || (follow && village.endedAt)) return { ok: false, error: "not_found" };
    if (follow) await tx.insert(villageFollows).values({ userId, villageId: village.id }).onConflictDoNothing();
    else await tx.delete(villageFollows).where(and(eq(villageFollows.userId, userId), eq(villageFollows.villageId, village.id)));
    return { ok: true };
  });
}

export async function isFollowingVillage(db: Db, userId: string, villageId: string): Promise<boolean> {
  const [row] = await db.select({ userId: villageFollows.userId }).from(villageFollows)
    .where(and(eq(villageFollows.userId, userId), eq(villageFollows.villageId, villageId))).limit(1);
  return !!row;
}

export type FollowedVillage = Pick<PublicVillage, "name" | "slug" | "kind" | "language"> & { followedAt: Date; latestAt: Date | null };

// The villages the member follows that can still be read and have not ended, the ones with the most recent post first (then by name).
async function readFollowedVillages(db: Db, userId: string, opts: { excludeJoined?: boolean; page?: number } = {}): Promise<FollowedVillage[]> {
  // The most recent activity is one row read from the village's own index (not an aggregate over all of its topics).
  const latest = sql<Date | null>`(select t.last_activity_at from ${topicListingStats} t where t.village_id = ${villages.id} order by t.last_activity_at desc limit 1)`;
  const rows = await db.select({ name: villages.name, slug: villages.slug, kind: villages.kind, language: villages.language, ownerHandle: profiles.handle, followedAt: villageFollows.createdAt, latestAt: latest })
    .from(villageFollows).innerJoin(villages, eq(villages.id, villageFollows.villageId)).leftJoin(profiles, eq(profiles.userId, villages.ownerId))
    .where(and(eq(villageFollows.userId, userId), activePublicPostVillageCondition(), or(isNull(villages.ownerId), isNotNull(profiles.userId)), opts.excludeJoined ? notExists(db.select({ one: sql`1` }).from(villageMembers).where(and(eq(villageMembers.villageId, villages.id), eq(villageMembers.userId, userId)))) : undefined))
    .orderBy(sql`${latest} desc nulls last`, desc(villageFollows.createdAt), sql`coalesce(${villages.slug}, ${profiles.handle})`, villages.id).limit(FOLLOWED_VILLAGES_MAX + 1).offset(((opts.page ?? 1) - 1) * FOLLOWED_VILLAGES_MAX);
  return rows.map(({ ownerHandle, ...row }) => ({ ...row, ...(row.kind === "personal" ? { slug: `@${ownerHandle}`, name: `@${ownerHandle}` } : {}), latestAt: row.latestAt ? new Date(row.latestAt) : null }));
}

export async function listFollowedVillages(db: Db, userId: string, opts: { excludeJoined?: boolean; page?: number } = {}): Promise<FollowedVillage[]> {
  return (await readFollowedVillages(db, userId, opts)).slice(0, FOLLOWED_VILLAGES_MAX);
}

export type FollowedVillageNavigation = Pick<PublicVillage, "name" | "slug" | "kind" | "language"> & WithVillageTranslation & { iconUrl?: string; moreLabel?: string };

// For the places list: the followed villages with names in the reader's language. `excludeJoined` leaves out the ones the member has also joined (they stand in the joined group).
export async function followedVillageNavigation(db: Db, userId: string, reader?: VillageReader, opts: { excludeJoined?: boolean; page?: number } = {}): Promise<FollowedVillageNavigation[]> {
  const followed = await listFollowedVillages(db, userId, opts);
  const rows: FollowedVillageNavigation[] = await withVillageIcons(db, await localizeVillages(db, followed.map(({ name, slug, kind, language }) => ({ name, slug, kind, language })), reader));
  // Keep the overflow label with the server-selected names; its translations need not travel in every page's scripts.
  for (const personal of [false, true]) {
    const group = rows.filter(row => (row.kind === "personal") === personal);
    if (group.length > FOLLOWED_NAVIGATION_VISIBLE) group[0].moreLabel = m.village_follow_more({ count: group.length - FOLLOWED_NAVIGATION_VISIBLE });
  }
  return rows;
}

// The slugs among `slugs` that the member follows (an ended or closed village never appears).
export async function followedAmong(db: Db, userId: string, slugs: readonly string[]): Promise<Set<string>> {
  if (!slugs.length) return new Set();
  const rows = await db.select({ slug: villages.slug }).from(villageFollows).innerJoin(villages, eq(villages.id, villageFollows.villageId))
    .where(and(eq(villageFollows.userId, userId), activeSharedVillageCondition(), inArray(villages.slug, [...slugs])));
  return new Set(rows.flatMap(row => row.slug ? [row.slug] : []));
}

// Whether the member follows or has joined at least one village that can be read (the home's "Following" list says what to do when there is none).
export async function hasVillagePlaces(db: Db, userId: string): Promise<boolean> {
  const [followed] = await db.select({ id: villageFollows.villageId }).from(villageFollows).innerJoin(villages, eq(villages.id, villageFollows.villageId))
    .where(and(eq(villageFollows.userId, userId), activePublicPostVillageCondition())).limit(1);
  if (followed) return true;
  const [joined] = await db.select({ id: villageMembers.villageId }).from(villageMembers).innerJoin(villages, eq(villages.id, villageMembers.villageId))
    .where(and(eq(villageMembers.userId, userId), activeSharedVillageCondition())).limit(1);
  return !!joined;
}
