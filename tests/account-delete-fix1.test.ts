import { eq, sql } from "drizzle-orm";
import { afterEach, expect, it, vi } from "vitest";
import { entries, entryRevisions, entryMentionSnapshots, handleHolds, notifications, profiles, session, suspendedEmailHashes, user, villageMembers, villages } from "~/lib/db/schema";
import { deleteAccount } from "~/lib/account-delete.server";
import { DELETED_MEMBER_ID } from "~/lib/deleted-member";
import { backfillMentionSnapshots } from "~/lib/mentions.server";
import { changeHandle, createProfile, HANDLE_CHANGE_DAYS } from "~/lib/profiles.server";
import { createInvitation, markInvitationUsed } from "~/lib/invitations.server";
import { suspendedEmailHash } from "~/lib/suspended-email.server";
import { action as invite } from "~/routes/invites-new";
import { action as withdraw, loader } from "~/routes/settings-delete-account";
import { addMember, createTestDb } from "./helpers/db";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";
let h: RouteHarness | undefined;
afterEach(() => h?.restore());

it("preserves frozen mention targets in retained posts and revisions across backfill and name reuse", async () => {
  const db = await createTestDb();
  await addMember(db,"quit-source","quit_source");await addMember(db,"quit-target","quit_target");
  const [p] = await db.insert(entries).values({kind:"topic",authorId:"quit-source",body:"@quit_target @quit_source",lang:"en"}).returning();
  await db.insert(entryRevisions).values({entryId:p.id,body:"Earlier @quit_target @quit_source",mentionRevision:1,editorId:"quit-source"});
  await backfillMentionSnapshots(db);
  const before = (await db.select().from(entryMentionSnapshots))[0];
  expect(before.bindings.some(b=>b.userId==="quit-target")).toBe(true);
  const now=new Date();await changeHandle(db,"quit-target","quit_renamed",{now});
  await deleteAccount(db,"quit-source",{confirmation:"quit_source"},{now});
  await db.delete(handleHolds);await addMember(db,"quit-reuser","quit_target");await addMember(db,"quit-self-reuser","quit_source");
  await backfillMentionSnapshots(db);
  const snapshots=await db.select().from(entryMentionSnapshots).where(eq(entryMentionSnapshots.entryId,p.id));
  expect(snapshots).toHaveLength(2);
  for (const saved of snapshots) {
    expect(saved.bindings.find(b=>b.spelling===before.bindings.find(b=>b.userId==="quit-target")!.spelling)?.userId).toBe("quit-target");
    expect(saved.bindings.find(b=>b.spelling===before.bindings.find(b=>b.userId==="quit-source")!.spelling)?.userId).toBeNull();
  }
});

it("creates an indistinguishable invitation for a suspended former address but will not consume it", async () => {
  h=await setupRouteHarness();await h.signIn("quit_inviter");
  await h.db.insert(suspendedEmailHashes).values({hash:suspendedEmailHash("held@example.com"),expiresAt:new Date(Date.now()+86400000)});
  for (const email of ["ordinary@example.com","held@example.com"]) {
    const result=await h.outcome(()=>invite(h!.args(h!.request("/invites/new",{as:"quit_inviter",form:{email}}))));
    expect(result.status).toBe(200);expect(result.value).toMatchObject({url:expect.any(String),error:null});
  }
  expect(await markInvitationUsed(h.db,"held@example.com")).toBe(0);
});

it.each([false,true])("requires a fresh login for deletion (signing %s)", async signPosts => {
  h=await setupRouteHarness();const id=await h.signIn("quit_stale");
  await h.db.update(profiles).set({signPosts}).where(eq(profiles.userId,id));
  await h.db.update(session).set({createdAt:new Date(Date.now()-25*3600000)}).where(eq(session.userId,id));
  for(const run of [()=>loader(h!.args(h!.request("/settings/delete-account",{as:"quit_stale"}))),()=>withdraw(h!.args(h!.request("/settings/delete-account",{as:"quit_stale",form:{intent:"delete-account",confirmation:"quit_stale"}})))]) {
    const result=await h.outcome(run);expect(result.location).toContain("/login?reauth=1");
  }
  expect(await h.db.select().from(user).where(eq(user.id,id))).toHaveLength(1);
});

it("preserves current and previous handle holds anonymously for the rename period", async () => {
  const db=await createTestDb();await addMember(db,"quit-holds","quit_old");await addMember(db,"other-holds","quit_other");
  const now=new Date();await changeHandle(db,"quit-holds","quit_current",{now});
  await deleteAccount(db,"quit-holds",{confirmation:"quit_current"},{now});
  const holds=await db.select().from(handleHolds);expect(holds).toHaveLength(2);
  for(const row of holds){expect(row.userId).toBeNull();expect(row.heldUntil.getTime()).toBe(now.getTime()+HANDLE_CHANGE_DAYS*86400000);}
  for(const handle of ["quit_old","quit_current"])expect(await changeHandle(db,"other-holds",handle,{now})).toMatchObject({ok:false,error:"handle_taken"});
});

it("transfers a sole-owned village to the chosen member and notifies that new owner", async () => {
  const db=await createTestDb();await addMember(db,"quit-owner","quit_owner");await addMember(db,"quit-next","quit_next");
  const [v]=await db.insert(villages).values({name:"Transfer village",slug:"quit-transfer",kind:"open",createdBy:"quit-owner"}).returning();
  await db.insert(villageMembers).values([{villageId:v.id,userId:"quit-owner",role:"owner"},{villageId:v.id,userId:"quit-next",role:"member"}]);
  await deleteAccount(db,"quit-owner",{confirmation:"quit_owner",villages:{[v.id]:"member:quit-next"}});
  expect((await db.select().from(villages))[0].endedAt).toBeNull();
  expect((await db.select().from(villageMembers))[0]).toMatchObject({userId:"quit-next",role:"owner"});
  expect(await db.select().from(notifications)).toEqual(expect.arrayContaining([expect.objectContaining({userId:"quit-next",villageId:v.id})]));
});
