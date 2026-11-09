import type { Lang } from "~/lib/languages";
import { withoutResolvedMentions } from "~/lib/mention-syntax";
import { proseOf } from "./structure.core.server";
import { chatParts } from "../village-chat";

// Detect a translation that is a copy of the source, exactly or nearly (used by looksUntranslated).
// Only the prose is compared (code, math, URLs and @mentions removed: proseOf). A translation is a near copy when
// 1. script: it contains almost no letters of the target language's script (kana for ja, Hangul for ko, Thai for th, Han for zh, Latin for en/fr/de/vi),
//    for example a Traditional Chinese post "translated" into Japanese that comes back as mostly Chinese. Not used when the source is already mostly in that script;
// 2. similarity: the character-bigram Dice coefficient to the source is very high (the source came back with a few words changed). Digits do not count, and when the
//    source and the target use different scripts only the characters of the source's script count, so numbers, names and quotations that are the same on both sides
//    (a Japanese post with a long English quotation) do not make a real translation look like a copy.
// Correct translations that look alike must not be flagged: zh-Hans and zh-Hant (the caller skips that pair), cognates in en/fr/de, and short texts that are
// mostly names, model numbers, code, math or URLs. So both checks run only when the text has enough "content letters" (letters of words that are not names
// or identifiers), and the similarity line is far above what real translations reach (0.3-0.6 for en to fr).

// Minimum content letters for an exact copy (after whitespace normalization) to count as untranslated. Below that, the text is a short title or a name list.
export const EXACT_MIN_CONTENT_LETTERS = 20;
// Minimum content letters for the near-copy checks.
export const NEAR_MIN_CONTENT_LETTERS = 40;
// Dice coefficient at or above which the translation is a near copy.
export const NEAR_COPY_SIMILARITY = 0.85;
// A translation shorter than this share of the source's letters is not a copy of it (it is some other kind of bad output, which other checks handle).
const NEAR_MIN_LENGTH_RATIO = 0.3;
// Minimum share of the target script among the letters of the translation. Real Japanese has 40% or more kana (particles); 56 real en to ja translations
// measured 0.58 at the lowest on 2026-10-01. Chinese measured 0.68 at the lowest. Hangul and Thai are nearly all of the letters, and Latin text is all Latin.
export const TARGET_SCRIPT_MIN_SHARE: Partial<Record<Lang, number>> = { ja: 0.2, "zh-Hans": 0.2, "zh-Hant": 0.2, ko: 0.2, th: 0.2, en: 0.5, fr: 0.5, de: 0.5, vi: 0.5 };
// The script check is skipped when the source itself has at least this share of the target script (a post declared as ja but written in English, translated to en).
const SOURCE_ALREADY_IN_SCRIPT = 0.5;

// The script(s) a language is written in, to tell whether source and target use different ones (zh-Hans and zh-Hant are both Han).
const LANG_SCRIPT_CHARS: Record<Lang, RegExp> = {
  ja: /[\p{scx=Hiragana}\p{scx=Katakana}\p{scx=Han}]/u,
  "zh-Hans": /\p{scx=Han}/u,
  "zh-Hant": /\p{scx=Han}/u,
  ko: /\p{scx=Hangul}/u,
  th: /\p{scx=Thai}/u,
  en: /\p{scx=Latin}/u,
  fr: /\p{scx=Latin}/u,
  de: /\p{scx=Latin}/u,
  vi: /\p{scx=Latin}/u,
};
const scriptName = (lang: Lang) => (lang === "ja" ? "ja" : lang === "zh-Hans" || lang === "zh-Hant" ? "han" : lang === "ko" ? "ko" : lang === "th" ? "th" : "latin");

const SCRIPT: Record<Lang, RegExp> = {
  ja: /[\p{scx=Hiragana}\p{scx=Katakana}]/gu,
  "zh-Hans": /\p{scx=Han}/gu,
  "zh-Hant": /\p{scx=Han}/gu,
  ko: /\p{scx=Hangul}/gu,
  th: /\p{scx=Thai}/gu,
  en: /\p{scx=Latin}/gu,
  fr: /\p{scx=Latin}/gu,
  de: /\p{scx=Latin}/gu,
  vi: /\p{scx=Latin}/gu,
};

const lettersOf = (s: string) => s.replace(/[^\p{L}]/gu, "");
const countOf = (s: string, re: RegExp) => (s.match(re) ?? []).length;

// Number of letters of the words that are not names or identifiers: Latin-script words that start with an uppercase letter or contain a digit or "_" are dropped
// (GPT-4o, Claude, RLHF, snake_case). A sentence-initial word is dropped too, which does not matter for a text long enough to be judged. Scripts without case
// (kana, Han, Hangul, Thai) are counted as they are.
export function contentLetters(prose: string): number {
  const words = prose.replace(/[\p{scx=Latin}\p{N}_][\p{scx=Latin}\p{N}_'’-]*/gu, (word) => (/^\p{Lu}|[\p{N}_]/u.test(word) ? " " : word));
  return lettersOf(words).length;
}

// Dice coefficient (0 to 1) of the character bigrams of two texts, ignoring case, whitespace, punctuation and digits (a table of numbers is not a copy of another one
// just because the numbers are the same). onlyChars: count only the characters that match (the source's script).
export function bigramDice(a: string, b: string, onlyChars?: RegExp): number {
  const grams = (s: string) => {
    const letters = s.normalize("NFKC").toLowerCase().replace(/[^\p{L}]/gu, "");
    const chars = [...letters].filter((c) => onlyChars === undefined || onlyChars.test(c));
    const out = new Map<string, number>();
    for (let i = 0; i + 1 < chars.length; i++) {
      const g = chars[i] + chars[i + 1];
      out.set(g, (out.get(g) ?? 0) + 1);
    }
    return { out, total: Math.max(0, chars.length - 1) };
  };
  const x = grams(a);
  const y = grams(b);
  if (x.total === 0 || y.total === 0) return 0;
  let shared = 0;
  for (const [g, n] of x.out) shared += Math.min(n, y.out.get(g) ?? 0);
  return (2 * shared) / (x.total + y.total);
}

// Share of the target script among the letters of the text (0 when there are no letters). For a target in a non-Latin script the Latin letters are left out of the
// count: a Japanese or Chinese translation keeps names, model numbers and English terms, or a whole quotation, in Latin letters, and that is not a sign of an untranslated text.
function scriptShare(text: string, lang: Lang): number {
  const letters = scriptName(lang) === "latin" ? lettersOf(text) : lettersOf(text).replace(/\p{scx=Latin}/gu, "");
  return letters === "" ? 0 : countOf(letters, SCRIPT[lang]) / [...letters].length;
}

export type CopyVerdict = { copy: boolean; reason?: "identical" | "script" | "similar" };

// Is the translation a copy of the source (identical or nearly)? The caller excludes the same language, the zh-Hans/zh-Hant pair, and short sources.
// near: false skips the two near-copy checks (the fake engine writes "[ja] original", which is a near copy by construction); an identical copy is still found.
// Structure inspection separately catches gross omissions using prose-length ratios and block counts.
// A translation that is only part translated (the first half French, the second half still English) is not found: its similarity to the source is about 0.5, far below
// NEAR_COPY_SIMILARITY, and it has Latin letters, which the script check for a Latin target does not count against it.
export function detectCopy(source: string, translated: string, from: Lang, to: Lang, opts: { near?: boolean; mentions?: readonly string[]; plainText?: boolean } = {}): CopyVerdict {
  // The @mentions are names that the translation keeps as written: they are not content, and must not make a translation look like a copy.
  const prose = opts.plainText ? (text: string) => chatParts(text).filter(part => part.type !== "link").map(part => part.text).join("") : proseOf;
  const a = withoutResolvedMentions(prose(source), opts.mentions);
  const b = withoutResolvedMentions(prose(translated), opts.mentions);
  const content = contentLetters(a);
  const normalize = (s: string) => s.replace(/\s+/g, " ").trim();
  if (normalize(source) === normalize(translated)) return content >= EXACT_MIN_CONTENT_LETTERS ? { copy: true, reason: "identical" } : { copy: false };
  if (opts.near === false || content < NEAR_MIN_CONTENT_LETTERS) return { copy: false };
  if (lettersOf(b).length < NEAR_MIN_LENGTH_RATIO * lettersOf(a).length) return { copy: false };

  // A Japanese translation without kana and without a sentence-final mark is a list of nouns (a Chinese list of terms becomes a list of kanji terms): not a sign of a copy.
  // A Chinese text that came back as it was has sentences, so it has a final mark.
  const nounList = to === "ja" && !/[。．.!?！？]/.test(b);
  const minShare = TARGET_SCRIPT_MIN_SHARE[to];
  if (minShare !== undefined && !nounList && scriptShare(a, to) < SOURCE_ALREADY_IN_SCRIPT && scriptShare(b, to) < minShare) return { copy: true, reason: "script" };
  // Similarity: over the characters of the source's script when the scripts differ, over all letters when they are the same.
  const onlySourceScript = scriptName(from) === scriptName(to) ? undefined : LANG_SCRIPT_CHARS[from];
  if (from !== to && bigramDice(a, b, onlySourceScript) >= NEAR_COPY_SIMILARITY) return { copy: true, reason: "similar" };
  return { copy: false };
}
