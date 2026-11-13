import { privateCacheMiddleware } from "~/lib/http/private-cache.server";
import { assertSameOrigin } from "~/lib/http/csrf.server";
import { eq } from "drizzle-orm";
import type { Route } from "./+types/nushi-availability";
import { requireMember, requireWriter } from "~/lib/auth/session.server";
import { villages, profiles } from "~/lib/db/schema";
import { personalVillage } from "~/lib/personal-villages.server";
import { villageBySlug } from "~/lib/villages.server";
import { nushiInVillage } from "~/lib/nushi-config.server";
import { nushiPlace } from "~/lib/nushi-materials.server";
import { callsNushi } from "~/lib/nushi-call.server";
import { hitMemberLimit, rateLimitHeaders } from "~/lib/rate-limit.server";

export async function loader({ request }: Route.LoaderArgs) {
  const { db, user, profile } = await requireMember(request);
  const rate = await hitMemberLimit(db, "mention-suggest", user.id);
  const headers = { "Cache-Control": "private, no-store" };
  if (!rate.allowed) return Response.json({ available: false }, { status: 429, headers: { ...headers, ...rateLimitHeaders(rate) } });
  const params = new URL(request.url).searchParams;
  const thread = params.get("thread"), slug = params.get("village");
  const [preference] = await db.select({ defaultVillageId: profiles.defaultVillageId }).from(profiles).where(eq(profiles.userId, user.id));
  const available = thread && /^\d+$/.test(thread) ? !!await nushiPlace(db, Number(thread)) : await (async () => {
    const village = slug?.startsWith("@") ? slug === `@${profile.handle}` ? await personalVillage(db, user.id) : null : slug ? await villageBySlug(db, slug) : preference?.defaultVillageId ? (await db.select().from(villages).where(eq(villages.id, preference?.defaultVillageId)))[0] : null;
    return !!village && nushiInVillage(village);
  })();
  return Response.json({ available }, { headers });
}

export async function action({ request }: Route.ActionArgs) {
  assertSameOrigin(request);
  const { db, user } = await requireWriter(request);
  const rate = await hitMemberLimit(db, "mention-suggest", user.id);
  if (!rate.allowed) return Response.json({ calls: false }, { status: 429, headers: rateLimitHeaders(rate) });
  const form = await request.formData();
  const body = form.get("body");
  return Response.json({ calls: typeof body === "string" && body.length <= 50_000 && await callsNushi(body) }, { headers: { "Cache-Control": "private, no-store" } });
}

export const middleware = [privateCacheMiddleware];
