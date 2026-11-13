import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { authSecret } from "./auth/secret.server";
import { LANGS } from "./languages";
import { AI_QUESTION_LIMITS, type AiQuestionContent, type AiQuestionResponse, type AiQuestionTarget } from "./ai-questions";
import { questionText } from "./ai-question-answer.server";
import type { Db } from "./db/client.server";
import { aiQuestionReports } from "./db/schema";

const passage = z.object({ quote: questionText(AI_QUESTION_LIMITS.quoteChars), lang: questionText(64), href: questionText(2_048) }).strict();
export const questionContentSchema = z.object({
  answer: z.object({
    status: z.enum(["answered", "not_confirmed"]),
    readings: z.array(z.object({ text: questionText(AI_QUESTION_LIMITS.readingChars), citations: z.array(z.number().int().min(1).max(AI_QUESTION_LIMITS.citations)).max(AI_QUESTION_LIMITS.citations) }).strict()).max(AI_QUESTION_LIMITS.readings),
    citations: z.array(z.object({
      sourceId: questionText(64), kind: z.enum(["post", "reply", "material"]), field: z.enum(["title", "body"]), author: questionText(128),
      original: passage,
      translation: passage.extend({ lang: z.enum(LANGS), stale: z.boolean(), generated: z.boolean().optional() }).strict().optional(),
    }).strict()).max(AI_QUESTION_LIMITS.citations),
  }).strict(),
  scope: z.object({ sources: z.number().int().min(0).max((AI_QUESTION_LIMITS.replies + 1) * 2 + 1), replies: z.number().int().min(0).max(AI_QUESTION_LIMITS.replies), truncated: z.boolean() }).strict(),
  language: z.enum(LANGS), engine: questionText(32), model: questionText(200), expiresAt: z.number().int().nonnegative(),
}).strict();
export const questionResponseSchema = questionContentSchema.extend({ receipt: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict();

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item);
}
function mac(userId: string, target: AiQuestionTarget, question: string, content: AiQuestionContent, secret: string): string {
  const key = hkdfSync("sha256", secret, "", "tomola ai-question report receipt v1", 32);
  return createHmac("sha256", Buffer.from(key)).update(canonical([userId, target, question, content])).digest("base64url");
}

// The receipt authenticates the client's transient copy; it contains no text
// and has no lookup endpoint or server-side conversation record.
export function signQuestionResponse(userId: string, target: AiQuestionTarget, question: string, content: AiQuestionContent, secret = authSecret()): AiQuestionResponse {
  return { ...content, receipt: mac(userId, target, question, content, secret) };
}
export function verifyQuestionReceipt(userId: string, target: AiQuestionTarget, question: string, response: AiQuestionResponse, now = new Date(), secret = authSecret()): boolean {
  const parsed = questionResponseSchema.safeParse(response);
  if (!parsed.success || parsed.data.expiresAt <= Math.floor(now.getTime() / 1_000)) return false;
  const { receipt, ...content } = parsed.data;
  const expected = Buffer.from(mac(userId, target, question, content, secret));
  const given = Buffer.from(receipt);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export async function saveQuestionReport(db: Db, userId: string, target: AiQuestionTarget, question: string, response: AiQuestionResponse, consent: boolean, now = new Date()): Promise<boolean> {
  if (!consent || !verifyQuestionReceipt(userId, target, question, response, now)) return false;
  const { receipt: _receipt, ...answer } = questionResponseSchema.parse(response);
  await db.insert(aiQuestionReports).values({ reporterId: userId, topicId: target.kind === "post" ? target.id : null, villageId: target.kind === "village" ? target.id : null, question, answer, createdAt: now });
  return true;
}
