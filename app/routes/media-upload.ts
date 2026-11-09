import { assertSameOrigin } from "~/lib/http/csrf.server";
import { requireWriter } from "~/lib/auth/session.server";
import { MEDIA_LIMITS, MediaError } from "~/lib/media";
import { readMediaForm, rewriteMedia, withMediaSlot, withReceiveSlot } from "~/lib/media-processing.server";
import { putMedia } from "~/lib/media-store.server";
import { hitRateLimit, rateLimitHeaders } from "~/lib/rate-limit.server";
import { and, eq } from "drizzle-orm";
import { rateLimits } from "~/lib/db/schema";

export async function action({ request }: { request: Request }) {
  assertSameOrigin(request);
  if (request.method !== "POST") return Response.json({ error: "generic" }, { status: 405, headers: { Allow: "POST", "Cache-Control": "no-store" } });
  const { db, user } = await requireWriter(request);
  const rule = { key: `media:member:${user.id}`, limit: MEDIA_LIMITS.hourly, windowSeconds: 3600 };
  const rateResponse = (rate: Awaited<ReturnType<typeof hitRateLimit>>) => Response.json({ error: "rate" }, { status: 429, headers: { ...rateLimitHeaders(rate), "Cache-Control": "no-store" } });
  try {
    // Avoid decoding for an exhausted member. This read does not charge uploads refused for lack of a decoder slot.
    const windowStart = new Date(Math.floor(Date.now() / (rule.windowSeconds * 1000)) * rule.windowSeconds * 1000);
    const [counter] = await db.select({ count: rateLimits.count }).from(rateLimits).where(and(eq(rateLimits.key, rule.key), eq(rateLimits.windowStart, windowStart)));
    if (counter && counter.count >= rule.limit) return rateResponse(await hitRateLimit(db, rule));
    let image: Awaited<ReturnType<typeof rewriteMedia>> | undefined, processingError: unknown;
    try {
      // The receive slot is taken before the body is read and released once the bytes are copied out; the decoder slot is separate.
      const bytes = await withReceiveSlot(user.id, async () => new Uint8Array(await (await readMediaForm(request)).arrayBuffer()));
      image = await withMediaSlot(() => rewriteMedia(bytes));
    } catch (error) {
      if (error instanceof MediaError && error.status === 503) throw error;
      processingError = error;
    }
    // Charge attempted processing (including damaged inputs), after releasing the decoder slot. Admission failures never reach this increment.
    const rate = await hitRateLimit(db, rule);
    if (!rate.allowed) return rateResponse(rate);
    if (processingError) throw processingError;
    if (!image) throw new MediaError("generic");
    const saved = await putMedia(db, user.id, image);
    return Response.json(saved, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const failure = error instanceof MediaError ? error : new MediaError("generic", 500);
    return Response.json({ error: failure.code }, { status: failure.status, headers: { "Cache-Control": "no-store" } });
  }
}
export function loader() { return new Response(null, { status: 405, headers: { Allow: "POST", "Cache-Control": "no-store" } }); }
