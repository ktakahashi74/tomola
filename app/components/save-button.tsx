import { useFetcher } from "react-router";
import { Button } from "~/components/ui/button";
import { m } from "~/paraglide/messages.js";

export function SaveButton({ topicId, saved, returnTo }: { topicId: number; saved: boolean; returnTo: string }) {
  const fetcher = useFetcher<{ ok: boolean }>();
  const busy = fetcher.state !== "idle";
  return <fetcher.Form method="post" action="/save" className="inline-flex flex-wrap items-center gap-2">
    <input type="hidden" name="topicId" value={topicId} />
    <input type="hidden" name="saved" value={saved ? "0" : "1"} />
    <input type="hidden" name="returnTo" value={returnTo} />
    <Button type="submit" variant="link" className="h-auto px-0 ui-meta" disabled={busy} aria-busy={busy} aria-pressed={saved}>
      {saved ? m.saved_remove() : m.saved_add()}
    </Button>
    <span role="status" className="ui-meta empty:sr-only">{!busy && fetcher.data?.ok === false ? m.saved_failed() : null}</span>
  </fetcher.Form>;
}
