import type { EmbedContentParameters, EmbedContentResponse } from "@google/genai";
import { EMBEDDING_DIM } from "~/lib/db/schema";
import { LlmError } from "../errors.server";
import { estimateTokens } from "../prompt.server";
import type { EmbeddingEngine, EmbedRequest, EmbedResult } from "../types";
import { createGeminiClient, noteFreeTierKey } from "./gemini.server";

// Gemini embeddings: default gemini-embedding-001, 768 output dimensions via outputDimensionality. The model defaults to 3072;
// truncated 768-dimensional output is not normalized, so L2-normalize here. EMBEDDING_MODEL selects another model but keeps 768 dimensions.
// REST shape (https://ai.google.dev/gemini-api/docs/embeddings): POST .../models/<model>:embedContent, body
// { content: { parts: [{ text }] }, taskType, title, outputDimensionality }; response { embedding: { values: [...] } }. Wrapped by SDK ai.models.embedContent.
// Gemini Developer API accepts only taskType, title and outputDimensionality. autoTruncate and mimeType are Vertex-only and throw if supplied to the SDK.
// Responses omit token usage. Record cost using the conservative estimateTokens estimate from input character count.
export const DEFAULT_EMBEDDING_MODEL = "gemini-embedding-001";
// Input character cap: gemini-embedding-001 accepts 2048 tokens. Japanese and similar scripts need roughly one token per character, so embed only this many leading characters with margin.
// The beginning represents the topic of a long post, sufficient for search.
export const EMBED_MAX_CHARS = 3000;
const REQUEST_TIMEOUT_MS = 2 * 60 * 1000;

// Tests inject fake clients matching this shape without network calls. The real GoogleGenAI client is assignable directly.
export type GeminiEmbeddingClient = {
  models: { embedContent(params: EmbedContentParameters): Promise<Pick<EmbedContentResponse, "embeddings">> };
};

// Truncate to the character limit without splitting a surrogate pair.
export function clipText(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

export function l2Normalize(values: readonly number[]): number[] {
  const norm = Math.hypot(...values);
  return norm === 0 ? [...values] : values.map((v) => v / norm);
}

export function createGeminiEmbeddingEngine(opts: { apiKey?: string; model?: string; client?: GeminiEmbeddingClient }): EmbeddingEngine {
  const model = opts.model ?? DEFAULT_EMBEDDING_MODEL;
  let client = opts.client;
  return {
    id: "gemini",
    model,
    dim: EMBEDDING_DIM,
    async embed(req: EmbedRequest): Promise<EmbedResult> {
      if (!client) {
        if (!opts.apiKey) throw new LlmError("config", "GEMINI_API_KEY is not set");
        client = createGeminiClient(opts.apiKey) as unknown as GeminiEmbeddingClient;
      }
      const text = clipText(req.text, EMBED_MAX_CHARS);
      const title = req.task === "document" && req.title ? clipText(req.title, 300) : undefined;
      const timeout = req.task === "query" ? 15_000 : REQUEST_TIMEOUT_MS;
      const signal = AbortSignal.any([AbortSignal.timeout(timeout), ...(req.signal ? [req.signal] : [])]);
      let response: Awaited<ReturnType<GeminiEmbeddingClient["models"]["embedContent"]>>;
      try {
        response = await client.models.embedContent({
          model,
          contents: text,
          config: {
            abortSignal: signal,
            taskType: req.task === "document" ? "RETRIEVAL_DOCUMENT" : "RETRIEVAL_QUERY",
            outputDimensionality: EMBEDDING_DIM,
            ...(title ? { title } : {}),
            httpOptions: { timeout, retryOptions: { attempts: 1 } },
          },
        });
      } catch (error) {
        signal.throwIfAborted();
        noteFreeTierKey(error);
        throw error;
      }
      const values = response.embeddings?.[0]?.values;
      if (!values || values.length !== EMBEDDING_DIM || values.some((v) => !Number.isFinite(v)) || values.every((v) => v === 0)) {
        throw new LlmError("invalid_output", `Gemini returned an unusable embedding (${values?.length ?? 0} values, expected ${EMBEDDING_DIM}, all finite and not all zero)`, {
          inputTokens: estimateTokens(text + (title ?? "")),
          outputTokens: 0,
        });
      }
      return { vector: l2Normalize(values), model, inputTokens: estimateTokens(text + (title ?? "")) };
    },
  };
}
