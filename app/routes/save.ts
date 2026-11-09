import { data, redirect } from "react-router";
import type { Route } from "./+types/save";
import { requireMember } from "~/lib/auth/session.server";
import { safeLocalPath } from "~/lib/display-lang.server";
import { formString } from "~/lib/entry-form.server";
import { assertSameOrigin } from "~/lib/http/csrf.server";
import { enforceMemberLimit } from "~/lib/http/limits.server";
import { isNavigation } from "~/lib/http/navigation.server";
import { getViewer } from "~/lib/roles.server";
import { setTopicSaved } from "~/lib/saved-topics.server";

const HEADERS = { "Cache-Control": "private, no-store" };
export function headers() { return HEADERS; }

// Private reading is not publishing. Suspended members retain control of their
// own saved list, subject to the same current reading permissions as everyone.
export async function action({ request }: Route.ActionArgs) {
  assertSameOrigin(request);
  if (request.method !== "POST") throw data("Method not allowed", { status: 405, headers: HEADERS });
  const { user, db } = await requireMember(request);
  await enforceMemberLimit(db, "save", user.id);
  const form = await request.formData();
  const raw = formString(form, "topicId");
  const topicId = /^[1-9]\d{0,15}$/.test(raw) ? Number(raw) : NaN;
  const saved = formString(form, "saved");
  if (!Number.isSafeInteger(topicId) || !["0", "1"].includes(saved)) return data({ ok: false as const }, { status: 400, headers: HEADERS });
  const result = await setTopicSaved(db, user.id, topicId, saved === "1", { viewer: await getViewer(db, user) });
  if (!result.ok) return data({ ok: false as const }, { status: 404, headers: HEADERS });
  if (isNavigation(request)) throw redirect(safeLocalPath(formString(form, "returnTo")), { headers: HEADERS });
  return data({ ok: true as const, topicId, saved: result.saved }, { headers: HEADERS });
}
