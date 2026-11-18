import { eq } from "drizzle-orm";
import type { Db } from "../app/lib/db/client.server";
import { profiles, villageMembers, villages } from "../app/lib/db/schema";
import { villagesEnabled } from "../app/lib/villages-enabled.server";

export async function seedVillageInviteSuggestions(db: Db) {
  if (!villagesEnabled()) return;
  for (const scenario of ["keys", "native", "race"]) {
    const [owner] = await db.select().from(profiles).where(eq(profiles.handle, `zis_${scenario}_owner`));
    const [village] = await db.insert(villages).values({ slug: `invite-suggest-${scenario}`, kind: "invite_public", name: `Invitation suggestions ${scenario}` }).returning();
    await db.insert(villageMembers).values({ villageId: village.id, userId: owner.userId, role: "owner" });
  }
  for (const [handle, displayName] of [["zis_candidate_a", "Zinnia Cedar"], ["zis_candidate_b", "Zinnia Elm"], ["zis_race_target", "Zinnia Willow"]]) {
    await db.update(profiles).set({ displayName }).where(eq(profiles.handle, handle));
  }
}
