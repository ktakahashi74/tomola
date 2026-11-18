import { and, asc, eq, isNotNull, or } from "drizzle-orm";
import type { Db } from "./db/client.server";
import { villages, villageTranslations } from "./db/schema";
import { handleKey } from "./handles";
import type { Lang } from "./languages";
import { textSubstringMatch } from "./member-matching.server";
import { villageName } from "./village-name";
import { villageSourceHash } from "./village-translations.server";
import { activeSharedVillageCondition } from "./villages.server";

export async function searchVillages(db: Db, query: string, displayLang: Lang) {
  const key = handleKey(query);
  if (!key.trim()) return [];
  const found = await db.select({ village: villages, translation: villageTranslations }).from(villages)
    .leftJoin(villageTranslations, and(eq(villageTranslations.villageId, villages.id), eq(villageTranslations.lang, displayLang), eq(villageTranslations.state, "ready")))
    .where(and(activeSharedVillageCondition(), or(
      textSubstringMatch(villages.name, query), textSubstringMatch(villages.description, query),
      textSubstringMatch(villageTranslations.name, query), textSubstringMatch(villageTranslations.description, query),
      // Language village names are generated in the interface language, not stored.
      isNotNull(villages.language),
    )))
    .orderBy(asc(villages.slug));
  const matches = (text: string | null | undefined) => !!text && handleKey(text).includes(key);
  return found.flatMap(({ village, translation }) => {
    const current = translation?.sourceHash === villageSourceHash(village) ? translation : null;
    const nameMatches = matches(villageName(village, displayLang)) || matches(current?.name);
    if (!nameMatches && !matches(village.description) && !matches(current?.description)) return [];
    return [{ rank: nameMatches ? 0 : 1, slug: village.slug!, language: village.language, kind: village.kind, name: current?.name ?? village.name }];
  })
    // Validate fingerprints before ranking and limiting: stale rows cannot hide valid hits.
    .sort((a, b) => a.rank - b.rank)
    .slice(0, 10)
    .map(({ rank: _rank, ...row }) => row);
}
