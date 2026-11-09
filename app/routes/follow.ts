import { data, redirect } from "react-router";
import type { Route } from "./+types/follow";
import { requireMember } from "~/lib/auth/session.server";
import { safeLocalPath } from "~/lib/display-lang.server";
import { formString } from "~/lib/entry-form.server";
import { setFollow } from "~/lib/follows.server";
import { assertSameOrigin } from "~/lib/http/csrf.server";
import { enforceMemberLimit } from "~/lib/http/limits.server";
import { isNavigation } from "~/lib/http/navigation.server";
import { getViewer } from "~/lib/roles.server";

// Follow or unfollow a topic (POST only; a resource route like /vote). From a fetcher (with JavaScript) it answers with data and the page stays; from a plain form submit
// (no JavaScript) it goes back to returnTo. Both do the same thing.
// The entry is requireMember, not requireWriter: following is not posting (it only decides which notifications the member's own account gets), so a suspended member may
// still unfollow (tests/member-gate.test.ts lists this reason). The answer is per member: `private, no-store`.
const HEADERS = { "Cache-Control": "private, no-store" };

export async function action({ request }: Route.ActionArgs) {
  // A POST from another site must not change anything (CSRF): check before authentication and before reading the input.
  assertSameOrigin(request);
  const { user, db } = await requireMember(request);
  await enforceMemberLimit(db, "follow", user.id);
  const form = await request.formData();
  const raw = formString(form, "threadId");
  const threadId = /^[1-9]\d{0,15}$/.test(raw) ? Number(raw) : NaN;
  const follow = formString(form, "follow");
  if (!Number.isSafeInteger(threadId) || (follow !== "1" && follow !== "0")) throw data("Bad request", { status: 400, headers: HEADERS });
  const res = await setFollow(db, user.id, threadId, follow === "1", { viewer: await getViewer(db, user) });
  if (!res.ok) throw data("Not found", { status: 404, headers: HEADERS });
  if (isNavigation(request)) throw redirect(safeLocalPath(formString(form, "returnTo")), { headers: HEADERS });
  return data({ ok: true as const, threadId, state: res.state }, { headers: HEADERS });
}
