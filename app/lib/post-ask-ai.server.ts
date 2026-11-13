import { z } from "zod";
import type { Db } from "./db/client.server";
import { AI_QUESTION_LIMITS, type AiQuestionError, type AiQuestionResponse } from "./ai-questions";
import { postQuestionMaterials, readableQuestionPost } from "./ai-question-materials.server";
import { questionPrompt, questionText, resolveQuestionCompleter, verifyQuestionAnswer } from "./ai-question-answer.server";
import { questionResponseSchema, saveQuestionReport, signQuestionResponse, verifyQuestionReceipt } from "./ai-question-reports.server";
import { countQuestionEvent, hitQuestionIpLimit, hitQuestionMemberLimit, markQuestionDraft } from "./ai-question-usage.server";
import { completionEstimate, meteredCall } from "./llm/metering.server";
import { BudgetPausedError } from "./llm/errors.server";
import { budgetResumeAt } from "./llm/usage.server";
import type { LlmEnv } from "./llm/types";
import type { JsonCompleter } from "./llm/completion.server";
import type { Lang } from "./languages";
import { createDraft } from "./drafts.server";
import { DRAFT_RATE_LIMIT, hitMemberLimit, hitRateLimit, rateLimitHeaders } from "./rate-limit.server";
import { postAskAiEnabled } from "./ai-question-config.server";

export const questionJson = (body: unknown, status = 200, headers?: HeadersInit) => {
  const out = new Headers(headers);
  out.set("Cache-Control", "private, no-store");
  out.set("X-Robots-Tag", "noindex");
  return Response.json(body, { status, headers: out });
};
const fail = (error: AiQuestionError, status: number, headers?: HeadersInit) => questionJson({ error }, status, headers);
const question = questionText(AI_QUESTION_LIMITS.questionChars);
const requestSchema = z.discriminatedUnion("intent", [
  z.object({ intent: z.literal("ask"), question }).strict(),
  z.object({ intent: z.literal("draft"), question, response: questionResponseSchema }).strict(),
  z.object({ intent: z.literal("report"), question, response: questionResponseSchema, consent: z.literal(true) }).strict(),
]);

async function readInput(request: Request): Promise<z.infer<typeof requestSchema> | null> {
  if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json" || !request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > AI_QUESTION_LIMITS.requestBytes) { await reader.cancel(); return null; }
      chunks.push(value);
    }
    const parsed = requestSchema.safeParse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))));
    return parsed.success ? parsed.data : null;
  } catch { return null;
  } finally { reader.releaseLock(); }
}

export async function askPostQuestion(db: Db, input: {
  userId: string; topicId: number; language: Lang; question: string; request: Request;
  env?: LlmEnv; now?: Date; completer?: JsonCompleter;
}): Promise<{ ok: true; response: AiQuestionResponse } | { ok: false; response: Response }> {
  const env = input.env ?? process.env;
  const clock = () => input.now ?? new Date();
  const now = clock();
  if (!postAskAiEnabled(env)) return { ok: false, response: fail("not_found", 404) };
  const parsedQuestion = question.safeParse(input.question);
  if (!parsedQuestion.success) return { ok: false, response: fail("invalid", 400) };
  input = { ...input, question: parsedQuestion.data };
  const ip = await hitQuestionIpLimit(db, input.request, env, now);
  if (ip && !ip.allowed) return { ok: false, response: fail("ip_limit", 429, rateLimitHeaders(ip)) };
  const materials = await postQuestionMaterials(db, input.topicId, input.language);
  if (!materials) return { ok: false, response: fail("not_found", 404) };
  const member = await hitQuestionMemberLimit(db, input.userId, env, now);
  if (!member.allowed) return { ok: false, response: fail("daily_limit", 429, rateLimitHeaders(member)) };
  try {
    const completer = input.completer ?? resolveQuestionCompleter(env);
    const prompt = { ...questionPrompt(materials, input.question, input.language), signal: input.request.signal };
    const { result } = await meteredCall(db, {
      engine: completer.engine, model: completer.model, purpose: "ask", role: "ask",
      estimateMicro: completionEstimate(completer.engine, completer.model, prompt.system, prompt.user, prompt.maxOutputTokens, env),
      now, clock, env, signal: input.request.signal,
    }, async () => {
      await countQuestionEvent(db, "ask", "asked", clock());
      return completer.complete(prompt);
    }, result => ({ inputTokens: result.inputTokens, outputTokens: result.outputTokens }));
    const answer = verifyQuestionAnswer(result.text, materials);
    // Recheck cited sources after generation. Other replies and newly available
    // translations do not invalidate passages that are still readable and unchanged.
    const current = answer ? await postQuestionMaterials(db, input.topicId, input.language) : null;
    const citationsUnchanged = answer && current && answer.citations.every(citation => {
      const before = materials.sources.find(source => source.id === citation.sourceId)!;
      const after = current.sources.find(source => source.id === citation.sourceId);
      if (!after) return false;
      const { translation: beforeTranslation, ...beforeOriginal } = before;
      const { translation: afterTranslation, ...afterOriginal } = after;
      return JSON.stringify(beforeOriginal) === JSON.stringify(afterOriginal)
        && (!citation.translation || JSON.stringify(beforeTranslation) === JSON.stringify(afterTranslation));
    });
    if (!citationsUnchanged) {
      await countQuestionEvent(db, "ask", "verification_failed", clock());
      return { ok: false, response: fail("unverified", 502) };
    }
    return { ok: true, response: signQuestionResponse(input.userId, { kind: "post", id: input.topicId }, input.question, {
      answer, scope: materials.scope, language: input.language, engine: completer.engine, model: completer.model,
      expiresAt: Math.floor(clock().getTime() / 1_000) + AI_QUESTION_LIMITS.receiptSeconds,
    }) };
  } catch (error) {
    // Provider and database errors can embed request text. They must not reach
    // the framework error logger, a response, a job payload or a retry queue.
    if (error instanceof BudgetPausedError) return { ok: false, response: fail("budget", 429, { "Retry-After": String(Math.max(1, Math.ceil((budgetResumeAt(now).getTime() - now.getTime()) / 1_000))) }) };
    return { ok: false, response: fail("unavailable", 503) };
  }
}

// Authentication and same-origin checks run in the resource route before this
// function reads any question or opt-in report content.
export async function handlePostQuestion(db: Db, userId: string, topicId: number, language: Lang, request: Request): Promise<Response> {
  try {
    if (!postAskAiEnabled()) return fail("not_found", 404);
    const input = await readInput(request);
    if (!input) return fail("invalid", 400);
    if (input.intent === "ask") {
      const result = await askPostQuestion(db, { userId, topicId, language, question: input.question, request });
      return result.ok ? questionJson(result.response) : result.response;
    }
    if (!await readableQuestionPost(db, topicId)) return fail("not_found", 404);
    const target = { kind: "post" as const, id: topicId };
    if (!verifyQuestionReceipt(userId, target, input.question, input.response)) return fail("expired", 403);
    if (input.intent === "report") {
      const rate = await hitMemberLimit(db, "report", userId);
      if (!rate.allowed) return fail("ip_limit", 429, rateLimitHeaders(rate));
      const saved = await saveQuestionReport(db, userId, target, input.question, input.response, input.consent);
      return saved ? questionJson({ reported: true }) : fail("expired", 403);
    }
    const rate = await hitRateLimit(db, { key: `draft:member:${userId}`, ...DRAFT_RATE_LIMIT });
    if (!rate.allowed) return fail("ip_limit", 429, rateLimitHeaders(rate));
    const draft = await db.transaction(async tx => {
      const created = await createDraft(tx, userId, { kind: "reply", threadId: topicId, body: input.question, lang: input.response.language });
      if (created.ok) await markQuestionDraft(tx, created.id, "ask");
      return created;
    });
    return draft.ok ? questionJson({ draftUrl: `/drafts/${draft.id}` }) : fail("unavailable", 400);
  } catch {
    return fail("unavailable", 503);
  }
}
