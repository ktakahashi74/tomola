import { safeErrorText } from "~/lib/error-text.server";
import type { Db } from "~/lib/db/client.server";
import { buildJudgePrompt, buildTranslationPrompt, outputTokenLimit } from "./prompt.server";
import { costMicro } from "./pricing.server";
import { claudeRequestShape } from "./engines/claude.server";
import { GEMINI_MAX_OUTPUT_TOKENS } from "./engines/gemini.server";
import { clipText, EMBED_MAX_CHARS } from "./engines/gemini-embedding.server";
import { judgeTokenLimit } from "./judge.server";
import { LlmError } from "./errors.server";
import { finalizeExpiredReservations, releaseReservation, reserveUsage, settleReservation, type UsagePurpose } from "./usage.server";
import type { EmbedRequest, JudgeRequest, LlmEnv, TranslationRequest } from "./types";
import { THINKING_HEADROOM } from "./thinking";

// UTF-8 bytes bound text tokens conservatively. Include message framing and the
// largest allowed output (including thinking/configuration fallbacks).
export function completionEstimate(engine: string, model: string, system: string, user: string, output: number, env?: LlmEnv): number {
  const input = Buffer.byteLength(system + user, "utf8") + 256;
  const limit = engine === "claude" ? output + claudeRequestShape(model).extraMaxTokens
    : Math.min(GEMINI_MAX_OUTPUT_TOKENS, output + Math.max(...Object.values(THINKING_HEADROOM)));
  return costMicro(engine, model, input, limit, env);
}

export function translationEstimate(engine: string, model: string, req: TranslationRequest, env?: LlmEnv): number {
  const { system, user } = buildTranslationPrompt(req);
  return completionEstimate(engine, model, system, user, outputTokenLimit(req.text.length), env);
}

export function judgeEstimate(engine: string, model: string, req: JudgeRequest, env?: LlmEnv): number {
  const { system, user } = buildJudgePrompt(req);
  return completionEstimate(engine, model, system, user, judgeTokenLimit(req.segments.length), env);
}

export function embeddingEstimate(engine: string, model: string, req: EmbedRequest, env?: LlmEnv): number {
  return costMicro(engine, model, Buffer.byteLength(clipText(req.text, EMBED_MAX_CHARS) + (req.task === "document" && req.title ? clipText(req.title, 300) : ""), "utf8") + 256, 0, env);
}

type Usage = { inputTokens: number; outputTokens: number; now?: Date; env?: LlmEnv };
const pending = new WeakMap<Db, Map<number, Usage>>();

export async function flushUsageSettlements(db: Db, now = new Date()): Promise<void> {
  const entries = pending.get(db);
  if (entries) {
    for (const [id, usage] of entries) {
      try { await settleReservation(db, id, usage); entries.delete(id); }
      catch { /* Keep the reservation charged until a later tick can settle it. */ }
    }
  }
  await finalizeExpiredReservations(db, now);
}

export async function meteredCall<T>(db: Db, opts: {
  engine: string; model: string; purpose: UsagePurpose;
  role: "primary" | "secondary" | "retry" | "judge" | "embed" | "chat";
  estimateMicro: number; now: Date; clock: () => Date; env?: LlmEnv; signal?: AbortSignal;
}, call: () => Promise<T>, usageOf: (result: T) => { inputTokens: number; outputTokens: number }): Promise<{ result: T; costUsdMicro: number }> {
  opts.signal?.throwIfAborted();
  await flushUsageSettlements(db, opts.now);
  const reservation = await reserveUsage(db, opts);
  const record = async (u: { inputTokens: number; outputTokens: number }) => {
    const usage = { ...u, now: opts.clock(), env: opts.env };
    try { await settleReservation(db, reservation, usage); }
    catch {
      let entries = pending.get(db);
      if (!entries) pending.set(db, entries = new Map());
      entries.set(reservation, usage);
      console.warn("[llm] usage settlement deferred; the cost reservation is retained");
    }
    return costMicro(opts.engine, opts.model, u.inputTokens, u.outputTokens, opts.env);
  };
  let result: T;
  try {
    opts.signal?.throwIfAborted();
    result = await call();
  } catch (error) {
    if (error instanceof LlmError && error.usage) await record(error.usage);
    else {
      try { await releaseReservation(db, reservation); }
      catch (releaseError) {
        console.warn("[llm] reservation release failed; retaining the estimate for expiration", safeErrorText(releaseError));
      }
    }
    throw error;
  }
  return { result, costUsdMicro: await record(usageOf(result)) };
}
