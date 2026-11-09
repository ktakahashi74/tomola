import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "./db/client.server";
import { entries, villages } from "./db/schema";
import { listTopics } from "./entries.server";
import { loadTitleDisplays, type TitleDisplay } from "./entry-display.server";
import type { Lang } from "./languages";
import { publicVillage, publicPostVillageCondition, villageSlug, type PublicVillage } from "./villages.server";
import { villagesEnabled } from "./villages-enabled.server";
import { localizeVillage } from "./village-translations.server";
import type { WithVillageTranslation } from "./village-translation-view";

export type TopicContinuation = { village: PublicVillage & WithVillageTranslation; topics: Array<{ id: number; title: TitleDisplay }> };

export async function topicContinuation(db: Db, id: number, display: { readLangs: readonly Lang[]; displayLang: Lang }): Promise<TopicContinuation | null> {
  if (!villagesEnabled()) return null;
  const [row] = await db.select({ village: villages }).from(entries).innerJoin(villages, eq(entries.villageId, villages.id))
    .where(and(eq(entries.id, id), eq(entries.kind, "topic"), isNull(entries.hiddenAt), isNull(entries.deletedAt), publicPostVillageCondition()));
  if (!row) return null;
  const slug = await villageSlug(db, row.village.id);
  if (row.village.kind === "personal" && !slug) return null;
  // Public visibility is deliberate, including when the current reader moderates this village.
  const page = await listTopics(db, { kind: "village", villageId: row.village.id }, { limit: 4, order: "created" });
  const topics = page.topics.filter(topic => topic.id !== id).slice(0, 3);
  const titles = await loadTitleDisplays(db, topics, display, true);
  return { village: await localizeVillage(db, { ...publicVillage(row.village), slug, ...(row.village.kind === "personal" ? { name: slug ?? "" } : {}) }, display), topics: topics.map(topic => ({ id: topic.id, title: titles.get(topic.id)! })) };
}
