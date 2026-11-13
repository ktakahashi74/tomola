import type { AiQuestionContent } from "~/lib/ai-questions";
import type { AiQuestionLabels } from "~/lib/ai-question-labels.server";

export function AiQuestionAnswerView({ content, labels, idPrefix = "ai-source" }: { content: AiQuestionContent; labels: AiQuestionLabels; idPrefix?: string }) {
  const { answer, scope } = content;
  return <div className="space-y-5 break-words [overflow-wrap:anywhere]" data-ai-question-answer="">
    <p className="ui-help text-muted-foreground">{labels.scope.replace("{replies}", String(scope.replies))}</p>
    {scope.truncated && <p className="ui-help">{labels.truncated}</p>}
    {answer.status === "not_confirmed" ? <p>{labels.notConfirmed}</p> : <>
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">{labels.reading}</h2>
        {answer.readings.map((reading, index) => <p key={index} className="whitespace-pre-wrap" lang={content.language}>
          {reading.text}{" "}{reading.citations.map(number => <a className="underline" href={`#${idPrefix}-${number}`} key={number}>[{number}]</a>)}
        </p>)}
      </section>
      {(["post", "reply"] as const).map(kind => {
        const citations = answer.citations.map((citation, index) => ({ citation, number: index + 1 })).filter(row => row.citation.kind === kind);
        return citations.length > 0 && <section className="space-y-3" key={kind}>
          <h2 className="text-lg font-semibold">{kind === "post" ? labels.posts : labels.replies}</h2>
          {citations.map(({ citation, number }) => <article key={number} id={`${idPrefix}-${number}`} className="space-y-2 rounded-lg border p-3">
            <p className="ui-meta">[{number}] {citation.author}</p>
            <div className={citation.translation ? "grid gap-3 sm:grid-cols-2" : "space-y-3"}>
              <div className="min-w-0 space-y-1">
                <a className="ui-meta underline" href={citation.original.href}>{labels.original}</a>
                <blockquote lang={citation.original.lang} className="whitespace-pre-wrap border-s-2 ps-3">{citation.original.quote}</blockquote>
              </div>
              {citation.translation && <div className="min-w-0 space-y-1">
                <a className="ui-meta underline" href={citation.translation.href}>{labels.translation}</a>
                <blockquote lang={citation.translation.lang} className="whitespace-pre-wrap border-s-2 ps-3">{citation.translation.quote}</blockquote>
                {citation.translation.stale && <p className="ui-help text-muted-foreground">{labels.stale}</p>}
              </div>}
            </div>
          </article>)}
        </section>;
      })}
    </>}
  </div>;
}
