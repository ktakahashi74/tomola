import { useEffect, useRef, useState, type FormEvent } from "react";
import { flushSync } from "react-dom";
import { data, Link, useNavigate } from "react-router";
import type { Route } from "./+types/post-ask-ai";
import { requireMember } from "~/lib/auth/session.server";
import { privateCacheMiddleware } from "~/lib/http/private-cache.server";
import { postAskAiEnabled } from "~/lib/ai-question-config.server";
import { readableQuestionPost } from "~/lib/ai-question-materials.server";
import { aiQuestionLabels } from "~/lib/ai-question-labels.server";
import { AI_QUESTION_ERRORS, AI_QUESTION_LIMITS, type AiQuestionError, type AiQuestionResponse } from "~/lib/ai-questions";
import { displayLangFor } from "~/lib/display-lang.server";
import { aiOpenLinks } from "~/lib/open-in-ai.server";
import { parseId } from "~/lib/params.server";
import { OpenInAi } from "~/components/open-in-ai";
import { AiQuestionAnswerView } from "~/components/ai-question-answer";
import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";
import { Label } from "~/components/ui/label";

export const middleware = [privateCacheMiddleware];
export async function loader({ request, params }: Route.LoaderArgs) {
  if (!postAskAiEnabled()) throw data("Not found", { status: 404 });
  const { db, user, profile } = await requireMember(request);
  const topicId = parseId(params.id);
  if (!await readableQuestionPost(db, topicId)) throw data("Not found", { status: 404 });
  const language = displayLangFor(request, profile);
  return { topicId, ownerId: user.id, language, labels: aiQuestionLabels(), maxQuestionChars: AI_QUESTION_LIMITS.questionChars,
    aiOpen: aiOpenLinks(request, profile, `/t/${topicId}`, { page: 1 }) };
}
export function meta({ loaderData }: Route.MetaArgs) {
  return [{ title: loaderData?.labels.title }, { name: "robots", content: "noindex, nofollow" }];
}

export default function PostAskAi({ loaderData }: Route.ComponentProps) {
  return <QuestionScreen key={`${loaderData.ownerId}:${loaderData.topicId}:${loaderData.language}`} view={loaderData} />;
}

function QuestionScreen({ view }: { view: Route.ComponentProps["loaderData"] }) {
  const { labels } = view;
  const navigate = useNavigate();
  const [question, setQuestion] = useState("");
  const [result, setResult] = useState<{ question: string; response: AiQuestionResponse } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AiQuestionError | null>(null);
  const [reportOpen, setReportOpen] = useState(false);
  const [consent, setConsent] = useState(false);
  const [reported, setReported] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const action = `/t/${view.topicId}/ask/action?${new URLSearchParams({ lang: view.language })}`;

  useEffect(() => {
    const clear = () => {
      controller.current?.abort();
      // Clear before a document can enter the browser's back/forward cache.
      flushSync(() => { setQuestion(""); setResult(null); setError(null); setReportOpen(false); setConsent(false); setReported(false); setBusy(false); });
    };
    window.addEventListener("pagehide", clear);
    return () => { window.removeEventListener("pagehide", clear); controller.current?.abort(); };
  }, []);

  async function send(payload: unknown): Promise<Record<string, unknown> | null> {
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    setBusy(true); setError(null);
    try {
      const response = await fetch(action, { method: "POST", redirect: "error", cache: "no-store", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), signal: current.signal });
      const body = await response.json() as Record<string, unknown>;
      if (current.signal.aborted) return null;
      if (!response.ok || body.error) {
        setError(AI_QUESTION_ERRORS.includes(body.error as AiQuestionError) ? body.error as AiQuestionError : "unavailable");
        return null;
      }
      return body;
    } catch { if (!current.signal.aborted) setError("unavailable"); return null; }
    finally { if (!current.signal.aborted) setBusy(false); }
  }
  async function ask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const submitted = question.trim();
    if (!submitted) return;
    setResult(null); setReportOpen(false); setConsent(false); setReported(false);
    const response = await send({ intent: "ask", question: submitted });
    if (response) setResult({ question: submitted, response: response as AiQuestionResponse });
  }
  async function makeDraft() {
    if (!result) return;
    const response = await send({ intent: "draft", question: result.question, response: result.response });
    if (typeof response?.draftUrl === "string" && /^\/drafts\/[1-9]\d*$/.test(response.draftUrl)) await navigate(response.draftUrl);
  }
  async function report() {
    if (!result || !consent) return;
    const response = await send({ intent: "report", question: result.question, response: result.response, consent });
    if (response?.reported === true) { setReported(true); setReportOpen(false); }
  }
  return <main className="reading-column space-y-6">
    <Link className="underline ui-meta" to={`/t/${view.topicId}?lang=${view.language}`}>{labels.back}</Link>
    <h1 className="text-2xl font-bold">{labels.title}</h1>
    <p>{labels.intro}</p>
    <p className="ui-help text-muted-foreground">{labels.privacy}</p>
    <p className="ui-help text-muted-foreground">{labels.daily}</p>
    {/* POST also prevents pre-hydration/native submission from putting a question in a URL. */}
    <form method="post" action={action} autoComplete="off" onSubmit={ask} className="space-y-3">
      <Label htmlFor="ai-question">{labels.question}</Label>
      <Textarea id="ai-question" name="question" value={question} onChange={event => setQuestion(event.target.value)} maxLength={view.maxQuestionChars} required disabled={busy} />
      <Button type="submit" pending={busy} disabled={busy}>{labels.submit}</Button>
    </form>
    {busy && <p role="status" className="ui-help">{labels.busy}</p>}
    {error && <p role="alert">{labels.errors[error]}</p>}
    {result && <section className="space-y-5" aria-label={labels.answerFor}>
      <p className="whitespace-pre-wrap break-words"><strong>{labels.answerFor}</strong>{" "}{result.question}</p>
      <AiQuestionAnswerView content={result.response} labels={labels} />
      <div className="space-y-2 border-t pt-4">
        <p className="ui-help text-muted-foreground">{labels.draftNotice}</p>
        <Button variant="outline" type="button" className="h-auto min-h-8 max-w-full whitespace-normal py-1.5" disabled={busy} onClick={makeDraft}>{labels.toAuthor}</Button>
      </div>
      <div className="space-y-3">
        {reported ? <p role="status">{labels.reported}</p> : <Button type="button" variant="ghost" disabled={busy} onClick={() => { setReportOpen(!reportOpen); setConsent(false); }}>{labels.report}</Button>}
        {reportOpen && !reported && <div className="space-y-3 rounded-lg border p-3">
          <label className="flex items-start gap-2"><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} disabled={busy} />{labels.reportConsent}</label>
          <Button type="button" onClick={report} disabled={!consent || busy}>{labels.reportSend}</Button>
        </div>}
      </div>
    </section>}
    <OpenInAi mdUrl={view.aiOpen.mdUrl} mdPath={view.aiOpen.mdPath} reader={false} />
  </main>;
}
