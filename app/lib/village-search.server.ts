import { and, asc, eq, gt, isNotNull, or } from "drizzle-orm";
import type { Db } from "./db/client.server";
import { villages, villageTranslations } from "./db/schema";
import { handleKey } from "./handles";
import type { Lang } from "./languages";
import { textSubstringMatch } from "./member-matching.server";
import { villageName } from "./village-name";
import { villageSourceHash } from "./village-translations.server";
import { activeSharedVillageCondition } from "./villages.server";

type VillageMatch = Pick<typeof villages.$inferSelect, "slug" | "kind" | "name" | "description" | "language"> & { slug: string };
const RESULT_LIMIT = 10;
const CANDIDATE_BATCH_SIZE = 50;

export async function searchVillages(db: Db, query: string, displayLang: Lang) {
  const key = handleKey(query);
  if (!key.trim()) return [];
  const matches = (text: string | null | undefined) => !!text && handleKey(text).includes(key);
  const names: VillageMatch[] = [];
  const descriptions: VillageMatch[] = [];
  let after: string | undefined;
  // Read bounded batches in slug order. Later name matches must still outrank earlier description matches.
  while (names.length < RESULT_LIMIT) {
    const found = await db.select({ village: villages, translation: villageTranslations }).from(villages)
      .leftJoin(villageTranslations, and(eq(villageTranslations.villageId, villages.id), eq(villageTranslations.lang, displayLang), eq(villageTranslations.state, "ready")))
      .where(and(activeSharedVillageCondition(), after === undefined ? undefined : gt(villages.slug, after), or(
        textSubstringMatch(villages.name, query), textSubstringMatch(villages.description, query),
        textSubstringMatch(villageTranslations.name, query), textSubstringMatch(villageTranslations.description, query),
        // Language village names are generated in the interface language, not stored.
        isNotNull(villages.language),
      )))
      .orderBy(asc(villages.slug)).limit(CANDIDATE_BATCH_SIZE);
    for (const { village, translation } of found) {
      const current = translation?.sourceHash === villageSourceHash(village) ? translation : null;
      const nameMatches = matches(villageName(village)) || matches(current?.name);
      if (!nameMatches && !matches(village.description) && !matches(current?.description)) continue;
      const hits = nameMatches ? names : descriptions;
      // Return original texts; the page applies the directory's reader-specific localization.
      if (hits.length < RESULT_LIMIT) hits.push({ slug: village.slug!, language: village.language, kind: village.kind, name: village.name, description: village.description });
      if (names.length === RESULT_LIMIT) break;
    }
    if (found.length < CANDIDATE_BATCH_SIZE) break;
    after = found.at(-1)!.village.slug!;
  }
  return [...names, ...descriptions].slice(0, RESULT_LIMIT);
}
