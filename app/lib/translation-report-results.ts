import type { Lang } from "./languages";

export const TRANSLATION_REPORT_OUTCOMES = ["machine_retranslated", "human_corrected", "unchanged", "source_updated"] as const;
export type TranslationReportOutcome = (typeof TRANSLATION_REPORT_OUTCOMES)[number];
export type TranslationReportResult = { outcome: TranslationReportOutcome; lang: Lang; field: "title" | "body"; sourceHash: string | null };
