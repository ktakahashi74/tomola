import { isLang, type Lang } from "~/lib/languages";

// A preview hint never chooses the screen language or travels to other pages.
export const SHARE_LANG_PARAM = "sl";

export function shareLanguageHint(search: string, enabled: readonly string[] | null, includeMarker = true): { param: string; lang: Lang } | null {
  const params = new URLSearchParams(search);
  for (const param of includeMarker ? ["lang", SHARE_LANG_PARAM] : ["lang"]) {
    const lang = params.get(param);
    if (isLang(lang) && (!enabled || enabled.includes(lang))) return { param, lang };
  }
  return null;
}
