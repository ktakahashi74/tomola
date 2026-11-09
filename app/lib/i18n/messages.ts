import { LANGS, type Lang } from "~/lib/languages";

// Validate interface message keys and inputs (`{name}`) in Paraglide-format messages/<language>.json.
// `pnpm i18n:translate` runs the same validation before accepting engine translations. `pnpm i18n:translate --check` and tests/i18n.test.ts validate saved files
// for missing/extra keys, mismatched inputs, empty values, newline counts, and missing preserved terms. Simple strings and cardinal-plural message-format variants are supported.

// Authoritative source and reference language. Generate the other seven languages from the source.
export const SOURCE_LOCALE = "en";
export const REFERENCE_LOCALE = "ja";
// Engine-translated languages: LANGS minus source/reference languages.
export const TARGET_LOCALES: readonly Lang[] = LANGS.filter((l) => l !== SOURCE_LOCALE && l !== REFERENCE_LOCALE);
export const ALL_LOCALES: readonly Lang[] = [SOURCE_LOCALE, REFERENCE_LOCALE, ...TARGET_LOCALES];

export type PluralMessage = { declarations: string[]; selectors: string[]; match: Record<string, string> };
export type Message = string | PluralMessage[];
export type Messages = Record<string, Message>;
export function messageText(value: Message): string {
  return typeof value === "string" ? value : Object.values(value[0]?.match ?? {}).join("\n");
}
export function isMessage(value: unknown): value is Message {
  if (typeof value === "string") return true;
  if (!Array.isArray(value) || value.length !== 1) return false;
  const item = value[0];
  return item !== null && typeof item === "object" && Array.isArray(item.declarations) && item.declarations.every((d: unknown) => typeof d === "string") && Array.isArray(item.selectors) && item.selectors.every((d: unknown) => typeof d === "string") && item.match !== null && typeof item.match === "object" && !Array.isArray(item.match) && Object.values(item.match).every(v => typeof v === "string");
}

// Input names in `{name}`, deduplicated and sorted.
export function placeholders(text: Message): string[] {
  return [...new Set([...messageText(text).matchAll(/\{(\w+)\}/g)].map((m) => m[1]))].sort();
}

// Preserve these terms unchanged (product names, standards, environment variables, etc.). A term present at a source word boundary must also appear in the translation.
export const KEEP_TERMS = ["tomola", "Markdown", "API", "OpenAPI", "JSON", "URL", "UTC", "LLM", "ChatGPT", "Claude", "BETTER_AUTH_URL", "OPERATOR_EMAILS"] as const;

const containsTerm = (text: string, term: string) => new RegExp(`(?<![A-Za-z0-9_])${term}(?![A-Za-z0-9_])`).test(text);

// Common characters exclusive to simplified or traditional Chinese, detecting mixed scripts in translations. Confusing the scripts is a frequent model error.
const SIMPLIFIED_ONLY = [..."们这个说为发对开时会来过还点动学现关种经进实应问与无将并户请设载删档邮码链显该选择输确认账号隐复统计"];
const TRADITIONAL_ONLY = [..."們這個說為發對開時會來過還點動學現關種經進實應問與無將並戶請設載刪檔郵碼鏈顯該選擇輸確認賬號隱復統計"];

export type Problem = string;

// Allowed letter scripts (\p{L}) per language. Allow Latin everywhere for product names, keys, and abbreviations. Engines occasionally insert another script into a word
// such as Arabic within Vietnamese 「Vui lòng」 or Hangul within Thai. Input/newline validation misses these, so detect them here.
// Also allow script-neutral characters (Script=Common/Inherited), such as the long-vowel mark 「ー」.
const COMMON = "\\p{Script=Common}\\p{Script=Inherited}\\p{Script=Latin}";
const allow = (extra: string) => new RegExp(`^[${COMMON}${extra}]$`, "u");
const ALLOWED_SCRIPTS: Record<string, RegExp> = {
  en: allow(""),
  fr: allow(""),
  de: allow(""),
  vi: allow(""),
  ja: allow("\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}"),
  "zh-Hant": allow("\\p{Script=Han}"),
  "zh-Hans": allow("\\p{Script=Han}"),
  ko: allow("\\p{Script=Hangul}"),
  th: allow("\\p{Script=Thai}"),
};

// Distinct letters belonging to scripts disallowed for this language, if present.
export function foreignLetters(text: string, locale: string): string[] {
  const allowed = ALLOWED_SCRIPTS[locale];
  if (!allowed) return [];
  const found = new Set<string>();
  for (const ch of text) if (/^\p{L}$/u.test(ch) && !allowed.test(ch)) found.add(ch);
  return [...found];
}

// Validate one translation, returning issues (empty means pass). heuristics checks quality indicators such as script/copy errors. Set false for saved-file --check to avoid questioning manual corrections.
function validatePattern(source: string, translated: string, opts: { locale?: string; heuristics?: boolean } = {}): Problem[] {
  const problems: Problem[] = [];
  if (typeof translated !== "string" || translated.trim() === "") return ["empty"];
  const want = placeholders(source);
  const got = placeholders(translated);
  if (JSON.stringify(want) !== JSON.stringify(got)) {
    problems.push(`placeholders: expected {${want.join("}, {")}} but found {${got.join("}, {")}} (keep every {name} exactly as written, do not translate or rename it)`);
  }
  // Newline counts: keep single-line messages single-line and preserve paragraph structure/blank lines in email bodies.
  const lines = (s: string) => s.split("\n").length;
  if (lines(source) !== lines(translated)) problems.push(`line breaks: expected ${lines(source)} line(s) but found ${lines(translated)}`);
  if (source === source.trim() && translated !== translated.trim()) problems.push("leading or trailing whitespace");
  for (const term of KEEP_TERMS) {
    if (containsTerm(source, term) && !translated.includes(term)) problems.push(`the term "${term}" must be kept exactly as written`);
  }
  if (opts.locale) {
    const foreign = foreignLetters(translated, opts.locale);
    if (foreign.length > 0) problems.push(`script: characters of another writing system (${foreign.join(" ")}) in the middle of the text; write it only in the target language`);
  }
  if (opts.heuristics) {
    // An untranslated sentence returned verbatim, excluding inputs and preserved-term-only text. Check only sentences of at least four words; single words/short phrases may correctly retain spelling
    // such as French 「Notifications」 or German 「Original」.
    const letters = source.replace(/\{\w+\}/g, "").replace(new RegExp(KEEP_TERMS.join("|"), "g"), "");
    if (translated === source && letters.replace(/[^A-Za-z]/g, "").length > 12 && source.trim().split(/\s+/).length >= 4) problems.push("unchanged: the text was returned in English, not translated");
    if (opts.locale === "zh-Hant" && [...translated].some((c) => SIMPLIFIED_ONLY.includes(c))) problems.push("script: Traditional Chinese expected, but Simplified characters were found");
    if (opts.locale === "zh-Hans" && [...translated].some((c) => TRADITIONAL_ONLY.includes(c))) problems.push("script: Simplified Chinese expected, but Traditional characters were found");
    if (opts.locale === "ko" && letters.replace(/[^A-Za-z]/g, "").length > 12 && !/[가-힯]/.test(translated)) problems.push("script: Korean (Hangul) expected");
    if (opts.locale === "th" && letters.replace(/[^A-Za-z]/g, "").length > 12 && !/[฀-๿]/.test(translated)) problems.push("script: Thai expected");
    // Short Latin sequences inserted inside words, such as Thai 「ได้รับreการ」: rare engine errors. Thai/Korean Latin words use spaces or trailing particles, so they are not surrounded on both sides by same-script letters.
    const inner = opts.locale === "th" ? /[\u0E00-\u0E7F][A-Za-z]{1,3}[\u0E00-\u0E7F]/ : opts.locale === "ko" ? /[\uAC00-\uD7AF][A-Za-z]{1,3}[\uAC00-\uD7AF]/ : null;
    if (inner && inner.test(translated.replace(/\{\w+\}/g, " "))) problems.push("script: a few Latin letters in the middle of a word; write the word only in the target language");
    if ((opts.locale === "zh-Hant" || opts.locale === "zh-Hans") && letters.replace(/[^A-Za-z]/g, "").length > 12 && !/[一-鿿]/.test(translated)) problems.push("script: Chinese expected");
  }
  return problems;
}

// Validate every branch, not just the fallback. Japanese may use one invariant
// string; languages with plurals declare their own Intl.PluralRules categories.
export function validateMessage(source: Message, translated: Message, opts: { locale?: string; heuristics?: boolean } = {}): Problem[] {
  if (!isMessage(source) || !isMessage(translated)) return ["invalid message-format value"];
  const base = typeof source === "string" ? source : Object.values(source[0].match).at(-1) ?? "";
  if (typeof translated === "string") {
    if (typeof source !== "string" && new Intl.PluralRules(opts.locale ?? "en").resolvedOptions().pluralCategories.length > 1) return ["plural variants required for this language"];
    return validatePattern(base, translated, opts);
  }
  const plural = translated[0];
  const selector = plural.selectors[0];
  const input = /^local (\w+) = (\w+): plural$/.exec(plural.declarations.find(d => d.startsWith("local ")) ?? "");
  if (!input || input[1] !== selector || plural.selectors.length !== 1 || !plural.declarations.includes(`input ${input[2]}`) || !placeholders(base).includes(input[2])) return ["invalid plural declarations"];
  const categories = new Intl.PluralRules(opts.locale ?? "en").resolvedOptions().pluralCategories;
  const problems: string[] = [];
  for (const category of categories) if (!(`${selector}=${category}` in plural.match) && !(`${selector}=*` in plural.match)) problems.push(`missing plural category: ${category}`);
  for (const [match, pattern] of Object.entries(plural.match)) {
    if (!match.startsWith(selector + "=")) problems.push(`invalid plural selector: ${match}`);
    problems.push(...validatePattern(base, pattern, opts).map(p => `${match}: ${p}`));
  }
  return problems;
}

export type CheckProblem = { locale: string; key: string; problem: string };

// Validate saved messages: en/ja are complete; other languages may omit untranslated keys and use English at runtime.
// Existing translations must match inputs, contain text, and preserve line structure and terms.
// $schema is not a message.
export function checkMessages(files: Record<string, Messages>, opts: { source?: string; locales?: readonly string[]; strict?: boolean } = {}): CheckProblem[] {
  const sourceLocale = opts.source ?? SOURCE_LOCALE;
  const source = files[sourceLocale];
  const problems: CheckProblem[] = [];
  if (!source) return [{ locale: sourceLocale, key: "", problem: "the source file is missing" }];
  const keysOf = (m: Messages) => Object.keys(m).filter((k) => k !== "$schema");
  for (const locale of opts.locales ?? Object.keys(files)) {
    const messages = files[locale];
    if (!messages) {
      problems.push({ locale, key: "", problem: "the file is missing" });
      continue;
    }
    for (const key of keysOf(source)) {
      if (!(key in messages)) {
        if (locale === REFERENCE_LOCALE || opts.strict) problems.push({ locale, key, problem: "missing" });
      }
      else for (const problem of validateMessage(source[key], messages[key], { locale })) problems.push({ locale, key, problem });
    }
    for (const key of keysOf(messages)) if (!(key in source)) problems.push({ locale, key, problem: "extra (not in the source file)" });
  }
  return problems;
}

// File contents merging new translations into existing ones without changing existing values, in source-key order. Put $schema first.
export function mergeMessages(source: Messages, existing: Messages, added: Messages): Messages {
  const out: Messages = {};
  if (source.$schema !== undefined) out.$schema = source.$schema;
  for (const key of Object.keys(source)) {
    if (key === "$schema") continue;
    if (key in existing) out[key] = existing[key];
    else if (key in added) out[key] = added[key];
  }
  // Keep extra keys absent from the source at the end; --check reports them for a human deletion decision.
  for (const key of Object.keys(existing)) if (!(key in out) && key !== "$schema") out[key] = existing[key];
  return out;
}

// File contents replacing old translations only for added keys, leaving all others unchanged. Use source-key order.
export function replaceMessages(source: Messages, existing: Messages, replaced: Messages): Messages {
  const out = mergeMessages(source, existing, {});
  for (const key of Object.keys(replaced)) if (key in out) out[key] = replaced[key];
  return out;
}

export function missingKeys(source: Messages, existing: Messages): string[] {
  return Object.keys(source).filter((k) => k !== "$schema" && !(k in existing));
}
