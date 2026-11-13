import { ReportReasonSelect } from "~/components/report-reason-select";
import { AiReportAssessment } from "~/components/ai-report-assessment";
import { privateCacheMiddleware } from "~/lib/http/private-cache.server";
import { useEffect, useState } from "react";
import { data, Form, Link, redirect, useFetcher, type ShouldRevalidateFunctionArgs } from "react-router";
import type { Route } from "./+types/mod-chat";
import { Button } from "~/components/ui/button";
import { Field, FieldLabel } from "~/components/ui/field";
import { Textarea } from "~/components/ui/textarea";
import { Input } from "~/components/ui/input";
import { reasonLabel } from "~/components/reason-label";
import { requireModerator } from "~/lib/auth/session.server";
import { assertSameOrigin } from "~/lib/http/csrf.server";
import { enforceMemberLimit } from "~/lib/http/limits.server";
import { parseId, parseIdOrNull } from "~/lib/params.server";
import { formString } from "~/lib/entry-form.server";
import { CHAT_PRIVATE_HEADERS } from "~/lib/village-chat-auth.server";
import { ChatReportError, chatCaseMetadata, moderateChatReport, readChatEvidence, type ChatEvidenceMessage, type ChatCase } from "~/lib/village-chat-reports.server";
import { decideAppeal } from "~/lib/appeals.server";
import { suspendMember } from "~/lib/moderation.server";
import { LANG_LABELS } from "~/lib/languages";
import { villageName } from "~/lib/village-name";
import { m } from "~/paraglide/messages.js";

function target(params: Route.LoaderArgs["params"]): ChatCase {
  if (params.kind !== "report" && params.kind !== "appeal") throw data("Not found", { status: 404, headers: CHAT_PRIVATE_HEADERS });
  return { kind: params.kind, id: parseId(params.caseId) };
}
function failure(error: unknown): never {
  if (!(error instanceof ChatReportError)) throw data("Service unavailable", { status: 503, headers: CHAT_PRIVATE_HEADERS });
  throw data(error.code === "unavailable" ? "Service unavailable" : "Not found", { status: error.code === "unavailable" ? 503 : error.code === "invalid" ? 400 : 404, headers: CHAT_PRIVATE_HEADERS });
}
export const middleware = [privateCacheMiddleware];
export function headers() { return CHAT_PRIVATE_HEADERS; }
export function meta() { return [{ title: m.chat_reports_title() }, { name: "robots", content: "noindex" }]; }
export function shouldRevalidate({ actionResult, defaultShouldRevalidate }: ShouldRevalidateFunctionArgs) {
  return actionResult?.error === "case_closed" ? true : defaultShouldRevalidate;
}

export async function loader({ request, params }: Route.LoaderArgs) {
  const { db, user, scope } = await requireModerator(request);
  await enforceMemberLimit(db, "mod", user.id);
  const item = target(params);
  try {
    const metadata = await chatCaseMetadata(db, { id: user.id, scope }, item);
    return data({ kind: item.kind, id: item.id, lang: metadata.lang, village: metadata.village, operator: scope.operator, closed: metadata.status !== "open", canHide: metadata.hasOpenReports && !metadata.hidden, canUnhide: metadata.canUnhide, canDismiss: metadata.hasOpenReports, canSuspend: scope.operator && item.kind === "report" && metadata.authorId !== null, done: new URL(request.url).searchParams.has("done") }, { headers: CHAT_PRIVATE_HEADERS });
  } catch (error) { return failure(error); }
}

export async function action({ request, params }: Route.ActionArgs) {
  assertSameOrigin(request);
  const { db, user, scope } = await requireModerator(request);
  await enforceMemberLimit(db, "mod", user.id);
  const item = target(params), actor = { id: user.id, scope }, form = await request.formData();
  const intent = formString(form, "intent");
  const previous = formString(form, "previous");
  const previousId = ["open", "context", "expand"].includes(intent) && previous ? parseIdOrNull(previous) : undefined;
  if (previousId === null) throw data("Bad request", { status: 400, headers: CHAT_PRIVATE_HEADERS });
  try {
    if (intent === "open" || intent === "context" || intent === "expand") {
      if (intent === "expand" && formString(form, "note").trim().startsWith("chat:")) return data({ error: "reserved_reason" }, { status: 400, headers: CHAT_PRIVATE_HEADERS });
      const evidence = await readChatEvidence(db, actor, item, { intent, previous: previousId, reason: formString(form, "note") });
      return data({ evidence }, { headers: CHAT_PRIVATE_HEADERS });
    }
    if (item.kind === "report" && (intent === "hide" || intent === "unhide" || intent === "dismiss")) {
      await moderateChatReport(db, actor, { reportId: item.id, intent, reason: formString(form, "reason"), note: formString(form, "note") });
    } else if (item.kind === "report" && intent === "suspend") {
      const metadata = await chatCaseMetadata(db, actor, item);
      if (!scope.operator || !metadata.authorId) throw new ChatReportError("forbidden");
      const result = await suspendMember(db, actor, { userId: metadata.authorId, reportId: item.id, days: formString(form, "days"), reason: formString(form, "reason"), note: formString(form, "note") });
      if (!result.ok) return data({ error: result.error }, { status: 400, headers: CHAT_PRIVATE_HEADERS });
    } else if (item.kind === "appeal" && (intent === "uphold" || intent === "overturn")) {
      const result = await decideAppeal(db, actor, item.id, { decision: intent === "uphold" ? "upheld" : "overturned", note: formString(form, "note") });
      if (!result.ok) return data({ error: result.error }, { status: 400, headers: CHAT_PRIVATE_HEADERS });
      throw redirect(`/mod/appeals?done=${result.status === "upheld" ? "upheld" : result.reversed ? "overturned" : "overturned-nochange"}`);
    } else throw new ChatReportError("invalid");
  } catch (error) {
    if (error instanceof Response) throw error;
    if (error instanceof ChatReportError && (error.code === "case_closed" || error.code === "expand_limit")) return data({ error: error.code }, { status: 409, headers: CHAT_PRIVATE_HEADERS });
    return failure(error);
  }
  throw redirect(`/mod/chat/${item.kind}/${item.id}?done=1`);
}

export default function ModChat({ loaderData, actionData }: Route.ComponentProps) {
  const fetcher = useFetcher<typeof action>({ key: `chat-case-${loaderData.kind}-${loaderData.id}` });
  const [opened, setOpened] = useState<Awaited<ReturnType<typeof readChatEvidence>> | null>(null);
  const [context, setContext] = useState<ChatEvidenceMessage[]>([]);
  const [previous, setPrevious] = useState<number>();
  useEffect(() => { setOpened(null); setContext([]); setPrevious(undefined); }, [loaderData.kind, loaderData.id, loaderData.closed]);
  useEffect(() => {
    if (loaderData.closed || fetcher.data && "error" in fetcher.data && fetcher.data.error === "case_closed") { setOpened(null); setContext([]); setPrevious(undefined); return; }
    if (!fetcher.data || !("evidence" in fetcher.data)) return;
    const value = fetcher.data.evidence;
    if (value.intent === "open") setOpened(value);
    else {
      setPrevious(value.logId);
      setContext(old => [...new Map([...(value.intent === "context" ? [] : old), ...value.context].map(message => [message.id, message])).values()].sort((a, b) => a.createdSeq - b.createdSeq));
    }
  }, [fetcher.data, loaderData.closed]);
  const busy = fetcher.state !== "idle";
  const errorText = (error: string) => error === "case_closed" ? m.chat_reports_closed() : error === "expand_limit" ? m.chat_reports_expand_limit() : error === "reserved_reason" ? m.chat_reports_reserved_reason() : m.mod_error_state();
  return <main className="max-w-3xl space-y-4 [overflow-wrap:anywhere]">
    <h1 className="text-2xl font-bold">{m.chat_reports_title()}</h1>
    <p>{m.mod_kind_chat()} · {LANG_LABELS[loaderData.lang as keyof typeof LANG_LABELS]} {loaderData.village && villageName(loaderData.village)}</p>
    <p className="ui-help text-muted-foreground">{m.chat_reports_read_help()}</p>
    {loaderData.done && <p role="status">{m.chat_reports_done()}</p>}
    {loaderData.closed && <p role="status">{m.chat_reports_closed()}</p>}
    {fetcher.data && "error" in fetcher.data && <p role="alert">{errorText(fetcher.data.error)}</p>}
    {actionData && "error" in actionData && <p role="alert">{errorText(actionData.error)}</p>}
    {!loaderData.closed && <fetcher.Form method="post"><Button type="submit" name="intent" value="open" disabled={busy}>{m.chat_reports_open()}</Button></fetcher.Form>}
    {!loaderData.closed && opened?.snapshot && <section className="space-y-2 rounded border p-3" aria-label={m.chat_reports_snapshot()}>
      <h2 className="font-semibold">{m.chat_reports_snapshot()}</h2>
      <p>@{opened.snapshot.author} · {opened.snapshot.createdAt}</p>
      <EvidenceReply reply={opened.snapshot.reply} />
      {opened.snapshot.body === null ? <p>{m.chat_reports_pruned()}</p> : <pre lang={opened.snapshot.lang} className="whitespace-pre-wrap font-sans">{opened.snapshot.body}</pre>}
      {opened.deleted && <p>{m.chat_reports_deleted()}</p>}
      {opened.current && <><h3>{m.chat_reports_current()}</h3><EvidenceReply reply={opened.current.reply} /><pre lang={opened.current.lang} className="whitespace-pre-wrap font-sans">{opened.current.body}</pre></>}
    </section>}
    {!loaderData.closed && opened?.statement && <section><h2>{m.mod_appeals_text()}</h2><pre className="whitespace-pre-wrap font-sans">{opened.statement}</pre>{opened.explanation && <p>{opened.explanation}</p>}</section>}
    {!loaderData.closed && opened?.assessments.map(report => <AiReportAssessment key={report.id} report={report} />)}
    {!loaderData.closed && <fetcher.Form method="post"><Button type="submit" name="intent" value="context" disabled={busy}>{m.chat_reports_context()}</Button></fetcher.Form>}
    {!loaderData.closed && !!context.length && <section className="space-y-3" aria-label={m.chat_reports_context()}>{context.map(message => <article key={message.id} className="rounded border p-3">
      <p className="ui-meta">@{message.author} · {message.createdAt} {message.hidden && m.village_chat_hidden()}</p>
      <EvidenceReply reply={message.reply} />
      <pre lang={message.lang} className="whitespace-pre-wrap font-sans">{message.body}</pre>
    </article>)}</section>}
    {!loaderData.closed && previous !== undefined && <fetcher.Form method="post" className="space-y-2">
      <input type="hidden" name="previous" value={previous} />
      <Field><FieldLabel>{m.chat_reports_expand_reason()}<Textarea name="note" required maxLength={500} rows={2} /></FieldLabel></Field>
      <Button type="submit" name="intent" value="expand" disabled={busy}>{m.chat_reports_expand()}</Button>
    </fetcher.Form>}
    {(loaderData.kind === "report" ? loaderData.canHide || loaderData.canUnhide || loaderData.canDismiss : !loaderData.closed) && <Form method="post" className="space-y-3 rounded border p-3">
      {loaderData.kind === "report" && <ReportReasonSelect appearance="native" label={m.mod_reason()} />}
      <Field><FieldLabel>{loaderData.kind === "report" ? m.mod_note() : m.mod_appeals_note()}<Textarea name="note" required maxLength={loaderData.kind === "report" ? 500 : 1000} rows={3} /></FieldLabel></Field>
      <div className="flex flex-wrap gap-2">{loaderData.kind === "report" ? <>
        {loaderData.canHide && <Button type="submit" name="intent" value="hide">{m.chat_reports_hide()}</Button>}{loaderData.canUnhide && <Button type="submit" name="intent" value="unhide" variant="outline">{m.chat_reports_unhide()}</Button>}{loaderData.canDismiss && <Button type="submit" name="intent" value="dismiss" variant="outline">{m.mod_dismiss()}</Button>}
      </> : <><Button type="submit" name="intent" value="uphold">{m.mod_appeals_uphold()}</Button><Button type="submit" name="intent" value="overturn" variant="outline">{m.mod_appeals_overturn()}</Button></>}</div>
    </Form>}
    {loaderData.canSuspend && <Form method="post" className="space-y-2 rounded border p-3">
      <p>{m.chat_reports_suspend_help()}</p><input type="hidden" name="reason" value="other" />
      <Field><FieldLabel>{m.mod_days({ max: 365 })}<Input type="number" name="days" min={1} max={365} required /></FieldLabel></Field>
      <Field><FieldLabel>{m.mod_note()}<Textarea name="note" required maxLength={1000} rows={2} /></FieldLabel></Field>
      <Button type="submit" name="intent" value="suspend">{m.mod_suspend()}</Button>
    </Form>}
    <p className="flex gap-4"><Link to="/mod" className="underline">{m.mod_title()}</Link>{loaderData.operator && <Link to="/admin/chat-access" className="underline">{m.chat_access_title()}</Link>}</p>
  </main>;
}

function EvidenceReply({ reply }: { reply: ChatEvidenceMessage["reply"] }) {
  if (!reply) return null;
  return <p data-chat-reply className="truncate border-s-2 ps-2 ui-meta text-muted-foreground">{"outside" in reply ? m.village_chat_reply_outside_context() : reply.unavailable ? m.village_chat_reply_unavailable() : <span lang={reply.lang}>@{reply.author}: {reply.text}</span>}</p>;
}
