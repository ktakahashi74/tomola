import { countReading } from "~/lib/reading-counts.server";
import { isAiCrawler, isBrowserRobot, readingSource } from "~/lib/reading-sources.server";
import { browserReadingLanguage } from "~/lib/reading-language.server";
import { data } from "react-router";
import { z } from "zod";
import type { Route } from "./+types/topic-translations";
import { getTranslationReader } from "~/lib/auth/session.server";
import { assertSameOrigin } from "~/lib/http/csrf.server";
import { clientAddress } from "~/lib/http/client-ip.server";
import { displayLangFor } from "~/lib/display-lang.server";
import { parseId, parsePage } from "~/lib/params.server";
import { isStanceTag } from "~/lib/stances";
import { hitRateLimit, rateLimitHeaders, translationReadLimitKey } from "~/lib/rate-limit.server";
import { markTranslationsSeen, requestBodyTranslations, translationPageInputs, TRANSLATION_READ_BATCH_MAX, TRANSLATION_READ_IP_HOURLY, TRANSLATION_READ_MEMBER_HOURLY, TRANSLATION_READ_CALLS_HOURLY } from "~/lib/translation-on-read.server";

const headers = { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex" };
const bodySchema = z.object({ intent: z.enum(["request", "status", "seen", "read"]), ids: z.array(z.number().int().positive().safe()).max(TRANSLATION_READ_BATCH_MAX * 2), internal: z.boolean().optional(), shared: z.boolean().optional(), referrerHost: z.string().max(253).regex(/^[a-zA-Z0-9.:\[\]-]*$/).optional() });
export function loader() { throw data("Method not allowed", { status: 405, headers: { ...headers, Allow: "POST" } }); }

// Browser reading only. Session authentication, page visibility, CSRF and browser
// fetch metadata apply equally to requests, status checks and display reports.
export async function action({ request, params }: Route.ActionArgs) {
  assertSameOrigin(request);
  if (request.headers.get("sec-fetch-site") !== "same-origin" || request.headers.get("sec-fetch-dest") !== "empty" ||
      !["cors", "same-origin"].includes(request.headers.get("sec-fetch-mode") ?? "") ||
      isBrowserRobot(request.headers.get("user-agent") ?? "")) throw data("Forbidden", { status: 403, headers });
  const referrer = request.headers.get("referer");
  const url = new URL(request.url);
  let pageUrl: URL | null = null;
  try { pageUrl = referrer ? new URL(referrer) : null; } catch { throw data("Forbidden", { status: 403, headers }); }
  const id = parseId(params.id);
  if (!pageUrl || pageUrl.origin !== url.origin || pageUrl.pathname !== `/t/${id}` || pageUrl.search !== url.search) throw data("Forbidden", { status: 403, headers });
  const { db, user, profile } = await getTranslationReader(request);
  if (!request.headers.get("content-type")?.startsWith("application/json")) throw data("Invalid request", { status: 400, headers });
  // Bound streaming bodies too; Content-Length alone is client controlled.
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  if (reader) for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    size += value.byteLength;
    if (size > 8192) { await reader.cancel(); throw data("Request too large", { status: 413, headers }); }
    chunks.push(value);
  }
  let raw: unknown;
  try { raw = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw data("Invalid request", { status: 400, headers }); }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) throw data("Invalid request", { status: 400, headers });
  const { intent } = parsed.data;
  if (intent === "read" && isAiCrawler(request.headers.get("user-agent") ?? "")) throw data("Forbidden", { status: 403, headers });
  const ids = [...new Set(parsed.data.ids)];
  if (intent !== "seen" && ids.length > TRANSLATION_READ_BATCH_MAX) throw data("Invalid request", { status: 400, headers });
  const ip = clientAddress(request);
  const callsKey = user ? translationReadLimitKey(user.id, "calls") : ip ? `ip:translation-read-calls:${ip}` : "translation-read-calls:unknown";
  const calls = await hitRateLimit(db, { key: callsKey, limit: TRANSLATION_READ_CALLS_HOURLY, windowSeconds: 3600 });
  if (!calls.allowed) throw data("Too many requests", { status: 429, headers: { ...headers, ...rateLimitHeaders(calls) } });
  const tag = pageUrl.searchParams.get("tag");
  const visible = await translationPageInputs(db, id, { page: parsePage(request), stanceTag: isStanceTag(tag) ? tag : undefined });
  if (!visible) throw data("Not found", { status: 404, headers });
  const lang = displayLangFor(request, profile);
  if (intent === "read") {
    if (parsePage(request) === 1) await countReading(db, id, { method: "browser", readerId: user?.id,
      lang: await browserReadingLanguage(db, visible[0], request, profile),
      source: readingSource(parsed.data.referrerHost, url.hostname, parsed.data["internal"] ?? true, parsed.data.shared ?? false) });
    return data({ ok: true }, { headers });
  }
  if (intent === "seen") {
    await markTranslationsSeen(db, visible, lang, ids, user?.id ?? null);
    return data({ ok: true }, { headers });
  }
  if (ids.some(id => !visible.some(e => e.id === id))) throw data("Not found", { status: 404, headers });
  if (intent === "request" && ids.length) {
    const key = user ? translationReadLimitKey(user.id, "pairs") : ip ? `ip:translation-read:${ip}` : "translation-read:unknown";
    const rate = await hitRateLimit(db, { key, limit: user ? TRANSLATION_READ_MEMBER_HOURLY : TRANSLATION_READ_IP_HOURLY, windowSeconds: 3600, cost: ids.length });
    if (!rate.allowed) throw data("Too many requests", { status: 429, headers: { ...headers, ...rateLimitHeaders(rate) } });
  }
  return data(await requestBodyTranslations(db, visible.filter(e => ids.includes(e.id)), lang, intent === "request"), { headers });
}
