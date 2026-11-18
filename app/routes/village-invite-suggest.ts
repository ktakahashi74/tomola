import type { Route } from "./+types/village-invite-suggest";
import type { data } from "react-router";
import { requireWriter } from "~/lib/auth/session.server";
import { hitMemberLimit, rateLimitHeaders } from "~/lib/rate-limit.server";
import { suggestVillageInvitees } from "~/lib/village-management.server";

const HEADERS = { "Cache-Control": "private, no-store" };

export async function loader({ request, params }: Route.LoaderArgs) {
  let member: Awaited<ReturnType<typeof requireWriter>>;
  try {
    member = await requireWriter(request);
  } catch (error) {
    if (error instanceof Response && error.status >= 300 && error.status < 400) return Response.json({ members: [] }, { status: 403, headers: HEADERS });
    const refusal = error as ReturnType<typeof data>;
    if (refusal?.init?.status === 429) return Response.json({ members: [] }, { status: 429, headers: { ...Object.fromEntries(new Headers(refusal.init.headers)), ...HEADERS } });
    throw error;
  }
  const { user, db } = member;
  const rate = await hitMemberLimit(db, "mention-suggest", user.id);
  if (!rate.allowed) return Response.json({ members: [] }, { status: 429, headers: { ...rateLimitHeaders(rate), ...HEADERS } });
  const query = new URL(request.url).searchParams.get("q") ?? "";
  const length = [...query].length;
  if (length < 1 || length > 30) return Response.json({ members: [] }, { headers: HEADERS });
  const members = await suggestVillageInvitees(db, user.id, params.slug, query);
  return Response.json({ members: members ?? [] }, { status: members === null ? 403 : 200, headers: HEADERS });
}
