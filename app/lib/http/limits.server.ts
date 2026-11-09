import { data } from "react-router";
import type { Db } from "~/lib/db/client.server";
import { hitIpLimit, hitMemberLimit, rateLimitHeaders, type IpLimitName, type MemberAction } from "~/lib/rate-limit.server";

// Rate limits for UI loaders/actions. Throw 429 when exceeded, with Retry-After; the error screen shows 「回数が多すぎる」.
// Per member for member screens (notifications/moderation); per IP for login/authentication pages, skipped if the IP is unavailable.

const tooMany = (rate: Parameters<typeof rateLimitHeaders>[0]) =>
  data("Too many requests", { status: 429, headers: { ...rateLimitHeaders(rate), "Cache-Control": "no-store" } });

export async function enforceMemberLimit(db: Db, action: MemberAction, userId: string): Promise<void> {
  const rate = await hitMemberLimit(db, action, userId);
  if (!rate.allowed) throw tooMany(rate);
}

export async function enforceIpLimit(db: Db, request: Request, name: IpLimitName): Promise<void> {
  const rate = await hitIpLimit(db, request, name);
  if (rate && !rate.allowed) throw tooMany(rate);
}
