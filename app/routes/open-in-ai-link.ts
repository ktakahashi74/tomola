import type { Route } from "./+types/open-in-ai-link";
import { getSessionUser, requireMember } from "~/lib/auth/session.server";
import { getDb } from "~/lib/db/client.server";
import { publicReading } from "~/lib/public-reading.server";
import { signAiOpenMarker } from "~/lib/ai-open-return.server";
import { assertSameOrigin } from "~/lib/http/csrf.server";
import { siteUrl } from "~/lib/md/urls.server";
import { canonicalReadResource, signOpenInAiToken } from "~/lib/open-in-ai.server";
import { hitIpLimit, hitRateLimit, rateLimitHeaders, READ_RATE_LIMIT } from "~/lib/rate-limit.server";
import { canReadMarkdownPublicly } from "~/lib/md/twin.server";
import { resolveDisplayLang } from "~/lib/display";
import { enabledLangs } from "~/lib/enabled-langs.server";

const headers = { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" };

export function loader() {
  return Response.json({ error: "method_not_allowed" }, { status: 405, headers: { ...headers, Allow: "POST" } });
}

// Read delegation is available to suspended readers too. A browser session and
// same-origin POST are mandatory for delegation. Public readers receive an inert
// receipt marker instead. Nothing is embedded in HTML or loader data.
export async function action({ request }: Route.ActionArgs) {
  assertSameOrigin(request);
  if (request.method !== "POST") return (await loader());
  const member = !publicReading() || await getSessionUser(request) ? await requireMember(request) : null;
  const db = member?.db ?? await getDb();
  const rate = member
    ? await hitRateLimit(db, { key: `read:member:${member.user.id}`, ...READ_RATE_LIMIT })
    : await hitIpLimit(db, request, "ai-open-link");
  if (rate && !rate.allowed) return Response.json({ error: "rate_limited" }, { status: 429, headers: { ...headers, ...rateLimitHeaders(rate) } });
  if (!/^(?:multipart\/form-data|application\/x-www-form-urlencoded)(?:;|$)/i.test(request.headers.get("content-type") ?? "")) return Response.json({ error: "unsupported_media_type" }, { status: 415, headers });
  const form = await request.formData();
  const path = form.get("path");
  if (form.getAll("path").length !== 1 || typeof path !== "string" || path.length > 4096 || !path.startsWith("/") || path.startsWith("//")) return Response.json({ error: "invalid_resource" }, { status: 400, headers });
  let supplied: URL;
  try { supplied = new URL(path, siteUrl("")); } catch { return Response.json({ error: "invalid_resource" }, { status: 400, headers }); }
  const resource = canonicalReadResource(supplied.href);
  if (resource === null || supplied.searchParams.has("k")) return Response.json({ error: "invalid_resource" }, { status: 400, headers });
  const delegated = new URL(siteUrl(resource));
  if (member && (!publicReading() || !await canReadMarkdownPublicly(db, resource))) {
    delegated.searchParams.set("k", signOpenInAiToken({ userId: member.user.id, generation: member.profile.openInAiGeneration, resource }));
  } else {
    if (member && !delegated.searchParams.has("lang")) delegated.searchParams.set("lang", resolveDisplayLang({ profile: member.profile, uiLocale: member.profile.uiLocale, enabled: enabledLangs() }));
    delegated.searchParams.set("o", signAiOpenMarker(delegated.href));
  }
  return Response.json({ url: delegated.href }, { headers });
}
