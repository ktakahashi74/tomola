import { FIGURE_MATH_VARIANTS, normalizeFigureNewlines } from "./figure";
import type { Lang } from "./languages";
import { hasMathLabel, unmatchedMath } from "./llm/math-preservation.core.server";
import { splitFigureMath } from "./llm/structure.core.server";

// Compare formula tokens and their multiplicity, preserving semantic distinctions.
export function preservesFigureMath(source: string, translated: string, to?: Lang): boolean {
  source = normalizeFigureNewlines(source);
  translated = normalizeFigureNewlines(translated);
  if (source.includes("$") || translated.includes("$")) {
    const a = splitFigureMath(source), b = splitFigureMath(translated);
    if (a.display.length !== b.display.length || unmatchedMath(a.display, b.display, to) === null ||
        a.inline.length !== b.inline.length ||
        unmatchedMath(a.inline.map(span => span.value), b.inline.map(span => span.value), to) === null) return false;
    source = a.rest;
    translated = b.rest;
  }
  // A text command identifies an undelimited TeX formula. Compare the entire
  // label so the OCR token check cannot drop or move a TeX argument.
  if (hasMathLabel(source) || hasMathLabel(translated)) return unmatchedMath([source], [translated], to) !== null;
  // Sources already contain visible symbols. Preserve literal source escapes,
  // but reject new or duplicated escapes before scanning formula tokens.
  const commands = (text: string) => {
    const counts = new Map<string, number>();
    for (const [command] of text.matchAll(/\\[A-Za-z]+/g)) counts.set(command, (counts.get(command) ?? 0) + 1);
    return counts;
  };
  const sourceCommands = commands(source);
  for (const [command, count] of commands(translated)) {
    if (sourceCommands.get(command) !== count) return false;
  }
  const tokens = (text: string, allowAsciiMinus = false) => {
    const normalized = [...text].map(c => FIGURE_MATH_VARIANTS[c] ?? c).join("");
    const comparable = allowAsciiMinus ? normalized.replace(/-/g, "−") : normalized;
    return (comparable.match(/[A-Za-z\u0370-\u03ff][A-Za-z0-9\u0370-\u03ff]*\([^()\r\n]*\)|[A-Za-z0-9\u0370-\u03ff]+(?:[_^](?:\{[^{}\r\n]+\}|[A-Za-z0-9]+))+|\(\s*[-\d][\d.,{};\s+−-]+\)|\d+(?:(?:[.,]|\{,\})\d+)*|[+=<>|]|\p{Sm}|[\u0370-\u03ff\u1f00-\u1fff\u2070-\u214f\u1d2c-\u1d6a\u1d9b-\u1dbf\u00b0\u00b2\u00b3\u00b9\u{1d400}-\u{1d7ff}]/gu) ?? []).map(token => token.replace(/-/g, "−"));
  };
  return unmatchedMath(tokens(source), tokens(translated, true), to) !== null;
}
