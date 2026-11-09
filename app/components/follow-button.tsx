import { Button } from "~/components/ui/button";
import { useFetcher } from "react-router";
import type { FollowState } from "~/lib/follows";
import { m } from "~/paraglide/messages.js";

type FollowResponse = { ok: true; threadId: number; state: FollowState };

// The follow button of a topic. It sends POST /follow with a fetcher (the page stays) and, without JavaScript, as a plain form (the server goes back to returnTo).
// The state shown is: what is being sent right now (so that it changes at once), else the last answer of the server, else `state` from the loader.
// "page" shows following as a status beside an explicit action; "list" is the small button of a list item ("Unfollow" while following).
// "compact" keeps the state separate from the explicit Unfollow action too.
export function FollowButton({
  threadId,
  state,
  returnTo,
  variant = "page",
}: {
  threadId: number;
  state: FollowState | null;
  returnTo: string;
  variant?: "page" | "list" | "compact";
}) {
  const fetcher = useFetcher<FollowResponse>();
  const sending = fetcher.formData?.get("threadId") === String(threadId) ? fetcher.formData.get("follow") : undefined;
  const answer = fetcher.data?.threadId === threadId ? fetcher.data.state : state;
  const current: FollowState | null = sending !== undefined && sending !== null ? (sending === "1" ? "following" : "unfollowed") : answer;
  const following = current === "following";
  const label = following ? m.follow_unfollow() : m.follow_button();
  return (
    <fetcher.Form method="post" action="/follow" title={variant === "compact" ? m.follow_help() : undefined} className={variant !== "list" ? "inline-flex flex-wrap items-center gap-2" : "inline"}>
      <input type="hidden" name="threadId" value={threadId} />
      <input type="hidden" name="follow" value={following ? "0" : "1"} />
      <input type="hidden" name="returnTo" value={returnTo} />
      <span role="status" className="ui-meta text-muted-foreground empty:sr-only">{variant !== "list" && following ? m.follow_following() : null}</span>
      <Button variant={variant === "page" ? "outline" : "link"}
        type="submit"
        className={variant === "page" ? "" : "h-auto px-0 ui-meta"}
      >
        {label}
      </Button>
    </fetcher.Form>
  );
}
