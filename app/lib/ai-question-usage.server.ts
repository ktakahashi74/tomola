import { createHmac, hkdfSync } from "node:crypto";
import { and, eq, inArray, like, sql } from "drizzle-orm";
import type { Db } from "./db/client.server";
import { rateLimits } from "./db/schema";
import { authSecret } from "./auth/secret.server";
import { clientAddress } from "./http/client-ip.server";
import { hitRateLimit, type RateLimitResult } from "./rate-limit.server";
import { aiQuestionLimits } from "./ai-question-config.server";
import { AI_QUESTION_PURPOSES, type AiQuestionPurpose } from "./ai-questions";
import { monthsBefore, RETENTION } from "./retention";
import type { LlmEnv } from "./llm/types";

export const AI_QUESTION_EVENTS = ["asked", "verification_failed", "draft_created", "reply_published"] as const;
export type AiQuestionEvent = typeof AI_QUESTION_EVENTS[number];
const epoch = new Date(0);
const dayStart = (now: Date) => new Date(Math.floor(now.getTime() / 86_400_000) * 86_400_000);
const markerKey = (purpose: AiQuestionPurpose, draftId: number) => `ai-question:draft:${purpose}:${draftId}`;

export function questionMemberKey(userId: string, secret = authSecret()): string {
  const key = hkdfSync("sha256", secret, "", "tomola ai-question member allowance v1", 32);
  return `member:ai-question:${createHmac("sha256", Buffer.from(key)).update(userId).digest("hex")}`;
}

export function questionIpKey(address: string, secret = authSecret()): string {
  const key = hkdfSync("sha256", secret, "", "tomola ai-question IP allowance v1", 32);
  return `ip:ai-question:${createHmac("sha256", Buffer.from(key)).update(address).digest("hex")}`;
}

// Deliberately independent of the post, village and usage purpose: future
// question entry points consume the same member allowance.
export function hitQuestionMemberLimit(db: Db, userId: string, env: LlmEnv = process.env, now = new Date()): Promise<RateLimitResult> {
  return hitRateLimit(db, { key: questionMemberKey(userId), ...aiQuestionLimits(env).member, now });
}
export async function hitQuestionIpLimit(db: Db, request: Request, env: LlmEnv = process.env, now = new Date()): Promise<RateLimitResult | null> {
  const address = clientAddress(request);
  return address === null ? null : hitRateLimit(db, { key: questionIpKey(address), ...aiQuestionLimits(env).ip, now });
}

// Reuse the existing expiring numeric-counter store. These daily rows have no
// member, post or question identifier, and retain no request or answer text.
export async function countQuestionEvent(db: Db, purpose: AiQuestionPurpose, event: AiQuestionEvent, now = new Date()): Promise<void> {
  const windowStart = dayStart(now);
  await db.insert(rateLimits).values({ key: `ai-question:metric:${purpose}:${event}`, windowStart, count: 1, expiresAt: monthsBefore(windowStart, -RETENTION.llmUsageMonths) })
    .onConflictDoUpdate({ target: [rateLimits.key, rateLimits.windowStart], set: { count: sql`${rateLimits.count} + 1` } });
}

// A numeric draft marker supports counting its eventual publication without
// retaining the question, answer, member or source post in an analytics record.
export async function markQuestionDraft(db: Db, draftId: number, purpose: AiQuestionPurpose, now = new Date()): Promise<void> {
  await db.insert(rateLimits).values({ key: markerKey(purpose, draftId), windowStart: epoch, count: 1, expiresAt: monthsBefore(now, -RETENTION.llmUsageMonths) });
  await countQuestionEvent(db, purpose, "draft_created", now);
}

// Call within the publication/deletion transaction. Concurrent publications
// cannot consume the same marker twice; discarding a draft does not count.
export async function finishQuestionDraft(db: Db, draftId: number, published: boolean, now = new Date()): Promise<void> {
  const rows = await db.delete(rateLimits).where(and(inArray(rateLimits.key, AI_QUESTION_PURPOSES.map(p => markerKey(p, draftId))), eq(rateLimits.windowStart, epoch)))
    .returning({ key: rateLimits.key });
  if (!published) return;
  for (const row of rows) {
    const purpose = AI_QUESTION_PURPOSES.find(p => row.key === markerKey(p, draftId))!;
    await countQuestionEvent(db, purpose, "reply_published", now);
  }
}

export async function questionEventCounts(db: Db) {
  const rows = await db.select({ key: rateLimits.key, count: sql<string>`sum(${rateLimits.count})` }).from(rateLimits)
    .where(like(rateLimits.key, "ai-question:metric:%")).groupBy(rateLimits.key);
  return Object.fromEntries(AI_QUESTION_EVENTS.map(event => [event, Number(rows.find(row => row.key === `ai-question:metric:ask:${event}`)?.count ?? 0)])) as Record<AiQuestionEvent, number>;
}
