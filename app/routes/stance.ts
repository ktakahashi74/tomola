import { data, redirect } from "react-router";
import type { Route } from "./+types/stance";
import { requireWriter } from "~/lib/auth/session.server";
import { distributionViewerFor, readDistributions } from "~/lib/distribution.server";
import { safeLocalPath } from "~/lib/display-lang.server";
import { formString } from "~/lib/entry-form.server";
import { assertSameOrigin } from "~/lib/http/csrf.server";
import { isNavigation } from "~/lib/http/navigation.server";
import { hitMemberLimit, hitStanceQuestionLimit, rateLimitHeaders } from "~/lib/rate-limit.server";
import { toDistributionView, type StanceResponse } from "~/lib/stance-ui";
import { isPosition, type Position } from "~/lib/stances";
import { setStance } from "~/lib/stances.server";

// One-click stance registration, change, or withdrawal (POST only, resource route like /vote). Return data to fetchers with JavaScript without navigating.
// Plain form submissions without JavaScript redirect to returnTo. Conflicts and rate-limit excess append ?stance_msg=conflict|rate_limited&stance_q=<question-id>
// for the destination loader to display; both paths produce the same outcome.
// Use the requireWriter gate (suspended members go to /suspended), reading session cookies only, never Bearer or ?k=. Stances cannot be written through the API.
// Include distributions only when a stance is selected: totals and language count, without per-area counts. Cache-Control: private, no-store.
const HEADERS = { "Cache-Control": "private, no-store" };

export async function action({ request }: Route.ActionArgs) {
  // Reject stance changes from cross-site POSTs (CSRF), checking before authentication or input parsing.
  assertSameOrigin(request);
  const { user, db, profile } = await requireWriter(request);
  const form = await request.formData();
  const questionRaw = formString(form, "questionId");
  const versionRaw = formString(form, "version");
  const positionRaw = formString(form, "position");
  const triggerRaw = formString(form, "trigger");
  const questionId = /^[1-9]\d{0,15}$/.test(questionRaw) ? Number(questionRaw) : NaN;
  const expectedVersion = /^\d{1,9}$/.test(versionRaw) ? Number(versionRaw) : NaN;
  const position: Position | null | undefined = positionRaw === "none" ? null : isPosition(positionRaw) ? positionRaw : undefined;
  if (!Number.isSafeInteger(questionId) || !Number.isSafeInteger(expectedVersion) || position === undefined) {
    return data({ ok: false, error: "bad_request" } satisfies StanceResponse, { status: 400, headers: HEADERS });
  }
  const triggerEntryId = /^[1-9]\d{0,15}$/.test(triggerRaw) ? Number(triggerRaw) : null;
  const navigating = isNavigation(request);
  const back = safeLocalPath(formString(form, "returnTo"));
  // Plain-form return destination, including the result marker (?stance_msg=).
  const backWith = (message: "conflict" | "rate_limited") => {
    const url = new URL(back, "http://tomola.invalid");
    url.searchParams.set("stance_msg", message);
    url.searchParams.set("stance_q", String(questionId));
    return redirect(`${url.pathname}${url.search}${url.hash}`);
  };

  // Rate limits, counted in order: 30 per member per hour, then 10 per member per question per day. Count rejected requests and identical resubmissions too.
  const memberLimit = await hitMemberLimit(db, "stance", user.id);
  const questionLimit = memberLimit.allowed ? await hitStanceQuestionLimit(db, user.id, questionId) : null;
  const refused = !memberLimit.allowed ? memberLimit : questionLimit && !questionLimit.allowed ? questionLimit : null;
  if (refused) {
    if (navigating) throw backWith("rate_limited");
    return data({ ok: false, error: "rate_limited" } satisfies StanceResponse, { status: 429, headers: { ...HEADERS, ...rateLimitHeaders(refused) } });
  }

  const res = await setStance(db, user.id, { questionId, position, expectedVersion, triggerEntryId });
  if (!res.ok && res.error !== "conflict") {
    if (res.error === "consent_required") {
      const next = new URL(back, "http://tomola.invalid");
      if (next.pathname !== `/t/${questionId}`) {
        const lang = next.searchParams.get("lang");
        next.search = "";
        if (lang !== null) next.searchParams.set("lang", lang);
      }
      for (const key of ["stance_choice", "stance_q", "stance_msg"]) next.searchParams.delete(key);
      next.pathname = `/t/${questionId}`;
      next.hash = "stance";
      // Preserve the POST body for the consent form, without putting the choice
      // in a URL or issuing a completion cookie before consent succeeds.
      throw redirect(`/settings/stances?${new URLSearchParams({ next: `${next.pathname}${next.search}${next.hash}` })}#consent`, 307);
    }
    if (res.error === "no_profile") throw data("Forbidden", { status: 403 });
    if (navigating) throw data("Not found", { status: 404 });
    return data({ ok: false, error: res.error } satisfies StanceResponse, { status: 404, headers: HEADERS });
  }
  // Include distribution totals and language count if a stance is selected. Omit deleted and hidden questions, which readDistributions excludes.
  const finalPosition = res.position;
  const distribution =
    finalPosition === null ? null : ((await readDistributions(db, [questionId], distributionViewerFor({ userId: user.id, profile }))).get(questionId) ?? null);
  const view = distribution ? toDistributionView(distribution) : null;
  // The time of the response, taken after the distribution was read (so the distribution is never newer than `at`).
  const at = new Date().toISOString();
  if (!res.ok) {
    if (navigating) throw backWith("conflict");
    return data({ ok: false, error: "conflict", questionId, position: res.position, version: res.version, distribution: view, at } satisfies StanceResponse, { status: 409, headers: HEADERS });
  }
  if (navigating) throw redirect(back);
  return data({ ok: true, questionId, position: res.position, version: res.version, distribution: view, at } satisfies StanceResponse, { headers: HEADERS });
}
