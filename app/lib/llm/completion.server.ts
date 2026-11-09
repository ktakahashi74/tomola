import { LlmError } from "./errors.server";
import { claudeComplete, createClaudeClient } from "./engines/claude.server";
import { createGeminiClient, geminiComplete } from "./engines/gemini.server";
import type { EngineDeps } from "./config.server";
import { LANG_NAMES } from "./prompt.server";
import type { EngineId, LlmEnv } from "./types";
import { LANGS, type Lang } from "~/lib/languages";

// Plain instruction/input-to-string completion, not TranslationEngine post translation. Used for interface messages (`pnpm i18n:translate`, app/lib/i18n/translate-messages.server.ts):
// reuses the project's Gemini/Claude LLM layer, refusal/truncation checks and usage accounting while allowing engine (--engine) and model (--model) selection.
// No llm_usage ledger entry: a one-time build cost computed and printed from usage by scripts/i18n-translate.ts.

export type Completion = { text: string; inputTokens: number; outputTokens: number };
export type CompleteRequest = { system: string; user: string; maxOutputTokens: number };

export type JsonCompleter = {
  engine: EngineId;
  model: string;
  complete(req: CompleteRequest): Promise<Completion>;
};

const value = (env: LlmEnv, name: string) => env[name]?.trim() || undefined;

// Default interface-message models: Gemini gemini-3.8-flash, Claude claude-sonnet-5-5 (few messages; prioritize translation quality).
// Override with I18N_MODEL or --model.
export const DEFAULT_I18N_MODELS: Record<EngineId, string> = {
  gemini: "gemini-3.8-flash",
  claude: "claude-sonnet-5-5",
  fake: "fake-i18n",
};

// Fake translations prepend a language marker and native-script characters to satisfy check heuristics. Preserve source {input} and newlines.
const FAKE_PREFIX: Record<Lang, string> = {
  ja: "[ja] ",
  en: "[en] ",
  fr: "[fr] ",
  de: "[de] ",
  vi: "[vi] ",
  ko: "[ko] 번역: ",
  th: "[th] แปล: ",
  "zh-Hans": "[zh-Hans] 译：",
  "zh-Hant": "[zh-Hant] 譯：",
};

// Detect the target from `into <language name>` in the translation prompt so the fake engine can add the language marker.
function localeOfSystem(system: string): Lang | null {
  const match = /from English into ([A-Za-z ]+)\./.exec(system);
  return match ? (LANGS.find((l) => LANG_NAMES[l] === match[1]) ?? null) : null;
}

function fakeComplete(req: CompleteRequest): Completion {
  const locale = localeOfSystem(req.system);
  const items = JSON.parse(req.user) as Record<string, { en: string }>;
  const out = Object.fromEntries(Object.entries(items).map(([key, item]) => [key, `${locale ? FAKE_PREFIX[locale] : "[?] "}${item.en}`]));
  const text = JSON.stringify(out);
  return { text, inputTokens: Math.ceil((req.system.length + req.user.length) / 4), outputTokens: Math.ceil(text.length / 4) };
}

// Build a completion from engine/model. Missing keys throw LlmError(config). Tests inject fake clients through deps.
export function createJsonCompleter(engine: EngineId, model: string, env: LlmEnv, deps: EngineDeps = {}): JsonCompleter {
  switch (engine) {
    case "gemini": {
      const apiKey = value(env, "GEMINI_API_KEY");
      if (!apiKey && !deps.geminiClient) throw new LlmError("config", "GEMINI_API_KEY is not set");
      const client = deps.geminiClient ?? createGeminiClient(apiKey!);
      // Request JSON and LOW thinking to limit thinking-token costs.
      return { engine, model, complete: (req) => geminiComplete(client, { model, system: req.system, user: req.user, maxOutputTokens: req.maxOutputTokens, json: true, thinkingLevel: "LOW" }) };
    }
    case "claude": {
      const apiKey = value(env, "ANTHROPIC_API_KEY");
      if (!apiKey && !deps.claudeClient) throw new LlmError("config", "ANTHROPIC_API_KEY is not set");
      const client = deps.claudeClient ?? createClaudeClient(apiKey!);
      // Claude has no JSON mode: the prompt requests only a JSON object; parseResponse in translate-messages.server.ts also accepts fenced output.
      // claudeRequestShape handles model differences in thinking and output limits.
      return { engine, model, complete: (req) => claudeComplete(client, { model, system: req.system, user: req.user, maxTokens: req.maxOutputTokens }) };
    }
    case "fake":
      return { engine, model, complete: async (req) => fakeComplete(req) };
  }
}
