import { villagesEnabled } from "./villages-enabled.server";
import { lockFigureMedia, queueEntryFigures } from "./figure-translation.server";
import { and, eq, exists, inArray, isNull, or } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "~/lib/db/client.server";
import { appeals, entries, entryMedia, media, motionPairs, moderationActions, profiles, villages } from "~/lib/db/schema";
import { motionCandidates } from "./motion-display.server";
import { publicPostVillageCondition } from "./villages.server";
import { isVillageOwner } from "./village-moderation.server";
import { canSeeHidden, type Viewer } from "~/lib/roles.server";

// Keep the original Markdown's local media references, including absolute URLs
// containing the same path. The database migration uses the same path pattern.
export function referencedMediaIds(body: string): string[] {
  return [...new Set([...body.matchAll(/\/media\/([a-f0-9]{64})-[1-9]\d{0,3}x[1-9]\d{0,3}\.webp\b/g)].map(match => match[1]))];
}

export async function syncMediaReferences(db: Db, entryId: number, body: string, renderedHtml?: string): Promise<void> {
  const [entry] = await db.select({ authorId: entries.authorId }).from(entries).where(eq(entries.id, entryId));
  const previous = await db.select({ id: entryMedia.mediaId }).from(entryMedia).where(eq(entryMedia.entryId, entryId));
  const ids = referencedMediaIds(body), affected = [...new Set([...ids, ...previous.map(row => row.id)])];
  const motions = affected.length ? await db.select({ id: media.id }).from(media).where(and(or(
    inArray(media.id, affected),
    exists(db.select({ id: motionPairs.motionId }).from(motionPairs).where(and(eq(motionPairs.motionId, media.id), inArray(motionPairs.stillId, affected)))),
  ), eq(media.uploadedBy, entry.authorId), eq(media.animated, true), eq(media.avatar, false), isNull(media.villageId))) : [];
  if (motions.length) await lockFigureMedia(db);
  await db.delete(entryMedia).where(eq(entryMedia.entryId, entryId));
  const stored = ids.length ? await db.select({ id: media.id }).from(media).where(inArray(media.id, ids)) : [];
  if (stored.length) await db.insert(entryMedia).values(stored.map(row => ({ entryId, mediaId: row.id })));
  if (motions.length) {
    const motionIds = motions.map(row => row.id);
    // Rebuild the affected relationships from current original posts, preserving
    // links in other posts without retaining superseded upload or edit pairs.
    const sources = await db.selectDistinct({ id: entries.id, html: entries.html }).from(entries)
      .innerJoin(entryMedia, eq(entryMedia.entryId, entries.id))
      .where(and(inArray(entryMedia.mediaId, motionIds), eq(entries.authorId, entry.authorId)));
    const candidates = sources.flatMap(source => motionCandidates(source.id === entryId && renderedHtml !== undefined ? renderedHtml : source.html ?? ""))
      .filter(pair => motionIds.includes(pair.motion.id));
    const candidateIds = [...new Set(candidates.flatMap(pair => [pair.motion.id, pair.still.id]))];
    const owned = candidateIds.length ? await db.select({ id: media.id, animated: media.animated, width: media.width, height: media.height }).from(media)
      .where(and(inArray(media.id, candidateIds), eq(media.uploadedBy, entry.authorId), eq(media.avatar, false), isNull(media.villageId), isNull(media.deletedAt))) : [];
    const images = new Map(owned.map(image => [image.id, image]));
    // Reuse sanitized output; never infer pairs from matching image hashes.
    const found = candidates.flatMap(pair => {
      const motion = images.get(pair.motion.id), still = images.get(pair.still.id);
      return motion?.animated && still && !still.animated && motion.width === pair.motion.width && motion.height === pair.motion.height && still.width === pair.still.width && still.height === pair.still.height ? [{ motionId: motion.id, stillId: still.id }] : [];
    });
    await db.delete(motionPairs).where(inArray(motionPairs.motionId, motionIds));
    if (found.length) await db.insert(motionPairs).values(found).onConflictDoNothing();
  }
  if (ids.length) await queueEntryFigures(db, entryId);
}

export async function canReadMedia(db: Db, id: string, viewer: Viewer | null): Promise<boolean> {
  const [image] = await db.select({ uploadedBy: media.uploadedBy, avatar: media.avatar, villageId: media.villageId }).from(media).where(eq(media.id, id));
  if (!image) return false;
  if (image.villageId) {
    const [place] = await db.select({ id: villages.id, iconMediaId: villages.iconMediaId }).from(villages).where(and(eq(villages.id, image.villageId), publicPostVillageCondition()));
    // Closed villages have no readable surface yet; neither uploads nor old URLs bypass that boundary.
    if (!place) return false;
    if (villagesEnabled() && place.iconMediaId === id || viewer?.scope.operator || viewer && await isVillageOwner(db, place.id, viewer.userId)) return true;
    // A former owner can still read the evidence of the appeal they filed.
    const [appellant] = viewer ? await db.select({ id: appeals.id }).from(appeals).innerJoin(moderationActions, eq(moderationActions.id, appeals.actionId))
      .where(and(eq(appeals.appellantId, viewer.userId), eq(moderationActions.targetVillageId, place.id), eq(moderationActions.iconMediaIdBefore, id))).limit(1) : [];
    return !!appellant;
  }
  if (image.avatar) {
    const [active] = await db.select({ id: profiles.userId }).from(profiles).where(eq(profiles.avatarMediaId, id)).limit(1);
    return !!active || viewer?.userId === image.uploadedBy || !!viewer?.scope.operator;
  }
  const root = alias(entries, "media_root");
  const references = await db.select({
    authorId: entries.authorId, lang: entries.lang, hiddenAt: entries.hiddenAt, deletedAt: entries.deletedAt,
    rootId: root.id, rootAuthorId: root.authorId, rootLang: root.lang, rootHiddenAt: root.hiddenAt, rootDeletedAt: root.deletedAt,
  }).from(entryMedia).innerJoin(entries, eq(entries.id, entryMedia.entryId))
    .leftJoin(root, and(eq(root.id, entries.threadId), eq(entries.kind, "reply")))
    .where(and(eq(entryMedia.mediaId, id), eq(entries.authorId, image.uploadedBy)));
  if (!references.length) return viewer?.userId === image.uploadedBy;
  return references.some(entry => {
    if ((entry.hiddenAt || entry.deletedAt) && !canSeeHidden(viewer, entry)) return false;
    if (entry.rootId !== null && (entry.rootHiddenAt || entry.rootDeletedAt)
      && !canSeeHidden(viewer, { authorId: entry.rootAuthorId!, lang: entry.rootLang! })) return false;
    return true;
  });
}
