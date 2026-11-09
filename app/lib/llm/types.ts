import type { Lang } from "~/lib/languages";
import type { ThinkingSetting } from "./thinking";
import type { TranslationTerms } from "../translation-terms";

// Common LLM interfaces for translation engines (gemini/claude/fake) and divergence judges.
// Callers depend only on these types and app/lib/llm/index.server.ts, not engine implementations.

export type EngineId = "gemini" | "claude" | "fake";

// Translation role in app/lib/llm/index.server.ts. retry uses TRANSLATION_RETRY_MODEL from the primary provider after a report.
export type TranslationRole = "primary" | "secondary" | "retry";

// Monthly budget state: normal below 80%; degraded from 80% to below 100% (secondary/judge stop); stopped at 100% or above (primary also stops).
export type BudgetState = "normal" | "degraded" | "stopped";

// Environment-variable collection: process.env or test-provided values.
export type LlmEnv = Record<string, string | undefined>;

// One glossary_entries row. A recommended translation, never forced uniformity.
export type GlossaryHint = {
  term: string;
  // Recommended translations in priority order.
  candidates: string[];
  note?: string;
  // Entry to retain in its original language.
  keepOriginal?: boolean;
};

export type TranslationRequest = {
  signal?: AbortSignal;
  // Source Markdown, or the title itself when translating a topic title.
  text: string;
  from: Lang;
  to: Lang;
  // Titles are displayed as plain text. Normalize their Markdown only for checks,
  // retaining the engine's original output for storage and display.
  field?: "title" | "body";
  // Legacy caller fields, ignored by translation prompts since v6. Use only the
  // bounded terminology field for response references; never import their claims.
  title?: string;
  context?: string;
  topicExcerpt?: string;
  report?: { excerpt: string; note: string };
  // Only for titles: bounded source/translated passages of this same post's body.
  titleBodyContext?: string;
  // Local author spellings and the opening response reference's terminology.
  terminology?: TranslationTerms;
  glossary?: GlossaryHint[];
  // The @mentions of the source body (the members it names, as written: "@hana"; the quoted ones included, they are shown as mentions). The translation keeps every one of
  // them (the prompt rule, and checkStructure). Only the body of a post has them.
  mentions?: string[];
  // Additional retry warning after the previous output failed structure checks; used by translateChecked.
  retryNote?: string;
  // Only village chat translations may use preceding messages as context.
  chat?: { context: string[] };
  // The name or the description of a village: short plain text (not Markdown) that stands alone, translated without any context from other members' texts.
  village?: "name" | "description";
  // A personal note attached to an invitation, translated on its own as plain text.
  invitationNote?: boolean;
  // A JSON array of labels from one figure, translated together in order.
  figure?: boolean;
  // One bounded shortening call for the labels that did not fit a figure.
  figureCharacterBudgets?: number[];
};

export type TranslationResult = {
  text: string;
  model: string;
  promptVersion: string;
  inputTokens: number;
  // Includes the thinking tokens (billed as output).
  outputTokens: number;
  // Gemini: the thinking tokens inside outputTokens, and the thinking level that was sent ("default": none). Not reported by other engines.
  thoughtTokens?: number;
  thinking?: string;
};

export interface TranslationEngine {
  readonly id: EngineId;
  readonly model: string;
  // Gemini engines: the GEMINI_TRANSLATION_THINKING setting the engine was made with (shown in the model comparison).
  readonly thinkingSetting?: ThinkingSetting;
  translate(req: TranslationRequest): Promise<TranslationResult>;
}

export const SEVERITIES = ["low", "medium", "high"] as const;
export type Severity = (typeof SEVERITIES)[number];

// Divergence in meaning between two translations of one source sentence.
// Category: meaning changes claims, negation, numbers, degree, terminology or scope. tone turns hedges (〜かも, I think, peut-être, 也许) into assertions, or vice versa.
export const DIVERGENCE_CATEGORIES = ["meaning", "tone"] as const;
export type DivergenceCategory = (typeof DIVERGENCE_CATEGORIES)[number];

export type Divergence = {
  // Zero-based source sentence index, matching segments.idx; sentence id is s-<sentence>.
  sentence: number;
  severity: Severity;
  note: string;
  category: DivergenceCategory;
};

export type JudgeRequest = {
  signal?: AbortSignal;
  // Source sentences from segmentSentences; array indices are their numbers.
  segments: string[];
  from: Lang;
  // Language of both translations, produced by different engines for the same target.
  to: Lang;
  translationA: string;
  translationB: string;
};

export type JudgeResult = {
  divergences: Divergence[];
  model: string;
  promptVersion: string;
  inputTokens: number;
  outputTokens: number;
};

export interface DivergenceJudge {
  readonly id: EngineId;
  readonly model: string;
  judge(req: JudgeRequest): Promise<JudgeResult>;
}

// Embeddings for semantic search: document and query use one model and equal-dimensional vectors.
// task selects document/query treatment when supported: Gemini RETRIEVAL_DOCUMENT/RETRIEVAL_QUERY. Fake does not distinguish them.
export type EmbedTask = "document" | "query";

export type EmbedRequest = {
  signal?: AbortSignal;
  text: string;
  task: EmbedTask;
  // Document title (topic title), supplied to the model only for task=document.
  title?: string;
};

export type EmbedResult = {
  // L2-normalized vector of length dim.
  vector: number[];
  model: string;
  inputTokens: number;
};

export interface EmbeddingEngine {
  readonly id: "gemini" | "fake";
  readonly model: string;
  // Output dimensions; must equal entry_embeddings.dim before storage.
  readonly dim: number;
  embed(req: EmbedRequest): Promise<EmbedResult>;
}
