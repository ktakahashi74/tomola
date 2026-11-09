import { enforceMemberLimit } from "~/lib/http/limits.server";
import { data, redirect } from "react-router";
import type { Route } from "./+types/vote";
import { requireWriter } from "~/lib/auth/session.server";
import { safeLocalPath } from "~/lib/display-lang.server";
import { formString } from "~/lib/entry-form.server";
import { assertSameOrigin } from "~/lib/http/csrf.server";
import { isNavigation } from "~/lib/http/navigation.server";
import type { VoteResponse } from "~/lib/vote-ui";
import { loadReactions, NO_REACTIONS, setVote } from "~/lib/votes.server";

const HEADERS = { "Cache-Control": "private, no-store" };

// Press or remove "Insightful" (POST only).
// A fetcher (with JavaScript) gets the result as data, including the post's new Insightful state, and the page does not move. A plain form post (without JavaScript; a browser
// navigation) is sent back to the page it came from. Both end the same way.
export async function action({ request }: Route.ActionArgs) {
  // A POST from another site must not press it (CSRF). Checked before authentication and before reading the input.
  assertSameOrigin(request);
  const { user, db } = await requireWriter(request);
  const form = await request.formData();
  const raw = formString(form, "entryId");
  const entryId = /^[1-9]\d{0,15}$/.test(raw) ? Number(raw) : NaN;
  const on = formString(form, "on");
  if (!Number.isSafeInteger(entryId) || (on !== "1" && on !== "0")) throw data("Bad request", { status: 400 });
  try { await enforceMemberLimit(db, "vote", user.id); }
  catch (error) {
    const refusal = error as ReturnType<typeof data>;
    if (refusal?.init?.status !== 429) throw error;
    const headers = refusal.init.headers;
    return data({ ok: false, entryId, error: "rate_limited" } satisfies VoteResponse, { status: 429, headers });
  }
  const res = await setVote(db, user.id, entryId, on === "1");
  if (!res.ok) {
    return data({ ok: false, entryId, error: res.error === "own_entry" ? "own_entry" : "not_found" } satisfies VoteResponse,
      { status: res.error === "own_entry" ? 403 : 404, headers: HEADERS });
  }
  if (isNavigation(request)) throw redirect(safeLocalPath(formString(form, "returnTo")));
  const reactions = (await loadReactions(db, [{ id: entryId }], user.id)).get(entryId) ?? NO_REACTIONS;
  // Taken after the read, so that the reactions are never newer than `at`.
  const at = new Date().toISOString();
  // private, no-store: the answer carries this member's own press state, so a shared cache or the browser's back-forward cache must not keep it (like /stance).
  return data({ ok: true as const, entryId, voted: res.voted, reactions, at } satisfies VoteResponse, { headers: HEADERS });
}
