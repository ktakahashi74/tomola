import type { Lang } from "~/lib/languages";
import { m } from "~/paraglide/messages.js";
import { getLocale, type Locale } from "~/paraglide/runtime.js";

// Post metadata uses messages so server and browser share the same language names.
// Language selectors continue to use autonyms.
export function languageLabel(lang: Lang): string {
  return localizedLanguageLabel(lang, getLocale());
}

export function localizedLanguageLabel(lang: Lang, locale: Locale): string {
  const labels = {
    ja: m.language_name_ja, en: m.language_name_en, fr: m.language_name_fr,
    de: m.language_name_de, "zh-Hant": m.language_name_zh_hant,
    "zh-Hans": m.language_name_zh_hans, ko: m.language_name_ko,
    th: m.language_name_th, vi: m.language_name_vi,
  };
  return labels[lang]({}, { locale });
}
