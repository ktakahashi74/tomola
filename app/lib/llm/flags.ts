// Flags stored in translations.flags from LLM output checks.
// Also used by browser display rules (app/lib/display.ts) to decide which primary flags prevent display, so this module is not server-only.
// - structure_mismatch: legacy code-count warning after retry. Display the primary with its warning, including existing rows.
// - quality_mismatch: changed code/math contents, missing mentions/blocks or extreme prose length. Hide the primary.
// - link_mismatch: translation contains URLs/links/images absent from source (possible prompt injection or URL rewrite). Hide the primary.
// - untranslated: identical to source, with no translation. Hide the primary.
// - untranslated_script/untranslated_similar: output resembles a source copy (little target script or high source similarity; app/lib/llm/copy-detection.server.ts).
//   False positives are possible for valid similar translations, so **do not hide**: show with the machine-translation label and list on /admin/usage.
// Title-only translation, displayed normally until the body job refines it. Does not request review.
export const FLAG_PROVISIONAL_TITLE = "provisional_title";

export const FLAG_STRUCTURE_MISMATCH = "structure_mismatch";
export const FLAG_QUALITY_MISMATCH = "quality_mismatch";
// Obvious generation breakdown: excessive expansion or leaked reasoning.
export const FLAG_OUTPUT_LEAK = "output_leak";
// Processing stopped before the translation could be checked or rendered.
export const FLAG_MARKDOWN_BUDGET = "body_too_complex";
export const FLAG_LINK_MISMATCH = "link_mismatch";
export const FLAG_UNTRANSLATED = "untranslated";
export const FLAG_UNTRANSLATED_SCRIPT = "untranslated_script";
export const FLAG_UNTRANSLATED_SIMILAR = "untranslated_similar";

// Treat a primary with these flags as pending translation and show the original.
export const HIDDEN_PRIMARY_FLAGS: readonly string[] = [FLAG_QUALITY_MISMATCH, FLAG_LINK_MISMATCH, FLAG_UNTRANSLATED, FLAG_MARKDOWN_BUDGET];

// Near-copy flags: shown to readers, listed for the operators, and not re-run by translations:requeue unless --include-flagged (the same result would be billed again and flagged again).
export const NEAR_COPY_FLAGS: readonly string[] = [FLAG_UNTRANSLATED_SCRIPT, FLAG_UNTRANSLATED_SIMILAR];

// The flags that ask an operator to look at the translation (the list in /admin/usage).
export const REVIEW_FLAGS: readonly string[] = [FLAG_STRUCTURE_MISMATCH, FLAG_QUALITY_MISMATCH, FLAG_LINK_MISMATCH, FLAG_UNTRANSLATED, FLAG_MARKDOWN_BUDGET, ...NEAR_COPY_FLAGS];

// Flag on a primary row automatically retranslated once by a higher-tier model after a report (retranslate_after_report in app/lib/jobs/translation-jobs.server.ts).
// Show 「指摘を受けて訳し直しました」 if no unresolved report remains for that language (loadReportNotices in app/lib/translation-reports.server.ts). Does not prevent display.
export const FLAG_RETRIED_AFTER_REPORT = "retried_after_report";

// Flag on secondary rows whose translation has been measured by the judge, even when no divergence was found.
// Retained along with translations for title-only edits, so body measurement is not repeated.
export const FLAG_JUDGED = "judged";
