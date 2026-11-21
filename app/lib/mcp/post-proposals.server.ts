import { and, count, eq, gt, isNull, lte, sql } from "drizzle-orm";
import type { Db, Tx } from "~/lib/db/client.server";
import { entries, entryEditProposals } from "~/lib/db/schema";
import { checkEntryInput, deleteOwnEntry, editEntry, replyLocation } from "~/lib/entries.server";
import { entryEditVersion } from "~/lib/entry-edit-version.server";
import type { SourceLang } from "~/lib/languages";
import { siteUrl } from "~/lib/md/urls.server";
import { lockReferenceTopics } from "~/lib/related-discussions.server";
import { drainRetentionRows, type RetentionResults } from "~/lib/retention-batch.server";
import { normalizeNewlines, titleOrNull } from "~/lib/text";
import { lockVillageProfile } from "~/lib/villages.server";
import { rootTopic, rootTopicOn, visibleWithTopic } from "~/lib/visibility.server";
import type { McpClientIdentity } from "./drafts.server";

const MAX_PENDING_EDITS = 100;
const PROPOSAL_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

type EditProposal = typeof entryEditProposals.$inferSelect;
const proposalFields = { id: entryEditProposals.id, entryId: entryEditProposals.entryId, version: entryEditProposals.version, state: entryEditProposals.state };
const authorProposal = (userId: string, id: number) => and(eq(entryEditProposals.authorId, userId), eq(entryEditProposals.id, id));
const activeProposal = (now: Date) => and(eq(entryEditProposals.state, "pending"), gt(entryEditProposals.expiresAt, now));
const editPath = (id: number) => `/mcp/entry-edits/${id}`;
const deletePath = (id: number) => `/mcp/entries/${id}/delete`;

// Fetch content only if both the entry and its thread are publicly readable posts
// and the authenticated member wrote the entry. Missing and inaccessible are identical.
async function ownVisibleEntry(db: Db, userId: string, id: number) {
  const [row] = await db.select({ id: entries.id, kind: entries.kind, threadId: entries.threadId,
    title: entries.title, body: entries.body, lang: entries.lang, stanceTag: entries.stanceTag, sourceHash: entries.sourceHash,
    asksStance: entries.asksStance, lockedAt: entries.stanceLockedAt,
  }).from(entries).innerJoin(rootTopic, rootTopicOn())
    .where(and(eq(entries.id, id), eq(entries.authorId, userId), visibleWithTopic()));
  return row ? { ...row, kind: row.kind as "topic" | "reply", lang: row.lang as SourceLang } : null;
}

type VisibleEntry = NonNullable<Awaited<ReturnType<typeof ownVisibleEntry>>>;
const entryPath = (db: Db, entry: Pick<VisibleEntry, "id" | "threadId">) => entry.threadId === null ? `/t/${entry.id}` : replyLocation(db, entry.threadId, entry.id);

async function proposalStatus(db: Db, id: number, row?: Pick<EditProposal, "id" | "entryId" | "version" | "state">) {
  if (!row) return { id, status: "unknown" as const };
  const result = { id, version: row.version, status: row.state };
  if (row.state === "discarded") return result;
  const [entry] = await db.select({ id: entries.id, threadId: entries.threadId }).from(entries).innerJoin(rootTopic, rootTopicOn())
    .where(and(eq(entries.id, row.entryId), visibleWithTopic()));
  if (!entry) return result;
  return row.state === "pending"
    ? { ...result, entryId: row.entryId, approvalUrl: siteUrl(editPath(id)) }
    : { ...result, entryId: row.entryId, entryUrl: siteUrl(await entryPath(db, entry)) };
}

export async function prepareEntryEdit(db: Db, userId: string, client: McpClientIdentity, id: number, change: { title?: string | null; body?: string; lang?: SourceLang }, now = new Date()) {
  const entry = await ownVisibleEntry(db, userId, id);
  if (!entry) return { ok: false as const, error: "not_found" as const };
  if (entry.lockedAt) return { ok: false as const, error: "locked" as const };
  if ((entry.kind === "reply" && change.title !== undefined) || (change.title === undefined && change.body === undefined && change.lang === undefined)) {
    return { ok: false as const, error: "invalid_edit" as const };
  }
  const title = change.title === undefined ? entry.title : titleOrNull(change.title)?.trim() ?? null;
  const body = normalizeNewlines(change.body ?? entry.body);
  const lang = change.lang ?? entry.lang;
  const invalid = await checkEntryInput(entry.kind, { title, body, lang, asksStance: entry.asksStance }, userId);
  if (invalid) return { ok: false as const, error: invalid };
  return db.transaction(async tx => {
    if (!await lockVillageProfile(tx, userId)) return { ok: false as const, error: "not_found" as const };
    const [{ pending }] = await tx.select({ pending: count() }).from(entryEditProposals)
      .where(and(eq(entryEditProposals.authorId, userId), activeProposal(now)));
    if (pending >= MAX_PENDING_EDITS) return { ok: false as const, error: "too_many_pending_edits" as const };
    const [row] = await tx.insert(entryEditProposals).values({
      authorId: userId, clientKey: client.key, clientName: client.name, entryId: id, entryVersion: entryEditVersion(entry), title, body, lang, createdAt: now, expiresAt: new Date(now.getTime() + PROPOSAL_LIFETIME_MS),
    }).returning(proposalFields);
    return { ok: true as const, proposal: await proposalStatus(tx, row.id, row) };
  });
}

export async function getClientEntryEditStatus(db: Db, userId: string, client: McpClientIdentity, id: number, now = new Date()) {
  const [row] = await db.select(proposalFields).from(entryEditProposals)
    .where(and(authorProposal(userId, id), eq(entryEditProposals.clientKey, client.key), gt(entryEditProposals.expiresAt, now)));
  return proposalStatus(db, id, row);
}

export async function getClientEntryEdit(db: Db, userId: string, client: McpClientIdentity, id: number, now = new Date()) {
  const [proposal] = await db.select().from(entryEditProposals)
    .where(and(authorProposal(userId, id), eq(entryEditProposals.clientKey, client.key), activeProposal(now)));
  if (!proposal) return null;
  const entry = await ownVisibleEntry(db, userId, proposal.entryId);
  if (!entry) return null;
  return { id, entryId: proposal.entryId, version: proposal.version, entryVersion: proposal.entryVersion, title: proposal.title,
    body: proposal.body, lang: proposal.lang, stale: Boolean(entry.lockedAt) || entryEditVersion(entry) !== proposal.entryVersion,
    approvalUrl: siteUrl(editPath(id)), expiresAt: proposal.expiresAt.toISOString() };
}

export async function discardEntryEdit(db: Db, userId: string, id: number, expectedVersion: number, client?: McpClientIdentity, now = new Date()) {
  const [row] = await db.update(entryEditProposals).set({
    state: "discarded", title: null, body: null, lang: null, version: sql`${entryEditProposals.version} + 1`, finishedAt: now,
  }).where(and(authorProposal(userId, id), client ? eq(entryEditProposals.clientKey, client.key) : undefined,
    activeProposal(now), eq(entryEditProposals.version, expectedVersion))).returning({ id: entryEditProposals.id });
  return row !== undefined;
}

export async function getEntryEditReview(db: Db, userId: string, id: number, now = new Date()) {
  const [proposal] = await db.select().from(entryEditProposals).where(and(authorProposal(userId, id), activeProposal(now)));
  if (!proposal) return null;
  const entry = await ownVisibleEntry(db, userId, proposal.entryId);
  const current = entry && !entry.lockedAt && entryEditVersion(entry) === proposal.entryVersion ? entry : null;
  return { proposal, entry, current, back: entry ? await entryPath(db, entry) : "/drafts" };
}

// Run through the ordinary signing and edit transactions. The submitted text is
// checked against the locked proposal so the signed payload and applied text agree.
export async function applyEntryEdit(tx: Tx, userId: string, id: number, form: {
  version: number; entryId: number; kind: "topic" | "reply"; title: string | null; body: string; lang: string;
}, now = new Date()) {
  const [proposal] = await tx.select().from(entryEditProposals).where(authorProposal(userId, id)).for("update");
  if (!proposal || proposal.expiresAt <= now) return { ok: false as const, error: "not_found" as const };
  if (proposal.state !== "pending" || proposal.version !== form.version || proposal.entryId !== form.entryId ||
      proposal.title !== form.title || proposal.body !== form.body || proposal.lang !== form.lang) {
    return { ok: false as const, error: "edit_conflict" as const };
  }
  const edited = await editEntry(tx, userId, proposal.entryId, { title: proposal.title, body: proposal.body, lang: proposal.lang }, {
    kind: form.kind, expectedVersion: proposal.entryVersion, visibleOnly: true, now,
  });
  if (!edited.ok) return edited;
  await tx.update(entryEditProposals).set({
    state: "applied", title: null, body: null, lang: null, version: sql`${entryEditProposals.version} + 1`, finishedAt: now,
  }).where(eq(entryEditProposals.id, id));
  return { ...edited, kind: form.kind };
}

async function replyCount(db: Db, entry: VisibleEntry) {
  const target = entry.kind === "topic" ? entries.threadId : entries.parentId;
  const [{ replies }] = await db.select({ replies: count() }).from(entries)
    .where(and(eq(target, entry.id), eq(entries.kind, "reply"), isNull(entries.deletedAt)));
  return replies;
}

export async function getEntryDeletionReview(db: Db, userId: string, id: number) {
  const entry = await ownVisibleEntry(db, userId, id);
  if (!entry) return null;
  return { entry, count: await replyCount(db, entry), version: entryEditVersion(entry), back: await entryPath(db, entry) };
}

export async function prepareEntryDeletion(db: Db, userId: string, id: number) {
  const review = await getEntryDeletionReview(db, userId, id);
  if (!review) return null;
  return { entryId: id, kind: review.entry.kind, replyCount: review.count,
    replyImpact: review.entry.kind === "topic" ? "thread_replies_unreadable" : "direct_replies_remain_readable",
    approvalUrl: siteUrl(deletePath(id)), entryUrl: siteUrl(review.back) };
}

export async function confirmEntryDeletion(db: Db, userId: string, id: number, expected: { count: number; version: string }) {
  return db.transaction(async tx => {
    await lockReferenceTopics(tx, { entryId: id });
    const entry = await ownVisibleEntry(tx, userId, id);
    if (!entry) return { ok: false as const, error: "not_found" as const };
    if (entryEditVersion(entry) !== expected.version || await replyCount(tx, entry) !== expected.count) {
      return { ok: false as const, error: "delete_conflict" as const };
    }
    return deleteOwnEntry(tx, userId, id, { kind: entry.kind });
  });
}

export async function exportOwnEntryEditProposals(db: Db, userId: string, now: Date) {
  const rows = await db.select().from(entryEditProposals)
    .where(and(eq(entryEditProposals.authorId, userId), activeProposal(now)))
    .orderBy(entryEditProposals.createdAt, entryEditProposals.id);
  return rows.map(row => ({ id: row.id, entry_id: row.entryId, client_name: row.clientName, title: row.title, body: row.body,
    lang: row.lang, created_at: row.createdAt.toISOString(), expires_at: row.expiresAt.toISOString() }));
}

export async function pruneEntryEditProposals(db: Db, now: Date, results?: RetentionResults) {
  return (await drainRetentionRows(db, "entry_edit_proposals", entryEditProposals, lte(entryEditProposals.expiresAt, now), results)).removed;
}
