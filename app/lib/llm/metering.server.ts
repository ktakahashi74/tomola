import { safeErrorText } from "~/lib/error-text.server";
import type { Db } from "~/lib/db/client.server";
import { FIGURE_IMAGE_TOKEN_BOUND, FIGURE_READING_OUTPUT_TOKENS, FIGURE_READING_PROMPT, figureReadingUser, type FigureReader } from "~/lib/figure-reading.server";
import { paidTranslationCall, translationCallKey } from "~/lib/jobs/paid-translation.server";
import { currentJobSignal } from "~/lib/jobs/signal.server";
import { buildJudgePrompt, buildTranslationPrompt, outputTokenLimit } from "./prompt.server";
import { costMicro } from "./pricing.server";
import { claudeRequestShape } from "./engines/claude.server";
import { GEMINI_MAX_OUTPUT_TOKENS } from "./engines/gemini.server";
import { clipText, EMBED_MAX_CHARS } from "./engines/gemini-embedding.server";
import { judgeTokenLimit } from "./judge.server";
import { LlmError } from "./errors.server";
import { finalizeExpiredReservations, releaseReservation, reserveUsage, settleReservation } from "./usage.server";
import { USAGE_POLICY, type UsagePurpose, type UsageRole } from "./usage-policy";
import type { CompleteRequest, JsonCompleter } from "./completion.server";
import type { DivergenceJudge, EmbeddingEngine, EmbedRequest, EmbedResult, JudgeRequest, LlmEnv, TranslationEngine, TranslationRequest, TranslationResult } from "./types";
import { THINKING_HEADROOM } from "./thinking";

// UTF-8 bytes bound text tokens conservatively. Include message framing and the
// largest allowed output (including thinking/configuration fallbacks).
function completionEstimate(engine: string, model: string, system: string, user: string, output: number, env?: LlmEnv): number {
  const input = Buffer.byteLength(system + user, "utf8") + 256;
  const limit = engine === "claude" ? output + claudeRequestShape(model).extraMaxTokens
    : Math.min(GEMINI_MAX_OUTPUT_TOKENS, output + Math.max(...Object.values(THINKING_HEADROOM)));
  return costMicro(engine, model, input, limit, env);
}

export function translationEstimate(engine: string, model: string, req: TranslationRequest, env?: LlmEnv): number {
  const { system, user } = buildTranslationPrompt(req);
  return completionEstimate(engine, model, system, user, outputTokenLimit(req.text.length), env);
}

function judgeEstimate(engine: string, model: string, req: JudgeRequest, env?: LlmEnv): number {
  const { system, user } = buildJudgePrompt(req);
  return completionEstimate(engine, model, system, user, judgeTokenLimit(req.segments.length), env);
}

function embeddingEstimate(engine: string, model: string, req: EmbedRequest, env?: LlmEnv): number {
  return costMicro(engine, model, Buffer.byteLength(clipText(req.text, EMBED_MAX_CHARS) + (req.task === "document" && req.title ? clipText(req.title, 300) : ""), "utf8") + 256, 0, env);
}

type Tokens = { inputTokens: number; outputTokens: number };
type Usage = Tokens & { now?: Date; env?: LlmEnv };
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

type MeteringOptions = {
  purpose: UsagePurpose;
  role?: UsageRole;
  // A fixed reservation time or a clock read at admission. Settlement has its own clock.
  now?: Date | (() => Date);
  clock?: () => Date;
  env?: LlmEnv;
  signal?: AbortSignal;
};
type MeteredResult<T> = { result: T; costUsdMicro: number };

export function meteredEngine(db: Db, opts: MeteringOptions) {
  const { purpose, env, now } = opts;
  const role = opts.role ?? USAGE_POLICY[purpose].role;
  const clock = opts.clock ?? (typeof now === "function" ? now : () => now ?? new Date());
  const tokens = (result: Tokens) => result;
  const run = <T>(engine: string, model: string, estimateMicro: number, signal: AbortSignal | undefined, call: () => Promise<T>, usageOf: (result: T) => Tokens, before?: () => Promise<void>) => meteredCall(db, {
    engine, model, purpose, role, estimateMicro,
    now: typeof now === "function" ? now() : now ?? clock(), clock, env, signal,
  }, call, usageOf, before);

  return {
    translation(engine: TranslationEngine, options: { reusePaidResult?: boolean; addCost?: (costUsdMicro: number) => void } = {}): TranslationEngine {
      return {
        id: engine.id,
        model: engine.model,
        async translate(req) {
          const { reusePaidResult, addCost } = options;
          const signal = opts.signal ?? req.signal ?? (reusePaidResult ? currentJobSignal() : undefined);
          if (reusePaidResult) signal?.throwIfAborted();
          const call = () => run(engine.id, engine.model, translationEstimate(engine.id, engine.model, req, env), signal,
            () => engine.translate({ ...req, signal }), tokens);
          const { result, costUsdMicro } = reusePaidResult
            ? await paidTranslationCall(translationCallKey(engine, req, purpose, role), call)
            : await call();
          addCost?.(costUsdMicro);
          return result;
        },
      };
    },
    complete(completer: JsonCompleter, req: CompleteRequest, before?: () => Promise<void>) {
      return run(completer.engine, completer.model, completionEstimate(completer.engine, completer.model, req.system, req.user, req.maxOutputTokens, env),
        opts.signal ?? req.signal, () => completer.complete(req), tokens, before);
    },
    judge(engine: DivergenceJudge, req: JudgeRequest) {
      const signal = opts.signal ?? req.signal;
      return run(engine.id, engine.model, judgeEstimate(engine.id, engine.model, req, env), signal, () => engine.judge({ ...req, signal }), tokens);
    },
    embed(engine: EmbeddingEngine, req: EmbedRequest, validate?: (result: EmbedResult) => void) {
      const signal = opts.signal ?? req.signal;
      return run(engine.id, engine.model, embeddingEstimate(engine.id, engine.model, req, env), signal, async () => {
        const result = await engine.embed({ ...req, signal });
        validate?.(result);
        return result;
      }, result => ({ inputTokens: result.inputTokens, outputTokens: 0 }));
    },
    readFigure(reader: FigureReader, bytes: Buffer, retryOverlap: boolean, paidKey: string): Promise<MeteredResult<TranslationResult>> {
      return paidTranslationCall(paidKey, () => {
        const estimate = completionEstimate(reader.id, reader.model, FIGURE_READING_PROMPT, figureReadingUser(retryOverlap), FIGURE_READING_OUTPUT_TOKENS, env)
          + costMicro(reader.id, reader.model, FIGURE_IMAGE_TOKEN_BOUND, 0, env);
        return run(reader.id, reader.model, estimate, opts.signal, () => reader.read(bytes, opts.signal, retryOverlap), tokens);
      });
    },
  };
}

async function meteredCall<T>(db: Db, opts: Parameters<typeof reserveUsage>[1] & { clock: () => Date; signal?: AbortSignal },
  call: () => Promise<T>, usageOf: (result: T) => Tokens, before?: () => Promise<void>): Promise<MeteredResult<T>> {
  opts.signal?.throwIfAborted();
  await flushUsageSettlements(db, opts.now);
  const reservation = await reserveUsage(db, opts);
  const record = async (u: Tokens) => {
    // Retain only numerical usage when settlement needs a retry.
    const usage = { inputTokens: u.inputTokens, outputTokens: u.outputTokens, now: opts.clock(), env: opts.env };
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
    if (before) await before();
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
