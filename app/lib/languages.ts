export const LANGS = ["ja", "en", "fr", "de", "zh-Hant", "zh-Hans", "ko", "th", "vi"] as const;
export type Lang = (typeof LANGS)[number];

export const SOURCE_LANGS = [...LANGS, "other"] as const;
export type SourceLang = typeof SOURCE_LANGS[number];
export type LangSource = "explicit" | "detected" | "default" | "checked";
export const isSourceLang = (value: unknown): value is SourceLang => value === "other" || isLang(value);

export const LATIN_SCRIPT_LANGS: readonly string[] = ["en", "fr", "de", "vi"] satisfies readonly Lang[];

export const AREAS = [...LANGS, "other"] as const;
export type Area = (typeof AREAS)[number];

// Language autonyms, never translated, shown in interface switching, home-area selection, readable languages, etc.
export const LANG_LABELS: Record<Lang, string> = {
  ja: "日本語",
  en: "English",
  fr: "Français",
  de: "Deutsch",
  "zh-Hant": "繁體中文",
  "zh-Hans": "简体中文",
  ko: "한국어",
  th: "ไทย",
  vi: "Tiếng Việt",
};

// Name languages by script, not country/region. Choices use LANG_LABELS autonyms: 简体中文, 繁體中文. For names in the reader's language,
// such as language composition, pass BCP 47 zh-Hans/zh-Hant directly to Intl.DisplayNames. languageDisplay: "standard" yields Japanese 「中国語 (簡体字)」「中国語 (繁体字)」
// and English 「Chinese (Simplified)」「Chinese (Traditional)」; default "dialect" yields Japanese 「簡体中国語」. Never name languages using zh-CN, zh-TW, 「台湾語」, or other country/region names.
const displayNames = new Map<string, Intl.DisplayNames>();
export function languageName(lang: Lang, inLocale: string): string {
  let names = displayNames.get(inLocale);
  if (!names) {
    names = new Intl.DisplayNames([inLocale], { type: "language", languageDisplay: "standard" });
    displayNames.set(inLocale, names);
  }
  return names.of(lang) ?? LANG_LABELS[lang];
}

export function isLang(x: unknown): x is Lang {
  return typeof x === "string" && (LANGS as readonly string[]).includes(x);
}

export function isArea(x: unknown): x is Area {
  return typeof x === "string" && (AREAS as readonly string[]).includes(x);
}

// Reads the value of ENABLED_LANGS (the languages the site uses, a subset of the nine that the software supports).
// Unset, empty or blank means all nine (the default for development and tests; production must set it, see assertEnabledLangsConfigured).
// Comma separated; surrounding spaces are ignored and tags match LANGS case-insensitively ("zh-hant" is accepted); duplicates collapse to one;
// empty segments ("ja,,en", a trailing comma) are skipped. The result follows the order of LANGS, not the order written, so every choice list is in the same order.
// An unknown tag is an error, and so is a value that names no language at all (",").
export function parseEnabledLangs(raw: string | undefined): { ok: true; langs: Lang[] } | { ok: false; error: string } {
  if (raw === undefined || raw.trim() === "") return { ok: true, langs: [...LANGS] };
  const byLower = new Map<string, Lang>(LANGS.map((l) => [l.toLowerCase(), l]));
  const wanted = new Set<Lang>();
  const unknown: string[] = [];
  for (const part of raw.split(",")) {
    const tag = part.trim();
    if (tag === "") continue;
    const lang = byLower.get(tag.toLowerCase());
    if (lang) wanted.add(lang);
    else unknown.push(tag);
  }
  if (unknown.length > 0) {
    const chinese = unknown.some((t) => /^zh(-|$)/i.test(t)) ? ' (Chinese is named by script: "zh-Hans" for Simplified, "zh-Hant" for Traditional)' : "";
    return { ok: false, error: `ENABLED_LANGS has unknown language tag(s): ${unknown.join(", ")}. The supported tags are: ${LANGS.join(", ")}${chinese}` };
  }
  if (wanted.size === 0) return { ok: false, error: `ENABLED_LANGS names no language. Use a comma-separated list of: ${LANGS.join(", ")}` };
  return { ok: true, langs: LANGS.filter((l) => wanted.has(l)) };
}

// The language to use when nothing else decides, for a list of enabled languages (never empty): en if it is enabled, otherwise the first enabled language.
export function defaultLangOf(langs: readonly Lang[]): Lang {
  return langs.includes("en") ? "en" : langs[0];
}
