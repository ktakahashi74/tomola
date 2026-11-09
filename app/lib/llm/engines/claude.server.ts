import Anthropic from "@anthropic-ai/sdk";
import type { Message, MessageCreateParamsNonStreaming } from "@anthropic-ai/sdk/resources/messages/messages";
import { LlmError } from "../errors.server";
import { buildTranslationPrompt, cleanTranslation, outputTokenLimit, promptVersionOf } from "../prompt.server";
import type { TranslationEngine, TranslationRequest, TranslationResult } from "../types";

export const DEFAULT_CLAUDE_MODEL = "claude-haiku-4-5";
const REQUEST_TIMEOUT_MS = 2 * 60 * 1000;

// Per-model Claude request shape: supported parameters vary by generation; avoid 400 errors after switching translation models.
// API version 2026-10-21 removes temperature, top_p and top_k for every model.
// - thinking: disable reasoning, which translation does not need at the cost of thinking tokens and max_tokens. Sonnet 5.5 rejects `disabled`; stop it with `between_tools`.
//   Sonnet 5 uses `disabled`; Opus 4.8/4.7 do not think when omitted. Opus 5.5 and Fable 5.x cannot disable thinking; reduce it with effort below.
// - effort (output_config.effort): low only for models whose thinking cannot be disabled. Haiku 4.5 and some others do not accept effort.
// - extraMaxTokens: extra output allowance for models whose thinking consumes max_tokens.
// Provider request compatibility must be verified with the configured model before production use.
export type ClaudeRequestShape = {
  thinking?: { type: "between_tools" } | { type: "disabled" };
  effort?: "low";
  extraMaxTokens: number;
};

export function claudeRequestShape(model: string): ClaudeRequestShape {
  const m = model.trim().toLowerCase();
  if (/^claude-sonnet-5-5(-|$)/.test(m)) return { thinking: { type: "between_tools" }, extraMaxTokens: 0 };
  if (/^claude-sonnet-5(-|$)/.test(m)) return { thinking: { type: "disabled" }, extraMaxTokens: 0 };
  if (/^claude-(opus-5(-5)?|fable-5(-1)?|mythos-5(-1)?)(-|$)/.test(m)) return { effort: "low", extraMaxTokens: 4096 };
  return { extraMaxTokens: 0 };
}

// Tests inject fake clients matching this shape, without network calls. The real Anthropic client is assignable directly.
export type ClaudeClient = {
  messages: {
    create(body: MessageCreateParamsNonStreaming, options?: { timeout?: number; maxRetries?: number; signal?: AbortSignal }): Promise<ClaudeMessage>;
  };
};
export type ClaudeMessage = Pick<Message, "content" | "stop_reason" | "usage"> & Partial<Pick<Message, "stop_details">>;

const clients = new Map<string, ClaudeClient>();

export function createClaudeClient(apiKey: string): ClaudeClient {
  let client = clients.get(apiKey);
  if (!client) {
    client = new Anthropic({ apiKey, maxRetries: 0, timeout: REQUEST_TIMEOUT_MS });
    clients.set(apiKey, client);
  }
  return client;
}

export type ClaudeCompletion = { text: string; inputTokens: number; outputTokens: number };

// Call one generation and inspect the response. A stop_reason other than end_turn (refusal, truncation, etc.),
// or empty output throws LlmError for the job to retry. Retain charged usage.
export async function claudeComplete(
  client: ClaudeClient,
  opts: { model: string; system: string; user: string; image?: { mimeType: "image/webp"; data: string }; maxTokens: number; signal?: AbortSignal },
): Promise<ClaudeCompletion> {
  const shape = claudeRequestShape(opts.model);
  // The SDK clears its fetch timeout when headers arrive. Keep a separate
  // deadline alive through response-body parsing as well.
  const signal = AbortSignal.any([AbortSignal.timeout(REQUEST_TIMEOUT_MS), ...(opts.signal ? [opts.signal] : [])]);
  // Explicit timeout prevents SDK rejection with 「ストリーミングが必要」 even for large outputs that may take minutes.
  const response = await client.messages.create(
    {
      model: opts.model,
      max_tokens: opts.maxTokens + shape.extraMaxTokens,
      ...(shape.thinking ? { thinking: shape.thinking } : {}),
      ...(shape.effort ? { output_config: { effort: shape.effort } } : {}),
      system: opts.system,
      messages: [{ role: "user", content: opts.image ? [{ type: "image", source: { type: "base64", media_type: opts.image.mimeType, data: opts.image.data } }, { type: "text", text: opts.user }] : opts.user }],
    },
    { timeout: REQUEST_TIMEOUT_MS, maxRetries: 0, signal },
  ).catch(error => { signal.throwIfAborted(); throw error; });
  const u = response.usage;
  const usage = {
    // Count cache-read/write tokens as input conservatively. Stable system instructions can be reused by provider prompt caches.
    inputTokens: u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
    outputTokens: u.output_tokens,
  };
  switch (response.stop_reason) {
    case "end_turn":
    case "stop_sequence":
      break;
    case "max_tokens":
      throw new LlmError("truncated", "Claude output was cut off (max_tokens)", usage);
    case "refusal": {
      const category = response.stop_details?.category;
      throw new LlmError("refusal", `Claude refused the request${category ? ` (${category})` : ""}`, usage);
    }
    default:
      throw new LlmError("invalid_output", `Claude stopped with unexpected stop_reason ${String(response.stop_reason)}`, usage);
  }
  const text = response.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
  if (!text.trim()) throw new LlmError("empty", "Claude returned an empty response", usage);
  return { text, ...usage };
}

export function createClaudeEngine(opts: { apiKey?: string; model?: string; client?: ClaudeClient }): TranslationEngine {
  const model = opts.model ?? DEFAULT_CLAUDE_MODEL;
  let client = opts.client;
  return {
    id: "claude",
    model,
    async translate(req: TranslationRequest): Promise<TranslationResult> {
      if (!client) {
        if (!opts.apiKey) throw new LlmError("config", "ANTHROPIC_API_KEY is not set");
        client = createClaudeClient(opts.apiKey);
      }
      const { system, user } = buildTranslationPrompt(req);
      const out = await claudeComplete(client, { model, system, user, maxTokens: outputTokenLimit(req.text.length), signal: req.signal });
      return {
        text: cleanTranslation(out.text),
        model,
        promptVersion: promptVersionOf(req),
        inputTokens: out.inputTokens,
        outputTokens: out.outputTokens,
      };
    },
  };
}
