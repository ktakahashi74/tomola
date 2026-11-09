import { ReportReasonSelect } from "~/components/report-reason-select";
import { FieldLabel } from "~/components/ui/field";
import { Textarea } from "~/components/ui/textarea";
import { Button } from "~/components/ui/button";
import { ActionPanel } from "~/components/ui/action-panel";
import { Form, useLocation } from "react-router";
import { m } from "~/paraglide/messages.js";

// Report a post to moderators, separately from reporting a mistranslation. Submit a reason category and optional explanation to the thread page's action (intent=flag).
// The reporter is disclosed neither to moderators nor in the public record. The short word "Report" is what is drawn; the full phrase is what is read out.
export function EntryReportForm({ entryId, anchor, reported }: { entryId: number; anchor: string; reported: boolean }) {
  const location = useLocation();
  if (reported) return <p className="ui-help text-muted-foreground">{m.flag_already_reported()}</p>;
  return (
    <ActionPanel
      label={<><span aria-hidden="true">{m.flag_short()}</span><span className="sr-only">{m.flag_summary()}</span></>}
      className="min-w-0 ui-meta open:basis-full"
      summaryClassName="touch-action h-auto px-1 ui-meta"
    >
      <Form method="post" action={`${location.pathname}${location.search}${anchor}`} className="space-y-2 rounded border p-3">
        <input type="hidden" name="intent" value="flag" />
        <input type="hidden" name="entryId" value={entryId} />
        <ReportReasonSelect label={m.flag_reason()} defaultValue="spam" />
        <FieldLabel className="w-full flex-col items-start">
          {m.flag_note()}
          <Textarea name="note" rows={3} maxLength={1000} />
        </FieldLabel>
        <p className="ui-help text-muted-foreground">{m.flag_privacy()}</p>
        <Button variant="outline" type="submit">
          {m.flag_submit()}
        </Button>
      </Form>
    </ActionPanel>
  );
}
