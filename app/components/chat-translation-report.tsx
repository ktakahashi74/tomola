import { useFetcher } from "react-router";
import { m } from "~/paraglide/messages.js";
export function ChatTranslationReport({ id, lang, tabIndex }: { id: string; lang: string; tabIndex?: number }) {
  const fetcher = useFetcher<{ translationReported?: boolean; error?: string }>();
  const reported = fetcher.data?.translationReported === true;
  return <fetcher.Form method="post" className="contents" preventScrollReset>
    <input type="hidden" name="intent" value="translation-report" /><input type="hidden" name="id" value={id} /><input type="hidden" name="lang" value={lang} />
    <button tabIndex={tabIndex} type="submit" className="underline" disabled={reported || fetcher.state !== "idle"}>{reported ? m.report_reported() : m.report_button()}</button>
    <details className="min-w-0 open:basis-full"><summary tabIndex={tabIndex} className="cursor-pointer underline">{m.report_optional_summary()}</summary>
      <label className="block">{m.report_note()}<textarea tabIndex={tabIndex} name="note" maxLength={2000} rows={2} className="block w-full rounded border p-2" /></label>
    </details>
    {fetcher.data?.error && <span role="alert">{fetcher.data.error === "limit" ? m.error_rate_limited() : m.report_error()}</span>}
    {reported && <span role="status" className="sr-only">{m.report_thanks()}</span>}
  </fetcher.Form>;
}
