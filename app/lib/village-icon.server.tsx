import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Languages, MapPinHouse } from "lucide-react";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "./db/client.server";
import { media, moderationActions, profiles, reports, user, villageEvents, villageMembers, villages } from "./db/schema";
import { AVATAR_EDGE } from "./avatar-image.server";
import { memberAvatarUrl } from "./member-avatar.server";
import { MediaError, mediaPath, parseMediaPath } from "./media";
import { deleteMedia, putMedia } from "./media-store.server";
import { isSharedVillageKind } from "./villages";
import { villagesEnabled } from "./villages-enabled.server";

const symbol = (icon: typeof Languages) => `data:image/svg+xml,${encodeURIComponent(renderToStaticMarkup(createElement(icon, { width: 24, height: 24, 'aria-hidden': true })))}`;
export const LANGUAGE_ICON = symbol(Languages);
export const VILLAGE_ICON = symbol(MapPinHouse);

type IconSource = { kind: string; language?: string | null; iconMediaId?: string | null; publicId?: string | null; avatarMediaId?: string | null };
export function villageIconUrl(village: IconSource): string {
  if (village.kind === "personal") return memberAvatarUrl(village) ?? VILLAGE_ICON;
  if (village.language) return LANGUAGE_ICON;
  return village.iconMediaId ? mediaPath(village.iconMediaId, AVATAR_EDGE, AVATAR_EDGE) : VILLAGE_ICON;
}

// Enrich only rows already admitted by the caller's village visibility query.
export async function withVillageIcons<T extends { slug: string | null; kind: string }>(db: Db, rows: readonly T[]): Promise<Array<T & { iconUrl: string }>> {
  const shared = rows.flatMap(v => v.kind !== "personal" && v.slug ? [v.slug] : []);
  const handles = rows.flatMap(v => v.kind === "personal" && v.slug?.startsWith("@") ? [v.slug.slice(1)] : []);
  const [places, people] = await Promise.all([
    shared.length ? db.select({ slug: villages.slug, kind: villages.kind, language: villages.language, iconMediaId: villages.iconMediaId }).from(villages).where(inArray(villages.slug, shared)) : [],
    handles.length ? db.select({ handle: profiles.handle, publicId: profiles.publicId, avatarMediaId: profiles.avatarMediaId }).from(profiles).where(inArray(profiles.handle, handles)) : [],
  ]);
  const urls = new Map<string | null, string>(places.map(v => [v.slug, villageIconUrl(v)]));
  for (const person of people) urls.set(`@${person.handle}`, villageIconUrl({ kind: "personal", ...person }));
  return rows.map(row => ({ ...row, iconUrl: urls.get(row.slug) ?? VILLAGE_ICON }));
}

export async function requireVillageIconOwner(db: Db, userId: string, slug: string) {
  const [place] = await db.select().from(villages).where(eq(villages.slug, slug.toLowerCase())).for("update");
  if (!place || !isSharedVillageKind(place.kind) || place.language || place.endedAt) throw new MediaError("generic", 404);
  const [owner] = await db.select({ id: villageMembers.userId }).from(villageMembers).where(and(eq(villageMembers.villageId, place.id), eq(villageMembers.userId, userId), eq(villageMembers.role, "owner")));
  if (!owner) throw new MediaError("generic", 403);
  return place;
}

export async function setVillageIcon(db: Db, userId: string, slug: string, image: { bytes: Buffer; width: number; height: number } | null) {
  if (image && (image.width !== AVATAR_EDGE || image.height !== AVATAR_EDGE)) throw new MediaError("generic");
  return db.transaction(async tx => {
    // Match image admission and account deletion: site, account, profile, village.
    await tx.execute(sql`select pg_advisory_xact_lock(732105, 1)`);
    // Notification foreign keys may take a key-share lock while moderation owns the village.
    const [account] = await tx.select({ id: user.id }).from(user).where(eq(user.id, userId)).for("no key update");
    const [person] = await tx.select({ handle: profiles.handle, suspendedUntil: profiles.suspendedUntil }).from(profiles).where(eq(profiles.userId, userId)).for("update");
    if (!account || !person || person.suspendedUntil && person.suspendedUntil > new Date()) throw new MediaError("generic", 403);
    const place = await requireVillageIconOwner(tx, userId, slug);
    const saved = image ? await putMedia(tx, userId, image, { avatar: true, villageId: place.id }) : null;
    const id = saved ? parseMediaPath(saved.url)!.id : null;
    await tx.update(villages).set({ iconMediaId: id, iconActionId: null }).where(eq(villages.id, place.id));
    await tx.insert(villageEvents).values({ villageId: place.id, actorId: userId, actorHandle: person.handle, action: "icon", detail: {} });
    if (place.iconMediaId && place.iconMediaId !== id) {
      const [report] = await tx.select({ id: reports.id }).from(reports).where(eq(reports.iconMediaId, place.iconMediaId)).limit(1);
      const [action] = await tx.select({ id: moderationActions.id }).from(moderationActions).where(eq(moderationActions.iconMediaIdBefore, place.iconMediaId)).limit(1);
      if (!report && !action) await deleteMedia(tx, place.iconMediaId);
    }
    return { url: villageIconUrl({ ...place, iconMediaId: id }), uploaded: id !== null };
  });
}

export async function exportVillageIcons(db: Db, userId: string) {
  if (!villagesEnabled()) return [];
  const rows = await db.select({ village: villages.slug, bytes: media.bytes }).from(villageMembers)
    .innerJoin(villages, eq(villages.id, villageMembers.villageId)).innerJoin(media, eq(media.id, villages.iconMediaId))
    .where(and(eq(villageMembers.userId, userId), eq(villageMembers.role, "owner"), isNull(media.deletedAt)));
  return rows.flatMap(row => row.bytes ? [{ village: row.village, mime: "image/webp" as const, base64: row.bytes.toString("base64") }] : []);
}
