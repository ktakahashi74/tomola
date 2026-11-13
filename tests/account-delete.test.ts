import { eq, sql } from "drizzle-orm";
import { expect, it } from "vitest";
import { accountDeletions, chatMessages, chatReportSnapshots, entries, entryRevisions, invitations, invitationNoteTranslations, jobs, profiles, reports, session, user, verification, villageMembers, villages } from "~/lib/db/schema";
import { readInvitationNote, saveInvitationNoteTranslation } from "~/lib/invitation-note.server";
import { rememberSignupInvitation } from "~/lib/signup-village.server";
import { deleteAccount, completeAccountDeletion, cancelAccountDeletion, requestAccountDeletion } from "~/lib/account-delete.server";
import { DELETED_MEMBER_ID } from "~/lib/deleted-member";
import { createInvitation, findValidInvitationByToken, markInvitationUsed } from "~/lib/invitations.server";
import { runMaintenanceCleanup } from "~/lib/jobs/maintenance-jobs.server";
import { addMember, createTestDb } from "./helpers/db";

const NOW = new Date("2030-03-31T12:00:00Z");
async function world() {
  const db = await createTestDb();
  await addMember(db, "quit-a", "quitter_a");
  await addMember(db, "quit-b", "quitter_b");
  const [post] = await db.insert(entries).values({ kind: "topic", authorId: "quit-a", lang: "en", body: "Keep the discussion", title: "A question" }).returning();
  await db.insert(entryRevisions).values({ entryId: post.id, body: "Earlier wording", editorId: "quit-a" });
  await db.insert(session).values({ id: "old-session", token: "old-token", userId: "quit-a", updatedAt: NOW, expiresAt: new Date("2031-01-01") });
  const [village] = await db.insert(villages).values({ name: "Quit fixture", slug: "quit-fixture", kind: "invite_public", createdBy: "quit-a" }).returning();
  await db.insert(villageMembers).values({ villageId: village.id, userId: "quit-a", role: "owner" });
  const [chat] = await db.insert(chatMessages).values({ villageId: village.id, authorId: "quit-a", body: "Private chat", lang: "en", createdSeq: 1, changedSeq: 1 }).returning();
  await db.insert(reports).values({ chatMessageId: chat.id, chatLang: "en", chatAuthorId: "quit-a", reporterId: "quit-b", reason: "other" });
  await db.insert(chatReportSnapshots).values({ messageId: chat.id, body: "Frozen evidence", lang: "en", authorId: "quit-a", authorHandle: "quitter_a", messageCreatedAt: NOW, createdSeq: 1, changedSeq: 1 });
  return { db, post, village, chat };
}

it("requires a decision even when an operator omits the village map", async () => {
  const w = await world();
  await w.db.insert(villageMembers).values({ villageId: w.village.id, userId: "quit-b" });
  await expect(deleteAccount(w.db, "quit-a", { confirmation: "quitter_a" })).rejects.toMatchObject({ code: "village_required", villageIds: [w.village.id] });
  expect(await w.db.select().from(accountDeletions)).toEqual([]);
  expect(await w.db.select().from(user).where(eq(user.id, "quit-a"))).toHaveLength(1);
  expect((await w.db.select().from(villages).where(eq(villages.id, w.village.id)))[0].endedAt).toBeNull();
  expect((await w.db.select().from(chatMessages))[0].body).toBe("Private chat");
});

it("erases invitation notes, translations and paid checkpoints in the deletion transaction and rejects late saves", async () => {
  const w = await world();
  const made = await createInvitation(w.db, { email: "note-recipient@example.com", createdBy: "quit-a", note: "招待の一言。" });
  const invitation = (await findValidInvitationByToken(w.db, made.token))!;
  await readInvitationNote(w.db, invitation.id, "en");
  await readInvitationNote(w.db, invitation.id, "fr");
  await w.db.update(jobs).set({ status: "running", payload: { invitationId: invitation.id, lang: "en", paidTranslationCalls: { saved: { result: { text: "private output" } } } } }).where(eq(jobs.dedupeKey, `invitation-note:${invitation.id}:en`));
  await w.db.insert(jobs).values({ kind: "translate_invitation_note", status: "failed", payload: { invitationId: invitation.id, lang: "de", paidTranslationCalls: { private: true } } });
  const other = await createInvitation(w.db, { email: "other-recipient@example.com", createdBy: "quit-b", note: "残す一言。" });
  const otherInvitation = (await findValidInvitationByToken(w.db, other.token))!;
  await readInvitationNote(w.db, otherInvitation.id, "en");
  await deleteAccount(w.db, "quit-a", { confirmation: "quitter_a" });
  expect((await w.db.select().from(invitations).where(eq(invitations.id, invitation.id)))[0]).toMatchObject({ note: null, noteLang: null, createdBy: null });
  expect(await w.db.select().from(invitationNoteTranslations).where(eq(invitationNoteTranslations.invitationId, invitation.id))).toEqual([]);
  const work = await w.db.select().from(jobs).where(sql`${jobs.payload}->>'invitationId' = ${invitation.id}`);
  expect(work.map(row => row.status).sort()).toEqual(["failed", "running"]);
  expect(work.find(row => row.status === "running")!.payload).toEqual({ invitationId: invitation.id, lang: "en", discardPaidTranslationCalls: true });
  expect(JSON.stringify(work)).not.toContain("paidTranslationCalls");
  await saveInvitationNoteTranslation(w.db, { invitationId: invitation.id, lang: "en" }, { state: "ready", text: "late response" });
  expect(await readInvitationNote(w.db, invitation.id, "en")).toBeNull();
  expect(await w.db.select().from(invitationNoteTranslations).where(eq(invitationNoteTranslations.invitationId, invitation.id))).toEqual([]);
  expect(await readInvitationNote(w.db, otherInvitation.id, "en")).toMatchObject({ pending: true });
});

it("keeps posts under one shared identity, removes credentials and private membership, always erases chat, and preserves evidence", async () => {
  const w = await world();
  await w.db.update(profiles).set({ colorScheme: "dark" }).where(eq(profiles.userId, "quit-a"));
  const result = await deleteAccount(w.db, "quit-a", { confirmation: "quitter_a" }, { now: NOW });
  expect(result.ok).toBe(true);
  expect(await w.db.select().from(user).where(eq(user.id, "quit-a"))).toEqual([]);
  expect(await w.db.select().from(profiles).where(eq(profiles.userId, "quit-a"))).toEqual([]);
  expect(await w.db.select().from(session)).toEqual([]);
  expect((await w.db.select().from(entries))[0]).toMatchObject({ authorId: DELETED_MEMBER_ID, body: "Keep the discussion", deletedAt: null, authorArea: null });
  expect((await w.db.select().from(entryRevisions))[0].editorId).toBe(DELETED_MEMBER_ID);
  expect((await w.db.select().from(chatMessages))[0]).toMatchObject({ authorId: DELETED_MEMBER_ID, body: "", deletedAt: expect.any(Date) });
  expect((await w.db.select().from(chatReportSnapshots))[0]).toMatchObject({ body: "Frozen evidence", authorId: DELETED_MEMBER_ID });
  expect(await w.db.select().from(villageMembers)).toEqual([]);
  expect((await w.db.select().from(villages).where(eq(villages.id, w.village.id)))[0].endedAt).not.toBeNull();
  expect((await w.db.select().from(accountDeletions))[0]).toMatchObject({ state: "completed", userId: null, posts: "keep" });
  // Two departed people must not acquire different substitute identities.
  await w.db.insert(entries).values({ kind: "topic", authorId: "quit-b", body: "Another member", lang: "en" });
  await deleteAccount(w.db, "quit-b", { confirmation: "quitter_b" }, { now: NOW });
  expect(new Set((await w.db.select().from(entries)).map(row => row.authorId))).toEqual(new Set([DELETED_MEMBER_ID]));
});

it("hides selected posts immediately and erases text and revisions through retention", async () => {
  const w = await world();
  await deleteAccount(w.db, "quit-a", { confirmation: "quitter_a", posts: "delete" }, { now: NOW });
  expect((await w.db.select().from(entries))[0]).toMatchObject({ deletedAt: NOW, body: "Keep the discussion" });
  await runMaintenanceCleanup(w.db, new Date(NOW.getTime() + 31 * 86_400_000));
  expect((await w.db.select().from(entries))[0].body).toBe("");
  expect(await w.db.select().from(entryRevisions)).toEqual([]);
});

it("erases the departed member's hashed signup association while keeping another member's", async () => {
  const w = await world();
  const associations = new Map<string, string>();
  for (const id of ["quit-a", "quit-b"]) {
    const created = await createInvitation(w.db, { email: `${id}@example.com`, createdBy: "quit-b", villageId: w.village.id });
    const invitation = (await findValidInvitationByToken(w.db, created.token))!;
    associations.set(id, invitation.id);
    await markInvitationUsed(w.db, `${id}@example.com`, { usedBy: id, invitationId: invitation.id });
    await rememberSignupInvitation(w.db, id, invitation.id);
  }
  const before = await w.db.select().from(verification);
  expect(before).toHaveLength(2);
  await deleteAccount(w.db, "quit-a", { confirmation: "quitter_a" }, { now: NOW });
  const remaining = await w.db.select().from(verification);
  expect(remaining).toHaveLength(1);
  expect(remaining[0].value).toBe(associations.get("quit-b"));
});

it("rejects a wrong confirmation and preserves a suspended address only as an expiring hash", async () => {
  const w = await world();
  await expect(deleteAccount(w.db, "quit-a", { confirmation: "wrong" }, { now: NOW })).rejects.toThrow();
  expect(await w.db.select().from(user).where(eq(user.id, "quit-a"))).toHaveLength(1);
  await w.db.update(profiles).set({ suspendedUntil: new Date("2031-01-01"), suspendedReason: "spam" }).where(eq(profiles.userId, "quit-a"));
  await deleteAccount(w.db, "quit-a", { confirmation: "quitter_a" }, { now: NOW });
  expect(await createInvitation(w.db, { email: "quit-a@example.com", now: NOW })).toMatchObject({ email: "quit-a@example.com" });
  const invitation = await createInvitation(w.db, { email: "quit-a@example.com", now: new Date("2031-04-01") });
  expect(invitation.email).toBe("quit-a@example.com");
});

it("rolls back a failed deletion, records the stop, resumes once, and permits cancelling an unstarted request", async () => {
  const w = await world();
  const made = await createInvitation(w.db, { email: "rollback-note@example.com", createdBy: "quit-a", note: "取引と一緒に消す一言。" });
  const invitation = (await findValidInvitationByToken(w.db, made.token))!;
  await readInvitationNote(w.db, invitation.id, "en");
  const id = await requestAccountDeletion(w.db, "quit-a", { confirmation: "quitter_a" }, NOW);
  await w.db.execute(sql`create function interrupt_deletion() returns trigger language plpgsql as $$ begin raise exception 'Injected stop'; end $$`);
  await w.db.execute(sql`create trigger interrupt_deletion before delete on "user" for each row execute function interrupt_deletion()`);
  await expect(completeAccountDeletion(w.db, id, { now: NOW })).rejects.toThrow();
  await w.db.execute(sql`drop trigger interrupt_deletion on "user"`);
  expect((await w.db.select().from(accountDeletions).where(eq(accountDeletions.id, id)))[0].state).toBe("failed");
  expect(await w.db.select().from(user).where(eq(user.id, "quit-a"))).toHaveLength(1);
  expect((await w.db.select().from(chatMessages))[0].body).toBe("Private chat");
  expect((await w.db.select().from(invitations).where(eq(invitations.id, invitation.id)))[0].note).not.toBeNull();
  expect(await w.db.select().from(invitationNoteTranslations).where(eq(invitationNoteTranslations.invitationId, invitation.id))).toHaveLength(1);
  await completeAccountDeletion(w.db, id, { now: NOW });
  expect((await w.db.select().from(invitations).where(eq(invitations.id, invitation.id)))[0].note).toBeNull();
  expect(await w.db.select().from(invitationNoteTranslations).where(eq(invitationNoteTranslations.invitationId, invitation.id))).toEqual([]);
  await completeAccountDeletion(w.db, id, { now: NOW });
  expect(await w.db.select().from(accountDeletions).where(eq(accountDeletions.state, "completed"))).toHaveLength(1);
  const cancelled = await requestAccountDeletion(w.db, "quit-b", { confirmation: "quitter_b" }, NOW);
  await cancelAccountDeletion(w.db, cancelled, NOW);
  await expect(completeAccountDeletion(w.db, cancelled, { now: NOW })).rejects.toThrow();
  expect(await w.db.select().from(user).where(eq(user.id, "quit-b"))).toHaveLength(1);
});

it.each(["transfer", "end"])("uses the confirmed %s choice for a co-owned village", async decision => {
  const w = await world();
  await w.db.insert(villageMembers).values({ villageId: w.village.id, userId: "quit-b", role: "owner" });
  await deleteAccount(w.db, "quit-a", { confirmation: "quitter_a", villages: { [w.village.id]: decision } }, { now: NOW });
  const [village] = await w.db.select().from(villages).where(eq(villages.id, w.village.id));
  expect(village.endedAt === null).toBe(decision === "transfer");
  expect((await w.db.select().from(villageMembers))[0]).toMatchObject({ userId: "quit-b", role: "owner" });
});

it("stops without changes when ownership changed after confirmation", async () => {
  const w = await world();
  await w.db.insert(villageMembers).values({ villageId: w.village.id, userId: "quit-b", role: "owner" });
  const id = await requestAccountDeletion(w.db, "quit-a", { confirmation: "quitter_a", villages: { [w.village.id]: "transfer" } }, NOW);
  await w.db.delete(villageMembers).where(eq(villageMembers.userId, "quit-b"));
  await expect(completeAccountDeletion(w.db, id, { now: NOW })).rejects.toMatchObject({ code: "village_changed" });
  expect((await w.db.select().from(chatMessages))[0].body).toBe("Private chat");
  expect((await w.db.select().from(villages).where(eq(villages.id, w.village.id)))[0].endedAt).toBeNull();
});

it("preserves moderation, appeals and audit FKs, clears personal copies, and keeps only referenced image bytes", async () => {
  const w = await world();
  const s = await import("~/lib/db/schema");
  const used = "1".repeat(64), unused = "2".repeat(64);
  await w.db.insert(s.media).values([used, unused].map(id => ({ id, bytes: Buffer.from([1]), mime: "image/webp", width: 1, height: 1, byteSize: 1, uploadedBy: "quit-a" })));
  await w.db.insert(s.entryMedia).values({ entryId: w.post.id, mediaId: used });
  await w.db.insert(s.entryMentionSnapshots).values({ entryId: w.post.id, revision: 0, body: "Private copy", bindings: [] });
  const [other] = await w.db.insert(entries).values({ kind: "topic", authorId: "quit-b", body: "@quitter_a", lang: "en" }).returning();
  await w.db.insert(s.entryMentionSnapshots).values({ entryId: other.id, revision: 0, body: "@quitter_a", bindings: [{ spelling: "quitter_a", prefix: null, userId: "quit-a" }] });
  await w.db.insert(s.drafts).values({ authorId: "quit-a", kind: "topic", body: "Private draft", lang: "en" });
  await w.db.insert(s.memberSignatures).values({ userId: "quit-a", entryId: w.post.id, operation: "create-topic", payload: "Identifying payload", payloadHash: "h", challenge: "unique", credentialId: "credential", publicKey: "public", rpId: "localhost", origin: "http://localhost:5173", assertion: {}, authenticatorData: "a", clientDataJson: "c", signature: "s" });
  await w.db.insert(s.passkeyRecoveries).values({ userId: "quit-a", operatorId: "quit-b", note: "Private recovery", expiresAt: NOW });
  const [action] = await w.db.insert(s.moderationActions).values({ action: "hide", targetEntryId: w.post.id, actorId: "quit-a", reason: "other" }).returning();
  await w.db.insert(s.appeals).values(["quit-a", "quit-b"].map(appellantId => ({ actionId: action.id, appellantId, text: "Please review" })));
  await w.db.insert(reports).values({ chatMessageId: w.chat.id, chatLang: "en", chatAuthorId: "quit-a", reporterId: "quit-a", reason: "other" });
  const [report] = await w.db.select().from(reports);
  await w.db.insert(s.chatAccessLog).values({ readerId: "quit-a", readerHandle: "quitter_a", reportId: report.id, villageId: w.village.id, kind: "context", fromSeq: 0, toSeq: 0, ranges: [], versions: [], reason: "Review" });
  await w.db.insert(s.villageEvents).values({ villageId: w.village.id, actorId: "quit-a", actorHandle: "quitter_a", action: "edit", detail: { member: "quitter_a" } });
  await w.db.insert(s.notifications).values({ userId: "quit-a", kind: "mention" });
  await w.db.insert(s.verification).values({ id: "old-link", identifier: "magic-link:oldhash", value: JSON.stringify({ email: "quit-a@example.com" }), expiresAt: NOW });
  await deleteAccount(w.db, "quit-a", { confirmation: "quitter_a" }, { now: NOW });
  expect((await w.db.select().from(s.media).where(eq(s.media.id, used)))[0].bytes).not.toBeNull();
  expect((await w.db.select().from(s.media).where(eq(s.media.id, unused)))[0]).toMatchObject({ bytes: null, deletedAt: NOW, uploadedBy: DELETED_MEMBER_ID });
  expect(await w.db.select().from(s.memberSignatures)).toEqual([]);
  expect(await w.db.select().from(s.passkeyRecoveries)).toEqual([]);
  expect(await w.db.select().from(s.drafts)).toEqual([]);
  expect(await w.db.select().from(s.notifications)).toEqual([]);
  expect(await w.db.select().from(s.verification)).toEqual([]);
  expect((await w.db.select().from(s.entryMentionSnapshots).where(eq(s.entryMentionSnapshots.entryId, other.id)))[0].bindings[0].userId).toBeNull();
  expect((await w.db.select().from(s.chatAccessLog))[0]).toMatchObject({ readerId: null, readerHandle: "[deleted]" });
  expect((await w.db.select().from(s.moderationActions))[0].actorId).toBe(DELETED_MEMBER_ID);
  expect(JSON.stringify(await w.db.select().from(s.villageEvents))).not.toContain("quitter_a");
  await deleteAccount(w.db, "quit-b", { confirmation: "quitter_b" }, { now: NOW });
  expect(await w.db.select().from(s.appeals)).toHaveLength(2);
  expect((await w.db.select().from(s.appeals)).every(row => row.appellantId === null)).toBe(true);
  expect(await w.db.select().from(reports)).toHaveLength(2);
  expect((await w.db.select().from(reports)).every(row => row.reporterId === null)).toBe(true);
});

it("recognizes a committed deletion when the completion acknowledgement is lost", async () => {
  const w = await world();
  const result = await deleteAccount(w.db, "quit-a", { confirmation: "quitter_a" }, { now: NOW, execute: async mutate => {
    await w.db.transaction(mutate);
    throw new Error("Lost commit acknowledgement");
  } });
  expect(result.ok).toBe(true);
  expect(await w.db.select().from(user).where(eq(user.id, "quit-a"))).toEqual([]);
  expect(await w.db.select().from(accountDeletions).where(eq(accountDeletions.state, "completed"))).toHaveLength(1);
});

it("closes an already open chat event stream when leaving an account in a co-owned village", async () => {
  const w = await world();
  const { villageChatEventStream } = await import("~/lib/village-chat-events.server");
  await w.db.insert(villageMembers).values({ villageId: w.village.id, userId: "quit-b", role: "owner" });
  const signal = new AbortController();
  const response = villageChatEventStream(w.village.id, "quit-a", 1, signal.signal);
  const reader = response.body!.getReader();
  await reader.read();
  try {
    await deleteAccount(w.db, "quit-a", { confirmation: "quitter_a" }, { now: NOW });
    for (let i = 0; i < 5; i++) if ((await reader.read()).done) return;
    throw new Error("Deleted member's stream stayed open");
  } finally { signal.abort(); await reader.cancel(); }
});

it("keeps departed members' entry and chat appeals reviewable without sending them notifications", async () => {
  const w = await world();
  const s = await import("~/lib/db/schema");
  const { listOpenAppeals, decideAppeal } = await import("~/lib/appeals.server");
  await addMember(w.db, "quit-reviewer", "quit_reviewer");
  const [postAction] = await w.db.insert(s.moderationActions).values({ action: "hide", targetEntryId: w.post.id, actorId: "quit-b", reason: "other" }).returning();
  const [chatAction] = await w.db.insert(s.moderationActions).values({ action: "hide_chat", targetChatMessageId: w.chat.id, actorId: "quit-b", reason: "other" }).returning();
  await w.db.insert(s.appeals).values([postAction, chatAction].map(action => ({ actionId: action.id, appellantId: "quit-a", text: "Please review" })));
  await deleteAccount(w.db, "quit-a", { confirmation: "quitter_a" }, { now: NOW });
  const reviewer = { id: "quit-reviewer", scope: { operator: true, langs: [] } };
  const queue = await listOpenAppeals(w.db, reviewer);
  expect(queue.cards).toHaveLength(2);
  for (const appeal of await w.db.select().from(s.appeals)) expect((await decideAppeal(w.db, reviewer, appeal.id, { decision: "upheld", note: "Reviewed evidence" })).ok).toBe(true);
  expect(await w.db.select().from(s.notifications)).toEqual([]);
});
