// What the "Insightful" button (components/reactions.tsx) and its pages share (browser-safe: it reads no database). The card of the home uses the same types.

// The Insightful state of one post as a page receives it: the total, the number of languages it came from, and whether the viewer pressed it. Nothing per language
// (the type has no place for it). It is structurally the same as Reactions in votes.server.ts.
export type ReactionsView = { insightful: { total: number; langs: number }; mine: boolean };

// The answer of POST /vote to a fetcher. `at` is the server time (ISO) at which `reactions` was read.
export type VoteResponse = { ok: true; entryId: number; voted: boolean; reactions: ReactionsView; at: string } | { ok: false; entryId: number; error: "own_entry" | "not_found" | "rate_limited" };

// Which Insightful state a button shows: the one from the member's latest /vote response for this post, or the one the page loader handed over (`loaderReactions`).
// The newer one wins. `loadedAt` is the time (ISO) at which the page's loader read its values. A response is newer than that unless the page was reloaded afterwards
// (a reply was sent, the member navigated, a revalidation ran): then the loader's values, which also contain this member's own press, are shown, so that a response from an
// earlier press never hides what other members did meanwhile. Without `loadedAt` (a page that never reloads its loader data after a press, as the lists do), the response stands.
export function pickReactions(latest: { at: string; reactions: ReactionsView } | null, loaderReactions: ReactionsView, loadedAt?: string): ReactionsView {
  if (latest === null) return loaderReactions;
  if (loadedAt !== undefined && Date.parse(loadedAt) > Date.parse(latest.at)) return loaderReactions;
  return latest.reactions;
}
