import type { Lang, SourceLang } from "~/lib/languages";

// ui: the language of the screen when it comes from the address (a shared ?lang= link, or an earlier choice that pinned it), otherwise null (cookie, browser language, default).
export type ReadingLanguageChoice = { current: Lang; usual: Lang; enabled: readonly Lang[]; ui?: Lang | null };

// Marks an address that a reader reached by pressing a reading language on the page (not one that someone sent). The reading language then only decides which language the
// posts are read in; the language of the screen (menus and labels) is left as it was. The value is "1" (the screen follows the cookie or the browser, as before) or a language
// (the screen was in that language only because of the address, and stays in it: rl=fr). An address without the mark keeps the old meaning: for a reader with no language cookie,
// a shared ?lang= link also sets the language of the screen. Links that carry ?lang= to the next page copy the mark (carriedLang).
export const READING_ONLY_PARAM = "rl";
const MARK_VALUE = /^(?:1|[A-Za-z]{2,3}(?:-[A-Za-z]{2,4})?)$/;

// Keep the current filters and order, but return to page one. The usual language
// needs no page override and restores the reader's original-reading preferences,
// unless the language of the screen comes from the address: then the choice keeps ?lang= and pins the screen with rl=<language of the screen>.
// With no usual language, every choice is explicit; article menus use this for
// translations, while an original-language choice keeps the usual reset behavior.
export function readingLangSearch(search: string, target: Lang, usual: Lang | null, ui: Lang | null = null): string {
  const params = new URLSearchParams(search);
  params.delete("page");
  params.delete("manage");
  if (ui) {
    params.set("lang", target);
    params.set(READING_ONLY_PARAM, ui);
  } else if (target === usual) {
    params.delete("lang");
    params.delete(READING_ONLY_PARAM);
  } else {
    params.set("lang", target);
    params.set(READING_ONLY_PARAM, "1");
  }
  const next = params.toString();
  return next ? `?${next}` : "";
}

// An article language choice clears only that article's version override.
export function entryReadingLangSearch(search: string, target: Lang, choice: ReadingLanguageChoice, originalLang: SourceLang | undefined, entryId: number): string {
  const explicit = target === choice.usual && target !== originalLang;
  const params = new URLSearchParams(readingLangSearch(search, target, explicit ? null : choice.usual, choice.ui ?? null));
  for (const name of ["orig", "tr", "old"]) {
    const rest = params.getAll(name).filter(id => id !== String(entryId));
    params.delete(name);
    for (const id of rest) params.append(name, id);
  }
  const next = params.toString();
  return next ? `?${next}` : "";
}

// The mark of an address, as it may be copied: "1" or a language, nothing else.
export function readingOnlyMark(search: string): string | null {
  const value = new URLSearchParams(search).get(READING_ONLY_PARAM);
  if (value === null) return null;
  return MARK_VALUE.test(value) ? value : "1";
}

// Puts a carried language (see below) into a query, as lang= and, when it has the mark, rl=<mark>.
export function setCarriedLang(params: URLSearchParams, carried: string | null | undefined): void {
  if (!carried) return;
  const [lang, ...marks] = carried.split("&");
  params.set("lang", lang);
  const mark = marks.find(part => part.startsWith(`${READING_ONLY_PARAM}=`))?.slice(READING_ONLY_PARAM.length + 1);
  if (mark && MARK_VALUE.test(mark)) params.set(READING_ONLY_PARAM, mark);
}

// The value to put after `lang=` in a link that carries the reading language to another page: "fr", or "fr&rl=1" / "fr&rl=de" when this page itself was reached from a reading language choice.
export function carriedLang(lang: Lang | null, search: string): string | null {
  if (!lang) return null;
  const mark = readingOnlyMark(search);
  return mark ? `${lang}&${READING_ONLY_PARAM}=${mark}` : lang;
}
