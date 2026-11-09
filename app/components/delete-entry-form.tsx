import { Button } from "~/components/ui/button";
import { ActionPanel } from "~/components/ui/action-panel";
import { Form } from "react-router";
import { m } from "~/paraglide/messages.js";

// Delete one's own post, with a confirmation step. The small "Delete" button opens the explanation and the confirmation button below it; it also works without JavaScript.
// A deleted post shows only "削除された投稿", while the positions of replies remain. Deletion cannot be undone. Submit to the thread page's action (intent=delete).
// `inline` is the short word in a row of a reply's actions (read out in full); otherwise the full phrase, for a menu.
export function DeleteEntryForm({ entryId, kind, inline = false }: { entryId: number; kind: "topic" | "reply"; inline?: boolean }) {
  return (
    <ActionPanel
      label={inline ? <><span aria-hidden="true">{m.delete_short()}</span><span className="sr-only">{m.delete_summary()}</span></> : m.delete_summary()}
      className={inline ? "min-w-0 ui-meta open:basis-full" : "ui-meta"}
      summaryClassName={inline ? "touch-action h-auto px-1 ui-meta" : "h-auto px-1 ui-meta"}
    >
      <Form method="post" className="space-y-2 rounded border border-destructive/30 p-3">
        <input type="hidden" name="intent" value="delete" />
        <input type="hidden" name="entryId" value={entryId} />
        <p className="ui-help">{kind === "topic" ? m.delete_warning_topic() : m.delete_warning_reply()}</p>
        <Button variant="destructive" type="submit" name="confirm" value="1">
          {m.delete_confirm()}
        </Button>
      </Form>
    </ActionPanel>
  );
}
