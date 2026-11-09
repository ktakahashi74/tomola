import { stopPush } from "./push/subscriptions.server";
import { lockFigureMedia } from "./figure-translation.server";
import { endPersonalVillage } from "./personal-villages.server";
import { createHmac, randomUUID } from "node:crypto";
import { signupInvitationIdentifier } from "./signup-village.server";
import { and, eq, inArray, is, isNotNull, isNull, or, sql } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import type { Db } from "./db/client.server";
import * as schema from "./db/schema";
import { accountDeletions, chatAccessLog, chatMessages, chatReportSnapshots, chatTranslationReports, entries, entryMedia, entryMentionSnapshots, invitations, invitationNoteTranslations, jobs, media, memberSignatures, moderationActions, notifications, profiles, reports, suspendedEmailHashes, translations, user, verification, villageEvents, villageInvites, villageMembers, villages } from "./db/schema";
import { discardPaidTranslationCalls } from "./jobs/paid-translation.server";
import { TRANSLATE_INVITATION_NOTE_JOB } from "./invitation-note.server";
import { DELETED_MEMBER_EMAIL, DELETED_MEMBER_HANDLE, DELETED_MEMBER_ID, isDeletedIdentity } from "./deleted-member";
import { revokeAllCredentials } from "./auth/revoke-credentials.server";
import { addressHasher } from "./auth/magic-link.server";
import { authSecret } from "./auth/secret.server";
import { lockHandleNamespace, reserveDepartingHandles } from "./profiles.server";
import { enqueueImmediateEmails } from "./notifications.server";
import { deleteAllStanceRecords } from "./stances.server";
import { softDeleteEntry } from "./entries.server";
import { deleteChatRows } from "./village-chat-delete.server";
import { closeMemberChatConnections, closeVillageChatConnections, signalVillageChat } from "./village-chat-events.server";
import { RETENTION, monthsBefore } from "./retention";
import { suspendedEmailHash } from "./suspended-email.server";
import { enqueue } from "./jobs/queue.server";
import { SEND_ACCOUNT_DELETED_JOB } from "./jobs/mail-kinds";

export type AccountDeletionInput = { confirmation: string; posts?: "keep" | "delete"; villages?: Record<string, string> };
export class AccountDeletionError extends Error {
  constructor(readonly code: "confirmation" | "invalid" | "not_found" | "cancelled" | "village_changed" | "village_required", readonly villageIds: string[] = []) { super(code); }
}
function fail(code: AccountDeletionError["code"]): never { throw new AccountDeletionError(code); }
function sameVillageDecisions(a: Record<string, string>, b: Record<string, string>): boolean {
  return Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([id, decision]) => b[id] === decision);
}

export async function deletionVillages(db: Db, userId: string) {
  const rows = await db.select({ id: villages.id, name: villages.name, slug: villages.slug }).from(villageMembers)
    .innerJoin(villages, eq(villages.id, villageMembers.villageId))
    .where(and(eq(villageMembers.userId, userId), eq(villageMembers.role, "owner"), isNull(villages.endedAt), isNull(villages.language))).orderBy(villages.id);
  return Promise.all(rows.map(async row => {
    const owners = await db.select({ id: villageMembers.userId }).from(villageMembers)
      .where(and(eq(villageMembers.villageId, row.id), eq(villageMembers.role, "owner"), sql`${villageMembers.userId} <> ${userId}`));
    const members = await db.select({ id: villageMembers.userId, handle: profiles.handle }).from(villageMembers)
      .innerJoin(profiles, eq(profiles.userId, villageMembers.userId))
      .where(and(eq(villageMembers.villageId, row.id), sql`${villageMembers.userId} <> ${userId}`)).orderBy(profiles.handle);
    return { ...row, otherOwners: owners.length, members };
  }));
}

export async function requestAccountDeletion(db: Db, userId: string, input: AccountDeletionInput, now = new Date()): Promise<string> {
  if (isDeletedIdentity(userId) || ![undefined, "keep", "delete"].includes(input.posts)) fail("invalid");
  const decisions = input.villages ?? {};
  if (Object.values(decisions).some(value => value !== "" && value !== "transfer" && value !== "end" && !value.startsWith("member:"))) fail("invalid");
  return db.transaction(async tx => {
    await tx.select({ id: user.id }).from(user).where(eq(user.id, userId)).for("no key update");
    await lockHandleNamespace(tx, now);
    const [profile] = await tx.select().from(profiles).where(eq(profiles.userId, userId)).for("update");
    if (!profile) {
      const completed = await completedAccountDeletion(tx, accountDeletionKey(userId));
      if (completed) return completed;
      fail("not_found");
    }
    if (input.confirmation !== profile.handle) fail("confirmation");
    const owned = await deletionVillages(tx, userId);
    // Every caller must explicitly choose for a sole-owned shared village.
    const missing = owned.filter(village => !village.otherOwners && village.members.length && !decisions[village.id]);
    if (missing.length) throw new AccountDeletionError("village_required", missing.map(village => village.id));
    if (input.villages !== undefined && (owned.length !== Object.keys(decisions).length || owned.some(village => !(village.id in decisions)))) fail("village_changed");
    if (Object.values(decisions).some(value => value === "")) fail("invalid");
    const resolved = Object.fromEntries(owned.map(village => [village.id, decisions[village.id] ?? (village.otherOwners ? "transfer" : "end")]));
    const [existing] = await tx.select().from(accountDeletions).where(and(eq(accountDeletions.userId, userId), inArray(accountDeletions.state, ["pending", "failed"]))).for("update");
    const values = { posts: input.posts ?? "keep", confirmation: profile.handle, villageDecisions: resolved, state: "pending", lastError: null, updatedAt: now };
    await stopPush(tx, userId, null, "account_deletion");
    if (existing) { await tx.update(accountDeletions).set(values).where(eq(accountDeletions.id, existing.id)); return existing.id; }
    const id = randomUUID();
    await tx.insert(accountDeletions).values({ id, userId, completionKey: accountDeletionKey(userId), ...values, createdAt: now });
    return id;
  });
}

export async function cancelAccountDeletion(db: Db, id: string, now = new Date()): Promise<void> {
  const changed = await db.update(accountDeletions).set({ state: "cancelled", completionKey: null, userId: null, confirmation: null, villageDecisions: {}, updatedAt: now })
    .where(and(eq(accountDeletions.id, id), inArray(accountDeletions.state, ["pending", "failed"]))).returning({ id: accountDeletions.id });
  if (!changed.length) fail("invalid");
  console.log(`[account-delete] ${id}: cancelled`);
}

// Discover every direct FK from the schema, failing closed on unsupported keys.
// Cascades remove private per-member records. Other nullable references become
// null; required history/content references use the shared non-member identity.
async function detachMember(tx: Db, userId: string) {
  for (const table of new Set(Object.values(schema).filter(value => is(value, PgTable)))) {
    for (const foreign of getTableConfig(table).foreignKeys) {
      const ref = foreign.reference();
      if (ref.foreignTable !== user || foreign.onDelete === "cascade") continue;
      if (ref.columns.length !== 1) throw new Error("Unsupported account reference");
      const column = ref.columns[0];
      // Chat appeals still need an affected author while their evidence exists.
      const required = column.notNull || table === moderationActions || (table === chatReportSnapshots && column === chatReportSnapshots.authorId) || (table === reports && (column === reports.displayNameUserId || column === reports.avatarUserId));
      await tx.execute(sql`update ${table} set ${sql.identifier(column.name)} = ${required ? DELETED_MEMBER_ID : null} where ${column} = ${userId}`);
    }
  }
}

function containsIdentity(value: unknown, identities: ReadonlySet<string>): boolean {
  if (typeof value === "string") return identities.has(value);
  if (Array.isArray(value)) return value.some(item => containsIdentity(item, identities));
  return !!value && typeof value === "object" && Object.values(value).some(item => containsIdentity(item, identities));
}
async function clearLoginRecords(tx: Db, userId: string, email: string) {
  await tx.delete(verification).where(eq(verification.identifier, signupInvitationIdentifier(userId)));
  const identities = new Set([userId, email, addressHasher(authSecret())(email)]);
  const rows = await tx.select().from(verification);
  const remove = new Set<string>();
  const tokenHashes = new Set<string>();
  for (const row of rows) {
    let value: unknown = row.value;
    try { value = JSON.parse(row.value); } catch { /* Some plugin values are plain text. */ }
    if (!containsIdentity(value, identities)) continue;
    remove.add(row.id);
    if (row.identifier.startsWith("magic-link:")) tokenHashes.add(row.identifier.slice("magic-link:".length));
    if (row.identifier.startsWith("magic-link-code:")) identities.add(row.identifier.slice("magic-link-code:".length));
  }
  for (const row of rows) {
    if (identities.has(row.value) || [...tokenHashes].some(hash => row.identifier.endsWith(`:${hash}`))) remove.add(row.id);
  }
  for (const id of remove) await tx.delete(verification).where(eq(verification.id, id));
}

type Completed = { ok: true; requestId: string };
type Execute = (mutate: (tx: Db) => Promise<Completed>, lock: (tx: Db) => Promise<void>) => Promise<Completed>;
export async function completeAccountDeletion(db: Db, id: string, opts: { now?: Date; execute?: Execute } = {}): Promise<Completed> {
  const now = opts.now ?? new Date();
  const [operation] = await db.select().from(accountDeletions).where(eq(accountDeletions.id, id));
  if (!operation) fail("not_found");
  if (operation.state === "completed") return { ok: true, requestId: id };
  if (!operation.userId || operation.state === "cancelled") fail("cancelled");
  const userId = operation.userId;
  const chatSignals: Array<{ villageId: string; seq: number }> = [], ended: string[] = [];
  const afterCommit = (): Completed => {
    closeMemberChatConnections(userId);
    for (const change of chatSignals) signalVillageChat(change.villageId, change.seq);
    for (const village of ended) closeVillageChatConnections(village);
    console.log(`[account-delete] ${id}: completed`);
    return { ok: true, requestId: id };
  };
  const targetIds = Object.values(operation.villageDecisions).filter(value => value.startsWith("member:")).map(value => value.slice(7));
  const lock = async (tx: Db) => {
    const ids = [...new Set([userId, ...targetIds])].sort();
    await tx.select({ id: user.id }).from(user).where(inArray(user.id, ids)).orderBy(user.id).for("no key update");
    await lockHandleNamespace(tx, now);
    const members = await tx.select({ id: profiles.userId }).from(profiles).where(inArray(profiles.userId, ids)).orderBy(profiles.userId).for("update");
    if (targetIds.some(id => !members.some(member => member.id === id))) fail("village_changed");
  };
  const mutate = async (tx: Db): Promise<Completed> => {
    await lock(tx);
    const [account] = await tx.select().from(user).where(eq(user.id, userId)).for("no key update");
    const [profile] = await tx.select().from(profiles).where(eq(profiles.userId, userId)).for("update");
    const [request] = await tx.select().from(accountDeletions).where(eq(accountDeletions.id, id)).for("update");
    if (request?.state === "completed") return { ok: true, requestId: id };
    if (!account || !profile || !request || request.userId !== userId) fail("not_found");
    if (request.state === "cancelled") fail("cancelled");
    if (!sameVillageDecisions(request.villageDecisions, operation.villageDecisions) || request.posts !== operation.posts) fail("invalid");
    if (profile.handle !== request.confirmation) fail("confirmation");
    // This identity has no profile, credentials, membership or reachable address.
    await tx.insert(user).values({ id: DELETED_MEMBER_ID, name: "", email: DELETED_MEMBER_EMAIL }).onConflictDoNothing({ target: user.id });
    await revokeAllCredentials(tx, userId, now);
    if (profile.suspendedUntil && profile.suspendedUntil > now) {
      await tx.insert(suspendedEmailHashes).values({ hash: suspendedEmailHash(account.email), expiresAt: monthsBefore(now, -12 * RETENTION.suspendedAccountHashYears) })
        .onConflictDoUpdate({ target: suspendedEmailHashes.hash, set: { expiresAt: monthsBefore(now, -12 * RETENTION.suspendedAccountHashYears) } });
    }
    const owned = await deletionVillages(tx, userId);
    if (owned.length !== Object.keys(request.villageDecisions).length || owned.some(village => !(village.id in request.villageDecisions))) fail("village_changed");
    for (const village of owned) {
      await tx.select({ id: villages.id }).from(villages).where(eq(villages.id, village.id)).for("update");
      const [membership] = await tx.select().from(villageMembers).where(and(eq(villageMembers.villageId, village.id), eq(villageMembers.userId, userId)));
      if (membership?.role !== "owner") fail("village_changed");
      const other = await tx.select({ id: villageMembers.userId }).from(villageMembers).where(and(eq(villageMembers.villageId, village.id), eq(villageMembers.role, "owner"), sql`${villageMembers.userId} <> ${userId}`));
      const decision = request.villageDecisions[village.id] ?? (other.length ? "transfer" : "end");
      if (decision === "transfer" && !other.length) fail("village_changed");
      if (decision.startsWith("member:")) {
        const targetId = decision.slice(7);
        if (other.length || targetId === userId || isDeletedIdentity(targetId)) fail("village_changed");
        const promoted = await tx.update(villageMembers).set({ role: "owner" })
          .where(and(eq(villageMembers.villageId, village.id), eq(villageMembers.userId, targetId), eq(villageMembers.role, "member"))).returning({ id: villageMembers.userId });
        if (!promoted.length) fail("village_changed");
        const notices = await tx.insert(notifications).values({ userId: targetId, villageId: village.id, kind: "village_owner_changed" }).returning({ id: notifications.id, userId: notifications.userId });
        await enqueueImmediateEmails(tx, notices.map(notice => ({ ...notice, kind: "village_owner_changed" as const })));
      }
      if (decision === "end") {
        await tx.update(villages).set({ endedAt: now }).where(eq(villages.id, village.id));
        await tx.update(villageInvites).set({ state: "cancelled", respondedAt: now }).where(and(eq(villageInvites.villageId, village.id), eq(villageInvites.state, "pending")));
        ended.push(village.id);
      }
      await tx.insert(villageEvents).values({ villageId: village.id, actorId: null, actorHandle: DELETED_MEMBER_HANDLE, action: decision === "end" ? "end" : "leave", detail: { reason: "account-deleted" }, createdAt: now });
    }
    // Former villages are included; account deletion does not require current
    // membership or a current chat-consent version.
    const chatVillages = await tx.selectDistinct({ id: chatMessages.villageId }).from(chatMessages).where(eq(chatMessages.authorId, userId)).orderBy(chatMessages.villageId);
    for (const village of chatVillages) {
      await tx.select({ id: villages.id }).from(villages).where(eq(villages.id, village.id)).for("share");
      for (;;) {
        const result = await deleteChatRows(tx, village.id, userId);
        if (!result.count) break;
        chatSignals.push({ villageId: village.id, seq: result.seq });
      }
    }
    const iconUploads = tx.select({ id: media.id }).from(media).where(and(eq(media.uploadedBy, userId), isNotNull(media.villageId)));
    await tx.update(villages).set({ iconMediaId: null, iconActionId: null }).where(inArray(villages.iconMediaId, iconUploads));
    await tx.update(reports).set({ iconMediaId: null }).where(inArray(reports.iconMediaId, iconUploads));
    await tx.update(moderationActions).set({ iconMediaIdBefore: null }).where(inArray(moderationActions.iconMediaIdBefore, iconUploads));
    await tx.update(moderationActions).set({ avatarMediaIdBefore: null }).where(eq(moderationActions.targetUserId, userId));
    await tx.update(reports).set({ avatarMediaId: null }).where(eq(reports.avatarUserId, userId));
    await tx.update(reports).set({ status: "dismissed", handledBy: null, handledAt: now }).where(and(eq(reports.avatarUserId, userId), eq(reports.status, "open")));
    await tx.update(moderationActions).set({ displayNamesBefore: null }).where(eq(moderationActions.targetUserId, userId));
    await tx.update(reports).set({ displayNamesReported: null }).where(eq(reports.displayNameUserId, userId));
    await tx.update(reports).set({ status: "dismissed", handledBy: null, handledAt: now }).where(and(eq(reports.displayNameUserId, userId), eq(reports.status, "open")));
    const ownPosts = await tx.select({ id: entries.id, deletedAt: entries.deletedAt }).from(entries).where(eq(entries.authorId, userId)).orderBy(entries.id);
    for (const post of ownPosts) if (!post.deletedAt && (request.posts === "delete" || post.id === profile.introEntryId)) await softDeleteEntry(tx, post.id, { now });
    const ownIds = sql`select ${entries.id} from ${entries} where ${entries.authorId} = ${userId}`;
    const mentioned = await tx.selectDistinct({ id: entryMentionSnapshots.entryId }).from(entryMentionSnapshots)
      .where(sql`${entryMentionSnapshots.bindings} @> jsonb_build_array(jsonb_build_object('userId', ${userId}::text))`);
    await tx.execute(sql`update ${entryMentionSnapshots} set bindings = (
      select coalesce(jsonb_agg(case when binding->>'userId' = ${userId} then binding || '{"userId":null}'::jsonb else binding end), '[]'::jsonb)
      from jsonb_array_elements(${entryMentionSnapshots.bindings}) as binding
    ) where ${entryMentionSnapshots.bindings} @> jsonb_build_array(jsonb_build_object('userId', ${userId}::text))`);
    for (const entry of mentioned) {
      await tx.update(entries).set({ html: null, cardHtml: null, htmlVersion: 0 }).where(eq(entries.id, entry.id));
      await tx.update(translations).set({ html: null, htmlVersion: 0 }).where(eq(translations.entryId, entry.id));
    }
    await tx.update(entries).set({ authorArea: null, html: null, cardHtml: null, htmlVersion: 0 }).where(eq(entries.authorId, userId));
    await tx.update(translations).set({ html: null, htmlVersion: 0 }).where(sql`${translations.entryId} in (${ownIds})`);
    await tx.delete(memberSignatures).where(eq(memberSignatures.userId, userId));
    await tx.delete(schema.passkeyRecoveries).where(eq(schema.passkeyRecoveries.userId, userId));
    await deleteAllStanceRecords(tx, userId);
    await lockFigureMedia(tx);
    // Keep bytes only where an undeleted discussion still uses the image.
    await tx.update(media).set({ bytes: null, deletedAt: now }).where(and(eq(media.uploadedBy, userId), isNull(media.deletedAt), or(eq(media.avatar, true), sql`not exists (select 1 from ${entryMedia} inner join ${entries} on ${entries.id} = ${entryMedia.entryId} where ${entryMedia.mediaId} = ${media.id} and ${entries.deletedAt} is null)`)));
    await tx.update(chatReportSnapshots).set({ authorHandle: DELETED_MEMBER_HANDLE }).where(eq(chatReportSnapshots.authorId, userId));
    await tx.update(chatAccessLog).set({ readerHandle: DELETED_MEMBER_HANDLE }).where(eq(chatAccessLog.readerId, userId));
    await tx.update(villageEvents).set({ actorHandle: DELETED_MEMBER_HANDLE }).where(eq(villageEvents.actorId, userId));
    await tx.update(villageEvents).set({ detail: sql`(select coalesce(jsonb_object_agg(key,
      case when value in (${userId}, ${profile.handle}) then to_jsonb(${DELETED_MEMBER_HANDLE}::text) else ${villageEvents.detail}->key end), '{}'::jsonb)
      from jsonb_each_text(${villageEvents.detail}))` })
      .where(sql`exists (select 1 from jsonb_each_text(${villageEvents.detail}) where value in (${userId}, ${profile.handle}))`);
    await tx.update(invitations).set({ email: null }).where(eq(invitations.email, account.email));
    await tx.update(invitations).set({ usedBy: null }).where(eq(invitations.usedBy, userId));
    // Lock and erase the parent first. Concurrent note reads and final writes
    // must finish before deletion or observe the erased source after commit.
    const issued = await tx.update(invitations).set({ createdBy: null, note: null, noteLang: null }).where(eq(invitations.createdBy, userId)).returning({ id: invitations.id });
    if (issued.length) {
      const ids = issued.map(row => row.id);
      const work = and(eq(jobs.kind, TRANSLATE_INVITATION_NOTE_JOB), inArray(sql`${jobs.payload}->>'invitationId'`, ids))!;
      await discardPaidTranslationCalls(tx, work);
      await tx.delete(jobs).where(and(work, eq(jobs.status, "queued")));
      await tx.delete(invitationNoteTranslations).where(inArray(invitationNoteTranslations.invitationId, ids));
    }
    await clearLoginRecords(tx, userId, account.email);
    await tx.delete(jobs).where(sql`${jobs.payload}->>'userId' = ${userId}`);
    await reserveDepartingHandles(tx, userId, profile.handleKey, now);
    // The reporter reference is nulled below; the free-text note must not outlive the person who wrote it.
    await tx.update(chatTranslationReports).set({ note: null }).where(eq(chatTranslationReports.reporterId, userId));
    await endPersonalVillage(tx, userId, now);
    await detachMember(tx, userId);
    await tx.delete(user).where(eq(user.id, userId));
    await tx.update(accountDeletions).set({ userId: null, confirmation: null, villageDecisions: {}, state: "completed", noticeState: "pending", lastError: null, updatedAt: now, completedAt: now }).where(eq(accountDeletions.id, id));
    // The delivery address exists only in the retryable mail job, and is erased
    // after sending or exhausting retries. It is never logged or exported.
    const notice = await enqueue(tx, SEND_ACCOUNT_DELETED_JOB, { requestId: id, to: account.email, posts: request.posts, locale: profile.uiLocale }, { runAt: now, dedupeKey: `account-deleted:${id}` });
    if (notice.created) await tx.update(jobs).set({ createdAt: now, updatedAt: now }).where(eq(jobs.id, notice.id));
    return { ok: true, requestId: id };
  };
  console.log(`[account-delete] ${id}: started`);
  try {
    await (opts.execute ? opts.execute(mutate, lock) : db.transaction(mutate));
    return afterCommit();
  } catch (error) {
    // A connection can fail after PostgreSQL has committed. Consult the durable
    // journal before recording a failure or asking the member to try again.
    const [recorded] = await db.select({ state: accountDeletions.state }).from(accountDeletions).where(eq(accountDeletions.id, id));
    if (recorded?.state === "completed") return afterCommit();
    const code = error instanceof AccountDeletionError ? error.code : error instanceof Response ? "authorization_failed" : "transaction_failed";
    await db.update(accountDeletions).set({ state: "failed", lastError: code, updatedAt: now })
      .where(and(eq(accountDeletions.id, id), inArray(accountDeletions.state, ["pending", "failed"])));
    console.warn(`[account-delete] ${id}: stopped (${code})`);
    if (error instanceof AccountDeletionError || error instanceof Response) throw error;
    // Driver errors can contain SQL parameter values. Keep those out of CLI,
    // browser responses and application logs.
    throw new Error("Account deletion stopped; retry the recorded request");
  }
}

export async function deleteAccount(db: Db, userId: string, input: AccountDeletionInput, opts: { now?: Date; execute?: Execute } = {}) {
  const id = await requestAccountDeletion(db, userId, input, opts.now);
  return completeAccountDeletion(db, id, opts);
}

// This opaque receipt can only redisplay completion, never authorize deletion.
export const accountDeletionKey = (userId: string) => createHmac("sha256", authSecret()).update(`account-deletion:${userId}`).digest("hex");
export async function completedAccountDeletion(db: Db, key: string): Promise<string | null> {
  if (!/^[0-9a-f]{64}$/.test(key)) return null;
  const [row] = await db.select({ id: accountDeletions.id }).from(accountDeletions).where(and(eq(accountDeletions.completionKey, key), eq(accountDeletions.state, "completed")));
  return row?.id ?? null;
}
