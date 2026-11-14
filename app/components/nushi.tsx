import { TranslationLabel } from "./translation-label";
import { ReportReasonSelect } from "./report-reason-select";
import { reasonLabel } from "./reason-label";
import { Button } from "./ui/button";
import type { readNushiAnswer } from "~/lib/nushi.server";
import { m } from "~/paraglide/messages.js";

export type NushiAnswerView = NonNullable<Awaited<ReturnType<typeof readNushiAnswer>>>;
export function NushiAnswer({ answer: value, hide = false, member = false, back }: { answer: NushiAnswerView; hide?: boolean; member?: boolean; back?: string }) {
  back ??= `/nushi/${value.id}`;
  if (value.hidden || hide) return <div id={`nushi-${value.id}`} data-nushi-hidden className="rounded border p-3 ui-help text-muted-foreground">
    {value.hidden && value.reason === "source_changed" ? m.nushi_source_changed() : m.nushi_hidden()}
    {hide && <a className="ms-2 underline" href={`/nushi/${value.id}`}>{m.notification_open()}</a>}
  </div>;
  const content = <>
    {value.answer.status === "not_confirmed" && <p>{m.nushi_not_found()}{value.answer.askPerson !== false && <> {m.nushi_ask_person()}</>}</p>}
    {value.answer.readings.map((reading, index) => <p key={index} lang={value.lang === "other" ? value.langCode ?? undefined : value.lang}>{reading.text} {reading.citations.map(number => <a key={number} className="underline" href={`#nushi-${value.id}-source-${number}`}>[{number}]</a>)}</p>)}
    <ol className="space-y-3">
      {value.answer.citations.map((citation, index) => {
        const id = Number(/^e-(\d+)-/.exec(citation.sourceId)![1]), label = value.labels.find(source => source.id === id);
        return <li key={index} id={`nushi-${value.id}-source-${index + 1}`}>
          <p className="ui-meta">[{index + 1}] <a href={label?.authorHref ?? citation.original.href} className="underline">{citation.author}</a> · {label?.date.slice(0, 10)}{label?.left && <> · {m.nushi_left()}</>}</p>
          <blockquote className="border-s ps-3" lang={citation.original.lang}><a className="underline" href={citation.original.href}>{citation.original.quote}</a></blockquote>
          {citation.translation && <blockquote className="border-s ps-3" lang={citation.translation.lang}><a className="underline" href={citation.translation.href}>{citation.translation.quote}</a></blockquote>}
        </li>;
      })}
    </ol>
  </>;
  const long = value.answer.readings.reduce((n, reading) => n + reading.text.length, 0) + value.answer.citations.reduce((n, citation) => n + citation.original.quote.length + (citation.translation?.quote.length ?? 0), 0) > 2200;
  return <article id={`nushi-${value.id}`} data-nushi-answer className="min-w-0 space-y-3 rounded border bg-muted/30 p-3 [overflow-wrap:anywhere]">
    <header className="space-y-1">
      <p><a href="/ai-use#nushi" className="font-semibold underline">{m.nushi_name()}</a> · {m.nushi_label({ handle: value.caller ?? "?" })}</p>
      {value.personal && <p className="ui-help text-muted-foreground">{m.nushi_personal_notice()}</p>}
      {value.translated && <p className="ui-meta"><TranslationLabel kind="primary" engine={value.translationEngine} model={value.translationModel} /> <a className="underline" href={`/nushi/${value.id}?lang=${value.originalLang}`}>{m.show_original()}</a></p>}
      <a className="ui-meta underline" href={`/nushi/${value.id}`}><time dateTime={value.date}>{value.date.slice(0, 10)}</time></a>
    </header>
    {long ? <><p>{value.answer.readings[0]?.text.slice(0, 180)}…</p><details className="space-y-3"><summary className="cursor-pointer underline">{m.nushi_more()}</summary>{content}</details></> : <div className="space-y-3">{content}</div>}
    <p className="ui-meta text-muted-foreground">{m.nushi_scope({ count: value.scope.posts, from: value.scope.from?.slice(0, 10) ?? "—", to: value.scope.to?.slice(0, 10) ?? "—" })} · <a href={`/search?village=${encodeURIComponent(value.villageSlug ?? value.villageId)}`} className="underline">{m.nushi_search()}</a></p>
    <p className="ui-meta"><a href="/ai-use#nushi" className="underline">{value.model} · {value.promptVersion}</a> · <a href="/principles#s6" className="underline">{m.ai_use_objections_link()}</a></p>
    {member && <div className="flex flex-wrap items-start gap-3 ui-meta">
      <a href={`/t/${value.threadId}?nushi_reply=${value.id}#reply`} className="underline">{m.reply_to_button()}</a>
      <NushiReport answerId={value.id} back={back} />
    </div>}
  </article>;
}

function NushiReport({ answerId, back }: { answerId: number; back: string }) {
  return <><details className="min-w-0 max-w-full open:basis-full"><summary className="cursor-pointer underline">{m.flag_summary()}</summary><form method="post" action="/nushi/action" className="space-y-2">
    <input type="hidden" name="intent" value="report" /><input type="hidden" name="answerId" value={answerId} /><input type="hidden" name="kind" value="moderation" /><input type="hidden" name="returnTo" value={back} />
    <ReportReasonSelect appearance="native" />
    <textarea name="note" maxLength={1000} aria-label={m.field_body()} className="w-full rounded border p-2" />
    <Button type="submit" variant="outline">{m.flag_summary()}</Button>
  </form></details>
  <details className="min-w-0 max-w-full open:basis-full"><summary className="cursor-pointer underline">{m.nushi_report_error()}</summary><form method="post" action="/nushi/action" className="space-y-2">
    <input type="hidden" name="intent" value="report" /><input type="hidden" name="answerId" value={answerId} /><input type="hidden" name="kind" value="error" /><input type="hidden" name="returnTo" value={back} />
    <select name="reason" aria-label={m.nushi_report_error()} className="w-full max-w-full rounded border p-1"><option value="missing_disagreement">{m.nushi_error_missing_disagreement()}</option><option value="wrong_post">{m.nushi_error_wrong_post()}</option><option value="lost_context">{m.nushi_error_lost_context()}</option><option value="other">{reasonLabel("other")}</option></select>
    <textarea name="note" maxLength={1000} aria-label={m.field_body()} className="w-full rounded border p-2" />
    <label className="block"><input type="checkbox" name="consent" value="1" required /> {m.nushi_report_consent()}</label><Button type="submit" variant="outline">{m.nushi_report_error()}</Button>
  </form></details></>;
}

export function NushiCallStatus({ state, failure }: { state: string; failure: string | null }) {
  const reason = failure === "unverified" ? m.nushi_failure_unverified() : failure === "limit" ? m.nushi_failure_limit() : failure === "budget" ? m.nushi_failure_budget() : failure === "expired" ? m.nushi_failure_expired() : failure === "private" ? m.nushi_failure_private() : "";
  return <p role="status" data-nushi-status className="ui-help text-muted-foreground">{["pending", "processing"].includes(state) ? m.nushi_pending() : `${m.nushi_failed()} ${reason}`}</p>;
}
