import { publicPostVillageCondition } from "./villages.server";
import { villagesEnabled } from "./villages-enabled.server";
import { lockFigureMedia } from "./figure-translation.server";
import { createHash, randomBytes } from "node:crypto";
import { and, count, desc, eq, exists, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import type { Db } from "~/lib/db/client.server";
import { entries, entryMedia, figureMedia, media, motionPairs, moderationActions, profiles, user, villages } from "~/lib/db/schema";
import type { RewrittenMedia } from "./media-processing.server";
import { MEDIA_LIMITS, MediaError, mediaPath } from "~/lib/media";
import { isReason } from "~/lib/moderation";
import type { ModScope } from "~/lib/roles.server";
import { rootTopic, rootTopicOn, visibleWithTopic } from "~/lib/visibility.server";

export async function putMedia(db: Db, memberId: string, image: RewrittenMedia, opts: { avatar?: boolean; villageId?: string } = {}) {
  // Scope new URLs to their uploader so another member's deletion cannot remove
  // a separately uploaded copy. Existing content-only IDs remain untouched.
  let id = createHash("sha256").update(memberId).update("\0").update(opts.avatar ? "avatar\0" : "").update(opts.villageId ? `village:${opts.villageId}\0` : "").update(image.bytes).digest("hex");
  return db.transaction(async tx => {
    // Serialize site-wide admission before member locks. Deletion only frees
    // bytes, so a concurrent deletion can cause a conservative refusal only.
    await tx.execute(sql`select pg_advisory_xact_lock(732105, 1)`);
    // Serialize each member's quota check with their insertion, including concurrent uploads.
    const [member] = await tx.select({ id: user.id }).from(user).where(eq(user.id, memberId)).for("update");
    if (!member) throw new MediaError("generic", 403);
    const [existing] = await tx.select({ deletedAt: media.deletedAt }).from(media).where(eq(media.id, id));
    let needsInsert = !existing;
    if (existing?.deletedAt) {
      // Keep every deleted URL withdrawn, including operator and CLI deletions.
      // Reuse an active replacement, or store the upload at a fresh URL.
      const [replacement] = await tx.select({ id: media.id }).from(media).where(and(eq(media.uploadedBy, memberId), eq(media.avatar, !!opts.avatar), opts.villageId ? eq(media.villageId, opts.villageId) : isNull(media.villageId), isNull(media.deletedAt),
        eq(media.byteSize, image.bytes.length), eq(media.width, image.width), eq(media.height, image.height), eq(media.bytes, image.bytes))).limit(1);
      if (replacement) id = replacement.id;
      else id = randomBytes(32).toString("hex");
      needsInsert = !replacement;
    }
    if (needsInsert) {
      const [total] = await tx.select({
        count: sql<number>`count(*) filter (where ${media.uploadedBy} = ${memberId})`.mapWith(Number),
        memberBytes: sql<number>`coalesce(sum(${media.byteSize}) filter (where ${media.uploadedBy} = ${memberId}), 0)`.mapWith(Number),
        siteBytes: sql<number>`coalesce(sum(${media.byteSize}), 0)`.mapWith(Number),
      }).from(media).where(isNull(media.deletedAt));
      if (total.count >= MEDIA_LIMITS.storedCount) throw new MediaError("quota", 409);
      if (total.memberBytes + image.bytes.length > MEDIA_LIMITS.memberStoredBytes) throw new MediaError("member_bytes", 409);
      if (total.siteBytes + image.bytes.length > MEDIA_LIMITS.siteStoredBytes) throw new MediaError("site_bytes", 409);
      await tx.insert(media).values({ id, avatar: !!opts.avatar, animated: (image.frames ?? 1) > 1, frames: image.frames ?? 1, durationMs: image.durationMs ?? 0, loop: image.loop ?? 0, villageId: opts.villageId, bytes: image.bytes, mime: "image/webp", width: image.width, height: image.height, byteSize: image.bytes.length, uploadedBy: memberId }).onConflictDoNothing();
    }
    const saved = await readMedia(tx, id);
    if (!saved) throw new MediaError("generic");
    return { url: mediaPath(id, saved.width, saved.height), width: saved.width, height: saved.height };
  });
}
export async function putUploadedMedia(db: Db, memberId: string, image: RewrittenMedia) {
  if (!image.poster) return putMedia(db, memberId, image);
  return db.transaction(async tx => {
    // Match account deletion's member-before-figure lock order. Reentrant
    // admission in putMedia keeps both quota checks in this transaction.
    await tx.execute(sql`select pg_advisory_xact_lock(732105, 1)`);
    await tx.select({ id: user.id }).from(user).where(eq(user.id, memberId)).for("update");
    await lockFigureMedia(tx);
    const motion = await putMedia(tx, memberId, image), poster = await putMedia(tx, memberId, image.poster!);
    const motionId = motion.url.slice(7, 71);
    const [referenced] = await tx.select({ id: entries.id }).from(entryMedia).innerJoin(entries, eq(entries.id, entryMedia.entryId))
      .where(and(inArray(entryMedia.mediaId, [motionId, poster.url.slice(7, 71)]), eq(entries.authorId, memberId))).limit(1);
    // A repeated upload must not restore a poster superseded in current posts.
    if (!referenced) await tx.insert(motionPairs).values({ motionId, stillId: poster.url.slice(7, 71) }).onConflictDoNothing();
    return { ...motion, posterUrl: poster.url };
  });
}
export async function readMedia(db: Db, id: string) {
  const [image] = await db.select({ bytes: media.bytes, mime: media.mime, width: media.width, height: media.height, animated: media.animated }).from(media).where(and(eq(media.id, id), isNull(media.deletedAt)));
  return image ?? null;
}
function publicMediaCondition(db: Db) {
  const publicReference = db.select({ id: entries.id }).from(entryMedia)
    .innerJoin(entries, and(eq(entries.id, entryMedia.entryId), eq(entries.authorId, media.uploadedBy)))
    .innerJoin(rootTopic, rootTopicOn()).where(and(eq(entryMedia.mediaId, media.id), visibleWithTopic()));
  return and(isNull(media.deletedAt), exists(publicReference), or(
    eq(media.avatar, false),
    exists(db.select({ id: profiles.userId }).from(profiles).where(eq(profiles.avatarMediaId, media.id))),
    villagesEnabled() ? exists(db.select({ id: villages.id }).from(villages).where(and(eq(villages.iconMediaId, media.id), publicPostVillageCondition()))) : undefined,
  ));
}
export async function readMediaBatch(db: Db, ids: readonly string[]) {
  return ids.length ? db.select({ id: media.id, bytes: media.bytes, width: media.width, height: media.height, animated: media.animated }).from(media)
    .where(and(inArray(media.id, [...ids]), publicMediaCondition(db))) : [];
}
export async function readFigureSource(db: Db, readingKey: string) {
  const [image] = await db.select({ id: media.id, bytes: media.bytes, width: media.width, height: media.height }).from(media)
    .innerJoin(figureMedia, and(eq(figureMedia.mediaId, media.id), eq(figureMedia.readingKey, readingKey)))
    .where(and(publicMediaCondition(db), isNotNull(media.bytes))).limit(1);
  return image;
}
export async function pairedMedia(db: Db, id: string) {
  const [source] = await db.select({ id: media.id, owner: media.uploadedBy, width: media.width, height: media.height, animated: media.animated, avatar: media.avatar, villageId: media.villageId }).from(media).where(and(eq(media.id, id), isNull(media.deletedAt)));
  if (!source) return [];
  if (source.avatar || source.villageId) return [{ id: source.id, width: source.width, height: source.height, animated: source.animated }];
  const images = await db.select({ id: media.id, width: media.width, height: media.height, animated: media.animated }).from(media).where(and(eq(media.uploadedBy, source.owner), eq(media.avatar, false), isNull(media.villageId), isNull(media.deletedAt)));
  if (!images.length) return [];
  const pairs = await db.select().from(motionPairs).where(inArray(motionPairs.motionId, images.map(image => image.id)));
  const ids = pairGroups(pairs, new Set(images.map(image => image.id))).get(id);
  return images.filter(image => ids?.has(image.id));
}
function pairGroups(pairs: { motionId: string; stillId: string }[], active: Set<string>) {
  // Include only immediate pairs. Sharing a still must not join animations
  // into a transitive deletion group.
  const groups = new Map([...active].map(id => [id, new Set([id])]));
  for (const pair of pairs) if (active.has(pair.motionId) && active.has(pair.stillId)) {
    groups.get(pair.motionId)!.add(pair.stillId);
    groups.get(pair.stillId)!.add(pair.motionId);
  }
  return groups;
}
async function lockMediaContext(db: Db, id: string) {
  const [image] = await db.select({ avatar: media.avatar, villageId: media.villageId, uploadedBy: media.uploadedBy }).from(media).where(eq(media.id, id));
  if (image?.villageId) await db.select({ id: villages.id }).from(villages).where(eq(villages.id, image.villageId)).for("update");
  else if (image?.avatar) await db.select({ id: profiles.userId }).from(profiles).where(eq(profiles.userId, image.uploadedBy)).for("update");
}
export async function deleteMedia(db: Db, id: string, now = new Date()): Promise<boolean> {
  return db.transaction(async tx => {
    // Avatar changes and appeal reversals lock the profile before image rows.
    await lockMediaContext(tx, id);
    await lockFigureMedia(tx);
    const ids = (await pairedMedia(tx, id)).map(image => image.id);
    const rows = ids.length ? await tx.update(media).set({ bytes: null, deletedAt: now }).where(and(inArray(media.id, ids), isNull(media.deletedAt))).returning({ id: media.id }) : [];
    if (rows.length) await tx.update(profiles).set({ avatarMediaId: null, avatarActionId: null }).where(eq(profiles.avatarMediaId, id));
    if (rows.length) await tx.update(villages).set({ iconMediaId: null, iconActionId: null }).where(eq(villages.iconMediaId, id));
    return rows.length > 0;
  });
}

export async function listOwnMedia(db: Db, userId: string) {
  const images = await db.select({ id: media.id, animated: media.animated, width: media.width, height: media.height, byteSize: media.byteSize, uploadedAt: media.uploadedAt, usedByOwnPosts: count(entries.id) }).from(media)
    .leftJoin(entryMedia, eq(entryMedia.mediaId, media.id))
    .leftJoin(entries, and(eq(entries.id, entryMedia.entryId), eq(entries.authorId, userId), isNull(entries.deletedAt)))
    .where(and(eq(media.uploadedBy, userId), eq(media.avatar, false), isNull(media.villageId), isNull(media.deletedAt))).groupBy(media.id)
    .orderBy(desc(media.uploadedAt), media.id).limit(MEDIA_LIMITS.storedCount);
  if (!images.length) return [];
  const active = new Set(images.map(image => image.id));
  const pairs = await db.select().from(motionPairs).where(inArray(motionPairs.motionId, [...active]));
  const groups = pairGroups(pairs, active);
  const uses = await db.select({ mediaId: entryMedia.mediaId, entryId: entries.id }).from(entryMedia).innerJoin(entries, eq(entries.id, entryMedia.entryId))
    .where(and(inArray(entryMedia.mediaId, [...active]), eq(entries.authorId, userId), isNull(entries.deletedAt)));
  return images.map(image => {
    const ids = groups.get(image.id)!, related = images.filter(row => ids.has(row.id));
    if (related.length <= 1) return { ...image, related: [] };
    return { ...image, related, usedByOwnPosts: new Set(uses.filter(use => ids.has(use.mediaId)).map(use => use.entryId)).size };
  });
}

export async function deleteOwnMedia(db: Db, userId: string, id: string, confirmedUsageCount: number) {
  return db.transaction(async tx => {
    await lockFigureMedia(tx);
    const [image] = await tx.select({ id: media.id }).from(media)
      .where(and(eq(media.id, id), eq(media.uploadedBy, userId), eq(media.avatar, false), isNull(media.villageId), isNull(media.deletedAt))).for("update");
    if (!image) return { status: "not_found" as const };
    const ids = (await pairedMedia(tx, id)).map(image => image.id);
    const [usage] = await tx.select({ count: sql<number>`count(distinct ${entries.id})`.mapWith(Number) }).from(entryMedia).innerJoin(entries, eq(entries.id, entryMedia.entryId))
      .where(and(inArray(entryMedia.mediaId, ids), eq(entries.authorId, userId), isNull(entries.deletedAt)));
    if (usage.count > confirmedUsageCount) return { status: "confirmation_required" as const, usedByOwnPosts: usage.count };
    await deleteMedia(tx, id);
    return { status: "deleted" as const };
  });
}

export async function deleteMediaWithLog(db: Db, actor: { id: string; scope: ModScope }, input: { id: string; reason: string; note: string; confirmedIds?: string }) {
  if (!actor.scope.operator) return { ok: false as const, error: "forbidden" as const };
  if (!isReason(input.reason) || !input.note.trim() || input.note.length > 1500) return { ok: false as const, error: "invalid_note" as const };
  return db.transaction(async tx => {
    await lockMediaContext(tx, input.id);
    await lockFigureMedia(tx);
    const group = await pairedMedia(tx, input.id);
    if (group.length > 1 && input.confirmedIds !== undefined && input.confirmedIds !== group.map(image => image.id).sort().join(",")) return { ok: false as const, error: "confirm_required" as const };
    if (!await deleteMedia(tx, input.id)) return { ok: false as const, error: "not_found" as const };
    await tx.insert(moderationActions).values(group.map(image => ({ action: "delete_media", targetMediaId: image.id, actorId: actor.id, reason: input.reason, note: input.note.trim() })));
    return { ok: true as const };
  });
}
