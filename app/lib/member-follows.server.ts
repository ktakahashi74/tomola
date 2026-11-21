import { and, asc, desc, eq, ne } from "drizzle-orm";
import type { Db } from "./db/client.server";
import { memberFollows, profiles } from "./db/schema";
import { DELETED_MEMBER_ID } from "./deleted-member";
import { memberAvatarUrl } from "./member-avatar.server";
import { selectDisplayName } from "./display-names.server";
import { FOLLOWED_NAVIGATION_VISIBLE, FOLLOWED_VILLAGES_MAX } from "./village-follow-limits";
import { m } from "~/paraglide/messages.js";

type MemberFollowResult = { ok: true } | { ok: false; error: "not_found" };

export async function setMemberFollow(db: Db, followerId: string, targetUserId: string, follow: boolean): Promise<MemberFollowResult> {
  if (!follow) {
    await db.delete(memberFollows).where(and(eq(memberFollows.followerId, followerId), eq(memberFollows.followedId, targetUserId)));
    return { ok: true };
  }
  if (followerId === targetUserId || targetUserId === DELETED_MEMBER_ID) return { ok: false, error: "not_found" };
  return db.transaction(async tx => {
    const [target] = await tx.select({ id: profiles.userId }).from(profiles)
      .where(eq(profiles.userId, targetUserId)).for("key share");
    if (!target) return { ok: false, error: "not_found" };
    await tx.insert(memberFollows).values({ followerId, followedId: target.id }).onConflictDoNothing();
    return { ok: true };
  });
}

export async function isFollowingMember(db: Db, followerId: string, targetUserId: string): Promise<boolean> {
  const [row] = await db.select({ id: memberFollows.followedId }).from(memberFollows)
    .where(and(eq(memberFollows.followerId, followerId), eq(memberFollows.followedId, targetUserId)));
  return !!row;
}

export async function listFollowedMembers(db: Db, followerId: string) {
  return db.select({
    handle: profiles.handle, displayName: profiles.displayName, displayNameLatin: profiles.displayNameLatin,
    homeArea: profiles.homeArea, publicId: profiles.publicId, avatarMediaId: profiles.avatarMediaId, createdAt: memberFollows.createdAt,
  }).from(memberFollows).innerJoin(profiles, eq(profiles.userId, memberFollows.followedId))
    .where(and(eq(memberFollows.followerId, followerId), ne(profiles.userId, DELETED_MEMBER_ID)))
    .orderBy(desc(memberFollows.createdAt), asc(profiles.handle), asc(profiles.userId)).limit(FOLLOWED_VILLAGES_MAX);
}

export type FollowedMemberNavigation = { handle: string; name: string | null; avatarUrl?: string | null; moreLabel?: string };

export async function followedMemberNavigation(db: Db, followerId: string, locale?: string): Promise<FollowedMemberNavigation[]> {
  const members = await listFollowedMembers(db, followerId);
  const rows: FollowedMemberNavigation[] = members.map(member => ({ handle: member.handle, name: selectDisplayName(member, locale), avatarUrl: memberAvatarUrl(member) }));
  if (rows.length > FOLLOWED_NAVIGATION_VISIBLE) rows[0].moreLabel = m.village_follow_more({ count: rows.length - FOLLOWED_NAVIGATION_VISIBLE });
  return rows;
}
