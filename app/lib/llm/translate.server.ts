import type { Lang } from "~/lib/languages";
import { FLAG_LINK_MISMATCH, FLAG_QUALITY_MISMATCH, FLAG_STRUCTURE_MISMATCH, FLAG_UNTRANSLATED, FLAG_UNTRANSLATED_SCRIPT, FLAG_UNTRANSLATED_SIMILAR } from "./flags";
import type * as core from "./translation-inspect.core.server";
import { markdownTask, MarkdownBudgetError } from "../markdown-budget.server";
import { FLAG_MARKDOWN_BUDGET } from "./flags";

import type { TranslationEngine, TranslationRequest, TranslationResult } from "./types";
import { FLAG_OUTPUT_LEAK } from "./flags";
import { LlmError } from "./errors.server";

// translations.flags constants live in ./flags; also re-exported here for existing imports.
export { FLAG_LINK_MISMATCH, FLAG_QUALITY_MISMATCH, FLAG_STRUCTURE_MISMATCH, FLAG_UNTRANSLATED, FLAG_UNTRANSLATED_SCRIPT, FLAG_UNTRANSLATED_SIMILAR };

export type CheckedTranslation = TranslationResult & {
  // Flags added to translations.flags when accepting output; see ./flags for display rules.
  flags: string[];
  // Engine calls: 1, or 2 after failed checks. Token counts total all calls.
  attempts: number;
  // Rejected outputs with a leak, including one fixed by the retry.
  leakDetections: number;
};

export { UNTRANSLATED_MIN_LENGTH } from "./translation-inspect.core.server";
export function judgeCopy(...args: Parameters<typeof core.judgeCopy>): Promise<ReturnType<typeof core.judgeCopy>> { return markdownTask("judgeCopy", args); }
export async function looksUntranslated(...args: Parameters<typeof core.looksUntranslated>): Promise<boolean> { return (await judgeCopy(...args)).copy; }
async function inspect(...args: Parameters<typeof core.inspectTranslation>): Promise<ReturnType<typeof core.inspectTranslation>> {
  try { return await markdownTask("inspectTranslation", args); }
  catch (error) {
    if (!(error instanceof MarkdownBudgetError)) throw error;
    return { flags: [FLAG_MARKDOWN_BUDGET], notes: ["Your previous output could not be processed within the formatting budget. Translate again using simpler markup, while preserving the source content."] };
  }
}

// Translate and check structure, links and untranslated output. On failure, retry once with a warning.
// Persistent output leaks throw a terminal error before storage. Other failed
// checks flag the second output. Legacy structure_mismatch remains
// visible; quality_mismatch hides strong preservation failures. Other display
// rules live in ./flags. Rethrow engine failures unchanged.
export async function translateChecked(engine: TranslationEngine, req: TranslationRequest): Promise<CheckedTranslation> {
  let leakDetections = 0;
  try {
    const first = await engine.translate(req);
    const firstProblems = await inspect(req, first.text, engine.id);
    if (firstProblems.flags.includes(FLAG_OUTPUT_LEAK)) leakDetections++;
    if (req.figure && req.figureCharacterBudgets) {
      if (firstProblems.flags.includes(FLAG_OUTPUT_LEAK)) throw new LlmError("output_leak", "Figure shortening output failed the leak check");
      return { ...first, flags: firstProblems.flags, attempts: 1, leakDetections };
    }
    if (firstProblems.notes.length === 0) return { ...first, text: firstProblems.normalizedText ?? first.text, flags: [], attempts: 1, leakDetections };

    const second = await engine.translate({ ...req, retryNote: firstProblems.notes.join(" Also, ") });
    const secondProblems = await inspect(req, second.text, engine.id);
    if (secondProblems.flags.includes(FLAG_OUTPUT_LEAK)) {
      leakDetections++;
      throw new LlmError("output_leak", "Translation output failed the leak check after one retry");
    }
    return {
      ...second,
      text: secondProblems.normalizedText ?? second.text,
      inputTokens: first.inputTokens + second.inputTokens,
      outputTokens: first.outputTokens + second.outputTokens,
      ...(first.thoughtTokens !== undefined || second.thoughtTokens !== undefined ? { thoughtTokens: (first.thoughtTokens ?? 0) + (second.thoughtTokens ?? 0) } : {}),
      flags: secondProblems.flags,
      attempts: 2,
      leakDetections,
    };
  } finally {
    if (leakDetections) console.warn(`[translate] output_leak detections=${leakDetections} engine=${engine.id} from=${req.from} to=${req.to} field=${req.chat ? "chat" : req.field ?? req.village ?? (req.invitationNote ? "invitation" : "body")}`);
  }
}
