import { withVillageIcons } from "./village-icon.server";
import type { Db } from "./db/client.server";
import { villagesEnabled } from "./villages-enabled.server";
import { listJoinedVillages, publicVillage, villageSlug, type PublicVillage } from "./villages.server";
import { personalVillage } from "./personal-villages.server";
import { villageChatEnabled } from "./village-chat-enabled.server";
import { chatUnreadCounts } from "./village-chat.server";
import { chatMentionCounts } from "./village-chat-notifications.server";
import { localizeVillages } from "./village-translations.server";
import type { VillageReader, WithVillageTranslation } from "./village-translation-view";

export type JoinedVillageNavigation = Pick<PublicVillage, "name" | "slug" | "kind" | "language"> & WithVillageTranslation & { iconUrl?: string; unread?: number; mentions?: number; chatAvailable?: boolean };

// The member's own entrance is shared by the places list and village directory.
export async function ownVillageNavigation(db: Db, userId: string): Promise<PublicVillage | null> {
  if (!villagesEnabled()) return null;
  const village = await personalVillage(db, userId);
  if (!village || village.endedAt) return null;
  const slug = await villageSlug(db, village.id);
  return slug ? { ...publicVillage(village), slug } : null;
}

// Shared by navigation surfaces. Closed chat never requests unread counts.
export async function joinedVillageNavigation(db: Db, userId: string, reader?: VillageReader): Promise<JoinedVillageNavigation[]> {
  if (!villagesEnabled()) return [];
  const [own, places] = await Promise.all([ownVillageNavigation(db, userId), listJoinedVillages(db, userId)]);
  if (own) places.unshift(own);
  const joined = await withVillageIcons(db, await localizeVillages(db, places.map(({ name, slug, kind, language }) => ({ name, slug, kind, language })), reader));
  if (!villageChatEnabled()) return joined;
  const [unread, mentions] = await Promise.all([chatUnreadCounts(db, userId, { excludeEnded: true }), chatMentionCounts(db, userId)]);
  return joined.map(village => village.kind === "personal" ? village : ({ ...village, chatAvailable: unread.has(village.slug!), unread: unread.get(village.slug!) ?? 0, mentions: mentions.get(village.slug!) ?? 0 }));
}
