import { useEffect, useRef } from "react";
import { Button } from "~/components/ui/button";
import { ActionPanel } from "~/components/ui/action-panel";
import { Link, useFetcher } from "react-router";
import { CountWithLanguages } from "~/components/count-with-languages";
import { pickDistribution, type DistributionView, type StanceMessage, type StanceResponse } from "~/lib/stance-ui";
import { POSITIONS, type Position } from "~/lib/stances";
import { m } from "~/paraglide/messages.js";

// Stance panel: one-tap buttons for three choices, followed by the distribution summary (three counts, how many languages answered, and the "場の結論ではない" note).
// The question page and list items (home cards) share this component. It is independent of placement: it accepts props only and never reads a route loader.
// Each question has its own fetcher key, preventing mixed submissions when several cards share a page. Callers supply returnTo and the "先に結果を見る" link (peekHref).
// No outer frame or spacing is defined here; follow the containing component's layout.
//
// A press shows the chosen stance at once, without waiting for the answer (the fetcher's own form data says what was asked for). If the answer is a refusal, the earlier stance comes back and the reason is shown.
// In a list (compact), once a stance is chosen the panel is one line: "You: Agree · counts · languages · Change". "Change" opens the three buttons (and the withdrawal) under it.
//
// Hide the distribution until a stance is chosen or the "先に結果を見る" link opens a loader-provided distribution. Only then show the three counts and number of languages that answered.
// Do not provide per-language breakdowns or language-composition views.
// Without JavaScript, an ordinary form submission makes /stance redirect to returnTo, with a message for conflicts or rate-limit violations.
export type StancePanelProps = {
  questionId: number;
  stance: { position: Position | null; version: number };
  distribution: DistributionView | null;
  peekHref: string;
  // The triggering post when opened through "立場を見直す".
  triggerEntryId?: number | null;
  // List items omit the one-line disclosure and distribution note.
  compact?: boolean;
  // Result of the previous submission without JavaScript (?stance_msg=).
  message?: StanceMessage | null;
  resumeChoice?: Position | null;
  returnTo: string;
  // false when a stance cannot currently be chosen, such as on a hidden question; withdrawal remains possible.
  canChoose: boolean;
};

const LABELS: Record<Position, () => string> = {
  agree: () => m.stance_agree(),
  disagree: () => m.stance_disagree(),
  neither: () => m.stance_neither(),
};

export function StancePanel({ questionId, stance, distribution, peekHref, triggerEntryId, compact = false, message = null, resumeChoice = null, returnTo, canChoose }: StancePanelProps) {
  const fetcher = useFetcher<StanceResponse>({ key: `stance-${questionId}` });
  const busy = fetcher.state !== "idle";
  const group = useRef<HTMLDivElement>(null);
  const resume = !fetcher.data && resumeChoice !== stance.position ? resumeChoice : null;
  useEffect(() => {
    if (!resume) return;
    // Let the page's route announcement focus main before restoring the choice.
    let frame = requestAnimationFrame(() => { frame = requestAnimationFrame(() => group.current?.querySelector<HTMLButtonElement>(`button[value="${resume}"]`)?.focus()); });
    return () => cancelAnimationFrame(frame);
  }, [resume]);
  const withdrawing = useRef(false);
  const submitted = useRef(false);
  // A press swaps what is on screen (the three buttons become the one line, a refusal puts them back, and "Change" is rebuilt when the answer comes), and the pressed button goes with it.
  // From the press until the answer has settled, whenever the keyboard focus is lost to the page, it goes to the one line or back to the group of buttons, whichever is on screen.
  const keepFocus = useRef(false);
  const youRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (fetcher.state !== "idle") return;
    submitted.current = false;
    if (withdrawing.current && fetcher.data?.ok && fetcher.data.position === null) group.current?.focus();
    withdrawing.current = false;
  }, [fetcher.state, fetcher.data]);
  const data = fetcher.data;
  // Prefer this member's response when it includes this question at a version at least as new as the current one; otherwise use loader values.
  const latest = data && "version" in data && data.questionId === questionId && data.version >= stance.version ? data : null;
  const asked = fetcher.formData?.get("position");
  const askedPosition: Position | null | undefined = asked === "none" ? null : POSITIONS.find(p => p === asked);
  const position = askedPosition !== undefined ? askedPosition : latest ? latest.position : stance.position;
  const version = latest ? latest.version : stance.version;
  // The newer of the response's distribution and the loader's (a response that has none, after a withdrawal, must not hide the one the loader read afterwards).
  const shown = pickDistribution(latest ? { at: latest.at, distribution: latest.distribution } : null, distribution);
  const oneLine = compact && position !== null && canChoose && !resume;
  useEffect(() => {
    if (!keepFocus.current) return;
    if (document.activeElement === document.body || document.activeElement === null) (oneLine ? youRef.current : group.current)?.focus();
    if (fetcher.state === "idle") keepFocus.current = false;
  }, [oneLine, version, fetcher.state]);
  const failure = data && !data.ok ? data.error : null;
  // Once this member has submitted, show that response only; a previous ?stance_msg= result is obsolete.
  const notice = data ? (failure === "conflict" || failure === "rate_limited" ? failure : failure !== null ? "error" : null) : message;

  const form = (
    <fetcher.Form method="post" action="/stance" className="space-y-2" onSubmit={event => {
      if (busy || submitted.current) { event.preventDefault(); return; }
      submitted.current = true;
      keepFocus.current = true;
      withdrawing.current = (event.nativeEvent as SubmitEvent).submitter?.getAttribute("value") === "none";
    }}>
      <input type="hidden" name="questionId" value={questionId} />
      <input type="hidden" name="version" value={version} />
      {triggerEntryId != null && <input type="hidden" name="trigger" value={triggerEntryId} />}
      <input type="hidden" name="returnTo" value={returnTo} />
      <div ref={group} tabIndex={-1} role="group" aria-label={m.stance_title()} className="flex flex-wrap items-center gap-2">
        {canChoose ? (
          POSITIONS.map((p) => (
            <Button variant="outline"
              key={p}
              type="submit"
              name="position"
              value={p}
              pressed={position === p}
              pending={busy}
            >
              {LABELS[p]()}
            </Button>
          ))
        ) : (
          position === null && <span className="ui-help text-muted-foreground">{m.stance_closed()}</span>
        )}
      </div>
      {position !== null && (
        <Button variant="link" type="submit" name="position" value="none" pending={busy} className="h-auto px-0 ui-meta text-muted-foreground">
          {m.stance_withdraw()}
        </Button>
      )}
    </fetcher.Form>
  );
  const noticeLine = notice && (
    <p role="status" className="ui-help text-notice-emphasis">
      {notice === "conflict" ? m.stance_conflict() : notice === "rate_limited" ? m.stance_rate_limited() : m.stance_error()}
    </p>
  );
  const counts = shown && (
    <ul aria-label={m.stance_counts_label()} className="flex flex-wrap gap-x-3">
      {POSITIONS.map((p) => (
        <li key={p}>
          {LABELS[p]()} <span className="font-semibold">{shown.counts[p]}</span>
        </li>
      ))}
    </ul>
  );

  // A list row after the choice: one line, with the three buttons behind "Change".
  if (oneLine) {
    return (
      <div className="space-y-2" data-question={questionId}>
        <div data-stance-summary="" className="flex flex-wrap items-center gap-x-4 gap-y-1 ui-meta">
          <span ref={youRef} tabIndex={-1} data-stance-you="" className="rounded-sm font-medium focus-visible:outline-2 focus-visible:outline-ring">{m.stance_you({ position: LABELS[position]() })}</span>
          {counts}
          {shown && <span><CountWithLanguages count={{ total: shown.total, langs: shown.langs }} kind="stances" short /></span>}
          <ActionPanel key={version} label={m.stance_change()} className="min-w-0 open:basis-full" summaryClassName="h-auto px-1 ui-meta">{form}</ActionPanel>
        </div>
        {noticeLine}
      </div>
    );
  }

  return (
    <div className="space-y-2" data-question={questionId}>
      {form}
      {resume && <p role="status" className="ui-help text-notice-emphasis">{m.stance_consent_resume({ position: LABELS[resume]() })}</p>}
      {noticeLine}
      {shown ? (
        <div className="space-y-1 ui-meta">
          {counts}
          <p>
            <CountWithLanguages count={{ total: shown.total, langs: shown.langs }} kind="stances" />
          </p>
          {!compact && <p role="note" className="ui-help text-muted-foreground">{m.stance_note_short()}</p>}
        </div>
      ) : (
        canChoose && (
          <p className="ui-meta">
            <Link to={peekHref} prefetch="none" preventScrollReset className="underline">
              {m.stance_peek()}
            </Link>
          </p>
        )
      )}
      {!compact && (
        <p className="ui-meta text-muted-foreground">
          {m.stance_privacy_line()}{" "}
          <Link to="/settings/stances#privacy" className="underline">
            {m.stance_privacy_title()}
          </Link>
        </p>
      )}
    </div>
  );
}
