import { and, eq } from "drizzle-orm";
import { getAuth } from "~/lib/auth/auth.server";
import { getDb, type Db } from "~/lib/db/client.server";
import { rateLimits } from "~/lib/db/schema";
import { safeErrorText } from "~/lib/error-text.server";
import { siteOrigin } from "~/lib/http/csrf.server";
import { withMcpAuth } from "~/lib/mcp/auth.server";
import { MEDIA_LIMITS, MediaError, parseMediaPath } from "~/lib/media";
import { processUploadedMedia, withReceiveSlot } from "~/lib/media-processing.server";
import { putMedia, putUploadedMedia } from "~/lib/media-store.server";
import { getWriter } from "~/lib/members.server";
import { hitIpLimit, hitRateLimit, rateLimitHeaders } from "~/lib/rate-limit.server";
import { errorResponse, memberResponse } from "./http.server";
import { readApiMedia } from "./media-body.server";

const fail = (request: Request, status: number, code: string, message: string, headers: Record<string, string> = {}) => errorResponse(request, "json", status, code, message, headers);

export async function handleMediaUpload(request: Request, opts: { db?: Db } = {}): Promise<Response> {
  if (request.method !== "POST") return fail(request, 405, "generic", "Use POST.", { Allow: "POST" });
  try {
    const db = opts.db ?? await getDb();
    const response = await withMcpAuth(request, { db, auth: await getAuth(), baseURL: siteOrigin() }, async principal => {
      if (!principal.scopes.has("media")) return fail(request, 403, "forbidden", "The upload images permission is required.");
      if (!(await getWriter(db, principal.userId)).ok) return fail(request, 403, "forbidden", "Writing is unavailable for this account. Review your account in the browser.");
      const rules = [
        { key: `media:member:${principal.userId}`, limit: MEDIA_LIMITS.hourly, windowSeconds: 3600 },
        { key: `media:api:${principal.userId}`, limit: MEDIA_LIMITS.apiHourly, windowSeconds: 3600 },
      ];
      const limited = (rate: Awaited<ReturnType<typeof hitRateLimit>>) => fail(request, 429, "rate", "Too many image uploads. Try again after the rate window resets.", rateLimitHeaders(rate));
      // Avoid receiving or decoding when either allowance is already exhausted.
      const windowStart = new Date(Math.floor(Date.now() / 3600_000) * 3600_000);
      for (const rule of rules) {
        const [counter] = await db.select({ count: rateLimits.count }).from(rateLimits).where(and(eq(rateLimits.key, rule.key), eq(rateLimits.windowStart, windowStart)));
        if (counter && counter.count >= rule.limit) return limited(await hitRateLimit(db, rule));
      }
      let image: Awaited<ReturnType<typeof processUploadedMedia>> | undefined, processingError: unknown;
      try {
        const bytes = await withReceiveSlot(principal.userId, () => readApiMedia(request));
        image = await processUploadedMedia(bytes);
      } catch (error) {
        if (error instanceof MediaError && error.status === 503) throw error;
        processingError = error;
      }
      // Match browser accounting: a motion/still pair costs two, and failed
      // attempts cost one. Decoder/receive admission failures are uncharged.
      const rates = await db.transaction(async tx => {
        const results = [];
        for (const rule of rules) results.push(await hitRateLimit(tx, { ...rule, cost: image?.poster ? 2 : 1 }));
        return results;
      });
      const denied = rates.find(rate => !rate.allowed);
      if (denied) return limited(denied);
      if (processingError) throw processingError;
      if (!image) throw new MediaError("generic");
      const saved = image.poster ? await putUploadedMedia(db, principal.userId, image) : await putMedia(db, principal.userId, image);
      const parsed = parseMediaPath(saved.url)!;
      const posterUrl = "posterUrl" in saved && typeof saved.posterUrl === "string" ? saved.posterUrl : undefined;
      const poster = posterUrl ? parseMediaPath(posterUrl)! : null;
      const result = {
        mediaId: parsed.id, ...saved,
        ...(poster ? { posterWidth: poster.width, posterHeight: poster.height } : {}),
        markdown: poster ? `[![Describe the image](${posterUrl})](${saved.url})` : `![Describe the image](${saved.url})`,
      };
      return memberResponse(request, JSON.stringify(result), { format: "json", status: 201, rate: rates[1] });
    });
    if (response.status === 401) {
      const rate = await hitIpLimit(db, request, "anon");
      if (rate && !rate.allowed) return fail(request, 429, "rate", "Too many requests without valid credentials. Try again after the rate window resets.", rateLimitHeaders(rate));
      return fail(request, 401, "unauthorized", "Send a valid Bearer token. Cookies and URL tokens are not accepted.", { "WWW-Authenticate": response.headers.get("www-authenticate") ?? "Bearer" });
    }
    return response;
  } catch (error) {
    if (!(error instanceof MediaError)) console.error(`[media-api] unexpected error for ${request.method} ${new URL(request.url).pathname}:`, safeErrorText(error));
    const failure = error instanceof MediaError ? error : new MediaError("generic", 500);
    const busy = failure.status === 503;
    return fail(request, failure.status, busy ? "busy" : failure.code, busy ? "Image processing is busy. Try again shortly." : `Image upload failed: ${failure.code}.`, busy ? { "Retry-After": "1" } : {});
  }
}
