import { and, desc, eq, getTableColumns, isNull, or, sql } from "drizzle-orm";
import type { Db } from "~/lib/db/client.server";
import { drafts, villages, profiles } from "~/lib/db/schema";
import { createDraft, updateDraft } from "~/lib/drafts.server";
import { MAX_PENDING_API_DRAFTS } from "~/lib/api/drafts-api.server";
import { checkBodyBudget } from "~/lib/markdown.server";
import { villagesEnabled } from "~/lib/villages-enabled.server";
import { lockVillageProfile } from "~/lib/villages.server";
import { checkDraftIssues } from "~/lib/draft-issues.server";

export type McpClientIdentity = { key: string; id: string; name: string; uri: string | null; tokenId: number | null };

// Every query carries the ownership boundary. Do not load a browser/other-client draft and filter it afterwards.
function owned(userId: string, client: McpClientIdentity) {
  const creator = client.tokenId === null
    ? eq(drafts.clientKey, client.key)
    : or(eq(drafts.clientKey, client.key), and(isNull(drafts.clientKey), eq(drafts.tokenId, client.tokenId)));
  return and(eq(drafts.authorId, userId), eq(drafts.via, "api"), creator);
}

export async function createClientDraft(db: Db, userId: string, client: McpClientIdentity, input: unknown, now = new Date(), onBusy?: () => void) {
  if (input && typeof input === "object" && "body" in input && typeof input.body === "string") {
    const bodyError = await checkBodyBudget(input.body, userId);
    if (bodyError) return { ok: false as const, error: bodyError };
  }
  const result = await createDraft(db, userId, input, { via: "api", aiSource: "mcp", tokenId: client.tokenId, client, now, maxPendingApiDrafts: MAX_PENDING_API_DRAFTS });
  if (!result.ok) return result;
  const draft = (await getClientDraft(db, userId, client, result.id))!;
  return { ...result, draft, ...await checkDraftIssues(db, draft, onBusy) };
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
    if (typeof patch.body === "string") {
      const bodyError = await checkBodyBudget(patch.body, userId);
      if (bodyError) return { ok: false as const, error: bodyError };
    }
    if ("altOf" in patch && patch.altOf !== row.altOf) return { ok: false as const, error: "invalid_alt_of" as const };
    // The shared mutation performs validation and increments the approval version.
    const merged = { lang: row.lang, title: row.title, body: row.body, asksStance: row.asksStance, stanceTag: row.stanceTag, ...patch };
    const result = await updateDraft(tx, userId, id, merged, { now });
    if (!result.ok) return result;
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

export async function deleteClientDraft(db: Db, userId: string, client: McpClientIdentity, id: number) {
  const rows = await db.delete(drafts).where(and(owned(userId, client), eq(drafts.id, id))).returning({ id: drafts.id });
  return rows.length !== 0;
}
