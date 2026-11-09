import { m } from "~/paraglide/messages.js";
import type { Locale } from "~/paraglide/runtime.js";
import { localizedLanguageLabel } from "./language-label";
import type { TranslationReportResult } from "./translation-report-results";

export function translationReportResultText(result: TranslationReportResult, title: string | null | undefined, locale: Locale) {
  const o = { locale };
  const target = { title: title || m.headline_empty({}, o), language: localizedLanguageLabel(result.lang, locale), field: result.field === "title" ? m.translation_report_result_title({}, o) : m.translation_report_result_body({}, o) };
  switch (result.outcome) {
    case "machine_retranslated": return m.translation_report_result_machine(target, o);
    case "human_corrected": return m.translation_report_result_human(target, o);
    case "unchanged": return m.translation_report_result_unchanged(target, o);
    case "source_updated": return m.translation_report_result_source(target, o);
  }
}
