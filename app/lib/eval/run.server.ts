import { createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Db } from "~/lib/db/client.server";
import { translationEvalPoints, translationEvalRuns, translationEvalTexts } from "~/lib/db/schema";
import { loadAllGlossary } from "~/lib/glossary.server";
import { createEngineForModel, primaryEngineId, primaryModelOf, translationThinking } from "~/lib/llm/config.server";
import { LlmError } from "~/lib/llm/errors.server";
import { costMicro } from "~/lib/llm/pricing.server";
import { buildTranslationPrompt, estimateTokens, PROMPT_VERSION } from "~/lib/llm/prompt.server";
import { translateChecked } from "~/lib/llm/translate.server";
import { FLAG_OUTPUT_LEAK, HIDDEN_PRIMARY_FLAGS } from "~/lib/llm/flags";
import type { GlossaryHint, LlmEnv, TranslationEngine, TranslationRequest } from "~/lib/llm/types";
import { authorTermDeclarations, terminologyPassages, titleBodyContext, type TranslationTerms } from "~/lib/translation-terms";
import { glossaryVersionOf, matchGlossary, type GlossaryRow } from "~/lib/translations.server";
import { evalMentions, type CheckResult, type EvalSet } from "./cases.server";
import { deterministicCheck } from "./checks.server";
import { createEvalJudge, EVAL_JUDGE_PROMPT_VERSION, evalJudgeSystem, evalJudgeSettings, type EvalJudge } from "./judge.server";

export function evaluationSettings(env: LlmEnv) {
  const provider = primaryEngineId(env);
  return { translator: { provider, model: primaryModelOf(env), thinking: provider === "gemini" ? translationThinking(env) : "not-applicable", promptVersion: PROMPT_VERSION }, judge: { ...evalJudgeSettings(env), promptVersion: EVAL_JUDGE_PROMPT_VERSION } };
}
export const evalSetHash = (set: EvalSet) => createHash("sha256").update(JSON.stringify(set)).digest("hex");

function termsForCase(set: EvalSet, item: EvalSet["cases"][number], to: TranslationRequest["to"], completed: Map<string, { body: string; title?: string }>): TranslationTerms | undefined {
  const author = authorTermDeclarations(item.text, to);
  const original = set.cases.find(c => c.id === item.respondsTo);
  const rendered = original && completed.get(`${original.id}:${to}`);
  const response = original ? {
    ...(original.title && rendered?.title ? { title: { source: original.title, translation: rendered.title } } : {}),
    passages: rendered ? terminologyPassages(original.text, rendered.body, item.text) : [], author: authorTermDeclarations(original.text, to),
  } : undefined;
  return author.length || response ? { author, ...(response ? { response } : {}) } : undefined;
}
const textWithTitle = (title: string | undefined, body: string) => title ? `Title: ${title}\n\n${body}` : body;

// No engine/client/database construction. The allowance covers glossary hints;
// output length and thinking are assumptions, not a price quote or hard cap.
export function estimateEvaluation(set: EvalSet, env: LlmEnv) {
  const settings = evaluationSettings(env);
  let translations = 0, judgments = 0, translationCost = 0, judgeCost = 0;
  const assumed = new Map<string, { body: string; title?: string }>();
  for (const item of set.cases) for (const to of item.to) {
    const terminology = termsForCase(set, item, to, assumed);
    const requests: TranslationRequest[] = [{ text: item.text, from: item.from, to, field: "body", mentions: evalMentions(item.text), ...(terminology ? { terminology } : {}) }];
    if (item.title) requests.push({ text: item.title, from: item.from, to, field: "title", titleBodyContext: titleBodyContext(item.text, item.text, item.title), ...(terminology ? { terminology } : {}) });
    for (const request of requests) {
      translations++;
      const prompt = buildTranslationPrompt(request, "0000000000000000");
      const input = estimateTokens(prompt.system + prompt.user) + 2000;
      const output = Math.ceil(estimateTokens(request.text) * 1.5) + (settings.translator.thinking === "default" ? 2500 : settings.translator.thinking === "low" ? 800 : 0);
      translationCost += costMicro(settings.translator.provider, settings.translator.model, input, output, env);
    }
    assumed.set(`${item.id}:${to}`, { body: item.text, title: item.title });
    const checks = item.checks.filter(c => c.kind === "semantic");
    if (!checks.length) continue;
    judgments++;
    const judgeInput = estimateTokens(evalJudgeSystem(terminology?.response) + JSON.stringify({ source: textWithTitle(item.title, item.text), translation: textWithTitle(item.title?.repeat(2), item.text.repeat(2)), checks, responseTerminology: terminology?.response }));
    const judgeOutput = 100 + checks.length * 180 + (settings.judge.thinking === "default" ? 2500 : settings.judge.thinking === "low" ? 800 : 0);
    judgeCost += costMicro(settings.judge.provider, settings.judge.model, judgeInput, judgeOutput, env);
  }
  return { setVersion: set.version, setHash: evalSetHash(set), cases: set.cases.length, ...settings, sameProvider: settings.translator.provider === settings.judge.provider, calls: { translation: translations, judge: judgments, total: translations + judgments, maximumWithStructureRetries: translations * 2 + judgments }, estimatedCostUsd: { withoutRetries: (translationCost + judgeCost) / 1e6, withAllStructureRetries: (translationCost * 2 + judgeCost) / 1e6 }, assumptions: "Approximate tokens; 2,000 glossary input tokens per translation; 1.5x source output length; thinking allowance. Provider prices come from the configured price table. Failures may still incur charges." };
}

export async function runEvaluation(db: Db, set: EvalSet, env: LlmEnv, deps: { translator?: TranslationEngine; judge?: EvalJudge; glossary?: GlossaryRow[]; now?: () => Date } = {}) {
  const settings = evaluationSettings(env);
  const translator = deps.translator ?? createEngineForModel(settings.translator.provider, settings.translator.model, env);
  const judge = deps.judge ?? createEvalJudge(env);
  if (translator.id !== settings.translator.provider || translator.model !== settings.translator.model || judge.provider !== settings.judge.provider || judge.model !== settings.judge.model) throw new Error("Injected engine does not match evaluation settings");
  const glossary = (deps.glossary ?? await loadAllGlossary(db)).map(({ term, lang, targetLang, candidates, note, keepOriginal }) => ({ term, lang, targetLang, candidates, note, keepOriginal }));
  const clock = deps.now ?? (() => new Date());
  const id = randomUUID();
  const totals = { calls: 0, inputTokens: 0, outputTokens: 0, costUsdMicro: 0 };
  const record = (provider: string, model: string, usage: { inputTokens: number; outputTokens: number }) => {
    totals.inputTokens += usage.inputTokens; totals.outputTokens += usage.outputTokens;
    totals.costUsdMicro += costMicro(provider, model, usage.inputTokens, usage.outputTokens, env);
  };
  await db.insert(translationEvalRuns).values({ id, startedAt: clock(), setVersion: set.version, setHash: evalSetHash(set), ...settings, glossaryVersion: glossaryVersionOf(glossary), glossary, sameProvider: translator.id === judge.provider });
  let failed = false;
  const completed = new Map<string, { body: string; title?: string }>();
  try {
    const metered: TranslationEngine = { ...translator, async translate(req) {
      totals.calls++;
      try { const out = await translator.translate(req); record(translator.id, translator.model, out); return out; }
      catch (error) { if (error instanceof LlmError && error.usage) record(translator.id, translator.model, error.usage); throw error; }
    } };
    for (const item of set.cases) for (const to of item.to) {
      let translation: string | null = null, flags: string[] = [], errorCode: string | null = null;
      let results: CheckResult[] = [];
      try {
        const hints: GlossaryHint[] = matchGlossary(glossary.filter(r => r.lang === item.from && r.targetLang === to), item.text);
        const terminology = termsForCase(set, item, to, completed);
        const out = await translateChecked(metered, { text: item.text, from: item.from, to, field: "body", glossary: hints, mentions: evalMentions(item.text), ...(terminology ? { terminology } : {}) });
        translation = out.text; flags = [...out.flags];
        let leakDetections = out.leakDetections;
        let title: string | undefined;
        if (item.title) {
          const result = await translateChecked(metered, { text: item.title, from: item.from, to, field: "title", glossary: matchGlossary(glossary.filter(r => r.lang === item.from && r.targetLang === to), item.title), titleBodyContext: titleBodyContext(item.text, out.text, item.title), ...(terminology ? { terminology } : {}) });
          title = result.text; flags.push(...result.flags); leakDetections += result.leakDetections;
          translation = textWithTitle(title, out.text);
        }
        // Evaluation history also retains leaks fixed by the retry.
        if (leakDetections > 0) flags.push("output_leak_retried");
        if (!flags.some(f => HIDDEN_PRIMARY_FLAGS.includes(f))) completed.set(`${item.id}:${to}`, { body: out.text, title });
        for (const check of item.checks) if (check.kind !== "semantic") results.push(await deterministicCheck(check, item.text, out.text, item.weight === "heavy"));
        const semantic = item.checks.filter(c => c.kind === "semantic").map(({ id, description }) => ({ id, description }));
        if (semantic.length) {
          totals.calls++;
          try { const judgment = await judge.judge({ source: textWithTitle(item.title, item.text), translation, checks: semantic, ...(terminology?.response ? { responseTerminology: terminology.response } : {}) }); record(judge.provider, judge.model, judgment); results.push(...judgment.results); }
          catch (error) { if (error instanceof LlmError && error.usage) record(judge.provider, judge.model, error.usage); throw error; }
        }
      } catch (error) {
        failed = true;
        errorCode = error instanceof LlmError ? error.code : "evaluation_failed";
        if (errorCode === "output_leak") flags = [FLAG_OUTPUT_LEAK];
        // Missing judgments are failures, never silently counted as passes.
        for (const check of item.checks) if (!results.some(r => r.id === check.id)) results.push({ id: check.id, preserved: false, severe: false, reason: `Not assessed: ${errorCode}` });
      }
      await db.transaction(async tx => {
        await tx.insert(translationEvalTexts).values({ runId: id, caseId: item.id, from: item.from, to, category: item.category, source: textWithTitle(item.title, item.text), translation, flags, error: errorCode });
        await tx.insert(translationEvalPoints).values(results.map(({ id: checkId, ...result }) => {
          const check = item.checks.find(c => c.id === checkId)!;
          return { runId: id, caseId: item.id, to, checkId, description: check.description, kind: check.kind, ...result };
        }));
        await tx.update(translationEvalRuns).set(totals).where(eq(translationEvalRuns.id, id));
      });
    }
  } catch (error) {
    await db.update(translationEvalRuns).set({ ...totals, status: "failed", finishedAt: clock() }).where(eq(translationEvalRuns.id, id));
    throw error;
  }
  await db.update(translationEvalRuns).set({ ...totals, status: failed ? "failed" : "completed", finishedAt: clock() }).where(eq(translationEvalRuns.id, id));
  return { id, status: failed ? "failed" : "completed", ...totals };
}
