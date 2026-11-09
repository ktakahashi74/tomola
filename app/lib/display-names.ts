import { LATIN_SCRIPT_LANGS } from "./languages";

export type DisplayNames = { displayName: string | null; displayNameLatin: string | null };
type NameSource = Partial<DisplayNames> & { homeArea?: string | null };
export type DisplayNamePresentation = { name: string | null; latin: string | null };

// Keep native Han spelling across Japanese and Chinese screens, without converting characters.
export function displayNamePresentation(names: NameSource | undefined, locale: string): DisplayNamePresentation {
  const native = names?.displayName || null, latin = names?.displayNameLatin || null;
  if (locale === names?.homeArea) return { name: native ?? latin, latin: null };
  const hanLanguages: readonly string[] = ["ja", "zh-Hans", "zh-Hant"];
  if (hanLanguages.includes(locale) && hanLanguages.includes(names?.homeArea ?? "") && native
    && /\p{Script=Han}/u.test(native) && /^[\p{Script=Han}\s·・]+$/u.test(native)) {
    return { name: native, latin: latin !== native ? latin : null };
  }
  return { name: latin ?? native, latin: null };
}

export function singleDisplayNameField(names: NameSource): boolean {
  return LATIN_SCRIPT_LANGS.includes(names.homeArea ?? "")
    && !(names.displayName && names.displayNameLatin && names.displayName !== names.displayNameLatin);
}
