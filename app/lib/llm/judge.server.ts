import { z } from "zod";
import { claudeComplete, createClaudeClient, DEFAULT_CLAUDE_MODEL, type ClaudeClient } from "./engines/claude.server";
import { createGeminiClient, DEFAULT_JUDGE_GEMINI_MODEL, geminiComplete, type GeminiClient } from "./engines/gemini.server";
import { LlmError } from "./errors.server";
import { buildJudgePrompt, JUDGE_PROMPT_VERSION } from "./prompt.server";
import { DEFAULT_TRANSLATION_THINKING, JUDGE_THINKING_ENV, type ThinkingSetting } from "./thinking";
import { DIVERGENCE_CATEGORIES, SEVERITIES, type Divergence, type DivergenceCategory, type DivergenceJudge, type JudgeRequest, type JudgeResult } from "./types";

// Validate judge JSON: sentence index, severity, category (meaning/tone; absent or unknown defaults to meaning), short note.
export const judgeOutputSchema = z.object({
  divergences: z
    .array(
      z.object({
        sentence: z.number().int().min(0),
        severity: z.enum(SEVERITIES),
        category: z.unknown().optional(),
        note: z
          .string()
          .transform((s) => s.trim().slice(0, 300))
          .pipe(z.string().min(1)),
      }),
    )
    .max(500),
});

// Extract response JSON even when the model adds a ```json fence or preamble.
export function parseJudgeJson(raw: string): unknown {
  const text = raw.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(text);
  const candidate = fenced ? fenced[1] : text;
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(candidate.slice(start, end + 1));
    throw new SyntaxError("no JSON object found");
  }
}

// Validate output, discard out-of-range indices, keep the greater severity for duplicates, and return in sentence-index order.
export function parseJudgeOutput(raw: string, segmentCount: number, usage: { inputTokens: number; outputTokens: number }): Divergence[] {
  let json: unknown;
  try {
    json = parseJudgeJson(raw);
  } catch {
    throw new LlmError("invalid_output", "Judge output is not valid JSON", usage);
  }
  const parsed = judgeOutputSchema.safeParse(json);
  if (!parsed.success) throw new LlmError("invalid_output", `Judge output does not match the schema: ${parsed.error.issues[0]?.message ?? "invalid"}`, usage);
  const rank = { low: 0, medium: 1, high: 2 } as const;
  const bySentence = new Map<number, Divergence>();
  for (const d of parsed.data.divergences) {
    if (d.sentence >= segmentCount) continue;
    const prev = bySentence.get(d.sentence);
    // Missing or unknown category defaults to meaning.
    const category: DivergenceCategory = (DIVERGENCE_CATEGORIES as readonly unknown[]).includes(d.category) ? (d.category as DivergenceCategory) : "meaning";
    if (!prev || rank[d.severity] > rank[prev.severity]) bySentence.set(d.sentence, { sentence: d.sentence, severity: d.severity, category, note: d.note });
  }
  return [...bySentence.values()].sort((a, b) => a.sentence - b.sentence);
}

// Judge output-token limit, with extra allowance because Gemini counts thinking tokens against output limits.
export function judgeTokenLimit(segmentCount: number, headroom = 0): number {
  return Math.min(16_000, Math.max(1024, segmentCount * 100 + 512) + headroom);
}

export function createClaudeJudge(opts: { apiKey?: string; model?: string; client?: ClaudeClient }): DivergenceJudge {
  const model = opts.model ?? DEFAULT_CLAUDE_MODEL;
  let client = opts.client;
  return {
    id: "claude",
    model,
    async judge(req: JudgeRequest): Promise<JudgeResult> {
      if (!client) {
        if (!opts.apiKey) throw new LlmError("config", "ANTHROPIC_API_KEY is not set");
        client = createClaudeClient(opts.apiKey);
      }
      const { system, user } = buildJudgePrompt(req);
      const out = await claudeComplete(client, { model, system, user, maxTokens: judgeTokenLimit(req.segments.length), signal: req.signal });
      const usage = { inputTokens: out.inputTokens, outputTokens: out.outputTokens };
      return { divergences: parseJudgeOutput(out.text, req.segments.length, usage), model, promptVersion: JUDGE_PROMPT_VERSION, ...usage };
    },
  };
}

// Judge without an Anthropic key: a Gemini model different from the primary.
export function createGeminiJudge(opts: { apiKey?: string; model?: string; client?: GeminiClient; thinking?: ThinkingSetting }): DivergenceJudge {
  const model = opts.model ?? DEFAULT_JUDGE_GEMINI_MODEL;
  // DIVERGENCE_JUDGE_THINKING (default off: the lowest level the model accepts, like the translation engines)
  const thinking = opts.thinking ?? DEFAULT_TRANSLATION_THINKING;
  let client = opts.client;
  return {
    id: "gemini",
    model,
    async judge(req: JudgeRequest): Promise<JudgeResult> {
      if (!client) {
        if (!opts.apiKey) throw new LlmError("config", "GEMINI_API_KEY is not set");
        client = createGeminiClient(opts.apiKey);
      }
      const { system, user } = buildJudgePrompt(req);
      const out = await geminiComplete(client, {
        model,
        system,
        user,
        // the limit of the visible output; geminiComplete adds the headroom for the thinking tokens of the level that is sent
        maxOutputTokens: judgeTokenLimit(req.segments.length),
        json: true,
        thinking,
        thinkingEnv: JUDGE_THINKING_ENV,
        signal: req.signal,
      });
      const usage = { inputTokens: out.inputTokens, outputTokens: out.outputTokens };
      return { divergences: parseJudgeOutput(out.text, req.segments.length, usage), model, promptVersion: JUDGE_PROMPT_VERSION, ...usage };
    },
  };
}
