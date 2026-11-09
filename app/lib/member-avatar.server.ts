import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "./db/client.server";
import { media, moderationActions, profiles, reports, user } from "./db/schema";
import { AVATAR_EDGE, automaticAvatarUrl } from "./avatar-image.server";
import { MediaError, mediaPath, parseMediaPath } from "./media";
import { deleteMedia, putMedia } from "./media-store.server";

export function memberAvatarUrl(person: { publicId?: string | null; avatarMediaId?: string | null } | undefined): string | null {
  return person?.avatarMediaId ? mediaPath(person.avatarMediaId, AVATAR_EDGE, AVATAR_EDGE) : person?.publicId ? automaticAvatarUrl(person.publicId) : null;
}

export async function loadMemberAvatars(db: Db, handles: readonly string[]) {
  const keys = [...new Set(handles)];
  const rows = keys.length ? await db.select({ handle: profiles.handle, publicId: profiles.publicId, avatarMediaId: profiles.avatarMediaId }).from(profiles).where(inArray(profiles.handle, keys)) : [];
  return new Map(rows.map(row => [row.handle, memberAvatarUrl(row)]));
}

// Profile images share image quotas and decoding, but have a separate content namespace.
export async function setMemberAvatar(db: Db, userId: string, image: { bytes: Buffer; width: number; height: number } | null) {
  if (image && (image.width !== AVATAR_EDGE || image.height !== AVATAR_EDGE)) throw new MediaError("generic");
  return db.transaction(async tx => {
    // Match putMedia's lock order, including account deletion's user-before-profile order.
    await tx.execute(sql`select pg_advisory_xact_lock(732105, 1)`);
    const [account] = await tx.select({ id: user.id }).from(user).where(eq(user.id, userId)).for("no key update");
    const [person] = await tx.select().from(profiles).where(eq(profiles.userId, userId)).for("update");
    if (!account || !person) throw new MediaError("generic", 403);
    const saved = image ? await putMedia(tx, userId, image, { avatar: true }) : null;
    const id = saved ? parseMediaPath(saved.url)!.id : null;
    await tx.update(profiles).set({ avatarMediaId: id, avatarActionId: null }).where(eq(profiles.userId, userId));
    // Preserve only images captured by a report or action, as with display-name copies.
    if (person.avatarMediaId && person.avatarMediaId !== id) {
      const [evidence] = await tx.select({ id: reports.id }).from(reports).where(eq(reports.avatarMediaId, person.avatarMediaId)).limit(1);
      const [action] = await tx.select({ id: moderationActions.id }).from(moderationActions).where(eq(moderationActions.avatarMediaIdBefore, person.avatarMediaId)).limit(1);
      if (!evidence && !action) await deleteMedia(tx, person.avatarMediaId);
    }
    return { url: memberAvatarUrl({ publicId: person.publicId, avatarMediaId: id })!, uploaded: id !== null };
  });
}

export async function exportMemberAvatar(db: Db, userId: string) {
  const [image] = await db.select({ bytes: media.bytes }).from(profiles).innerJoin(media, eq(media.id, profiles.avatarMediaId))
    .where(and(eq(profiles.userId, userId), eq(media.avatar, true), isNull(media.deletedAt)));
  return image?.bytes ? { uploaded: true, mime: "image/webp" as const, base64: image.bytes.toString("base64") } : { uploaded: false, mime: null, base64: null };
}
