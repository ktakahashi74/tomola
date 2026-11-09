import { reviewHrefFor, type StanceResponse } from "~/lib/stance-ui";
import { Button } from "~/components/ui/button";
import { Tooltip, TooltipTrigger, TooltipContent } from "~/components/ui/tooltip";
import { useEffect, useId, useState } from "react";
import { Link, useFetcher, useLocation } from "react-router";
import { CountWithLanguages } from "~/components/count-with-languages";
import { pickReactions, type ReactionsView, type VoteResponse } from "~/lib/vote-ui";
import { m } from "~/paraglide/messages.js";

// "Insightful": the reader gained a new perspective from this post (it is not a vote of agreement). The button and the count of one post.
// The count is the total and the number of languages it came from ("Insightful 9 (3 languages)"), drawn by the one shared component CountWithLanguages. There is nothing
// per language here, and the props have no place for it.
//
// Where the data comes from: a page hands over `reactions` (its loader's values) and, if it reloads its loader data after a press, `loadedAt` (when it read them).
// The button shows the answer of its own fetcher (POST /vote) while that is newer, so that a press is seen at once on a page that does not reload (the lists, the cards of the
// home) and without a flicker on a page that does (the question page). The fetcher is keyed by the post: two buttons of the same post on one page (the reasons panel and
// the reply list) share it.
//
// Without JavaScript the button is a plain form post and the server sends the member back to `anchor`, which gives the same result.

// "Reconsider my stance": a small link next to the button, shown only while the button is pressed, and only when the page hands over `reviewHref`, which it does only to a viewer
// who currently holds a stance on this question. It has no wording that urges a change: the choice belongs to the member.
export function EntryReactions({
  entryId,
  reactions,
  canVote,
  anchor,
  loadedAt,
  reviewHref = null,
  compact = false,
}: {
  entryId: number;
  reactions: ReactionsView;
  canVote: boolean;
  anchor: string;
  loadedAt?: string;
  reviewHref?: string | null;
  compact?: boolean;
}) {
  const fetcher = useFetcher<VoteResponse>({ key: `vote-${entryId}` });
  const location = useLocation();
  const questionId = /^\/t\/([1-9]\d*)$/.exec(location.pathname)?.[1];
  const stance = useFetcher<StanceResponse>({ key: `stance-${questionId}` }).data;
  const currentStance = stance && "version" in stance && String(stance.questionId) === questionId && (!loadedAt || stance.at >= loadedAt) ? stance : null;
  const shownReviewHref = currentStance ? currentStance.position === null ? null : reviewHrefFor(location.pathname, location.search, entryId) : reviewHref;
  const returnTo = `${location.pathname}${location.search}${anchor}`;
  const data = fetcher.data;
  const [accepted, setAccepted] = useState<Extract<VoteResponse, { ok: true }> | null>(null);
  useEffect(() => { if (data?.ok && data.entryId === entryId) setAccepted(data); }, [data, entryId]);
  // A rejected attempt must not erase the last confirmed press on a page that skips revalidation.
  const latest = data?.ok && data.entryId === entryId ? data : accepted?.entryId === entryId ? accepted : null;
  const shownReactions = pickReactions(latest, reactions, loadedAt);
  // While sending, show the state that was asked for.
  const sending = fetcher.formData?.get("on");
  const pressed = sending === "1" ? true : sending === "0" ? false : shownReactions.mine;
  // One id per button (the same post can have a button in the reasons panel and one in the reply list, so the id cannot be made from the post alone).
  const helpId = useId();
  const [helpOpen, setHelpOpen] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      {canVote && (
        <fetcher.Form method="post" action="/vote" className="inline">
          <input type="hidden" name="entryId" value={entryId} />
          {/* The value to send is the opposite of the state shown now (while sending, of the state asked for), so that a quick second press reverses what is on the screen. */}
          <input type="hidden" name="on" value={pressed ? "0" : "1"} />
          <input type="hidden" name="returnTo" value={returnTo} />
          <Tooltip open={helpOpen} onOpenChange={setHelpOpen}><TooltipTrigger render={<Button variant={compact ? "link" : "outline"}
            type="submit"
            onClick={() => setHelpOpen(false)}
            pressed={pressed}
            aria-describedby={helpId}
            className={compact ? "touch-action h-auto px-0 ui-meta data-pressed:px-1.5" : ""}
          />}>
            {m.insightful_give()}
          </TooltipTrigger><TooltipContent role="tooltip">{m.insightful_help()}</TooltipContent></Tooltip>
          <span id={helpId} className="sr-only">
            {m.insightful_help()}
          </span>
        </fetcher.Form>
      )}
      <span className="ui-meta">
        <CountWithLanguages count={shownReactions.insightful} kind="insightful" short={canVote} />
      </span>
      {data && !data.ok && data.entryId === entryId && <p role="status" className="ui-help text-destructive">{data.error === "rate_limited" ? m.error_rate_limited() : data.error === "not_found" ? m.mod_error_not_found() : m.error_generic()}</p>}
      {canVote && pressed && shownReviewHref && (
        <Link to={shownReviewHref} className="ui-meta underline">
          {m.insightful_review()}
        </Link>
      )}
    </div>
  );
}
