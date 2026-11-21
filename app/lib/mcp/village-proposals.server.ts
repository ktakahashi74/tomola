import { createHash } from "node:crypto";
import { and, count, eq, gt, inArray, isNull, lte, type SQL, sql } from "drizzle-orm";
import { AVATAR_EDGE } from "~/lib/avatar-image.server";
import type { Db, Tx } from "~/lib/db/client.server";
import { media, profiles, user, villageEvents, villageMembers, villageProposals, villages } from "~/lib/db/schema";
import { enforceMemberLimit } from "~/lib/http/limits.server";
import { MediaError } from "~/lib/media";
import { rewriteMedia, withMediaSlot } from "~/lib/media-processing.server";
import { getWriter } from "~/lib/members.server";
import { drainRetentionRows, type RetentionResults } from "~/lib/retention-batch.server";
import { setVillageIcon, VILLAGE_ICON, villageIconUrl } from "~/lib/village-icon.server";
import { editVillage } from "~/lib/village-management.server";
import { validVillageSlug, villageDescriptionText, villageNameText } from "~/lib/villages";
import { villagesEnabled } from "~/lib/villages-enabled.server";
import { sharedVillageCondition } from "~/lib/villages.server";
import type { McpClientIdentity } from "./drafts.server";

const MAX_PENDING = 10;
const MAX_ICON_BYTES = 256 * 1024;
const EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;
const proposalId = /^[a-f0-9]{32}$/;
const digest = /^[a-f0-9]{64}$/;
const failure = <E extends string>(error: E) => ({ ok: false as const, error });
export const villageProposalPath = (id: string) => `/village-proposals/${id}`;

type Village = typeof villages.$inferSelect;
type Proposal = typeof villageProposals.$inferSelect;
type VillageProposalInput = {
  slug: string;
  name?: string;
  description?: string;
  icon?: { action: "reset" } | { action: "replace"; mediaId: string };
};

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
function lastChange(villageId: typeof villages.id | string) {
  return sql<string | null>`(select ${villageEvents.id}::text from ${villageEvents}
    where ${villageEvents.villageId} = ${villageId} and ${inArray(villageEvents.action, [
      "edit", "icon", "end", "moderation_fix", "moderation_unfix", "moderation_end", "moderation_reopen", "moderation_icon", "moderation_restore_icon",
    ])} order by ${villageEvents.id} desc limit 1)`;
}
function sourceVersion(village: Village, lastChangeId: string | null) {
  // Direct maintenance can change a stored value without logging an event. The
  // event also detects owner or moderator edits that restore an earlier value.
  return sha256(JSON.stringify([
    village.id, village.slug, village.kind, village.language, village.name, village.description,
    village.sourceLang, village.iconMediaId, village.iconActionId, village.endedAt, lastChangeId,
  ]));
}
function proposalVersion(row: Pick<Proposal, "id" | "sourceVersion">) {
  // A proposal ID identifies one immutable payload. Bind approval to its pinned village version as well.
  return sha256(`${row.id}:${row.sourceVersion}`);
}
function pending(userId: string, id: string, now: Date) {
  return and(eq(villageProposals.id, id), eq(villageProposals.userId, userId), gt(villageProposals.expiresAt, now))!;
}
const eligibleVillage = () => and(sharedVillageCondition(), isNull(villages.language));
const ownerJoin = (userId: string) => and(eq(villageMembers.villageId, villages.id), eq(villageMembers.userId, userId), eq(villageMembers.role, "owner"));
const ownedStill = (userId: string, id: string) => and(
  eq(media.id, id), eq(media.uploadedBy, userId), eq(media.avatar, false), eq(media.animated, false),
  isNull(media.villageId), isNull(media.deletedAt),
);

async function lockWriter(tx: Tx, userId: string) {
  // Account deletion takes the account before the profile. Foreign keys need the account lock when inserting an owned proposal.
  const [account] = await tx.select({ id: user.id }).from(user).where(eq(user.id, userId)).for("no key update");
  if (!account) return false;
  const [profile] = await tx.select({ userId: profiles.userId }).from(profiles).where(eq(profiles.userId, userId)).for("update");
  return !!profile && (await getWriter(tx, userId)).ok;
}

async function lockOwnedVillage(tx: Tx, userId: string, target: SQL) {
  const [village] = await tx.select().from(villages).where(and(eligibleVillage(), target)).for("update");
  if (!village) return null;
  // Check ownership after waiting for the same village lock held by ownership changes.
  const [owner] = await tx.select({ lastChangeId: lastChange(village.id) }).from(villageMembers).where(and(
    eq(villageMembers.villageId, village.id), eq(villageMembers.userId, userId), eq(villageMembers.role, "owner"),
  ));
  return owner ? { village, lastChangeId: owner.lastChangeId } : null;
}

function clientView(row: Pick<Proposal, "id" | "sourceVersion" | "name" | "description" | "iconAction" | "expiresAt">, village: Village, lastChangeId: string | null) {
  return {
    id: row.id, version: proposalVersion(row), village: village.slug!,
    name: row.name, description: row.description, icon: row.iconAction, expiresAt: row.expiresAt.toISOString(),
    status: row.sourceVersion === sourceVersion(village, lastChangeId) ? "pending" as const : "stale" as const,
  };
}

async function prepareIcon(db: Db, userId: string, id: string) {
  try {
    return await withMediaSlot(async () => {
      const [image] = await db.select({ bytes: media.bytes }).from(media).where(ownedStill(userId, id));
      if (!image?.bytes) return failure("invalid_image");
      const normalized = await rewriteMedia(image.bytes, { avatar: true });
      if (normalized.bytes.length > MAX_ICON_BYTES) return failure("invalid_image");
      return { ok: true as const, bytes: normalized.bytes };
    });
  } catch (error) {
    if (error instanceof MediaError) return failure(error.status === 503 ? "busy" : "invalid_image");
    throw error;
  }
}

export async function createVillageProposal(db: Db, userId: string, client: McpClientIdentity, input: VillageProposalInput) {
  if (!villagesEnabled() || !validVillageSlug(input.slug)) return failure("not_found");
  const name = input.name === undefined ? undefined : villageNameText(input.name);
  const description = input.description === undefined ? undefined : villageDescriptionText(input.description);
  if (name === null || description === null || (name === undefined && description === undefined && !input.icon)) return failure("invalid");
  const [owned] = await db.select({ id: villages.id, endedAt: villages.endedAt }).from(villages)
    .innerJoin(villageMembers, ownerJoin(userId)).where(and(eligibleVillage(), eq(villages.slug, input.slug)));
  if (!owned || (input.icon && owned.endedAt) || !(await getWriter(db, userId)).ok) return failure("not_found");

  let iconBytes: Buffer | null = null;
  if (input.icon?.action === "replace") {
    if (!digest.test(input.icon.mediaId)) return failure("invalid_image");
    const result = await prepareIcon(db, userId, input.icon.mediaId);
    if (!result.ok) return result;
    iconBytes = result.bytes;
  }

  return db.transaction(async tx => {
    if (!await lockWriter(tx, userId)) return failure("not_found");
    const locked = await lockOwnedVillage(tx, userId, eq(villages.id, owned.id));
    if (!locked || locked.village.slug !== input.slug || (input.icon && locked.village.endedAt)) return failure("not_found");
    const { village, lastChangeId } = locked;
    const now = new Date();
    const [{ total }] = await tx.select({ total: count() }).from(villageProposals)
      .where(and(eq(villageProposals.userId, userId), gt(villageProposals.expiresAt, now)));
    if (total >= MAX_PENDING) return failure("limit");
    const newName = name === village.name ? null : name ?? null;
    const newDescription = description === village.description ? null : description ?? null;
    const iconAction = input.icon?.action === "reset" && !village.iconMediaId ? "keep" : input.icon?.action ?? "keep";
    if (newName === null && newDescription === null && iconAction === "keep") return failure("invalid");
    if (input.icon?.action === "replace") {
      // Ordinary upload bytes are immutable. Lock and recheck the input before
      // storing an independent, proposal-owned icon copy.
      const [source] = await tx.select({ id: media.id }).from(media).where(ownedStill(userId, input.icon.mediaId)).for("share");
      if (!source) return failure("invalid_image");
    }
    const [row] = await tx.insert(villageProposals).values({
      userId, clientKey: client.key, clientId: client.id, clientName: client.name, villageId: village.id,
      sourceVersion: sourceVersion(village, lastChangeId), name: newName, description: newDescription, iconAction, iconBytes,
      createdAt: now, expiresAt: new Date(now.getTime() + EXPIRY_MS),
    }).returning({ id: villageProposals.id, sourceVersion: villageProposals.sourceVersion, name: villageProposals.name,
      description: villageProposals.description, iconAction: villageProposals.iconAction, expiresAt: villageProposals.expiresAt });
    return { ok: true as const, proposal: clientView(row, village, lastChangeId) };
  });
}

export async function getClientVillageProposal(db: Db, userId: string, client: McpClientIdentity, id: string) {
  if (!villagesEnabled() || !proposalId.test(id)) return failure("not_found");
  const [row] = await db.select({
    id: villageProposals.id, sourceVersion: villageProposals.sourceVersion, name: villageProposals.name, description: villageProposals.description,
    iconAction: villageProposals.iconAction, expiresAt: villageProposals.expiresAt, village: villages, lastChangeId: lastChange(villages.id),
  }).from(villageProposals).innerJoin(villages, eq(villages.id, villageProposals.villageId))
    .innerJoin(villageMembers, ownerJoin(userId)).where(and(pending(userId, id, new Date()), eq(villageProposals.clientKey, client.key), eligibleVillage()));
  return row ? { ok: true as const, proposal: clientView(row, row.village, row.lastChangeId) } : failure("not_found");
}

export async function discardClientVillageProposal(db: Db, userId: string, client: McpClientIdentity, id: string) {
  if (!villagesEnabled() || !proposalId.test(id)) return false;
  return discardProposal(db, and(pending(userId, id, new Date()), eq(villageProposals.clientKey, client.key))!);
}

async function discardProposal(db: Db, filter: SQL) {
  const [deleted] = await db.delete(villageProposals).where(filter).returning({ id: villageProposals.id });
  return !!deleted;
}

export async function discardVillageProposalReview(db: Db, userId: string, id: string, version: string) {
  if (!villagesEnabled() || !proposalId.test(id)) return failure("not_found");
  const filter = pending(userId, id, new Date());
  const [target] = await db.select({ id: villageProposals.id, sourceVersion: villageProposals.sourceVersion, slug: villages.slug }).from(villageProposals)
    .innerJoin(villages, eq(villages.id, villageProposals.villageId)).where(filter);
  if (!target) return failure("not_found");
  if (proposalVersion(target) !== version) return failure("stale");
  return await discardProposal(db, filter) ? { ok: true as const, village: target.slug } : failure("not_found");
}

export async function readVillageProposalReview(db: Db, userId: string, id: string) {
  if (!villagesEnabled() || !proposalId.test(id)) return failure("not_found");
  const [row] = await db.select({ proposal: villageProposals, village: villages, lastChangeId: lastChange(villages.id) })
    .from(villageProposals).innerJoin(villages, eq(villages.id, villageProposals.villageId))
    .innerJoin(villageMembers, ownerJoin(userId)).where(and(pending(userId, id, new Date()), eligibleVillage()));
  if (!row) return failure("not_found");
  const { proposal, village } = row;
  const target = { version: proposalVersion(proposal), village: village.slug! };
  if (proposal.sourceVersion !== sourceVersion(village, row.lastChangeId)) return { ...failure("stale"), ...target };
  const before = {
    name: proposal.name === null ? null : village.name,
    description: proposal.description === null ? null : village.description,
    icon: proposal.iconAction === "keep" ? null : villageIconUrl(village),
  };
  const after = { name: proposal.name, description: proposal.description, icon: proposal.iconAction === "reset" ? VILLAGE_ICON :
    proposal.iconBytes ? `data:image/webp;base64,${proposal.iconBytes.toString("base64")}` : null };
  return { ok: true as const, ...target, clientName: proposal.clientName, iconAction: proposal.iconAction, before, after };
}

export async function applyVillageProposal(db: Db, userId: string, id: string, version: string) {
  if (!villagesEnabled() || !proposalId.test(id)) return failure("not_found");
  if (!digest.test(version)) return failure("stale");
  try {
    return await db.transaction(async tx => {
      const [target] = await tx.select({ villageId: villageProposals.villageId, iconAction: villageProposals.iconAction })
        .from(villageProposals).where(pending(userId, id, new Date()));
      if (!target) return failure("not_found");
      // The icon path can admit new media. Match its site -> account -> profile -> village order.
      if (target.iconAction !== "keep") await tx.execute(sql`select pg_advisory_xact_lock(732105, 1)`);
      if (!await lockWriter(tx, userId)) return failure("not_found");
      const locked = await lockOwnedVillage(tx, userId, eq(villages.id, target.villageId));
      if (!locked) return failure("not_found");
      const { village, lastChangeId } = locked;
      const [proposal] = await tx.select().from(villageProposals).where(pending(userId, id, new Date())).for("update");
      if (!proposal || proposal.expiresAt <= new Date()) return failure("not_found");
      if (proposalVersion(proposal) !== version || proposal.sourceVersion !== sourceVersion(village, lastChangeId)) return failure("stale");
      if (proposal.name !== null || proposal.description !== null) {
        const edited = await editVillage(tx, userId, village.slug!, { name: proposal.name ?? village.name, description: proposal.description ?? village.description },
          inner => enforceMemberLimit(inner, "edit", userId));
        if (!edited.ok) return failure("not_found");
      }
      if (proposal.iconAction !== "keep") {
        const image = proposal.iconBytes ? { bytes: proposal.iconBytes, width: AVATAR_EDGE, height: AVATAR_EDGE } : null;
        await setVillageIcon(tx, userId, village.slug!, image);
      }
      await tx.delete(villageProposals).where(eq(villageProposals.id, id));
      return { ok: true as const, village: village.slug! };
    });
  } catch (error) {
    if (error instanceof MediaError && error.status === 409) return failure("image_limit");
    throw error;
  }
}

export async function exportOwnVillageProposals(db: Db, userId: string, now: Date) {
  const rows = await db.select({ proposal: villageProposals, slug: villages.slug }).from(villageProposals)
    .innerJoin(villages, eq(villages.id, villageProposals.villageId))
    .where(and(eq(villageProposals.userId, userId), gt(villageProposals.expiresAt, now))).orderBy(villageProposals.createdAt, villageProposals.id);
  return rows.map(({ proposal, slug }) => ({
    id: proposal.id, village: slug, client_id: proposal.clientId, client_name: proposal.clientName,
    name: proposal.name, description: proposal.description, icon_action: proposal.iconAction,
    icon: proposal.iconBytes ? { mime: "image/webp", base64: proposal.iconBytes.toString("base64") } : null,
    created_at: proposal.createdAt.toISOString(), expires_at: proposal.expiresAt.toISOString(),
  }));
}

export async function pruneVillageProposals(db: Db, now: Date, results?: RetentionResults) {
  return (await drainRetentionRows(db, "village_proposals", villageProposals, lte(villageProposals.expiresAt, now), results)).removed;
}
