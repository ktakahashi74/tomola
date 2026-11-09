import { withVillageIcons } from "./village-icon.server";
import type { Db } from "./db/client.server";
import { villagesEnabled } from "./villages-enabled.server";
import { listJoinedVillages, type PublicVillage } from "./villages.server";
import { villageChatEnabled } from "./village-chat-enabled.server";
import { chatUnreadCounts } from "./village-chat.server";
import { chatMentionCounts } from "./village-chat-notifications.server";
import { localizeVillages } from "./village-translations.server";
import type { VillageReader, WithVillageTranslation } from "./village-translation-view";

export type JoinedVillageNavigation = Pick<PublicVillage, "name" | "slug" | "kind" | "language"> & WithVillageTranslation & { iconUrl?: string; unread?: number; mentions?: number; chatAvailable?: boolean };

// Shared by navigation surfaces. Closed chat never requests unread counts.
export async function joinedVillageNavigation(db: Db, userId: string, reader?: VillageReader): Promise<JoinedVillageNavigation[]> {
  if (!villagesEnabled()) return [];
  const joined = await withVillageIcons(db, (await localizeVillages(db, (await listJoinedVillages(db, userId)).map(({ name, slug, kind, language }) => ({ name, slug, kind, language })), reader)));
  if (!villageChatEnabled()) return joined;
  const [unread, mentions] = await Promise.all([chatUnreadCounts(db, userId, { excludeEnded: true }), chatMentionCounts(db, userId)]);
  return joined.map(village => ({ ...village, chatAvailable: unread.has(village.slug!), unread: unread.get(village.slug!) ?? 0, mentions: mentions.get(village.slug!) ?? 0 }));
}
