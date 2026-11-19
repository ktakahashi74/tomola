import { hasPaidTranslationCall, translationCallKey } from "../jobs/paid-translation.server";
import { currentJobSignal } from "../jobs/signal.server";
import { meteredEngine } from "./metering.server";
import type { Db } from "~/lib/db/client.server";
import { resolveChatEngine, resolveEmbeddingEngine, resolveEngines, type EngineSet } from "./config.server";
import { LlmError } from "./errors.server";
import { assertBudget, getBudgetState, getChatBudgetStatus } from "./usage.server";
import { budgetAllows } from "./usage-policy";
import { CHAT_PROMPT_VERSION, decodeChatEntities } from "./prompt.server";
import { villageChatEnabled } from "../village-chat-enabled.server";
import { translateChecked, type CheckedTranslation } from "./translate.server";
import { currentDivergenceSampleRate, isDivergenceSampled } from "./divergence-sample.server";
import type { DivergenceJudge, EmbeddingEngine, EmbedRequest, EmbedResult, EngineId, JudgeRequest, JudgeResult, LlmEnv, TranslationEngine, TranslationRequest, TranslationRole } from "./types";

// Translation-pipeline entry point: check budget, call engines and record each call in llm_usage.
// - translate(db, "primary" | "secondary" | "retry", req): translate with structure checks and retry. retry is the single report-triggered retranslation (TRANSLATION_RETRY_MODEL).
// - judgeDivergence(db, req): judge divergence between two translations.
// - getBudgetState(db, now): budget state (normal | degraded | stopped).
// BudgetPausedError extends DeferJob when budget prevents calling. A handler rethrowing it leaves the job waiting,
// without failure, until the limit is raised or a new month begins. Engine errors throw LlmError, causing job retry.

export { getBudgetState, getBudgetStatus, type BudgetState } from "./usage.server";
export { BudgetPausedError, LlmError } from "./errors.server";
export { resolveEmbeddingEngine, resolveEngines, type EngineSet } from "./config.server";
export type * from "./types";

export type LlmOptions = {
  signal?: AbortSignal;
  // Time for budget month boundaries, default now. Also used for ledger timestamps if clock is absent.
  now?: Date;
  // The time of a call, for the ledger (llm_usage.created_at). A job passes its clock, so a call that took 95 seconds is recorded when it ended, not when the job started
  // (otherwise a long job that crosses a month boundary would put its cost in the previous month). Without it, `now` is used (tests), and without both, the database's time.
  clock?: () => Date;
  env?: LlmEnv;
  // Engine override for tests; otherwise configured from environment variables.
  engines?: EngineSet;
  // Embedding-engine override for tests; otherwise configured from environment variables.
  embeddingEngine?: EmbeddingEngine;
  chatEngine?: TranslationEngine;
};

export type Role = TranslationRole | "judge" | "embed";

// When to record a call that has just ended.
const usageTime = (opts: LlmOptions): Date | undefined => opts.clock?.() ?? opts.now;

// The options of a job handler: the job's `now` for the budget, the job's clock for the ledger, and the overrides of the caller (tests). An overridden `now`
// is also the time of the records (no clock).
export function jobLlmOptions(ctx: { now: Date; clock?: () => Date }, override?: LlmOptions): LlmOptions {
  return { now: ctx.now, ...(override?.now ? {} : { clock: ctx.clock }), ...override };
}

export async function translateChat(db: Db, req: TranslationRequest & { chat: { context: string[] } }, opts: LlmOptions & { beforeTranslate?: () => Promise<void> } = {}): Promise<TranslationOutcome> {
  if (!villageChatEnabled(opts.env)) throw new LlmError("unavailable", "Village chat is disabled");
  const now = opts.now ?? new Date();
  const engine = opts.chatEngine ?? opts.engines?.chat ?? resolveChatEngine(opts.env);
  if (!hasPaidTranslationCall(translationCallKey(engine, req, "chat", "chat"))) {
    assertBudget((await getChatBudgetStatus(db, now, opts.env)).state, "chat", now);
  }
  await opts.beforeTranslate?.();
  let costUsdMicro = 0;
  const metered = meteredEngine(db, { ...opts, purpose: "chat", now: opts.clock ?? opts.now }).translation(engine, {
    reusePaidResult: true, addCost: cost => { costUsdMicro += cost; },
  });
  const result = await translateChecked({ ...metered, async translate(request) {
    const translated = await metered.translate(request);
    return { ...translated, text: decodeChatEntities(translated.text, request.text), promptVersion: CHAT_PROMPT_VERSION };
  } }, req);
  return { ...result, engine: engine.id, costUsdMicro };
}

export type TranslationOutcome = CheckedTranslation & {
  engine: EngineId;
  // Cost of this translation, including retries, in microdollars.
  costUsdMicro: number;
};

export function hasSavedTranslation(role: TranslationRole, req: TranslationRequest, opts: LlmOptions = {}): boolean {
  const engines = opts.engines ?? resolveEngines(opts.env);
  const engine = role === "primary" ? engines.primary : role === "secondary" ? engines.secondary : engines.retry;
  return !!engine && hasPaidTranslationCall(translationCallKey(engine, req, role === "retry" ? "retry" : "translate", role));
}

export async function translate(db: Db, role: TranslationRole, req: TranslationRequest, opts: LlmOptions = {}): Promise<TranslationOutcome> {
  const now = opts.now ?? new Date();
  const engines = opts.engines ?? resolveEngines(opts.env);
  const engine = role === "primary" ? engines.primary : role === "secondary" ? engines.secondary : (engines.retry ?? null);
  const purpose = role === "retry" ? "retry" : "translate";
  if (!engine || !hasPaidTranslationCall(translationCallKey(engine, req, purpose, role))) {
    assertBudget(await getBudgetState(db, now, opts.env), purpose, now, role);
  }
  if (!engine) throw new LlmError("unavailable", `No ${role} translation engine is configured`);
  let costUsdMicro = 0;
  const metered = meteredEngine(db, { ...opts, purpose, role, now: opts.clock ?? opts.now }).translation(engine, {
    reusePaidResult: true, addCost: cost => { costUsdMicro += cost; },
  });
  const result = await translateChecked(metered, { ...req, postTranslation: true });
  return { ...result, engine: engine.id, costUsdMicro };
}

export type JudgeOutcome = JudgeResult & { engine: EngineId; costUsdMicro: number };

export async function judgeDivergence(db: Db, req: JudgeRequest, opts: LlmOptions = {}): Promise<JudgeOutcome> {
  const now = opts.now ?? new Date();
  assertBudget(await getBudgetState(db, now, opts.env), "judge", now);
  const engines = opts.engines ?? resolveEngines(opts.env);
  const judge: DivergenceJudge | null = engines.judge;
  if (!judge) throw new LlmError("unavailable", "No divergence judge is configured");
  const signal = opts.signal ?? req.signal ?? currentJobSignal();
  const { result, costUsdMicro } = await meteredEngine(db, {
    purpose: "judge", now: opts.clock ?? now, clock: () => usageTime(opts) ?? new Date(), env: opts.env, signal,
  }).judge(judge, req);
  return { ...result, engine: judge.id, costUsdMicro };
}

// Whether automatic report retranslation is configured (TRANSLATION_RETRY_MODEL). Do not check budget here: reports still enter retry during degraded/stopped states,
// and jobs wait queued. Configuration errors such as missing keys make it unavailable, so the caller sends reports to moderators.
export function isRetryConfigured(opts: LlmOptions = {}): boolean {
  try {
    return (opts.engines ?? resolveEngines(opts.env)).retry != null;
  } catch (error) {
    // Development/tests lack startup rejection: warn once why reports go straight to moderators instead of silently returning unavailable. Production rejects this at startup.
    const message = error instanceof Error ? error.message : String(error);
    if (!warnedRetryUnusable.has(message)) {
      warnedRetryUnusable.add(message);
      console.warn(`[llm] the automatic re-translation after a report is not used, and reports go straight to the moderators: ${message}`);
    }
    return false;
  }
}

const warnedRetryUnusable = new Set<string>();

// Whether a secondary is configured and the budget is normal; determines fallback availability after primary refusal/failure.
// Degradation disables the secondary, including fallback, under the budget rules.
export async function isSecondaryAvailable(db: Db, opts: LlmOptions = {}): Promise<boolean> {
  const now = opts.now ?? new Date();
  if (!budgetAllows(await getBudgetState(db, now, opts.env), "translate", "secondary")) return false;
  try {
    return (opts.engines ?? resolveEngines(opts.env)).secondary !== null;
  } catch {
    // Configuration error, e.g. missing key: fallback unavailable; caller returns the original failure.
    return false;
  }
}

// Whether secondary and judge are configured and the budget is not degraded; translation jobs use this to decide whether to enqueue measure_divergence.
export async function isDivergenceAvailable(db: Db, opts: LlmOptions = {}): Promise<boolean> {
  const now = opts.now ?? new Date();
  const state = await getBudgetState(db, now, opts.env);
  if (!budgetAllows(state, "translate", "secondary") || !budgetAllows(state, "judge")) return false;
  const engines = opts.engines ?? resolveEngines(opts.env);
  return engines.secondary !== null && engines.judge !== null;
}

// Whether to measure this translation (post, target language, source version): secondary and judge must be available (isDivergenceAvailable), and selection must pass DIVERGENCE_SAMPLE_RATE,
// deterministically sampled by divergence-sample.server.ts. Default rate 0 measures nothing.
export async function shouldMeasureDivergence(db: Db, key: { entryId: number; lang: string; sourceHash: string }, opts: LlmOptions = {}): Promise<boolean> {
  if (!isDivergenceSampled(key, currentDivergenceSampleRate(opts.env))) return false;
  return isDivergenceAvailable(db, opts);
}

// Usable embedding: every value finite and vector nonzero.
export function isUsableEmbedding(vector: readonly number[]): boolean {
  let nonZero = false;
  for (const v of vector) {
    if (!Number.isFinite(v)) return false;
    if (v !== 0) nonZero = true;
  }
  return nonZero;
}

export type EmbedOutcome = EmbedResult & { engine: EmbeddingEngine["id"]; costUsdMicro: number };

// Embed posts (embed_entry) or search queries. Stopped budgets throw BudgetPausedError: embed_entry waits; search shows 「一時的に使えない」.
// Record charged usage, including failed returned responses, in the ledger with purpose=embed.
export async function embed(db: Db, req: EmbedRequest, opts: LlmOptions = {}): Promise<EmbedOutcome> {
  const now = opts.now ?? new Date();
  assertBudget(await getBudgetState(db, now, opts.env), "embed", now);
  const engine = opts.embeddingEngine ?? resolveEmbeddingEngine(opts.env);
  const signal = opts.signal ?? req.signal ?? currentJobSignal();
  const { result, costUsdMicro } = await meteredEngine(db, {
    purpose: "embed", now: opts.clock ?? now, clock: () => usageTime(opts) ?? new Date(), env: opts.env, signal,
  }).embed(engine, req, result => {
    // Charged but unusable responses still settle their reservation.
    if (!isUsableEmbedding(result.vector)) throw new LlmError("invalid_output", "the embedding is all zeros or has a value that is not finite", { inputTokens: result.inputTokens, outputTokens: 0 });
  });
  return { ...result, engine: engine.id, costUsdMicro };
}
