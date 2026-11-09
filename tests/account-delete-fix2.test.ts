import { eq } from "drizzle-orm";
import { afterEach, expect, it } from "vitest";
import { accountDeletions, entries, user, villageMembers, villages } from "~/lib/db/schema";
import { completeAccountDeletion, requestAccountDeletion } from "~/lib/account-delete.server";
import { action } from "~/routes/settings-delete-account";
import { addMember, createTestDb } from "./helpers/db";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";

let h: RouteHarness | undefined;
afterEach(() => h?.restore());

it.each(["", undefined])("returns the unchosen sole-owned village field without deleting anything (%s)", async choice => {
  h = await setupRouteHarness();
  const owner = await h.signIn("quit_choose"), next = await h.signIn("quit_next");
  const [village] = await h.db.insert(villages).values({ name: "Choose an owner", slug: "quit-choose", kind: "invite_public", createdBy: owner }).returning();
  await h.db.insert(villageMembers).values([{ villageId: village.id, userId: owner, role: "owner" }, { villageId: village.id, userId: next, role: "member" }]);
  const form = { intent: "delete-account", confirmation: "quit_choose", ...(choice === undefined ? {} : { [`village:${village.id}`]: choice }) };
  const result = await h.outcome(() => action(h!.args(h!.request("/settings/delete-account", { as: "quit_choose", form }))));
  expect(result).toMatchObject({ status: 400, value: { data: { error: "village_required", villageErrors: [village.id] } } });
  expect(await h.db.select().from(user).where(eq(user.id, owner))).toHaveLength(1);
  expect((await h.db.select().from(villages).where(eq(villages.id, village.id)))[0].endedAt).toBeNull();
  expect(await h.db.select().from(accountDeletions)).toHaveLength(0);
});

it("replaces a stranded pending request after the post choice and village roster change", async () => {
  const db = await createTestDb();
  await addMember(db, "quit-pending", "quit_pending"); await addMember(db, "quit-new-owner", "quit_new_owner");
  const [village] = await db.insert(villages).values({ name: "Pending village", slug: "quit-pending", kind: "invite_public", createdBy: "quit-pending" }).returning();
  await db.insert(villageMembers).values({ villageId: village.id, userId: "quit-pending", role: "owner" });
  const [post] = await db.insert(entries).values({ kind: "topic", authorId: "quit-pending", body: "Pending post", lang: "en" }).returning();
  const id = await requestAccountDeletion(db, "quit-pending", { confirmation: "quit_pending", posts: "keep", villages: { [village.id]: "end" } });
  await db.insert(villageMembers).values({ villageId: village.id, userId: "quit-new-owner", role: "member" });
  const revised = { confirmation: "quit_pending", posts: "delete" as const, villages: { [village.id]: "member:quit-new-owner" } };
  expect(await requestAccountDeletion(db, "quit-pending", revised)).toBe(id);
  expect(await db.select().from(accountDeletions)).toMatchObject([{ id, state: "pending", posts: "delete", villageDecisions: revised.villages }]);
  await completeAccountDeletion(db, id);
  expect((await db.select().from(entries).where(eq(entries.id, post.id)))[0].deletedAt).not.toBeNull();
  expect((await db.select().from(villages).where(eq(villages.id, village.id)))[0].endedAt).toBeNull();
  expect(await db.select().from(villageMembers)).toMatchObject([{ userId: "quit-new-owner", role: "owner" }]);
});
