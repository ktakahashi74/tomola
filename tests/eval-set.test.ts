import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { FinishReason } from "@google/genai";
import { and, eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { glossaryEntries, translationEvalPoints, translationEvalRuns, translationEvalTexts } from "~/lib/db/schema";
import { parseEvalSet, type EvalSet } from "~/lib/eval/cases.server";
import { deterministicCheck } from "~/lib/eval/checks.server";
import { runEvalCli } from "~/lib/eval/cli.server";
import { createEvalJudge, EVAL_JUDGE_SYSTEM, evalJudgeSystem, evalJudgeSettings, parseEvalJudgment } from "~/lib/eval/judge.server";
import { evaluationHistory } from "~/lib/eval/metrics.server";
import { estimateEvaluation, runEvaluation } from "~/lib/eval/run.server";
import { createFakeEngine } from "~/lib/llm/engines/fake.server";
import type { TranslationRequest } from "~/lib/llm/types";
import type { JudgeInput } from "~/lib/eval/judge.server";
import { LlmError } from "~/lib/llm/errors.server";
import { createTestDb } from "./helpers/db";
import { leakedReasoning } from "./helpers/translation-leak";

const source = fs.readFileSync(new URL("../eval/translation/cases.yaml", import.meta.url), "utf8");
const set = parseEvalSet(source);
const env = { TRANSLATION_PRIMARY: "fake", EVAL_JUDGE_PROVIDER: "fake" };
const subset = (): EvalSet => ({ ...set, cases: [set.cases[0], set.cases[30]].map(c => ({ ...c, to: ["en"] })) });

describe("translation evaluation", () => {
  it.each([false, true])("retains recovered leaks in evaluation flags alongside final checks, with structure mismatch=%s", async mismatch => {
    const db = await createTestDb();
    const item = set.cases.find(c => c.id === "E23")!;
    const text = mismatch ? "```\nadded code\n```" : "Une traduction correcte.";
    const baseJudge = createEvalJudge(env);
    const judge = { ...baseJudge, judge: vi.fn(baseJudge.judge) };
    const result = { text, model: "fake-1", promptVersion: "test", inputTokens: 10, outputTokens: 20 };
    const translator = { ...createFakeEngine(), translate: vi.fn()
      .mockResolvedValueOnce({ ...result, text: leakedReasoning })
      .mockResolvedValueOnce(result) };
    const out = await runEvaluation(db, { ...set, cases: [{ ...item, to: ["fr"] }] }, env, { translator, judge });
    expect(out).toMatchObject({ status: "completed", calls: 3 });
    expect(translator.translate).toHaveBeenCalledTimes(2);
    expect(judge.judge).toHaveBeenCalledTimes(1);
    expect(judge.judge).toHaveBeenCalledWith(expect.objectContaining({ translation: text }));
    expect(await db.select().from(translationEvalTexts)).toMatchObject([{ caseId: "E23", translation: text,
      flags: mismatch ? ["structure_mismatch", "quality_mismatch", "output_leak_retried"] : ["output_leak_retried"], error: null }]);
  });

  it("flags persistent output leaks, retains charged usage, and skips judging rejected text", async () => {
    const db = await createTestDb();
    const item = set.cases.find(c => c.id === "E23")!;
    const judge = { ...createEvalJudge(env), judge: vi.fn() };
    const translator = { ...createFakeEngine(), translate: vi.fn(async () => ({ text: leakedReasoning, model: "fake-1", promptVersion: "test", inputTokens: 10, outputTokens: 20 })) };
    const out = await runEvaluation(db, { ...set, cases: [{ ...item, to: ["fr"] }] }, env, { translator, judge });
    expect(out).toMatchObject({ status: "failed", calls: 2, inputTokens: 20, outputTokens: 40 });
    expect(judge.judge).not.toHaveBeenCalled();
    expect(await db.select().from(translationEvalTexts)).toMatchObject([{ caseId: "E23", translation: null, flags: ["output_leak"], error: "output_leak" }]);
    expect((await db.select().from(translationEvalPoints)).every(point => !point.preserved)).toBe(true);
  });

  it("loads all 40 examples and preserves the published E29 paragraph", () => {
    expect(set.cases.map(c => c.id)).toEqual(Array.from({ length: 40 }, (_, i) => `E${String(i + 1).padStart(2, "0")}`));
    const e29 = set.cases.find(c => c.id === "E29")!;
    expect(fs.readFileSync("app/content/why/ja.md", "utf8").split("\n\n")).toContain(e29.text);
    expect(set.cases.flatMap(c => c.checks).filter(c => c.kind !== "semantic").length).toBeGreaterThan(5);
    const bad = structuredClone(set); bad.cases.push(bad.cases[0]);
    expect(() => parseEvalSet(JSON.stringify(bad))).toThrow();
  });

  it("keeps local provenance paths readable while allowing published passages without a local file", () => {
    for (const item of set.cases) {
      if (item.source.kind === "published" && item.source.path) {
        expect(fs.existsSync(item.source.path), `${item.id}: ${item.source.path}`).toBe(true);
      }
    }
    const published = set.cases.find(c => c.source.kind === "published")!;
    const withoutPath = structuredClone(published);
    if (withoutPath.source.kind === "published") delete withoutPath.source.path;
    expect(() => parseEvalSet(JSON.stringify({ ...set, cases: [withoutPath] }))).not.toThrow();
  });

  it("estimates calls and costs without keys, constructing engines or opening the database", async () => {
    const openDb = vi.fn(() => { throw new Error("DB must not open"); });
    const log = vi.fn();
    expect(await runEvalCli(["--estimate"], { env: { TRANSLATION_PRIMARY: "gemini", EVAL_JUDGE_PROVIDER: "claude" }, read: async () => source, openDb, log })).toBe(0);
    const out = JSON.parse(log.mock.calls[0][0]);
    expect(out.calls.translation).toBe(109);
    expect(out.calls.judge).toBeLessThan(out.calls.translation);
    expect(out.calls.maximumWithStructureRetries).toBe(out.calls.translation * 2 + out.calls.judge);
    expect(out.estimatedCostUsd.withoutRetries).toBeGreaterThan(0);
    expect(openDb).not.toHaveBeenCalled();
    await expect(runEvalCli([], { env: { TRANSLATION_PRIMARY: "gemini", EVAL_JUDGE_PROVIDER: "fake" }, read: async () => source, openDb, log })).rejects.toThrow("explicit approval");
    expect(openDb).not.toHaveBeenCalled();
    expect(estimateEvaluation(set, env).estimatedCostUsd.withoutRetries).toBe(0);
  });

  it("prints actionable CLI failure reasons before opening a database or making calls", () => {
    for (const [settings, reason] of [
      [{ TRANSLATION_PRIMARY: "gemini", EVAL_JUDGE_PROVIDER: "fake" }, "Real API calls require explicit approval"],
      [{ TRANSLATION_PRIMARY: "fake", EVAL_JUDGE_PROVIDER: "claude", EVAL_JUDGE_MODEL: "gemini-wrong" }, "EVAL_JUDGE_MODEL does not match"],
    ] as const) {
      const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/eval-translate.ts"], { encoding: "utf8", timeout: 15_000,
        env: { ...process.env, GEMINI_API_KEY: "", ANTHROPIC_API_KEY: "", DATABASE_URL: "postgres://invalid.invalid/no-database", ...settings },
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(reason);
      expect(result.stderr).not.toContain("invalid.invalid");
    }
  });

  it("compares settings without loading stored glossary snapshots", async () => {
    const queries: string[] = [];
    const db = await createTestDb({ logger: { logQuery(query) { queries.push(query); } } });
    const first = await runEvaluation(db, subset(), env);
    const second = await runEvaluation(db, subset(), env);
    queries.length = 0;
    expect((await evaluationHistory(db))[0].configurationChanged).toBe(false);
    const historyQuery = queries.find(query => query.includes('from "translation_eval_runs"'))!;
    expect(historyQuery).toBeDefined();
    expect(historyQuery).not.toMatch(/"glossary"|select \*/);
    const [run] = await db.select().from(translationEvalRuns).where(eq(translationEvalRuns.id, second.id));
    const changes = [
      { translator: { ...run.translator, model: "another-model" } },
      { translator: { ...run.translator, promptVersion: "another-prompt" } },
      { judge: { ...run.judge, model: "another-judge" } },
    ];
    for (const change of changes) {
      await db.update(translationEvalRuns).set({ translator: run.translator, judge: run.judge, ...change }).where(eq(translationEvalRuns.id, second.id));
      expect((await evaluationHistory(db))[0]).toMatchObject({ previousId: first.id, configurationChanged: true });
    }
  });

  it("configures the judge independently, omitting translator metadata from its request", async () => {
    const inputs: unknown[] = [];
    const judge = createEvalJudge({ TRANSLATION_PRIMARY: "claude", EVAL_JUDGE_PROVIDER: "gemini", EVAL_JUDGE_MODEL: "gemini-test", EVAL_JUDGE_THINKING: "low" }, { geminiClient: { models: { async generateContent(req) {
      inputs.push(req);
      return { text: JSON.stringify({ results: [{ id: "C1", preserved: false, severe: true, reason: "Negation reversed" }] }), candidates: [{ finishReason: FinishReason.STOP }], usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 10 } };
    } } } });
    const result = await judge.judge({ source: "No", translation: "Yes", checks: [{ id: "C1", description: "Preserve negation" }] });
    expect(result.results[0].severe).toBe(true);
    expect(JSON.stringify(inputs)).not.toContain("claude");
    expect(inputs).toHaveLength(1);
    expect(evalJudgeSettings({ TRANSLATION_PRIMARY: "gemini" }).provider).toBe("gemini");
    expect(() => evalJudgeSettings({ EVAL_JUDGE_PROVIDER: "gemini", EVAL_JUDGE_MODEL: "claude-test" })).toThrow();
    expect(() => createEvalJudge({ EVAL_JUDGE_PROVIDER: "claude" })).toThrow("ANTHROPIC_API_KEY");
    expect(() => createEvalJudge({ EVAL_JUDGE_PROVIDER: "gemini" })).toThrow("GEMINI_API_KEY");
    for (const bad of ["{}", '{"results":[]}', '{"results":[{"id":"C1","preserved":true,"severe":true,"reason":"x"}]}']) expect(() => parseEvalJudgment(bad, ["C1"])).toThrow();
  });

  it("evaluates a titled essay and response using the generated original's terms in both translator and judge", async () => {
    const db = await createTestDb();
    const pair: EvalSet = { ...set, cases: set.cases.slice(-2) };
    const requests: TranslationRequest[] = [], judgments: JudgeInput[] = [];
    const fake = createFakeEngine(), judge = createEvalJudge(env);
    expect(await runEvaluation(db, pair, env, {
      translator: { ...fake, async translate(req) { requests.push(req); return fake.translate(req); } },
      judge: { ...judge, async judge(req) { judgments.push(req); return judge.judge(req); } },
    })).toMatchObject({ status: "completed", calls: 6, costUsdMicro: 0 });
    expect(requests.map(r => r.field)).toEqual(["body", "title", "body", "title"]);
    expect(requests[1].titleBodyContext).toContain("[en]");
    expect(requests[2].terminology?.response?.title).toEqual({ source: pair.cases[0].title, translation: `[en] ${pair.cases[0].title}` });
    expect(requests[2].terminology?.response?.author.join()).toContain("Lantern Triad");
    expect(judgments[1].responseTerminology).toEqual(requests[2].terminology?.response);
    const rows = await db.select().from(translationEvalTexts);
    expect(rows.every(r => r.source.includes("Title:") && r.translation?.includes("Title:"))).toBe(true);
    const invalid = { ...pair, cases: [...pair.cases].reverse() };
    expect(() => parseEvalSet(JSON.stringify(invalid))).toThrow("Response reference must precede");
  });

  it("adds judge instructions only when the request includes response terminology", async () => {
    const requests: Array<{ model: string; config?: { systemInstruction?: unknown } }> = [];
    const judge = createEvalJudge({ EVAL_JUDGE_PROVIDER: "gemini" }, { geminiClient: { models: { async generateContent(req) {
      requests.push(req);
      return { text: JSON.stringify({ results: [{ id: "C1", preserved: true, severe: false, reason: "Preserved" }] }), candidates: [{ finishReason: FinishReason.STOP }] };
    } } } });
    const input = { source: "三重の灯", translation: "Lantern Triad", checks: [{ id: "C1", description: "Keep the term" }] };
    const responseTerminology = { author: ["Lantern Triad"], passages: [] };
    await judge.judge(input);
    await judge.judge({ ...input, responseTerminology });
    await judge.judge(input);
    expect(requests.map(r => r.config?.systemInstruction)).toEqual([EVAL_JUDGE_SYSTEM, evalJudgeSystem(responseTerminology), EVAL_JUDGE_SYSTEM]);
    expect(requests.map(r => r.model)).toEqual(["gemini-3.6-flash", "gemini-3.6-flash", "gemini-3.6-flash"]);
    expect(requests[1].config?.systemInstruction).not.toBe(EVAL_JUDGE_SYSTEM);
  });

  it("runs all fake translations through checks, stores text and points, and aggregates history", async () => {
    const db = await createTestDb();
    const first = await runEvaluation(db, set, env);
    expect(first).toMatchObject({ status: "completed", costUsdMicro: 0 });
    const texts = await db.select().from(translationEvalTexts);
    expect(texts).toHaveLength(107);
    expect(texts.every(t => t.translation?.includes(`[${t.to}] `))).toBe(true);
    expect(texts.every(t => !t.flags.includes("output_leak_retried"))).toBe(true);
    const points = await db.select().from(translationEvalPoints);
    expect(points).toHaveLength(set.cases.reduce((n, c) => n + c.to.length * c.checks.length, 0));
    expect(points.every(p => p.preserved)).toBe(true);
    const [run] = await db.select().from(translationEvalRuns);
    expect(run).toMatchObject({ sameProvider: true, translator: { provider: "fake", promptVersion: "translate-v13" }, judge: { provider: "fake" }, calls: first.calls });
    const second = await runEvaluation(db, set, env);
    await db.update(translationEvalPoints).set({ preserved: false, severe: true }).where(and(eq(translationEvalPoints.runId, second.id), eq(translationEvalPoints.caseId, "E01"), eq(translationEvalPoints.to, "en")));
    const [latest] = await evaluationHistory(db);
    expect(latest).toMatchObject({ sameProvider: true, fake: true, previousId: first.id });
    expect(latest.pairs.find(p => p.label === "ja → en")?.delta).toBeLessThan(0);
    expect(latest.categories.find(p => p.label === "rights")?.severeDelta).toBe(set.cases.find(c => c.id === "E01")!.checks.length);
  });

  it("meters retry calls and failed judgments, retains failed texts, and never reports an incomplete run as passing", async () => {
    const db = await createTestDb();
    const fake = createFakeEngine();
    let calls = 0;
    const out = await runEvaluation(db, subset(), env, {
      translator: { ...fake, async translate(req) { calls++; return fake.translate({ ...req, text: calls === 1 ? "```js\nchanged\n```" : req.text }); } },
      judge: { ...createEvalJudge(env), async judge() { throw new LlmError("invalid_output", "bad JSON", { inputTokens: 12, outputTokens: 7 }); } },
    });
    expect(out.status).toBe("failed");
    expect(out.calls).toBe(calls + 1);
    const texts = await db.select().from(translationEvalTexts);
    expect(texts.find(t => t.caseId === "E01")).toMatchObject({ error: "invalid_output" });
    expect(texts.every(t => !t.flags.includes("output_leak_retried"))).toBe(true);
    expect(texts.every(t => t.translation !== null)).toBe(true);
    const [history] = await evaluationHistory(db);
    expect(history.pairs.every(p => p.rate === null && p.delta === null)).toBe(true);
  });

  it("uses the production glossary while retaining only public glossary content and supports a different judge provider", async () => {
    const db = await createTestDb();
    await db.insert(glossaryEntries).values({ term: "運営者", lang: "ja", targetLang: "en", candidates: ["operator"], note: "Use the site role." });
    const requests: unknown[] = [];
    const fake = createFakeEngine();
    const mixed = { TRANSLATION_PRIMARY: "fake", EVAL_JUDGE_PROVIDER: "gemini", EVAL_JUDGE_MODEL: "gemini-test" };
    const judge = { provider: "gemini" as const, model: "gemini-test", thinking: "off", async judge(input: { source: string; translation: string; checks: Array<{ id: string; description: string }> }) {
      return { results: input.checks.map(c => ({ id: c.id, preserved: true, severe: false, reason: "Mock judgment" })), inputTokens: 10, outputTokens: 5 };
    } };
    const out = await runEvaluation(db, subset(), mixed, { translator: { ...fake, async translate(req) { requests.push(req); return fake.translate(req); } }, judge });
    expect(out.status).toBe("completed");
    expect(requests[0]).toMatchObject({ glossary: [{ term: "運営者", candidates: ["operator"] }] });
    const [run] = await db.select().from(translationEvalRuns);
    expect(run.sameProvider).toBe(false);
    expect(run.glossaryVersion).not.toBeNull();
    expect(run.glossary).toEqual([{ term: "運営者", lang: "ja", targetLang: "en", candidates: ["operator"], note: "Use the site role.", keepOriginal: false }]);
  });
});

describe("deterministic evaluation points", () => {
  it.each([
    ["mentions", "@kim", "@kimm", false], ["urls", "[x](https://example.org/a#one)", "[x](https://example.org/a#two)", false],
    ["urls", "https://example.org/a", "", false], ["code", "Use `x=2`", "Use `x=3`", false],
    ["math", "$x \\times 2$", "$x \\times 3$", false], ["markdown", "**only this**", "only this", false],
    ["numbers", "2027年1月から2倍", "Twice from January 2027", true], ["numbers", "3割ほど（47件中14件）", "about 30% (14 out of 47)", true],
    ["numbers", "2027年1月から2倍", "从二〇二七年一月开始翻倍", true],
    ["numbers", "3割ほど（47件中14件）", "约三成（全四十七件中十四件）", true],
    ["numbers", "3割ほど（47件中14件）", "environ 30 pour cent (quatorze sur quarante-sept)", true],
    ["numbers", "47件中14件", "15 out of 47", false],
    ["numbers", "2027年1月から2倍", "Les tarifs vont doubler à partir de janvier 2027.", true],
    ["numbers", "2倍", "Les tarifs ont doublé.", true],
    ["numbers", "2倍", "Les valeurs sont doublées.", true],
    ["numbers", "2倍", "Les tarifs doubleront.", true],
    ["numbers", "3倍", "Les tarifs vont tripler.", true],
    ["numbers", "4倍", "Les tarifs quadrupleraient.", true],
    ["numbers", "2倍", "deux fois", true],
    ["numbers", "3倍", "trois fois", true],
    ["numbers", "4倍", "quatre fois", true],
    ["numbers", "2倍", "doubled", true],
    ["numbers", "3倍", "tripling", true],
    ["numbers", "4倍", "quadrupled", true],
    ["numbers", "3倍", "three times", true],
    ["numbers", "3倍", "threefold", true],
    ["numbers", "3倍", "thrice", true],
    ["numbers", "4倍", "four times", true],
    ["numbers", "2倍", "从现在开始翻倍", true],
    ["numbers", "3倍", "现在是三倍", true],
    ["numbers", "4倍", "四倍", true],
    ["numbers", "2倍", "從現在開始翻一番", true],
    ["numbers", "3倍", "現在是三倍", true],
    ["numbers", "4倍", "翻兩番", true],
    ["numbers", "2027年1月から2倍", "2027년 1월부터 두 배로", true],
    ["numbers", "3倍", "세 배", true],
    ["numbers", "4倍", "네배로", true],
    ["numbers", "2倍", "이 배", true],
    ["numbers", "3倍", "삼 배", true],
    ["numbers", "4倍", "사 배", true],
    ["numbers", "2倍", "triple", false],
    ["numbers", "2倍", "tripler", false],
    ["numbers", "2倍", "三倍", false],
    ["numbers", "3倍", "翻倍", false],
    ["numbers", "2倍", "세 배", false],
    ["numbers", "3倍", "두 배", false],
    ["numbers", "2倍", "redoubler", false],
    ["numbers", "2倍", "doublement", true],
    ["numbers", "2倍", "열두 배", false],
    ["numbers", "2倍", "undoubled", false],
  ] as const)("checks %s without the judge", async (kind, source, translation, preserved) => {
    await expect(deterministicCheck({ id: "C1", kind, description: "Check" }, source, translation, true)).resolves.toMatchObject({ preserved, severe: !preserved });
  });
});
