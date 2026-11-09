import type { Lang } from "~/lib/languages";

// Target-language instructions. Post translation (prompt.server.ts) and interface-message translation
// (app/lib/i18n/translate-messages.server.ts, `pnpm i18n:translate`) share these exact instructions to avoid inconsistent edits.
//
// Name Chinese by script, not country/region. Simplified zh-Hans and Traditional zh-Hant are distinct languages and translate both ways; exempt from looksUntranslated.
// Traditional translations use Taiwanese vocabulary/orthography; Simplified uses mainland Chinese usage. Do more than script conversion: regional terms differ
// (software: 軟體／软件; network: 網路／网络; information: 資訊／信息).
// Bump PROMPT_VERSION in prompt.server.ts when changing instructions; stored on post translations. Interface translations have no version record, so changes affect only future translations.
// Wording in Japanese (loanwords). Meaning and tone come first; within that, choose the word that reads naturally. The script (katakana, native or Sino-Japanese words, Latin letters) never decides by itself.
// What is avoided is translationese only: a word that copies the sound of the source word without checking its meaning. This is not a replacement table, so examples carry their context.
const JA_WORDING =
  " Keep the meaning and the tone first; within that, choose the Japanese that reads naturally to the reader." +
  " Do not choose between katakana loanwords, native Japanese words, Sino-Japanese words and Latin letters by the kind of script: decide by meaning, readers, register and the usual wording of the field." +
  " Avoid only translationese: a loanword that copies the sound of the source word without its meaning having been checked. This is not a table of fixed replacements, because the same source word needs different Japanese in different contexts." +
  " For example, for a text that is organized in parts, \"consists of three parts\" is 3つの部分からなる, not 3つのパートで構成; and \"a case where ...\" is usually ...ことがある, not ...というケース." +
  " A loanword that is the ordinary Japanese word for the meaning (for example システム, メッセージ, スレッド) stays as it is." +
  " Terms of a field: follow a glossary entry whose sense and field fit the text; otherwise use the word that people of that field use in Japanese. If no word has settled, an explanatory translation, a transliteration, the original word or a short gloss are all acceptable: choose what conveys the meaning." +
  " Put the original word in parentheses beside a term only where a misunderstanding is likely or where the source is discussing that very word." +
  " Give one translation: never offer alternative words in the output (such as A（またはB）).";

const PRESERVE = " Preserve code, URLs, formulas and Markdown syntax. Do not add emphasis or line breaks absent from the source.";

export const TARGET_LANG_SPECS: Partial<Record<Lang, string>> = {
  en: "Use typographic quotation marks (“ ” ‘ ’), apostrophes (’), ellipses (…) and en dashes (–) for numeric ranges." + PRESERVE,
  fr: "Use French guillemets (« ») with non-breaking spaces inside them, non-breaking spaces before ; : ! ?, typographic apostrophes (’) and ellipses (…)." + PRESERVE,
  de: "Use German quotation marks („ “), typographic apostrophes (’) and ellipses (…)." + PRESERVE,
  ja: "Use full-width Japanese punctuation and brackets (、。「」（）), and half-width Latin letters and digits. Do not insert spaces between Japanese text and Latin letters or digits; the display supplies spacing." + JA_WORDING + PRESERVE,
  ko: "Use the language's standard punctuation and quotation marks." + PRESERVE,
  th: "Use the language's standard punctuation and quotation marks." + PRESERVE,
  vi: "Use the language's standard punctuation and quotation marks." + PRESERVE,
  "zh-Hant":
    "Write in Traditional Chinese characters, with the vocabulary, usage and orthography of Taiwan (for example 軟體, 網路, 資訊, 程式, 影片, 伺服器, 品質). This is not a script conversion of Simplified Chinese: choose the words and the punctuation that a reader in Taiwan would expect, and never leave Simplified characters or mainland-only terms (such as 软件, 网络, 信息) in the output. If the source is Simplified Chinese, it is still a translation, not a character-by-character conversion. Use full-width punctuation (，。：；！？（）「」)." + PRESERVE,
  "zh-Hans":
    "Write in Simplified Chinese characters, with the vocabulary, usage and orthography of mainland China (for example 软件, 网络, 信息, 程序, 视频, 服务器, 质量). This is not a script conversion of Traditional Chinese: choose the words and the punctuation that a reader in mainland China would expect, and never leave Traditional characters or Taiwan-only terms (such as 軟體, 網路, 資訊) in the output. If the source is Traditional Chinese, it is still a translation, not a character-by-character conversion. Use full-width punctuation (，。：；！？（）“”)." + PRESERVE,
};

// Source-language instructions: how to read the source text, when it is in a language that needs it. Only Japanese has one so far.
export const SOURCE_LANG_SPECS: Partial<Record<Lang, string>> = {
  ja:
    "Read katakana loanwords as Japanese words and translate their meaning in context. The foreign word a loanword sounds like is often the right translation, but not always: check the meaning before using it. " +
    "Japanese coinages from foreign words and loanwords whose meaning changed after borrowing can need different translations in different contexts " +
    "(for example マンション: a building, a dwelling unit, or a form of ownership; ナイーブ: sensitive, innocent, or naive), so do not use a fixed correspondence. " +
    "Latin letters inside Japanese text may be a name, a term, a quotation, a slogan or a sentence in a foreign language: treat each by its role. Keeping them as they are is not always natural in the target language.",
};

export function sourceLangSpec(lang: Lang): string | undefined {
  return SOURCE_LANG_SPECS[lang];
}

// Target-language instruction, or undefined if absent.
export function targetLangSpec(lang: Lang): string | undefined {
  return TARGET_LANG_SPECS[lang];
}
