import { privateCacheMiddleware } from "~/lib/http/private-cache.server";
import { data, redirect } from "react-router";
import { eq } from "drizzle-orm";
import type { Route } from "./+types/nushi-action";
import { requireMember, requireWriter } from "~/lib/auth/session.server";
import { profiles } from "~/lib/db/schema";
import { assertSameOrigin } from "~/lib/http/csrf.server";
import { formString } from "~/lib/entry-form.server";
import { safeLocalPath } from "~/lib/display-lang.server";
import { setTopicNushi, setVillageNushi } from "~/lib/nushi-settings.server";
import { reportNushi, resolveNushiReport } from "~/lib/nushi-reports.server";
import { getViewer } from "~/lib/roles.server";
import { hitMemberLimit, rateLimitHeaders } from "~/lib/rate-limit.server";

export async function action({ request }: Route.ActionArgs) {
  assertSameOrigin(request);
  if (request.method !== "POST") throw data("Method not allowed", { status: 405 });
  const form = await request.formData(), text = (key: string) => formString(form, key);
  const back = safeLocalPath(text("returnTo") || "/settings#settings-nushi");
  if (text("intent") === "visitor-hide") throw redirect(back, { headers: { "Set-Cookie": `nushi_hidden=${text("hide") === "1" ? "1" : "0"}; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly`, "Cache-Control": "private, no-store" } });
  const member = text("intent") === "preferences" ? await requireMember(request) : await requireWriter(request);
  const { db, user } = member;
  const rate = await hitMemberLimit(db, text("intent") === "report" ? "report" : "edit", user.id);
  if (!rate.allowed) throw data("Too many requests", { status: 429, headers: rateLimitHeaders(rate) });
  let ok = false;
  switch (text("intent")) {
    case "preferences":
      await db.update(profiles).set({ hideNushi: text("hide") === "1", nushiCitationNotifications: text("citations") === "1" }).where(eq(profiles.userId, user.id));
      ok = true; break;
    case "village": ok = await setVillageNushi(db, user.id, text("villageId"), text("enabled") === "1"); break;
    case "topic": ok = await setTopicNushi(db, user.id, Number(text("threadId")), text("disabled") === "1"); break;
    case "report": ok = await reportNushi(db, user.id, { answerId: Number(text("answerId")), kind: text("kind"), reason: text("reason"), note: text("note"), consent: text("consent") === "1" }); break;
    case "moderate": {
      const viewer = await getViewer(db, user);
      if (!viewer.scope.operator) throw data("Forbidden", { status: 403 });
      ok = await resolveNushiReport(db, user.id, Number(text("reportId")), text("hide") === "1", text("note")); break;
    }
  }
  if (!ok) throw data("Not found or invalid request", { status: 400, headers: { "Cache-Control": "private, no-store" } });
  throw redirect(back, { headers: { "Cache-Control": "private, no-store" } });
}

export const middleware = [privateCacheMiddleware];
