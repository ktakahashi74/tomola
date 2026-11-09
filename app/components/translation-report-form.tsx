import { Fragment, useId, useState } from "react";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "~/components/ui/select";
import { Field, FieldLabel } from "~/components/ui/field";
import { Textarea } from "~/components/ui/textarea";
import { Button, buttonVariants } from "~/components/ui/button";
import { cn } from "~/lib/utils";
import { ActionPanel } from "~/components/ui/action-panel";
import { useFetcher, useLocation } from "react-router";
import { m } from "~/paraglide/messages.js";

type Report = { id: number; lang: string; field: string; excerpt: string; note: string };
type Result = { intent: string; entryId: number | null; error?: string | null; reported: boolean; reportId?: number | null; lang?: string; field?: string };
type Part = "body" | "title";

// Report a wrong translation with one small press. The press reports the part it names: the body, or for a post with a title a second small button reports the title alone, so that a person who found
// only the title wrong does not start a re-translation of the body. Only after a report does a panel open under the buttons, with the optional parts (the wrong passage and a note), which amend that
// report (when two parts are reported, a choice says which one). Both forms also work as native POSTs.
// The forms take no space of their own (`contents`): their buttons, panel and message are items of the row of actions that holds them. The words drawn are the names read out.
// `inline` is accepted for callers that name it; there is one look now.
export function TranslationReportForm({ entryId, lang, kind, hasTitle = true, reports = [] }: { entryId: number; lang: string; kind: "topic" | "reply"; hasTitle?: boolean; inline?: boolean; reports?: Report[] }) {
  const reasonId = useId();
  const partNoteId = useId();
  const location = useLocation();
  const reporting = useFetcher<Result>();
  const amending = useFetcher<Result>();
  const [editing, setEditing] = useState<Part>("body");
  const [last, setLast] = useState<"report" | "details">("report");
  const [details, setDetails] = useState<Partial<Record<Part, { excerpt: string; note: string }>>>({});
  const parts: Part[] = kind === "topic" && hasTitle ? ["body", "title"] : ["body"];
  const mine = (result: Result | undefined, part?: Part) => result?.entryId === entryId && (!result.lang || result.lang === lang) && (part === undefined || (result.field ?? "body") === part) ? result : undefined;
  const stored = (part: Part) => reports.find(report => report.lang === lang && report.field === part);
  // Revalidation owns the current version; an old fetcher result must not mark a replacement translation.
  const justReported = (part: Part) => reporting.state === "loading" && !!mine(reporting.data, part)?.reported;
  const isReported = (part: Part) => !!stored(part) || justReported(part);
  const reportIdOf = (part: Part) => stored(part)?.id ?? (justReported(part) ? mine(reporting.data, part)?.reportId ?? null : null);
  const reportedParts = parts.filter(isReported);
  const part = reportedParts.includes(editing) ? editing : reportedParts[0];
  const busy = reporting.state !== "idle" || amending.state !== "idle";
  const sending = reporting.formData?.get("field");
  const anchor = `#${kind === "topic" ? "p" : "c"}-${entryId}`;
  const action = `${location.pathname}${location.search}${anchor}`;
  const guard = (event: { preventDefault(): void }) => { if (busy) event.preventDefault(); };
  const result = last === "details" ? mine(amending.data) : mine(reporting.data);
  const shownResult = result && (result.reported || result.error) ? result : undefined;
  const reportId = part ? reportIdOf(part) : null;
  function change(name: "excerpt" | "note", value: string) {
    if (!part) return;
    setDetails(current => ({ ...current, [part]: { excerpt: stored(part)?.excerpt ?? "", note: stored(part)?.note ?? "", ...current[part], [name]: value } }));
  }
  return <>
    <reporting.Form method="post" action={action} className="contents" onSubmit={event => {
      setLast("report");
      guard(event);
      // The panel that opens after this press is for the part just reported.
      if (event.defaultPrevented) return;
      const submitted = (event.nativeEvent as SubmitEvent).submitter?.getAttribute("value");
      if (submitted === "body" || submitted === "title") setEditing(submitted);
    }}>
      <input type="hidden" name="intent" value="report" />
      <input type="hidden" name="entryId" value={entryId} />
      <input type="hidden" name="lang" value={lang} />
      {parts.map(each => {
        const pending = reporting.state !== "idle" && sending === each;
        // A plain button: the name and value must be in the page's own HTML, so that the title button reports the title without a script too.
        return <Fragment key={each}><button type="submit" name="field" value={each} disabled={isReported(each)} aria-busy={pending || undefined} aria-disabled={pending || undefined} aria-describedby={isReported(each) && reportedParts.length > 1 ? `${partNoteId}-${each}` : undefined} data-pending={pending ? "" : undefined}
          className={cn(buttonVariants({ variant: "ghost" }), "touch-action h-auto px-1 ui-meta text-muted-foreground data-pending:pointer-events-none data-pending:opacity-50")}>
          {isReported(each) ? m.report_reported() : each === "body" ? m.report_button() : m.report_title_button()}
        </button>
        {isReported(each) && reportedParts.length > 1 && <span id={`${partNoteId}-${each}`} className="sr-only">{each === "body" ? m.report_field_body() : m.report_field_title()}</span>}
        </Fragment>;
      })}
    </reporting.Form>
    {part && <ActionPanel label={m.report_optional_summary()} open={!!mine(reporting.data)?.reported && reportedParts.length > 0} className="min-w-0 ui-meta open:basis-full" summaryClassName="touch-action h-auto px-1 ui-meta">
      <amending.Form method="post" action={action} className="space-y-2 rounded border p-3" onSubmit={event => { setLast("details"); guard(event); }}>
        <input type="hidden" name="intent" value="report-details" />
        <input type="hidden" name="entryId" value={entryId} />
        <input type="hidden" name="lang" value={lang} />
        {reportId && <input type="hidden" name="reportId" value={reportId} />}
        {reportedParts.length > 1 ? <Field>
          <FieldLabel htmlFor={reasonId}>{m.report_field()}</FieldLabel>
          <Select name="field" value={part} disabled={busy} onValueChange={value => { if (value === "body" || value === "title") setEditing(value); }} items={[{ value: "body", label: m.report_field_body() }, { value: "title", label: m.report_field_title() }]}>
            <SelectTrigger id={reasonId} aria-label={m.report_field()}><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="body">{m.report_field_body()}</SelectItem><SelectItem value="title">{m.report_field_title()}</SelectItem></SelectContent>
          </Select>
        </Field> : <input type="hidden" name="field" value={part} />}
        <FieldLabel className="w-full flex-col items-start">{m.report_excerpt()}<Textarea name="excerpt" rows={2} maxLength={1000} lang={lang} value={details[part]?.excerpt ?? stored(part)?.excerpt ?? ""} onChange={event => change("excerpt", event.target.value)} /></FieldLabel>
        <FieldLabel className="w-full flex-col items-start">{m.report_note()}<Textarea name="note" rows={3} maxLength={2000} value={details[part]?.note ?? stored(part)?.note ?? ""} onChange={event => change("note", event.target.value)} /></FieldLabel>
        {reportId && <Button variant="outline" type="submit" pending={amending.state !== "idle"}>{m.save_changes()}</Button>}
      </amending.Form>
    </ActionPanel>}
    {shownResult && <p role={shownResult.error ? "alert" : "status"} className={`basis-full ${shownResult.error ? "text-destructive" : "text-success"}`}>{shownResult.error === "rate_limited" ? m.error_rate_limited() : shownResult.error ? m.report_error() : m.report_thanks()}</p>}
  </>;
}
