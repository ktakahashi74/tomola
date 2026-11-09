import { GoogleGenAI, ThinkingLevel, MediaResolution, type GenerateContentParameters, type GenerateContentResponse } from "@google/genai";
import { LlmError } from "../errors.server";
import { CHAT_THINKING_ENV, DEFAULT_TRANSLATION_THINKING, THINKING_ENV, THINKING_HEADROOM, THINKING_LADDER, THINKING_REPROBE_AFTER_MS, thinkingHeadroom, type ThinkingLevelName, type ThinkingSetting } from "../thinking";
import { buildTranslationPrompt, cleanTranslation, estimateTokens, outputTokenLimit, promptVersionOf } from "../prompt.server";
import type { TranslationEngine, TranslationRequest, TranslationResult } from "../types";

// Shared light-model default for primary translation, chat, moderation and figure reading.
export const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash-lite";
// Explicit Gemini secondary and judge roles use a different model from the default primary.
export const DEFAULT_SECONDARY_GEMINI_MODEL = "gemini-3.6-flash";
export const DEFAULT_JUDGE_GEMINI_MODEL = "gemini-3.6-flash";
const REQUEST_TIMEOUT_MS = 2 * 60 * 1000;
// Gemini 3.x thinks by default. Thinking tokens consume maxOutputTokens and are charged as output. The source-based outputTokenLimit alone can make short texts
// hit MAX_TOKENS before an answer. Observed 2026-10-01: first-call truncation in 3/5 gemini-3.5-flash retranslations of 300–900-character posts.
// Add thinking allowance. Only actual output is charged, so a higher cap costs no more when thinking remains short.
// The headroom depends on the thinking level that is sent (THINKING_HEADROOM: small when thinking is off, this much for the model's default), and geminiComplete adds it.
export const GEMINI_THINKING_HEADROOM_TOKENS = THINKING_HEADROOM.default;
export const GEMINI_MAX_OUTPUT_TOKENS = 65_536;

// Tests inject fake clients matching this shape without network calls. The real GoogleGenAI client is assignable directly.
export type GeminiClient = {
  models: {
    generateContent(params: GenerateContentParameters): Promise<GeminiResponse>;
  };
};
export type GeminiResponse = Pick<GenerateContentResponse, "text" | "candidates" | "usageMetadata" | "promptFeedback">;

// Free-tier keys (billing disabled) cannot be used in production: roughly 20 calls per model per day (`GenerateRequestsPerDayPerProjectPerModel-FreeTier`,
// including failed requests), and inputs may be used for Google product improvement or human review, contrary to the member data-use disclosure. Use billing-enabled project keys.
// If an API error contains free_tier or PerDay…FreeTier, treat the key as free-tier and log once per process.
export function looksLikeFreeTierError(error: unknown): boolean {
  const text = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return /free[_\- ]?tier|GenerateRequests\w*PerDay\w*PerModel|PerDay\w*FreeTier/i.test(text);
}

export const FREE_TIER_WARNING =
  "[llm] GEMINI_API_KEY looks like a free-tier key (the API answered with a free-tier quota error). A free-tier key allows only about 20 requests per model per day, and Google may use its inputs to improve its products, " +
  "which conflicts with the disclosure to members. Use a key from a project with billing enabled (docs/deploy.md).";

const warnState = globalThis as { __tomolaFreeTierWarned?: boolean };

// Warn once for a free-tier error; return true only when a warning is emitted.
export function noteFreeTierKey(error: unknown, log: (message: string) => void = (m) => console.error(m)): boolean {
  if (warnState.__tomolaFreeTierWarned || !looksLikeFreeTierError(error)) return false;
  warnState.__tomolaFreeTierWarned = true;
  log(FREE_TIER_WARNING);
  return true;
}

// Test helper: allow the warning to be emitted again.
export function resetFreeTierWarning(): void {
  warnState.__tomolaFreeTierWarned = false;
}

const clients = new Map<string, GeminiClient>();

export function createGeminiClient(apiKey: string): GeminiClient {
  let client = clients.get(apiKey);
  if (!client) {
    client = new GoogleGenAI({ apiKey, httpOptions: { timeout: REQUEST_TIMEOUT_MS, retryOptions: { attempts: 1 } } });
    clients.set(apiKey, client);
  }
  return client;
}

// Non-retryable refusal finish reasons; promptFeedback.blockReason input blocking also counts. Other non-STOP reasons are retryable errors.
const REFUSAL_FINISH_REASONS = new Set(["SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII"]);

export type GeminiCompletion = {
  text: string;
  inputTokens: number;
  // Includes the thinking tokens (they are billed as output).
  outputTokens: number;
  // The thinking tokens alone (0 when the response does not report them).
  thoughtTokens: number;
  // The thinking level that was sent ("default": no thinkingConfig).
  thinking: string;
};

// The text of an API error, on one line.
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").trim();

// A 400 whose text is about the thinking configuration ("Thinking level MINIMAL is not supported", "...thinking_config.thinking_level..."). Only such an answer steps the level down:
// a 400 about something else (a bad prompt, a bad parameter) would be repeated at every rung.
const isThinkingConfigError = (error: unknown) =>
  typeof error === "object" && error !== null && (error as { status?: unknown }).status === 400 && /thinking/i.test(errorText(error));

// For each model and thinking setting, the rung of THINKING_LADDER that the API accepted last time, and when (so a model that rejects MINIMAL is not asked for it on every call,
// but is asked again after THINKING_REPROBE_AFTER_MS, and after a restart).
const acceptedRung = new Map<string, { rung: number; at: number }>();

// For tests.
export function resetThinkingFallbacks(): void {
  acceptedRung.clear();
}

// One generation call, and a check of the response. A generation that did not end with STOP (cut off, stopped for safety) and an empty output
// throw LlmError (SAFETY, PROHIBITED_CONTENT, BLOCKLIST, SPII and a blocked prompt are a refusal, and the job fails without retrying; the rest the job retries).
// The tokens that were billed go in usage.
export async function geminiComplete(
  client: GeminiClient,
  // maxOutputTokens: the limit for the visible output. With `thinking`, the headroom for the thinking tokens of the level that is sent is added (capped at GEMINI_MAX_OUTPUT_TOKENS).
  // json: ask for a JSON response (the judge).
  // responseJsonSchema: optional structured output constraints (figure reading).
  // thinking: the thinking setting (GEMINI_TRANSLATION_THINKING for the translation engines, DIVERGENCE_JUDGE_THINKING for the judge; thinkingEnv names it in the warning). If the API
  // answers 400 about the thinking configuration, the next rung of THINKING_LADDER is tried (a model that cannot take MINIMAL gets LOW, and then no thinkingConfig), and the rung that
  // worked is remembered per model for an hour.
  // thinkingLevel: one fixed level, no fallback and no headroom added (the messages translation, scripts/i18n-translate.ts, uses LOW to keep the thinking cost down). If neither is
  // given, the model's default.
  opts: {
    model: string;
    system: string;
    user: string;
    image?: { mimeType: "image/webp"; data: string };
    maxOutputTokens: number;
    json?: boolean;
    responseJsonSchema?: NonNullable<GenerateContentParameters["config"]>["responseJsonSchema"];
    thinking?: ThinkingSetting;
    thinkingEnv?: string;
    thinkingLevel?: ThinkingLevelName;
    signal?: AbortSignal;
  },
): Promise<GeminiCompletion> {
  const ladder: ReadonlyArray<ThinkingLevelName | null> = opts.thinking ? THINKING_LADDER[opts.thinking] : [opts.thinkingLevel ?? null];
  const rungKey = `${opts.model}|${opts.thinking ?? ""}`;
  const remembered = acceptedRung.get(rungKey);
  const firstRung = opts.thinking && remembered && Date.now() - remembered.at < THINKING_REPROBE_AFTER_MS ? Math.min(remembered.rung, ladder.length - 1) : 0;
  let rung = firstRung;
  let rejection: string | null = null;
  let response: GeminiResponse;
  // The same deadline covers all thinking-configuration fallbacks too.
  const signal = AbortSignal.any([AbortSignal.timeout(REQUEST_TIMEOUT_MS), ...(opts.signal ? [opts.signal] : [])]);
  for (;;) {
    const level = ladder[rung];
    try {
      response = await client.models.generateContent({
        model: opts.model,
        contents: opts.image ? [{ text: opts.user }, { inlineData: opts.image }] : opts.user,
        config: {
          abortSignal: signal,
          systemInstruction: opts.system,
          maxOutputTokens: opts.thinking ? Math.min(GEMINI_MAX_OUTPUT_TOKENS, opts.maxOutputTokens + thinkingHeadroom(level)) : opts.maxOutputTokens,
          ...(opts.image ? { mediaResolution: MediaResolution.MEDIA_RESOLUTION_HIGH } : {}),
          ...(opts.json || opts.responseJsonSchema ? { responseMimeType: "application/json" } : {}),
          ...(opts.responseJsonSchema ? { responseJsonSchema: opts.responseJsonSchema } : {}),
          ...(level ? { thinkingConfig: { thinkingLevel: ThinkingLevel[level] } } : {}),
          httpOptions: { timeout: REQUEST_TIMEOUT_MS, retryOptions: { attempts: 1 } },
        },
      });
      break;
    } catch (error) {
      signal.throwIfAborted();
      // The model may not take this thinking level: try the next rung (a rejected request is not billed).
      if (opts.thinking && level !== null && isThinkingConfigError(error) && rung + 1 < ladder.length) {
        rejection ??= errorText(error).slice(0, 300);
        rung++;
        continue;
      }
      noteFreeTierKey(error);
      throw error;
    }
  }
  if (opts.thinking && rung !== firstRung) {
    const name = opts.thinkingEnv ?? THINKING_ENV;
    const detail = name === CHAT_THINKING_ENV ? "the API rejected the thinking configuration" : `the API said: ${rejection}`;
    acceptedRung.set(rungKey, { rung, at: Date.now() });
    console.warn(
      `[llm] ${opts.model} did not accept thinking level ${ladder[firstRung] ?? "default"} for ${name}=${opts.thinking} (${detail}); using ${ladder[rung] ?? "the model default"} for it, and asking for ${ladder[0] ?? "default"} again in an hour or after a restart. Set ${name} to choose the level yourself.`,
    );
  } else if (opts.thinking && rung === firstRung && firstRung === 0 && remembered) {
    // asked for the first rung again after the hour, and the API accepted it: forget the lowered level
    acceptedRung.delete(rungKey);
  }
  const level = ladder[rung];
  const meta = response.usageMetadata;
  const text = response.text ?? "";
  // Thinking tokens are billed as output tokens.
  const thoughtTokens = meta?.thoughtsTokenCount ?? 0;
  const inputTokens = meta?.promptTokenCount ?? estimateTokens(opts.system + opts.user);
  const outputTokens = meta ? (meta.candidatesTokenCount ?? 0) + thoughtTokens : estimateTokens(text);
  const usage = { inputTokens, outputTokens, thoughtTokens };

  const blocked = response.promptFeedback?.blockReason;
  if (blocked) throw new LlmError("refusal", `Gemini blocked the prompt: ${blocked}`, usage);
  const candidate = response.candidates?.[0];
  if (!candidate) throw new LlmError("empty", "Gemini returned no candidates", usage);
  const finish = candidate.finishReason;
  if (finish === "MAX_TOKENS") throw new LlmError("truncated", "Gemini output was cut off (MAX_TOKENS)", usage);
  if (finish !== undefined && finish !== "STOP") {
    const message = `Gemini stopped with finish reason ${finish}${candidate.finishMessage ? `: ${candidate.finishMessage}` : ""}`;
    // Refusals for safety and the like (retrying gives the same answer, so the job fails at once). OTHER, RECITATION and so on may pass on a retry.
    throw new LlmError(REFUSAL_FINISH_REASONS.has(String(finish)) ? "refusal" : "invalid_output", message, usage);
  }
  if (!text.trim()) throw new LlmError("empty", "Gemini returned an empty response", usage);
  return { text, ...usage, thinking: level ?? "default" };
}

// One line per translation call in the log (llm_usage has no column for the thinking level): the model, the setting and the level that was sent, and the tokens. Quiet in tests.
export function logTranslationCall(line: string): void {
  if (process.env.NODE_ENV !== "test") console.info(line);
}

export function createGeminiEngine(opts: {
  apiKey?: string;
  model?: string;
  client?: GeminiClient;
  // GEMINI_TRANSLATION_THINKING (default: off, the lowest level the model accepts).
  thinking?: ThinkingSetting;
  thinkingEnv?: string;
  // Where the per-call line goes (default: the log; nothing in tests).
  log?: (line: string) => void;
}): TranslationEngine {
  const model = opts.model ?? DEFAULT_GEMINI_MODEL;
  const thinking = opts.thinking ?? DEFAULT_TRANSLATION_THINKING;
  const thinkingEnv = opts.thinkingEnv ?? THINKING_ENV;
  const log = opts.log ?? logTranslationCall;
  let client = opts.client;
  return {
    id: "gemini",
    model,
    thinkingSetting: thinking,
    async translate(req: TranslationRequest): Promise<TranslationResult> {
      if (!client) {
        if (!opts.apiKey) throw new LlmError("config", "GEMINI_API_KEY is not set");
        client = createGeminiClient(opts.apiKey);
      }
      const { system, user } = buildTranslationPrompt(req);
      const line = (u: { inputTokens: number; outputTokens: number; thoughtTokens?: number }, extra: string) =>
        log(`[llm] translate gemini ${model} ${thinkingEnv}=${thinking}${extra} input=${u.inputTokens} output=${u.outputTokens} thinking_tokens=${u.thoughtTokens ?? 0}`);
      let out: GeminiCompletion;
      try {
        out = await geminiComplete(client, {
          model,
          system,
          user,
          maxOutputTokens: outputTokenLimit(req.text.length),
          thinking,
          thinkingEnv,
          signal: req.signal,
        });
      } catch (error) {
        // A call that came back but was not usable (cut off, refused) was billed too.
        if (error instanceof LlmError && error.usage) line(error.usage, ` error=${error.code}`);
        throw error;
      }
      line(out, ` level=${out.thinking}`);
      return {
        text: cleanTranslation(out.text),
        model,
        promptVersion: promptVersionOf(req),
        inputTokens: out.inputTokens,
        outputTokens: out.outputTokens,
        thoughtTokens: out.thoughtTokens,
        thinking: out.thinking,
      };
    },
  };
}
