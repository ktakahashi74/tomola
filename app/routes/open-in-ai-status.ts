import type { Route } from "./+types/open-in-ai-status";
import { aiOpenWasRead } from "~/lib/ai-open-return.server";
import { getDb } from "~/lib/db/client.server";
import { assertSameOrigin } from "~/lib/http/csrf.server";
import { hitIpLimit, rateLimitHeaders } from "~/lib/rate-limit.server";

const headers = { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" };
export function loader() {
  return Response.json({ read: false }, { status: 405, headers: { ...headers, Allow: "POST" } });
}

// Possession of the signed link is sufficient. Never report authentication,
// membership, invalidity reasons, or the existence of other links.
export async function action({ request }: Route.ActionArgs) {
  assertSameOrigin(request);
  if (request.method !== "POST") return (await loader());
  const db = await getDb();
  const rate = await hitIpLimit(db, request, "ai-open-status");
  if (rate && !rate.allowed) return Response.json({ read: false }, { status: 429, headers: { ...headers, ...rateLimitHeaders(rate) } });
  if (!/^(?:multipart\/form-data|application\/x-www-form-urlencoded)(?:;|$)/i.test(request.headers.get("content-type") ?? "")) return Response.json({ read: false }, { headers });
  let form: FormData;
  try {
    form = await request.formData();
  } catch { return Response.json({ read: false }, { headers }); }
  const link = form.get("url");
  const read = form.getAll("url").length === 1 && typeof link === "string" && await aiOpenWasRead(db, link);
  return Response.json({ read }, { headers });
}
