import type { Distribution } from "~/lib/distribution.server";
import type { Position } from "~/lib/stances";

// Browser-safe, DB-free helpers for StancePanel and hosting screens, also used by home cards.

// UI distribution carries only totals/language counts; asOf is ISO text. The type cannot carry per-area counts.
export type DistributionView = { questionId: number; total: number; counts: Record<Position, number>; langs: number; asOf: string };

export function toDistributionView(d: Distribution): DistributionView {
  return { questionId: d.questionId, total: d.total, counts: { agree: d.counts.agree, disagree: d.counts.disagree, neither: d.counts.neither }, langs: d.langs, asOf: d.asOf.toISOString() };
}

// /stance fetcher response: success, conflict with current stance/version, rate limit, or other error. distribution only when a stance is chosen.
// at: the server time (ISO) at which the response was made; pickDistribution compares it with the as_of of a distribution the page loaded later.
export type StanceResponse =
  | { ok: true; questionId: number; position: Position | null; version: number; distribution: DistributionView | null; at: string }
  | { ok: false; error: "conflict"; questionId: number; position: Position | null; version: number; distribution: DistributionView | null; at: string }
  | { ok: false; error: "rate_limited" | "not_found" | "not_a_question" | "hidden" | "bad_request" };

// Which distribution a stance panel shows: the one from the member's latest /stance response (`latest`), or the one the page loader handed over (`loaderDistribution`).
// The newer one wins. The response is newer unless the loader read the distribution after the response was made (`asOf` later than `latest.at`): after "choose, withdraw,
// see the results first" the response has no distribution (null), and the loader's, read when the member followed the link, must be shown. Without a response, the loader's.
// A loader without a distribution (no peek, nothing chosen) has no time to compare, so the response stands (null after a withdrawal).
export function pickDistribution(latest: { at: string; distribution: DistributionView | null } | null, loaderDistribution: DistributionView | null): DistributionView | null {
  if (latest === null) return loaderDistribution;
  if (loaderDistribution !== null && Date.parse(loaderDistribution.asOf) > Date.parse(latest.at)) return loaderDistribution;
  return latest.distribution;
}

// No-JS form conflicts/rate limits redirect with ?stance_msg=conflict|rate_limited&stance_q=<question-id> for loader display.
export type StanceMessage = "conflict" | "rate_limited";
export type StanceMessageParam = { message: StanceMessage; questionId: number };

export function readStanceMessage(url: URL): StanceMessageParam | null {
  const message = url.searchParams.get("stance_msg");
  const questionId = parseId(url.searchParams.get("stance_q"));
  return (message === "conflict" || message === "rate_limited") && questionId !== null ? { message, questionId } : null;
}

// ?peek=<question-id>, 「先に結果を見る」: lists use ?peek=<id>#q-<id>, thread uses ?peek=1#stance. One positive integer; null if absent/invalid.
export function readPeekParam(url: URL): number | null {
  return parseId(url.searchParams.get("peek"));
}

function parseId(raw: string | null): number | null {
  if (raw === null || !/^[1-9]\d{0,15}$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) ? id : null;
}

// Destinations of fetcher posts after which a page does not reload its loader data, because the control that posted already shows its own result from the response:
// the stance panel (/stance), the Insightful button (/vote) and the follow button (/follow). A list uses this so that a one-tap press does not re-order or re-draw the list (the order of a list
// must not move under the reader's finger). The thread uses the same self-updating controls.
export const SELF_UPDATING_ACTIONS: readonly string[] = ["/stance", "/vote", "/follow"];

export function skipRevalidationFor(formAction: string | undefined): boolean {
  if (formAction === undefined) return false;
  const path = formAction.split(/[?#]/)[0];
  return SELF_UPDATING_ACTIONS.includes(path);
}

// Stance return URL from current location: drop ?stance_msg/?stance_q prior-result notices and ?peek, then add question anchor.
// Also drop ?review=: after one 「立場を見直す」 change, do not carry the trigger across no-JS reloads as a candidate again.
export function stanceReturnTo(pathname: string, search: string, anchor: string): string {
  const params = new URLSearchParams(search);
  params.delete("stance_msg");
  params.delete("stance_q");
  params.delete("stance_choice");
  params.delete("peek");
  params.delete("review");
  const query = params.toString();
  return `${pathname}${query ? `?${query}` : ""}#${anchor}`;
}

// 「先に結果を見る」 link preserves filters ?asks=/page=/lang= and adds ?peek=<id>.
export function peekHrefFor(pathname: string, search: string, peekId: number, anchor: string): string {
  const params = new URLSearchParams(search);
  params.delete("stance_msg");
  params.delete("stance_q");
  params.set("peek", String(peekId));
  return `${pathname}?${params.toString()}#${anchor}`;
}

// ?review=<post id>: the member came from the "Reconsider my stance" link of a post they pressed Insightful on. One positive integer; otherwise null.
// The loader checks that the post may really be the trigger (loadReviewTrigger in stances.server.ts) before it hands it to the stance panel.
export function readReviewParam(url: URL): number | null {
  return parseId(url.searchParams.get("review"));
}

// The link "Reconsider my stance" of a post inside a question's thread: the current page (so that ?lang= and the like stay), with ?review=<post> and the stance panel as the anchor.
export function reviewHrefFor(pathname: string, search: string, entryId: number): string {
  const params = new URLSearchParams(search);
  params.delete("stance_msg");
  params.delete("stance_q");
  params.delete("peek");
  params.set("review", String(entryId));
  return `${pathname}?${params.toString()}#stance`;
}
