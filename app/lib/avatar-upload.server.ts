import { MEDIA_LIMITS, MediaError } from "~/lib/media";
import { readMediaForm, rewriteMedia, withMediaSlot, withReceiveSlot } from "~/lib/media-processing.server";
import { hitRateLimit, rateLimitHeaders } from "~/lib/rate-limit.server";
import { and, eq } from "drizzle-orm";
import { rateLimits } from "~/lib/db/schema";

import type { Db } from "./db/client.server";

export async function avatarUploadAction(request: Request, { db, user }: { db: Db; user: { id: string } }, save: (db: Db, userId: string, image: Awaited<ReturnType<typeof rewriteMedia>> | null) => Promise<{ url: string; uploaded: boolean }>, authorize?: (db: Db, userId: string) => Promise<unknown>) {
  if (request.method !== "POST") return Response.json({ error: "generic" }, { status: 405, headers: { Allow: "POST", "Cache-Control": "no-store" } });
  const rule = { key: `media:member:${user.id}`, limit: MEDIA_LIMITS.hourly, windowSeconds: 3600 };
  const rateResponse = (rate: Awaited<ReturnType<typeof hitRateLimit>>) => Response.json({ error: "rate" }, { status: 429, headers: { ...rateLimitHeaders(rate), "Cache-Control": "no-store" } });
  try {
    await authorize?.(db, user.id);
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("multipart/form-data;")) {
      const form = await request.formData();
      if (form.get("intent") !== "reset") throw new MediaError("generic");
      const rate = await hitRateLimit(db, rule);
      if (!rate.allowed) return rateResponse(rate);
      return Response.json(await save(db, user.id, null), { headers: { "Cache-Control": "no-store" } });
    }
    // Avoid decoding for an exhausted member. This read does not charge uploads refused for lack of a decoder slot.
    const windowStart = new Date(Math.floor(Date.now() / (rule.windowSeconds * 1000)) * rule.windowSeconds * 1000);
    const [counter] = await db.select({ count: rateLimits.count }).from(rateLimits).where(and(eq(rateLimits.key, rule.key), eq(rateLimits.windowStart, windowStart)));
    if (counter && counter.count >= rule.limit) return rateResponse(await hitRateLimit(db, rule));
    let image: Awaited<ReturnType<typeof rewriteMedia>> | undefined, processingError: unknown;
    try {
      // The receive slot is taken before the body is read and released once the bytes are copied out; the decoder slot is separate.
      const bytes = await withReceiveSlot(user.id, async () => new Uint8Array(await (await readMediaForm(request)).arrayBuffer()));
      image = await withMediaSlot(() => rewriteMedia(bytes, { avatar: true }));
    } catch (error) {
      if (error instanceof MediaError && error.status === 503) throw error;
      processingError = error;
    }
    // Charge attempted processing (including damaged inputs), after releasing the decoder slot. Admission failures never reach this increment.
    const rate = await hitRateLimit(db, rule);
    if (!rate.allowed) return rateResponse(rate);
    if (processingError) throw processingError;
    if (!image) throw new MediaError("generic");
    const saved = await save(db, user.id, image);
    return Response.json(saved, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const failure = error instanceof MediaError ? error : new MediaError("generic", 500);
    return Response.json({ error: failure.code }, { status: failure.status, headers: { "Cache-Control": "no-store" } });
  }
}