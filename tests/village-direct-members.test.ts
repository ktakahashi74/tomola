import { afterEach, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { addMember, createTestDb } from "./helpers/db";
import { notifications, profiles, villageDepartures, villageInvites, villageMembers } from "~/lib/db/schema";
import { createTopic, getThread } from "~/lib/entries.server";
import { changeVillageMembership, ensureLanguageVillages, villageBySlug } from "~/lib/villages.server";
import { createVillage, inviteToVillage, removeVillageMember, respondToVillageInvite } from "~/lib/village-management.server";
import { VILLAGE_REMOVAL_REASON_MAX } from "~/lib/villages";

afterEach(() => vi.unstubAllEnvs());
async function world() {
  vi.stubEnv("VILLAGES", "1"); vi.stubEnv("ENABLED_LANGS", "en,ja");
  const db = await createTestDb(); await ensureLanguageVillages(db);
  for (const id of ["owner", "guest", "second"]) await addMember(db, id, `direct_${id}`, { homeArea: "en" });
  await createVillage(db, "owner", { slug: "direct-club", name: "Club", description: "", kind: "invite_public" });
  const village = (await villageBySlug(db, "direct-club"))!;
  await db.insert(villageMembers).values({ villageId: village.id, userId: "guest" });
  return { db, village };
}

it("refuses removal of a co-owner but permits voluntary departure", async () => {
  const { db, village } = await world();
  await db.insert(villageMembers).values({ villageId: village.id, userId: "second", role: "owner" });
  const before = await db.select().from(villageMembers);
  expect(await removeVillageMember(db, "owner", "direct-club", "direct_second", "")).toMatchObject({ error: "forbidden" });
  expect(await db.select().from(villageMembers)).toEqual(before);
  expect(await db.select().from(notifications)).toEqual([]);
  expect(await changeVillageMembership(db, "second", "direct-club", "leave")).toBe(true);
});

it("requires acceptance to return after departure, even after owner and handle changes", async () => {
  const { db, village } = await world();
  expect(await changeVillageMembership(db, "guest", "direct-club", "leave")).toBe(true);
  await db.insert(villageMembers).values({ villageId: village.id, userId: "second", role: "owner" });
  await db.update(profiles).set({ handle: "renamed_guest", handleKey: "renamed_guest" }).where(eq(profiles.userId, "guest"));
  expect(await inviteToVillage(db, "second", "direct-club", "renamed_guest", "join")).toMatchObject({ ok: true });
  const [invite] = await db.select().from(villageInvites).where(eq(villageInvites.userId, "guest"));
  expect(await db.select().from(villageMembers).where(and(eq(villageMembers.villageId, village.id), eq(villageMembers.userId, "guest")))).toEqual([]);
  expect(await respondToVillageInvite(db, "guest", "direct-club", invite.id, "accepted")).toMatchObject({ ok: true });
  expect(await db.select().from(villageDepartures).where(eq(villageDepartures.userId, "guest"))).toHaveLength(1);
});

it("removes without a reason, keeps posts and cancels pending ownership invitations", async () => {
  const { db, village } = await world();
  expect(await inviteToVillage(db, "owner", "direct-club", "direct_guest", "owner")).toMatchObject({ ok: true });
  const [pending] = await db.select().from(villageInvites);
  const topic = await createTopic(db, "guest", { body: "Kept public article.", lang: "en", village: "direct-club" });
  if (!topic.ok) throw new Error(topic.error);
  expect(await removeVillageMember(db, "owner", "direct-club", "direct_guest", "x".repeat(VILLAGE_REMOVAL_REASON_MAX + 1))).toMatchObject({ error: "invalid" });
  expect(await removeVillageMember(db, "owner", "direct-club", "direct_guest", null)).toMatchObject({ ok: true });
  expect((await getThread(db, topic.id))?.topic.id).toBe(topic.id);
  expect(await db.select().from(villageDepartures)).toEqual([]);
  expect(await respondToVillageInvite(db, "guest", "direct-club", pending.id, "accepted")).toMatchObject({ error: "not_found" });
  expect(await db.select().from(villageMembers).where(and(eq(villageMembers.villageId, village.id), eq(villageMembers.userId, "guest")))).toEqual([]);
});
