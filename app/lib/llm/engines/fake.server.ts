import { JUDGE_PROMPT_VERSION, promptVersionOf } from "../prompt.server";
import type { Divergence, DivergenceJudge, JudgeRequest, JudgeResult, Severity, TranslationEngine, TranslationRequest, TranslationResult } from "../types";

// Deterministic fake engine for tests and keyless development, without network calls.
// Translation: `[<to>] <source text>`. Estimated tokens: character count divided by four, rounded up.

export const FAKE_MODEL = "fake-1";

const fakeTokens = (s: string) => Math.ceil(s.length / 4);

// Passing model names the fake engine (e.g. TRANSLATION_RETRY_MODEL=fake-retry for report-triggered retranslation). For models other than the default fake-1,
// translation becomes `[<to>/<model>] <source text>` so tests can distinguish a retranslated row from the primary output.
export function createFakeEngine(opts: { model?: string } = {}): TranslationEngine {
  const model = opts.model ?? FAKE_MODEL;
  return {
    id: "fake",
    model,
    async translate(req: TranslationRequest): Promise<TranslationResult> {
      // Browser fixtures can hold the fake engine until a pending result was
      // observed, independent of signal coalescing and machine speed.
      const beforeTranslate = (globalThis as typeof globalThis & { __tomolaFakeBeforeTranslate?: (request: TranslationRequest) => Promise<void> }).__tomolaFakeBeforeTranslate;
      if (beforeTranslate) await beforeTranslate(req);
      const prefix = model === FAKE_MODEL ? `[${req.to}] ` : `[${req.to}/${model}] `;
      const text = req.figure ? JSON.stringify((JSON.parse(req.text) as string[]).map(label => prefix + label)) : prefix + req.text;
      return {
        text,
        model,
        promptVersion: promptVersionOf(req),
        inputTokens: fakeTokens([req.text, req.titleBodyContext, req.terminology ? JSON.stringify(req.terminology) : "", req.title, req.context, req.topicExcerpt, req.report?.excerpt, req.report?.note].join("")),
        outputTokens: fakeTokens(text),
      };
    },
  };
}

// DIVERGE-LOW/MEDIUM/HIGH in the source signals divergence in that sentence. A -TONE suffix (DIVERGE-MEDIUM-TONE) signals a tone difference (category tone),
// a deterministic marker for testing divergence records. Other sentences have no divergence.
export function createFakeJudge(): DivergenceJudge {
  return {
    id: "fake",
    model: FAKE_MODEL,
    async judge(req: JudgeRequest): Promise<JudgeResult> {
      const divergences: Divergence[] = [];
      req.segments.forEach((segment, sentence) => {
        const match = /DIVERGE-(LOW|MEDIUM|HIGH)(-TONE)?/.exec(segment);
        if (match) divergences.push({ sentence, severity: match[1].toLowerCase() as Severity, category: match[2] ? "tone" : "meaning", note: `fake divergence (${match[1]}${match[2] ?? ""})` });
      });
      return {
        divergences,
        model: FAKE_MODEL,
        promptVersion: JUDGE_PROMPT_VERSION,
        inputTokens: fakeTokens(req.segments.join("") + req.translationA + req.translationB),
        outputTokens: fakeTokens(JSON.stringify(divergences)),
      };
    },
  };
}
