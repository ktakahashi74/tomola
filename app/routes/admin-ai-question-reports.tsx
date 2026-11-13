import { desc, gte } from "drizzle-orm";
import { Link } from "react-router";
import type { Route } from "./+types/admin-ai-question-reports";
import { requireOperator } from "~/lib/auth/session.server";
import { aiQuestionReports } from "~/lib/db/schema";
import { privateCacheMiddleware } from "~/lib/http/private-cache.server";
import { aiQuestionLabels } from "~/lib/ai-question-labels.server";
import { AI_QUESTION_EVENTS, questionEventCounts } from "~/lib/ai-question-usage.server";
import { getPostAskBudgetStatus } from "~/lib/llm/usage.server";
import { formatUsdMicro } from "~/lib/llm/format";
import { RETENTION, daysBefore } from "~/lib/retention";
import { AiQuestionAnswerView } from "~/components/ai-question-answer";
import { m } from "~/paraglide/messages.js";

export const middleware = [privateCacheMiddleware];
export async function loader({ request }: Route.LoaderArgs) {
  const { db } = await requireOperator(request);
  const now = new Date();
  const [rows, counts, budget] = await Promise.all([
    db.select({ id: aiQuestionReports.id, topicId: aiQuestionReports.topicId, villageId: aiQuestionReports.villageId, question: aiQuestionReports.question, answer: aiQuestionReports.answer, createdAt: aiQuestionReports.createdAt })
      .from(aiQuestionReports).where(gte(aiQuestionReports.createdAt, daysBefore(now, RETENTION.aiQuestionReportDays)))
      .orderBy(desc(aiQuestionReports.createdAt), desc(aiQuestionReports.id)).limit(50),
    questionEventCounts(db), getPostAskBudgetStatus(db, now),
  ]);
  const names = { asked: m.post_ask_metric_asked(), verification_failed: m.post_ask_metric_verification_failed(), draft_created: m.post_ask_metric_draft_created(), reply_published: m.post_ask_metric_reply_published() };
  return { title: m.post_ask_reports_title(), empty: m.post_ask_reports_none(), countHelp: m.post_ask_counts(), labels: aiQuestionLabels(),
    budget: m.post_ask_budget({ used: formatUsdMicro(budget.usedMicro), budget: formatUsdMicro(budget.budgetMicro) }),
    counts: AI_QUESTION_EVENTS.map(event => ({ name: names[event], count: counts[event] })),
    reports: rows.map(row => ({ ...row, createdAt: row.createdAt.toISOString() })),
  };
}
export function meta({ loaderData }: Route.MetaArgs) { return [{ title: loaderData?.title }, { name: "robots", content: "noindex, nofollow" }]; }

export default function AiQuestionReports({ loaderData: view }: Route.ComponentProps) {
  return <main className="reading-column space-y-6">
    <h1 className="text-2xl font-bold">{view.title}</h1>
    <p>{view.budget}</p>
    <p className="ui-help text-muted-foreground">{view.countHelp}</p>
    <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-2">{view.counts.map(row => <div className="contents" key={row.name}><dt>{row.name}</dt><dd>{row.count}</dd></div>)}</dl>
    {view.reports.length === 0 && <p>{view.empty}</p>}
    {view.reports.map(report => <section key={report.id} className="space-y-4 border-t pt-4">
      <p className="ui-meta"><time dateTime={report.createdAt}>{report.createdAt}</time>{" · "}{report.answer.language}{" · "}{report.answer.engine}/{report.answer.model}</p>
      {report.topicId && <Link className="underline" to={`/t/${report.topicId}`}>{view.labels.back}</Link>}
      <p className="whitespace-pre-wrap break-words">{report.question}</p>
      <AiQuestionAnswerView content={report.answer} labels={view.labels} idPrefix={`ai-report-${report.id}-source`} />
    </section>)}
  </main>;
}
