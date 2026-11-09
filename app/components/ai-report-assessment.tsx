import { m } from "~/paraglide/messages.js";
import { getLocale } from "~/paraglide/runtime.js";

type Assessment = { aiPriority?: string | null; aiAssessment?: { en: string; ja: string } | null };
export function AiReportAssessment({ report, priorityOnly = false }: { report: Assessment; priorityOnly?: boolean }) {
  if (!report.aiPriority || !priorityOnly && !report.aiAssessment) return null;
  const priority = report.aiPriority === "urgent" ? m.mod_ai_urgent() : report.aiPriority === "low" ? m.mod_ai_low() : m.mod_ai_normal();
  return <div className="space-y-1 rounded border p-2 text-sm">
    <p><strong>{m.mod_ai_priority()}</strong>: {priority}</p>
    {!priorityOnly && report.aiAssessment && <p><strong>{m.mod_ai_assessment()}</strong>: {getLocale() === "ja" ? report.aiAssessment.ja : report.aiAssessment.en}</p>}
    <p className="ui-help text-muted-foreground">{m.mod_ai_notice()}</p>
  </div>;
}
