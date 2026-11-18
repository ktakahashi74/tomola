import { and, desc, eq, exists, gt, inArray, isNotNull, ne, not, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import type { Db } from "./db/client.server";
import { villageInvites, villageMembers } from "./db/schema";
import { VILLAGE_DECLINE_LIMIT, VILLAGE_INVITE_PAUSE_DAYS, VILLAGE_REINVITE_HOURS, type VillageInviteKind } from "./villages";

export const villageInviteOtherMember = (sender: string, target: string | AnyPgColumn) => sql<boolean>`${target} <> ${sender}`;

// Used with a locked recipient by the action, and a correlated profile by search.
export function villageInviteMembershipAllowed(db: Db, village: { id: string; kind: string }, target: string | AnyPgColumn, kind: VillageInviteKind) {
  const member = db.select({ id: villageMembers.userId }).from(villageMembers)
    .where(and(eq(villageMembers.villageId, village.id), eq(villageMembers.userId, target), kind === "owner" ? ne(villageMembers.role, "owner") : undefined));
  return kind === "join" ? and(sql`${village.kind} = 'invite_public'`, not(exists(member)))! : exists(member);
}

export function villageInvitePairRestrictions(db: Db, sender: string, target: string | AnyPgColumn, now: Date) {
  const history = db.select({ state: villageInvites.state, at: villageInvites.respondedAt, event: villageInvites.responseEventId }).from(villageInvites)
    .where(and(eq(villageInvites.invitedBy, sender), eq(villageInvites.userId, target), inArray(villageInvites.state, ["accepted", "declined"]), isNotNull(villageInvites.respondedAt)))
    .orderBy(desc(villageInvites.responseEventId)).limit(VILLAGE_DECLINE_LIMIT).as("invite_history");
  // Event order, including ties and nulls, is the same as the invitation action's history.
  const paused = sql<boolean>`(select count(*) = ${VILLAGE_DECLINE_LIMIT} and bool_and(${history.state} = 'declined')
    and (array_agg(${history.at} order by ${history.event} desc))[1] > ${new Date(now.getTime() - VILLAGE_INVITE_PAUSE_DAYS * 86400000).toISOString()} from ${history})`;
  const waiting = exists(db.select({ id: villageInvites.id }).from(villageInvites)
    .where(and(eq(villageInvites.invitedBy, sender), eq(villageInvites.userId, target), inArray(villageInvites.state, ["cancelled", "declined"]),
      gt(villageInvites.respondedAt, new Date(now.getTime() - VILLAGE_REINVITE_HOURS * 3600000)))));
  return { paused, waiting };
}
