import { LANG_LABELS, type Lang } from "~/lib/languages";

// Editions of the public principles; additional editions do not open a posting or interface language.
export const PRINCIPLES_LANGS = ["ja", "en", "fr", "de", "zh-Hant", "zh-Hans", "ko", "th", "vi", "es", "pt", "ru", "ar", "hi", "id", "bn", "ur"] as const;
export type PrinciplesLang = (typeof PRINCIPLES_LANGS)[number];

export const PRINCIPLES_LANG_LABELS: Record<PrinciplesLang, string> = {
  ...LANG_LABELS,
  es: "Español",
  pt: "Português",
  ru: "Русский",
  ar: "العربية",
  hi: "हिन्दी",
  id: "Bahasa Indonesia",
  bn: "বাংলা",
  ur: "اردو",
};

export function principlesDirection(lang: PrinciplesLang): "rtl" | "ltr" {
  return lang === "ar" || lang === "ur" ? "rtl" : "ltr";
}

export function principlesLanguageGroups(enabled: readonly Lang[], available: readonly PrinciplesLang[] = PRINCIPLES_LANGS) {
  const open = new Set<string>(enabled);
  const ordered = [...available].sort((a, b) => a === b ? 0 : a === "ja" ? -1 : b === "ja" ? 1 : a < b ? -1 : 1);
  return { open: ordered.filter(lang => open.has(lang)), readOnly: ordered.filter(lang => !open.has(lang)) };
}
