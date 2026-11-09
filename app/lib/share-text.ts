import type { Lang } from "~/lib/languages";

// Text for the shared preview of a page (Open Graph and the description): how long a description is for a language, where it is cut, and the locale name a preview carries.
// Pure and free of server code, so a route's `meta` can use it on the server and in the browser.

// A description is a few lines in a chat or social feed. The budget counts characters as a reader does (grapheme clusters). Scripts that are written without spaces, or that pack
// a word into one block, get fewer characters for the same width.
const WIDE: ReadonlySet<string> = new Set(["ja", "zh-Hans", "zh-Hant", "ko"]);
export function previewBudget(lang: string): number {
  return WIDE.has(lang) ? 120 : lang === "th" ? 140 : 160;
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
function countGraphemes(text: string): number {
  let n = 0;
  for (const _ of graphemes.segment(text)) n++;
  return n;
}

function wordSegmenter(lang: string): Intl.Segmenter {
  try { return new Intl.Segmenter(lang, { granularity: "word" }); }
  catch { return new Intl.Segmenter(undefined, { granularity: "word" }); }
}

// What cannot end a cut text: separators, and brackets or quotes that were opened and not closed.
const DANGLING = /[\s　、，,;:；：\-–—(（[「『"“‘]+$/u;

// The plain text of a post cut for a description: white space collapsed, and when it is over the budget, cut at the last word boundary that fits (the segmenter knows the words of
// each language, Japanese and Thai included) with an ellipsis. Text with no boundary inside the budget (one very long run) is cut at a character.
export function previewText(text: string, lang: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  const max = previewBudget(lang);
  if (countGraphemes(clean) <= max) return clean;
  let kept = "";
  let used = 0;
  for (const { segment } of wordSegmenter(lang).segment(clean)) {
    const n = countGraphemes(segment);
    if (used + n > max) break;
    kept += segment;
    used += n;
  }
  kept = kept.replace(DANGLING, "");
  if (kept === "") {
    const cut: string[] = [];
    for (const { segment } of graphemes.segment(clean)) {
      if (cut.length >= max) break;
      cut.push(segment);
    }
    kept = cut.join("").replace(DANGLING, "");
  }
  return `${kept}…`;
}

// Open Graph locale names (language_TERRITORY) of the languages of the site.
const OG_LOCALES: Record<Lang, string> = {
  ja: "ja_JP", en: "en_US", fr: "fr_FR", de: "de_DE", "zh-Hant": "zh_TW", "zh-Hans": "zh_CN", ko: "ko_KR", th: "th_TH", vi: "vi_VN",
};
export function ogLocale(lang: string): string | null {
  return (OG_LOCALES as Record<string, string | undefined>)[lang] ?? null;
}
