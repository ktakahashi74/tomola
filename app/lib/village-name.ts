import { isLang } from "~/lib/languages";
import { localizedLanguageLabel } from "~/lib/language-label";
import { m } from "~/paraglide/messages.js";
import { getLocale, type Locale } from "~/paraglide/runtime.js";

export function villageName(village: { language: string | null; name: string; kind?: string }, locale: Locale = getLocale()): string {
  return village.name || (village.kind === "personal" ? m.village_personal({}, { locale }) : isLang(village.language) ? m.village_language_name({ language: localizedLanguageLabel(village.language, locale) }, { locale }) : "");
}

export function postingVillageName(village: { language: string | null; name: string; kind?: string; slug: string | null }, ownHandle: string | null, locale: Locale = getLocale()): string {
  return village.kind === "personal" && ownHandle && village.slug === `@${ownHandle}`
    ? m.village_personal_destination({ handle: ownHandle }, { locale })
    : villageName(village, locale);
}

export function villagePath(slug: string | null): string {
  return slug?.startsWith("@") ? `/u/${slug.slice(1)}` : `/v/${slug}`;
}
