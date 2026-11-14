import { createHmac, hkdfSync } from "node:crypto";
import { lt, sql } from "drizzle-orm";
import { authSecret } from "~/lib/auth/secret.server";
import type { Db } from "~/lib/db/client.server";
import { rateLimits, verification } from "~/lib/db/schema";
import { drainRetentionRows, type RetentionResults } from "~/lib/retention-batch.server";
import { clientAddress } from "~/lib/http/client-ip.server";

// Simple fixed-window DB rate limiting via rate_limits. Call with key, cap and window length for API reads/draft creation and
// magic links. Windows align by epoch divided by duration, e.g. hour windows begin on the hour;
// counts reset at boundaries. Requests can reach twice the cap around a boundary, inherent to fixed windows and unsuitable for strict limits.
// One upsert (INSERT ... ON CONFLICT DO UPDATE ... RETURNING) counts concurrent requests without loss.
// Count rejected requests too, revealing continued attempts over the cap.

export type RateLimitRule = { limit: number; windowSeconds: number };
// Shared member caps across browser, API and MCP: 600 reads/hour, 30 draft creations/hour.
export const READ_RATE_LIMIT: RateLimitRule = { limit: 600, windowSeconds: 3600 };
export const DRAFT_RATE_LIMIT: RateLimitRule = { limit: 30, windowSeconds: 3600 };

// A page can run a layout and multiple loaders with the same Request. Count that
// browser read once; the weak keys do not retain completed HTTP requests.
const browserReads = new WeakMap<Request, Map<string, Promise<RateLimitResult>>>();
export function hitBrowserReadLimit(db: Db, request: Request, userId: string): Promise<RateLimitResult> {
  let members = browserReads.get(request);
  if (!members) { members = new Map(); browserReads.set(request, members); }
  let result = members.get(userId);
  if (!result) {
    result = Promise.resolve(hitMemoryReadLimit(db, `read:member:${userId}`, READ_RATE_LIMIT));
    members.set(userId, result);
  }
  return result;
}
// Sending sources have separate allowances; the recipient-wide cap only limits mail floods.
export const MAGIC_LINK_EMAIL_LIMIT: RateLimitRule = { limit: 30, windowSeconds: 3600 };
export const MAGIC_LINK_EMAIL_IP_LIMIT: RateLimitRule = { limit: 5, windowSeconds: 900 };
export const MAGIC_LINK_IP_LIMIT: RateLimitRule = { limit: 20, windowSeconds: 900 };
// Login requests are told whether an address is registered, so every request from one source counts here, member or not, on /login and /mcp/login alike. Past the cap the answer
// is the same for every address and nothing is looked up or sent. The window is fixed: it resets at the hour. People sharing one address (an office, an event) share this allowance.
export const LOGIN_LOOKUP_IP_LIMIT: RateLimitRule = { limit: 20, windowSeconds: 3600 };
// Passkey endpoints /api/auth/passkey/*: 60/IP/15 minutes (app/routes/api.auth.ts).
export const PASSKEY_IP_LIMIT: RateLimitRule = { limit: 60, windowSeconds: 900 };

// Unauthenticated/failed-auth per-IP cap for twins, changes, manifest and draft API: missing credentials or invalid tokens
// allow 120/hour, excluding correctly authenticated requests. Protect DB from brute-force tokens or repeated unauthenticated access.
export const ANON_IP_LIMIT: RateLimitRule = { limit: 120, windowSeconds: 3600 };
// Login/auth POSTs (/login,/invite/<token>,/auth/confirm): 300/IP/15 minutes. Do not count page GETs, avoiding DB writes; generous enough for people
// sharing workshop/public-event IPs. Magic-link sending has separate stricter MAGIC_LINK_* limits.
export const AUTH_PAGE_IP_LIMIT: RateLimitRule = { limit: 300, windowSeconds: 900 };

// Stance register/change/withdraw: 30/member/hour (MEMBER_RATE_LIMITS.stance) and 10/member/question/day, fixed UTC-midnight windows.
// Count identical resubmissions and rejected attempts under existing rules. Exempt deletion of personal records to preserve deletion rights.
export const STANCE_PER_QUESTION_LIMIT: RateLimitRule = { limit: 10, windowSeconds: 86400 };

// Per-member caps: preview 300/hour, search 60/hour (query embeddings cost money; UI/twins share counts), mistranslation/post reports 30/hour each, invites 20/day.
// village-membership (join/leave/post-here): 30 attempts/member/hour.
// Invites determine login-mail destinations; limit creating invitation links then causing login mail to their recipients.
export const MEMBER_RATE_LIMITS = {
  "push-state": { limit: 300, windowSeconds: 600 },
  "push-register": { limit: 30, windowSeconds: 3600 },
  "push-test": { limit: 3, windowSeconds: 600 },
  "push-send": { limit: 60, windowSeconds: 3600 },
  "draft-autosave": { limit: 600, windowSeconds: 3600 },
  "display-name": { limit: 5, windowSeconds: 86400 },
  "village-create": { limit: 5, windowSeconds: 86400 },
  "village-slug-suggest": { limit: 30, windowSeconds: 3600 },
  "village-membership": { limit: 30, windowSeconds: 3600 },
  // Following and unfollowing a village (POST /v/<slug>): 60 per hour per member.
  "village-follow": { limit: 60, windowSeconds: 3600 },
  "chat-send-minute": { limit: 20, windowSeconds: 60 },
  "chat-send-hour": { limit: 300, windowSeconds: 3600 },
  "chat-edit": { limit: 60, windowSeconds: 60 },
  "chat-delete": { limit: 60, windowSeconds: 60 },
  "chat-read": { limit: 120, windowSeconds: 60 },
  "chat-search": { limit: 60, windowSeconds: 3600 },
  "list-seen": { limit: 120, windowSeconds: 60 },
  "chat-changes": { limit: 120, windowSeconds: 60 },
  "chat-nushi-preview": { limit: 120, windowSeconds: 60 },
  "chat-events": { limit: 120, windowSeconds: 3600 },
  preview: { limit: 300, windowSeconds: 3600 },
  search: { limit: 60, windowSeconds: 3600 },
  "translation-report": { limit: 30, windowSeconds: 3600 },
  report: { limit: 30, windowSeconds: 3600 },
  invitation: { limit: 20, windowSeconds: 86400 },
  stance: { limit: 30, windowSeconds: 3600 },
  vote: { limit: 30, windowSeconds: 3600 },
  // Posting from the screens (a topic from /t/new or the publishing of a draft; a reply from the thread page or the publishing of a draft): 20 topics
  // and 60 replies per hour per member. Saving or editing a draft is not counted. The API's drafts have their own limit (DRAFT_RATE_LIMIT). The values are initial defaults;
  // review them against observed usage.
  topic: { limit: 20, windowSeconds: 3600 },
  reply: { limit: 60, windowSeconds: 3600 },
  edit: { limit: 60, windowSeconds: 3600 },
  // Following and unfollowing a topic (POST /follow): 120 per hour per member.
  follow: { limit: 120, windowSeconds: 3600 },
  // Saving and removing a topic (POST /save): 120 per hour per member.
  save: { limit: 120, windowSeconds: 3600 },
  // UI loaders: notifications, moderation and appeal review. 10/minute, well above ordinary use.
  // Observation/member exports: 10/hour, since reading every row is expensive.
  export: { limit: 10, windowSeconds: 3600 },
  notifications: { limit: 600, windowSeconds: 3600 },
  mod: { limit: 600, windowSeconds: 3600 },
  "mod-appeals": { limit: 600, windowSeconds: 3600 },
  // Handle suggestions while typing an @mention (a request every few keystrokes): 600 per hour.
  "mention-suggest": { limit: 600, windowSeconds: 3600 },
  // Signing previews/options and passkey enrollment create short-lived challenges. Bound per-member accumulation.
  signing: { limit: 600, windowSeconds: 3600 },
  "passkey-enroll": { limit: 60, windowSeconds: 3600 },
} as const satisfies Record<string, RateLimitRule>;
export type MemberAction = keyof typeof MEMBER_RATE_LIMITS;

export type RateLimitResult = {
  allowed: boolean;
  // Count in this window through the current request, including rejections.
  count: number;
  limit: number;
  remaining: number;
  // Window end when the count resets to zero.
  resetAt: Date;
  // Retry seconds when denied, at least 1 until window end; 0 when allowed.
  retryAfterSeconds: number;
};

export async function hitRateLimit(
  db: Db,
  input: { key: string; limit: number; windowSeconds: number; now?: Date; cost?: number },
): Promise<RateLimitResult> {
  if (!Number.isInteger(input.limit) || input.limit < 1 || !Number.isInteger(input.windowSeconds) || input.windowSeconds < 1) {
    throw new RangeError("invalid rate limit rule");
  }
  const cost = input.cost ?? 1;
  if (!Number.isSafeInteger(cost) || cost < 1) throw new RangeError("invalid rate limit cost");
  if (input.key.startsWith("read:member:")) return hitMemoryReadLimit(db, input.key, input, input.now);
  const now = input.now ?? new Date();
  const windowMs = input.windowSeconds * 1000;
  const windowStart = new Date(Math.floor(now.getTime() / windowMs) * windowMs);
  const resetAt = new Date(windowStart.getTime() + windowMs);
  const [row] = await db
    .insert(rateLimits)
    .values({ key: input.key, windowStart, count: cost, expiresAt: resetAt })
    .onConflictDoUpdate({ target: [rateLimits.key, rateLimits.windowStart], set: { count: sql`${rateLimits.count} + ${cost}` } })
    .returning({ count: rateLimits.count });
  const count = Number(row.count);
  const allowed = count <= input.limit;
  return {
    allowed,
    count,
    limit: input.limit,
    remaining: Math.max(0, input.limit - count),
    resetAt,
    retryAfterSeconds: allowed ? 0 : Math.max(1, Math.ceil((resetAt.getTime() - now.getTime()) / 1000)),
  };
}

// Count member actions under member:<action>:<user-id>. Callers render denials as route-appropriate 429 or form errors.
export function hitMemberLimit(db: Db, action: MemberAction, userId: string, now?: Date): Promise<RateLimitResult> {
  return hitRateLimit(db, { key: `member:${action}:${userId}`, ...MEMBER_RATE_LIMITS[action], now });
}

// Stance submissions to one question: 10/member/question/day.
// The key is an HMAC of the member and the question, not their ids: a plain key (member:stance-question:<user>:<question>) would leave "this member took part in this question" in
// rate_limits after the member deletes their stance record. The key is derived from BETTER_AUTH_SECRET with HKDF and its own info string (as the magic-link address key is, with
// another info), so someone who reads the table cannot test a guessed member and question against it. The row only counts sends until the window (a UTC day) ends.
const STANCE_QUESTION_HKDF_INFO = "tomola stance-question rate limit v1";
const stanceKeys = new Map<string, Buffer>();
export function stanceQuestionLimitKey(userId: string, questionId: number, secret: string = authSecret()): string {
  let key = stanceKeys.get(secret);
  if (!key) {
    key = Buffer.from(hkdfSync("sha256", secret, "", STANCE_QUESTION_HKDF_INFO, 32));
    stanceKeys.set(secret, key);
  }
  return `member:stance-question:${createHmac("sha256", key).update(`${userId}:${questionId}`, "utf8").digest("hex")}`;
}

export function hitStanceQuestionLimit(db: Db, userId: string, questionId: number, now?: Date): Promise<RateLimitResult> {
  return hitRateLimit(db, { key: stanceQuestionLimitKey(userId, questionId), ...STANCE_PER_QUESTION_LIMIT, now });
}

const translationReadKeys = new Map<string, Buffer>();
export function translationReadLimitKey(userId: string, scope: "pairs" | "calls", secret: string = authSecret()): string {
  let key = translationReadKeys.get(secret);
  if (!key) {
    key = Buffer.from(hkdfSync("sha256", secret, "", "tomola translation-read rate limit v1", 32));
    translationReadKeys.set(secret, key);
  }
  return `member:translation-read:${scope}:${createHmac("sha256", key).update(userId, "utf8").digest("hex")}`;
}

// Per-IP limits using clientAddress (app/lib/http/client-ip.server.ts). Without an IP, e.g. first hookless dev request, return null and skip limiting.
// Separate counters per name, keyed ip:<name>:<IP>.
export const IP_RATE_LIMITS = {
  anon: ANON_IP_LIMIT, "auth-page": AUTH_PAGE_IP_LIMIT, "public-read": READ_RATE_LIMIT,
  "ai-open-link": { limit: 600, windowSeconds: 3600 },
  "ai-open-status": { limit: 12000, windowSeconds: 3600 },
} as const satisfies Record<string, RateLimitRule>;
export type IpLimitName = keyof typeof IP_RATE_LIMITS;

export async function hitIpLimit(db: Db, source: Request | Headers, name: IpLimitName, now?: Date): Promise<RateLimitResult | null> {
  const ip = clientAddress(source);
  if (ip === null) return null;
  return name === "public-read"
    ? hitMemoryReadLimit(db, `ip:${name}:${ip}`, IP_RATE_LIMITS[name], now)
    : hitRateLimit(db, { key: `ip:${name}:${ip}`, ...IP_RATE_LIMITS[name], now });
}

// Layouts, page loaders and Markdown share one count for the same Request.
const publicReads = new WeakMap<Request, Promise<RateLimitResult | null>>();
export function hitPublicReadLimit(db: Db, request: Request, now?: Date): Promise<RateLimitResult | null> {
  let result = publicReads.get(request);
  if (!result) {
    result = hitIpLimit(db, request, "public-read", now);
    publicReads.set(request, result);
  }
  return result;
}

// Response headers: X-RateLimit-* and Retry-After on denial.
export function rateLimitHeaders(result: RateLimitResult): Record<string, string> {
  const headers: Record<string, string> = {
    "X-RateLimit-Limit": String(result.limit),
    "X-RateLimit-Remaining": String(result.remaining),
    "X-RateLimit-Reset": String(Math.ceil(result.resetAt.getTime() / 1000)),
  };
  if (!result.allowed) headers["Retry-After"] = String(result.retryAfterSeconds);
  return headers;
}

// Read limits are process-local. Databases remain isolated in tests and embedded deployments.
const memoryReads = new WeakMap<Db, Map<string, { count: number; reset: number }>>();
export function hitMemoryReadLimit(db: Db, key: string, rule: RateLimitRule, now = new Date()): RateLimitResult {
  let counters = memoryReads.get(db);
  if (!counters) { counters = new Map(); memoryReads.set(db, counters); }
  const time = now.getTime(), windowMs = rule.windowSeconds * 1000;
  const reset = (Math.floor(time / windowMs) + 1) * windowMs;
  // Sweep at most once per minute, rather than scanning on every new visitor.
  let sweep = memorySweeps.get(db) ?? 0;
  if (time >= sweep) {
    for (const [name, counter] of counters) if (counter.reset <= time) counters.delete(name);
    memorySweeps.set(db, time + 60_000);
  }
  const previous = counters.get(key);
  const count = previous?.reset === reset ? Math.min(previous.count + 1, Number.MAX_SAFE_INTEGER) : 1;
  counters.set(key, { count, reset });
  const allowed = count <= rule.limit;
  return { allowed, count, limit: rule.limit, remaining: Math.max(0, rule.limit - count), resetAt: new Date(reset), retryAfterSeconds: allowed ? 0 : Math.max(1, Math.ceil((reset - time) / 1000)) };
}
const memorySweeps = new WeakMap<Db, number>();

// Called by periodic maintenance, never by a request's rate-limit check.
export async function cleanupExpiredLimits(db: Db, now = new Date()): Promise<RetentionResults> {
  const results: RetentionResults = {};
  await drainRetentionRows(db, "rate_limits", rateLimits, sql`${rateLimits.expiresAt} <= ${now}`, results);
  await drainRetentionRows(db, "verification", verification, sql`${verification.expiresAt} <= ${now}`, results);
  return results;
}

// Test fixtures reset process-local reads alongside their isolated database rows.
export function clearMemoryReadLimitsForTests(db: Db): void {
  memoryReads.delete(db); memorySweeps.delete(db);
}
