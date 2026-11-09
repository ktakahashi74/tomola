import { and, eq, sql } from "drizzle-orm";
import type { Db } from "~/lib/db/client.server";
import { villageInvites } from "~/lib/db/schema";

// Caller holds the village lock. Reconcile historical departures and deleted
// senders as well as the membership change in the current transaction.
export async function cancelUnavailableVillageInvites(db: Db, villageId: string, now = new Date()): Promise<void> {
  await db.update(villageInvites).set({ state: "cancelled", respondedAt: now }).where(and(
    eq(villageInvites.villageId, villageId), eq(villageInvites.state, "pending"),
    sql`not exists (select 1 from village_members as invite_owner where invite_owner.village_id = ${villageInvites.villageId} and invite_owner.user_id = ${villageInvites.invitedBy} and invite_owner.role = 'owner')`,
  ));
}
