import { data } from "react-router";
import type { Route } from "./+types/list-seen";
import { requireMember } from "~/lib/auth/session.server";
import { assertSameOrigin } from "~/lib/http/csrf.server";
import { enforceMemberLimit } from "~/lib/http/limits.server";
import { exchangeListSeen, validListScope } from "~/lib/list-seen.server";

const HEADERS = { "Cache-Control": "private, no-store" };
export function headers() { return HEADERS; }

// Viewing state is private account data, not publishing; suspended members may update it.
export async function action({ request }: Route.ActionArgs) {
  assertSameOrigin(request);
  if (request.method !== "POST") throw data("Method not allowed", { status: 405, headers: HEADERS });
  const { db, user } = await requireMember(request);
  await enforceMemberLimit(db, "list-seen", user.id);
  const form = await request.formData();
  const scope = form.get("scope");
  const rawTime = form.get("seenAt");
  const seenAt = typeof rawTime === "string" && rawTime.length <= 30 ? new Date(rawTime) : new Date(NaN);
  if (!validListScope(scope) || !Number.isFinite(seenAt.getTime()) || seenAt.getTime() > Date.now()) {
    throw data("Bad request", { status: 400, headers: HEADERS });
  }
  const previous = await exchangeListSeen(db, user.id, scope, seenAt);
  return Response.json({ previous }, { headers: HEADERS });
}
