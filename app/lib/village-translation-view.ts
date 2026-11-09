import type { Lang } from "~/lib/languages";

// What a page needs to say about the translation of a village's name and description. Present only when a current translation exists for the reader; `shown` says whether the
// name and description of the row are that translation (true) or the original (false, the reader asked for it). The row's own name and description are the ones that are shown.
export type VillageTranslationInfo = { from: Lang; shown: boolean; originalName: string; originalDescription: string };
export type WithVillageTranslation = { translation?: VillageTranslationInfo };

// The original name, for a tooltip beside a translated one: nothing when the name is the original (or only the description was translated).
export function villageNameTitle(village: { name: string } & WithVillageTranslation): string | undefined {
  const info = village.translation;
  return info?.shown && info.originalName && info.originalName !== village.name ? info.originalName : undefined;
}

// The language a reader wants things translated into, and the languages they read in the original (as for posts: wantsTranslation in display.ts).
export type VillageReader = { displayLang: Lang; readLangs: readonly Lang[] };

// The language of the name when the original is shown while a translation exists (the reader asked for it): the reader's language is that of the screen, the name's is the original's.
export function villageNameLang(village: WithVillageTranslation): Lang | undefined {
  return village.translation && !village.translation.shown ? village.translation.from : undefined;
}
