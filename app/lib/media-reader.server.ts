import { getSessionUser } from "~/lib/auth/session.server";
import { getDb } from "~/lib/db/client.server";
import { getActiveMember } from "~/lib/members.server";
import { publicReading } from "~/lib/public-reading.server";
import { clientAddress } from "~/lib/http/client-ip.server";
import { MEDIA_LIMITS } from "~/lib/media";
import { hitRateLimit, rateLimitHeaders } from "~/lib/rate-limit.server";
import { getViewer } from "~/lib/roles.server";

// Image requests use the ordinary membership decision without consuming page-read counters.
export async function getMediaReader(request: Request) {
  const user = await getSessionUser(request);
  if (!user && !publicReading()) return null;
  const db = await getDb();
  if (user && !await getActiveMember(db, user.id)) return null;
  const ip = user ? null : clientAddress(request);
  const key = user ? `media-read:member:${user.id}` : ip ? `ip:media-read:${ip}` : null;
  if (key) {
    const rate = await hitRateLimit(db, {
      key,
      limit: user ? MEDIA_LIMITS.memberReadsHourly : MEDIA_LIMITS.anonymousReadsHourly,
      windowSeconds: MEDIA_LIMITS.readWindowSeconds,
    });
    if (!rate.allowed) throw new Response(null, { status: 429, headers: rateLimitHeaders(rate) });
  }
  return { db, viewer: user ? await getViewer(db, user) : null };
}
