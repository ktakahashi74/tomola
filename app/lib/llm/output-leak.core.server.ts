import { proseOf } from "./structure.core.server";
import type { TranslationRequest } from "./types";

// Deliberately wider than ordinary translation expansion, especially from
// compact scripts to spaced languages. Short sources also need an absolute floor.
export const OUTPUT_LEAK_LIMITS = {
  minExpandedChars: 600,
  ratios: { compactToSpaced: 8, spacedToCompact: 4, other: 6 },
  minLineChars: 240,
  minLines: 12,
  lineRatio: 4,
  minReasoningChars: 120,
  minReasoningLines: 3,
  addedReasoningLines: 2,
} as const;

const reasoningStarts = [
  /\bWait\s*,/i,
  /\bLet['’]s\b/i,
  /\bLet me\b/i,
  /\bI need to\b/i,
  /\bThe user\b/i,
  /\bRule\s*:/i,
  /\bTranslation\s*:/i,
];
const compact = (lang: string) => ["ja", "zh-Hans", "zh-Hant", "th"].includes(lang);

// Code/math are not prose; block quotes are measured for expansion but cannot
// supply reasoning markers. A marker mentioned anywhere in the source is exempt.
// This catches obvious generation breakdowns, not semantic translation errors.
export function hasTranslationOutputLeak(req: TranslationRequest, text: string): boolean {
  if (req.from === req.to) return false;
  const chars = (value: string) => Array.from(value.replace(/\s/g, "")).length;
  const pair = compact(req.from) && !compact(req.to) ? "compactToSpaced" : !compact(req.from) && compact(req.to) ? "spacedToCompact" : "other";
  // Unchanged code/math cannot cause whole-output expansion. Check this before
  // parsing: a runaway answer may be huge or wrapped in an unclosed code fence.
  const rawOutputChars = chars(text);
  if (rawOutputChars >= OUTPUT_LEAK_LIMITS.minExpandedChars
    && rawOutputChars > Math.max(1, chars(req.text)) * OUTPUT_LEAK_LIMITS.ratios[pair]) return true;
  const plain = !!req.chat || !!req.village || !!req.invitationNote;
  const source = plain ? req.text : proseOf(req.text);
  const output = plain ? text : proseOf(text);
  const sourceChars = chars(source), outputChars = chars(output);
  const ratio = outputChars / Math.max(1, sourceChars);
  if (outputChars >= OUTPUT_LEAK_LIMITS.minExpandedChars && ratio > OUTPUT_LEAK_LIMITS.ratios[pair]) return true;

  const lines = (value: string) => value.split(/\r?\n/).filter(line => line.trim()).length;
  if (outputChars >= OUTPUT_LEAK_LIMITS.minLineChars && ratio > (pair === "compactToSpaced" ? 3 : 2)
    && lines(output) >= Math.max(OUTPUT_LEAK_LIMITS.minLines, lines(source) * OUTPUT_LEAK_LIMITS.lineRatio)) return true;

  if (outputChars < OUTPUT_LEAK_LIMITS.minReasoningChars) return false;
  const absent = reasoningStarts.filter(pattern => !pattern.test(req.text));
  const reasoning = plain ? text : proseOf(text, true);
  const reasoningLines = reasoning.split(/\r?\n/).filter(line => absent.some(pattern => {
    const match = pattern.exec(line);
    return match && !line.slice(0, match.index).trim();
  })).length;
  // The source may itself be reasoning written in another language. Preserve
  // those translations when their line structure and expansion remain ordinary.
  return reasoningLines >= OUTPUT_LEAK_LIMITS.minReasoningLines
    && (lines(output) >= lines(source) + OUTPUT_LEAK_LIMITS.addedReasoningLines || ratio > OUTPUT_LEAK_LIMITS.ratios[pair]);
}
