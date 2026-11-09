import { ReportReasonSelect } from "~/components/report-reason-select";
import { FieldLabel } from "~/components/ui/field";
import { Checkbox } from "~/components/ui/checkbox";
import { Textarea } from "~/components/ui/textarea";
import { Button } from "~/components/ui/button";
import { ActionPanel } from "~/components/ui/action-panel";
import { Form, useFetcher } from "react-router";
import { errorText, type ModError } from "~/lib/mod-error-text";
import { m } from "~/paraglide/messages.js";

// Moderation controls for a thread post, shown only to its responsible moderators and operators for another member's post within their jurisdiction: hide/unhide and operator deletion.
// Submit to /mod's action, which handles actions in the same way as the report list. On success, return to returnTo (this post).
type ModerationPanelProps = { entryId: number; hidden: boolean; returnTo: string; canDelete: boolean; retainsReply?: boolean; className?: string };

export function ModerationPanel({ className, ...props }: ModerationPanelProps) {
  return <ActionPanel label={m.mod_panel_summary()} className={className ?? "text-sm"} summaryClassName="touch-action h-auto px-1 ui-meta"><ModerationForm {...props} /></ActionPanel>;
}

export function ModerationForm({ entryId, hidden, returnTo, canDelete, retainsReply = false }: Omit<ModerationPanelProps, "className">) {
  const fetcher = useFetcher<{ error?: ModError }>();
  // Reply controls keep the editor on refusals; successful redirects return to this topic.
  const ActionForm = retainsReply ? fetcher.Form : Form;
  return (
    <ActionForm method="post" action="/mod" className="space-y-2 rounded border p-3" onSubmit={() => {
      if (retainsReply && fetcher.state === "idle" && fetcher.data) fetcher.reset();
    }}>
      <input type="hidden" name="entryId" value={entryId} />
      <input type="hidden" name="returnTo" value={returnTo} />
      <ReportReasonSelect label={m.mod_reason()} defaultValue="other" />
      <FieldLabel className="w-full flex-col items-start">
        {m.mod_note()}
        <Textarea name="note" rows={2} maxLength={500} />
      </FieldLabel>
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="outline" type="submit" name="intent" value={hidden ? "unhide" : "hide"}>
          {hidden ? m.mod_unhide() : m.mod_hide()}
        </Button>
        {canDelete && (
          <>
            <FieldLabel>
              <Checkbox name="confirm" value="1" /> {m.mod_delete_confirm()}
            </FieldLabel>
            <Button variant="destructive" type="submit" name="intent" value="delete">
              {m.mod_delete()}
            </Button>
          </>
        )}
      </div>
      {retainsReply && fetcher.data?.error && <p role="alert" className="text-destructive">{errorText(fetcher.data.error)}</p>}
    </ActionForm>
  );
}
