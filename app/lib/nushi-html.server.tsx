import type { listNushiReports } from "./nushi-reports.server";
import { renderToStaticMarkup } from "react-dom/server";
import type { ComponentProps } from "react";
import NushiThreadEntry, { NushiThreadControls } from "~/components/nushi-thread";
import { NushiAnswer, type NushiAnswerView } from "~/components/nushi";
import { Button } from "~/components/ui/button";
import { m } from "~/paraglide/messages.js";

// These are native links and forms. React escapes all model and source text;
// the client inserts only this server-rendered markup, never raw provider HTML.
export function renderNushiAnswerPage(answer: NushiAnswerView, preferences: { hide: boolean; citations: boolean }, member: boolean) {
  return renderToStaticMarkup(<main className="reading-column space-y-4"><NushiAnswer answer={answer} hide={preferences.hide} member={member} />{preferences.hide && <form method="post" action="/nushi/action"><input type="hidden" name="intent" value={member ? "preferences" : "visitor-hide"} /><input type="hidden" name="hide" value="0" /><input type="hidden" name="citations" value={preferences.citations ? "1" : "0"} /><input type="hidden" name="returnTo" value={`/nushi/${answer.id}`} /><Button type="submit" variant="outline">{m.notification_open()}</Button></form>}<a className="underline" href={`/t/${answer.threadId}`}>{m.reply_target_link()}</a></main>, { identifierPrefix: `nushi-${answer.id}-` });
}

export function renderNushiThread(view: ComponentProps<typeof NushiThreadControls>["view"], posts: Array<{ id: number; nushiParentId?: number | null }>, options: { threadId: number; member: boolean; back: string; reply?: number }) {
  const entries: Record<number, string> = {};
  for (const post of posts) {
    if (!post.nushiParentId && !view.answers.some(answer => answer.entryId === post.id) && !view.requests.some(request => request.entryId === post.id)) continue;
    entries[post.id] = renderToStaticMarkup(<NushiThreadEntry entryId={post.id} nushiParentId={post.nushiParentId} view={view} member={options.member} />, { identifierPrefix: `nushi-${post.id}-` });
  }
  const controls = view.setting !== null || view.answers.length ? renderToStaticMarkup(<NushiThreadControls view={view} {...options} />, { identifierPrefix: `nushi-controls-${options.threadId}-` }) : "";
  const reply = options.reply ? renderToStaticMarkup(<><input type="hidden" name="nushiParentId" value={options.reply} /><p>{m.nushi_name()} · {m.reply_to_button()}</p></>) : "";
  return { entries, controls, reply };
}

type NushiReportList = { operator: boolean; page: number; evidence: string | null; reports: Array<Omit<Awaited<ReturnType<typeof listNushiReports>>[number], "date"> & { date: string }> };
export function renderNushiReports(loaderData: NushiReportList) {
  return renderToStaticMarkup(<main className="space-y-4"><h1>{loaderData.operator ? m.nushi_reports() : m.nushi_report_status()}</h1>
    {loaderData.evidence && <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded border p-3 text-sm">{loaderData.evidence}</pre>}
    <ul className="space-y-4">{loaderData.reports.map(report => <li key={report.id} id={`nushi-report-${report.id}`} className="space-y-2 rounded border p-3"><a className="underline" href={`/nushi/${report.answerId}`}>{m.nushi_name()} · {report.answerId}</a><p>{report.reason} · {report.status}</p>{loaderData.operator && report.kind === "error" && <a className="underline" href={`?page=${loaderData.page}&evidence=${report.id}`}>{m.nushi_report_consent()}</a>}<p>{report.note}</p>{report.resolution && <p>{report.resolution}</p>}
      {loaderData.operator && report.status === "open" && <form method="post" action="/nushi/action" className="space-y-2"><input type="hidden" name="intent" value="moderate" /><input type="hidden" name="reportId" value={report.id} /><input type="hidden" name="returnTo" value="/nushi/reports" /><textarea required name="note" maxLength={500} aria-label={m.flag_note()} className="w-full rounded border p-2" /><Button type="submit" name="hide" value="1" variant="outline">{m.nushi_resolve()}</Button> <Button type="submit" name="hide" value="0" variant="outline">{m.nushi_dismiss()}</Button></form>}
    </li>)}</ul><div className="flex gap-4">{loaderData.page > 1 && <a href={`?page=${loaderData.page - 1}`}>←</a>}{loaderData.reports.length === 30 && <a href={`?page=${loaderData.page + 1}`}>→</a>}</div>
  </main>, { identifierPrefix: "nushi-reports-" });
}
