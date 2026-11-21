import { createHash } from "node:crypto";
import { bodyWithinLimits } from "../body-length";
import { and, desc, eq, getTableColumns, isNull, or, sql } from "drizzle-orm";
import type { Db, Tx } from "~/lib/db/client.server";
import { draftReceipts, drafts, entries, villages, profiles } from "~/lib/db/schema";
import { createDraft, updateDraft } from "~/lib/drafts.server";
import { MAX_PENDING_API_DRAFTS } from "~/lib/api/drafts-api.server";
import { checkBodyBudget } from "~/lib/markdown.server";
import { villagesEnabled } from "~/lib/villages-enabled.server";
import { lockVillageProfile } from "~/lib/villages.server";
import { finishDraftReceipt } from "~/lib/draft-receipts.server";
import { replyLocation } from "~/lib/entries.server";
import { siteUrl } from "~/lib/md/urls.server";
import { rootTopic, rootTopicOn, visibleWithTopic } from "~/lib/visibility.server";
import { checkDraftIssues } from "~/lib/draft-issues.server";

export type McpClientIdentity = { key: string; id: string; name: string; uri: string | null; tokenId: number | null };

// Every query carries the ownership boundary. Do not load a browser/other-client draft and filter it afterwards.
function owned(userId: string, client: McpClientIdentity) {
  const creator = client.tokenId === null
    ? eq(drafts.clientKey, client.key)
    : or(eq(drafts.clientKey, client.key), and(isNull(drafts.clientKey), eq(drafts.tokenId, client.tokenId)));
  return and(eq(drafts.authorId, userId), eq(drafts.via, "api"), creator);
}

type DraftRow = typeof drafts.$inferSelect;
type Receipt = typeof draftReceipts.$inferSelect;
type ClientDraftStatus = { draftId: number } & (
  | { status: "pending"; version: number }
  | { status: "published"; entryUrl?: string }
  | { status: "discarded" | "unknown" }
);

function ownedReceipt(userId: string, client: McpClientIdentity) {
  return and(eq(draftReceipts.authorId, userId), eq(draftReceipts.clientKey, client.key));
}

async function statusOf(db: Db, draftId: number, draft: DraftRow | null, receipt?: Receipt): Promise<ClientDraftStatus> {
  if (draft) return { draftId, status: "pending", version: draft.version };
  if (receipt?.state === "discarded") return { draftId, status: "discarded" };
  if (receipt?.state === "published" && receipt.entryId !== null && receipt.threadId !== null) {
    const [visible] = await db.select({ id: entries.id }).from(entries).innerJoin(rootTopic, rootTopicOn())
      .where(and(eq(entries.id, receipt.entryId), visibleWithTopic()));
    if (!visible) return { draftId, status: "published" };
    const path = receipt.entryId === receipt.threadId ? `/t/${receipt.entryId}` : await replyLocation(db, receipt.threadId, receipt.entryId);
    return { draftId, status: "published", entryUrl: siteUrl(path) };
  }
  return { draftId, status: "unknown" };
}

export async function getClientDraftStatus(db: Db, userId: string, client: McpClientIdentity, draftId: number): Promise<ClientDraftStatus> {
  const [row] = await db.select({ receipt: draftReceipts, draft: drafts }).from(draftReceipts)
    .leftJoin(drafts, and(eq(drafts.id, draftReceipts.draftId), owned(userId, client)))
    .where(and(ownedReceipt(userId, client), eq(draftReceipts.draftId, draftId)));
  return statusOf(db, draftId, row ? row.draft : await getClientDraft(db, userId, client, draftId), row?.receipt);
}

// Tool input is a flat JSON object. Hash the supplied fields before defaults such as
// detected language are filled in. Replay stays stable if the member changes defaults.
function requestHash(input: unknown) {
  const sorted = input && typeof input === "object" ? Object.entries(input)
    .filter(([name, value]) => name !== "requestId" && value !== undefined)
    .sort(([a], [b]) => a.localeCompare(b, "en")) : [];
  return createHash("sha256").update(JSON.stringify(sorted)).digest("hex");
}

export async function createClientDraft(db: Db, userId: string, client: McpClientIdentity, input: unknown, now = new Date(), onBusy?: () => void, requestInput = input) {
  const requestId = input && typeof input === "object" && "requestId" in input ? input.requestId : undefined;
  if (requestId !== undefined && (typeof requestId !== "string" || !requestId.length || requestId.length > 128 || requestId.includes("\0"))) {
    return { ok: false as const, error: "invalid_draft" as const };
  }
  const request = requestId === undefined ? undefined : { id: requestId, hash: requestHash(requestInput) };
  const save = async (tx: Tx) => {
    if (request) {
      await lockVillageProfile(tx, userId);
      const [previous] = await tx.select({ receipt: draftReceipts, draft: drafts }).from(draftReceipts)
        .leftJoin(drafts, and(eq(drafts.id, draftReceipts.draftId), owned(userId, client)))
        .where(and(ownedReceipt(userId, client), eq(draftReceipts.requestId, request.id)));
      if (previous) {
        if (previous.receipt.requestHash !== request.hash) return { ok: false as const, error: "request_id_conflict" as const };
        return { ok: true as const, id: previous.receipt.draftId, draft: previous.draft, receipt: previous.receipt };
      }
    }
    if (input && typeof input === "object" && "body" in input && typeof input.body === "string") {
      const kind = "kind" in input && input.kind === "reply" ? "reply" : "topic";
      if (!bodyWithinLimits(input.body, kind)) return { ok: false as const, error: "body_too_long" as const };
      const bodyError = await checkBodyBudget(input.body, userId);
      if (bodyError) return { ok: false as const, error: bodyError };
    }
    const result = await createDraft(tx, userId, input, { via: "api", aiSource: "mcp", tokenId: client.tokenId, client, now, maxPendingApiDrafts: MAX_PENDING_API_DRAFTS, request });
    if (!result.ok) return result;
    return { ...result, draft: await getClientDraft(tx, userId, client, result.id), receipt: undefined };
  };
  const result = await db.transaction(save);
  if (!result.ok) return result;
  const { receipt, ...saved } = result;
  return { ...saved, status: await statusOf(db, saved.id, saved.draft, receipt), ...(saved.draft ? await checkDraftIssues(db, saved.draft, onBusy) : {}) };
}

export async function listClientDrafts(db: Db, userId: string, client: McpClientIdentity) {
  if (villagesEnabled()) return db.select({ ...getTableColumns(drafts), village: sql<string | null>`case when ${villages.kind} = 'personal' then '@' || ${profiles.handle} else ${villages.slug} end` }).from(drafts)
    .leftJoin(villages, eq(villages.id, drafts.villageId)).leftJoin(profiles, eq(profiles.userId, villages.ownerId))
    .where(owned(userId, client)).orderBy(desc(drafts.updatedAt), desc(drafts.id)).limit(100);
  return db.select().from(drafts).where(owned(userId, client)).orderBy(desc(drafts.updatedAt), desc(drafts.id)).limit(100);
}

export async function getClientDraft(db: Db, userId: string, client: McpClientIdentity, id: number) {
  const [row] = await db.select().from(drafts).where(and(owned(userId, client), eq(drafts.id, id)));
  return row ?? null;
}

export async function updateClientDraft(db: Db, userId: string, client: McpClientIdentity, id: number, input: unknown, now = new Date(), onBusy?: () => void) {
  const saved = await db.transaction(async (tx) => {
    if (villagesEnabled()) await lockVillageProfile(tx, userId);
    const [row] = await tx.select().from(drafts).where(and(owned(userId, client), eq(drafts.id, id))).for("update");
    if (!row) return { ok: false as const, error: "not_found" as const };
    if (typeof input !== "object" || input === null || Array.isArray(input)) return { ok: false as const, error: "invalid_draft" as const };
    const patch = input as Record<string, unknown>;
    if (patch.expectedVersion !== row.version) return { ok: false as const, error: "draft_conflict" as const };
    if (typeof patch.body === "string") {
      if (!bodyWithinLimits(patch.body, row.kind === "reply" ? "reply" : "topic")) return { ok: false as const, error: "body_too_long" as const };
      const bodyError = await checkBodyBudget(patch.body, userId);
      if (bodyError) return { ok: false as const, error: bodyError };
    }
    if ("altOf" in patch && patch.altOf !== row.altOf) return { ok: false as const, error: "invalid_alt_of" as const };
    // The shared mutation performs validation and increments the approval version.
    const merged = { lang: row.lang, title: row.title, body: row.body, asksStance: row.asksStance, stanceTag: row.stanceTag, ...patch };
    const result = await updateDraft(tx, userId, id, merged, { now, expectedVersion: row.version, skipUnchanged: true });
    if (!result.ok) return result;
    if (result.version === row.version) return { ...result, draft: row };
    const [updated] = await tx.select({ title: drafts.title, body: drafts.body }).from(drafts).where(eq(drafts.id, id));
    const [draft] = await tx.update(drafts).set({ clientUpdatedAt: now, aiSource: "mcp", aiBaseline: {
      title: patch.title === undefined ? row.aiBaseline?.title ?? row.title : updated.title,
      body: patch.body === undefined ? row.aiBaseline?.body ?? row.body : updated.body,
    } }).where(and(owned(userId, client), eq(drafts.id, id))).returning();
    return { ...result, draft };
  });
  if (!saved.ok) return saved;
  return { ...saved, ...await checkDraftIssues(db, saved.draft, onBusy) };
}

export async function deleteClientDraft(db: Db, userId: string, client: McpClientIdentity, id: number, expectedVersion: number) {
  return db.transaction(async tx => {
    const [draft] = await tx.select({ version: drafts.version }).from(drafts)
      .where(and(owned(userId, client), eq(drafts.id, id))).for("update");
    if (!draft) return { ok: false as const, error: "not_found" as const };
    if (draft.version !== expectedVersion) return { ok: false as const, error: "draft_conflict" as const };
    await tx.delete(drafts).where(and(owned(userId, client), eq(drafts.id, id)));
    await finishDraftReceipt(tx, id, null);
    return { ok: true as const };
  });
}
