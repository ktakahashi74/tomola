import { preservesFigureMath, sameFigureLabel } from "~/lib/figure";
import type { Lang } from "~/lib/languages";
import { FLAG_LINK_MISMATCH, FLAG_QUALITY_MISMATCH, FLAG_STRUCTURE_MISMATCH, FLAG_UNTRANSLATED, FLAG_UNTRANSLATED_SCRIPT, FLAG_UNTRANSLATED_SIMILAR } from "./flags";
import { detectCopy, type CopyVerdict } from "./copy-detection.core.server";
import { checkChatContent, checkStructure, normalizeTranslationDollars } from "./structure.core.server";
import type { TranslationRequest } from "./types";
import { FLAG_OUTPUT_LEAK } from "./flags";
import { hasTranslationOutputLeak } from "./output-leak.core.server";

// Short-text exemption from untranslated detection, after whitespace normalization: proper names and short titles may legitimately remain identical.
export const UNTRANSLATED_MIN_LENGTH = 20;

const normalizeSpace = (s: string) => s.replace(/\s+/g, " ").trim();

// Detect source copying instead of translation: whitespace-normalized identical output, very little target-language script,
// or high character-bigram similarity (copy-detection.server.ts). Exempt same-language requests and Simplified/Traditional pairs (normally high overlap despite different characters),
// short text, posts without prose (code/math only), and name/model-number-heavy text. near:false skips the two near-copy checks for fake engines.
export function judgeCopy(source: string, translated: string, from: Lang, to: Lang, opts: { near?: boolean; mentions?: readonly string[]; plainText?: boolean } = {}): CopyVerdict {
  if (from === to) return { copy: false };
  if ((from === "zh-Hans" && to === "zh-Hant") || (from === "zh-Hant" && to === "zh-Hans")) return { copy: false };
  if (normalizeSpace(source).length < UNTRANSLATED_MIN_LENGTH) return { copy: false };
  return detectCopy(source, translated, from, to, opts);
}

export const looksUntranslated = (source: string, translated: string, from: Lang, to: Lang, opts: { mentions?: readonly string[] } = {}): boolean => judgeCopy(source, translated, from, to, opts).copy;

// The flag for a copy verdict: an exact copy hides the translation (untranslated); a near copy may be a wrong call, so its flag does not hide it.
const COPY_FLAG = { identical: FLAG_UNTRANSLATED, script: FLAG_UNTRANSLATED_SCRIPT, similar: FLAG_UNTRANSLATED_SIMILAR } as const;

type Problems = { notes: string[]; flags: string[]; normalizedText?: string };

// Check translation structure (code/math counts), links (URLs absent from source) and untranslated output.
export function inspectTranslation(req: TranslationRequest, text: string, engineId: string): Problems {
  if (req.figure) {
    try {
      const source: unknown = JSON.parse(req.text), labels: unknown = JSON.parse(text);
      if (!Array.isArray(source) || !Array.isArray(labels) || labels.length !== source.length || !source.every(item => typeof item === "string") || !labels.every(item => typeof item === "string" && item.trim().length > 0 && item.length <= 2000)) throw new Error("labels");
      const checks = source.map((label, index) => {
        const check = inspectTranslation({ ...req, figure: false, invitationNote: true, text: label }, labels[index], engineId);
        if (!sameFigureLabel(label, labels[index]) && !preservesFigureMath(label, labels[index])) {
          check.flags.push(FLAG_QUALITY_MISMATCH);
          check.notes.push("Preserve every mathematical formula and symbol exactly in its original label, including partial derivatives, Greek letters, superscripts, subscripts and function expressions.");
        }
        return check;
      });
      return { notes: [...new Set(checks.flatMap(check => check.notes))], flags: [...new Set(checks.flatMap(check => check.flags))] };
    } catch {
      return { notes: ["Return a valid JSON array containing exactly one translated string for each source label, in the original order."], flags: [FLAG_QUALITY_MISMATCH] };
    }
  }
  const notes: string[] = [];
  const prefix = engineId === "fake" ? /^\[[^\]\n]+\] /.exec(text)?.[0] ?? "" : "";
  const body = text.slice(prefix.length);
  // Chat messages and village names/descriptions are plain text: no code, math or Markdown structure to preserve.
  const plain = !!req.chat || !!req.village || !!req.invitationNote;
  if (hasTranslationOutputLeak(req, body)) {
    notes.push("Your previous output expanded excessively or included reasoning that was not in the source. Return only the translation, without analysis, alternatives, rules or commentary, preserving the source content and line breaks.");
    return { flags: [FLAG_OUTPUT_LEAK], notes };
  }
  const checkedText = plain ? body : normalizeTranslationDollars(req.text, body);
  const normalizedText = prefix + checkedText;
  const check = (plain ? checkChatContent : checkStructure)(req.text, checkedText, { mentions: req.mentions, from: req.from, to: req.to });
  const flags = [...check.flags];
  const counts = check.mismatches.filter((m) => !m.startsWith("links:") && !m.startsWith("mentions:"));
  if ((flags.includes(FLAG_STRUCTURE_MISMATCH) || flags.includes(FLAG_QUALITY_MISMATCH)) && counts.length > 0) {
    notes.push(
      `your previous translation did not preserve the structure of the source (${counts.join("; ")}). Translate again, and keep every code block, every inline code span, and every math formula and delimiter, heading, list item, table and paragraph of the source exactly as it is. Translate all prose without omissions or additions. Do not translate anything inside code, including comments, docstrings, and strings.`,
    );
  }
  if (check.mismatches.some((m) => m.startsWith("mentions:"))) {
    notes.push(
      "your previous translation lost or changed an @mention of a forum member (an @ followed by a handle). Translate again, and keep every @mention of the source exactly as written: do not translate, transliterate, respace, or remove one.",
    );
  }
  if (flags.includes(FLAG_LINK_MISMATCH)) {
    notes.push(
      "your previous translation contained URLs, links, or images that are not in the source. Translate again, keep every URL, link target, and image address of the source exactly as it is, and do not add any.",
    );
  }
  // The fake engine writes "[ja] original": a near copy by construction, so only an identical copy counts for it.
  const verdict = judgeCopy(req.text, text, req.from, req.to, { near: engineId !== "fake", mentions: req.mentions, ...(plain ? { plainText: true } : {}) });
  if (verdict.copy && verdict.reason) {
    flags.push(COPY_FLAG[verdict.reason]);
    notes.push("your previous output was identical to the source text, or nearly so, or it was not written in the target language. Translate the whole text into the target language; do not copy it.");
  }
  // Copy detection uses the raw output above: escaping dollars must not turn an
  // exact source copy into a merely similar, displayable translation.
  // Titles need the same currency checks, but their plain-text display must not
  // receive Markdown escapes or autolink rewrites.
  return { notes, flags, ...(req.field !== "title" && normalizedText !== text ? { normalizedText } : {}) };
}
