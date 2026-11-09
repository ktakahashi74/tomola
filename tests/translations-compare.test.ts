import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { llmUsage } from "~/lib/db/schema";
import { runCompareCli, parseCompareArgs, parseCompareDirectory, parseCompareFile, parseCompareInput, type CompareCliIo } from "~/lib/llm/compare-cli.server";
import { blindKey, compareTotals, compareTranslations, estimateCompare, renderCompareMarkdown, type CompareItem } from "~/lib/llm/compare.server";
import type { ClaudeClient, ClaudeMessage } from "~/lib/llm/engines/claude.server";
import { createFakeEngine } from "~/lib/llm/engines/fake.server";
import { LlmError } from "~/lib/llm/errors.server";
import type { EngineId, TranslationEngine, TranslationRequest } from "~/lib/llm/types";
import { createTestDb } from "./helpers/db";

// Translation-model comparison (pnpm translations:compare): fake-engine side-by-side output, blind mode, --dry-run, fake-engine rejection, both input forms, and invalid arguments. No real engines are called
// and no keys are needed. The Claude path uses a fake client to verify request shapes.

const ITEMS: CompareItem[] = [
  { id: "t1", lang: "ja", title: "ソフトの安全", body: "整合性について議論したい。\n\n二段落目|縦線あり。" },
  { id: "t2", lang: "en", body: "A reply that needs the thread.", context: "The post above." },
  { id: "t3", lang: "zh-Hans", title: "软件", body: "这是一个关于网络的帖子。" },
];

const fakeA = () => createFakeEngine({ model: "fake-a" });
const fakeB = () => createFakeEngine({ model: "fake-b" });

// A fake engine omits model names from translations to test that blind output does not leak them; use mark to distinguish the two translations.
function neutral(model: string, mark: string): TranslationEngine {
  return {
    id: "gemini",
    model,
    async translate(req) {
      return { text: `${mark}:${req.to} ${req.text}`, model, promptVersion: "translate-v3", inputTokens: 10, outputTokens: 5 };
    },
  };
}

// A counting engine posing as a real engine requires no keys and counts calls.
function counting(id: EngineId, model: string, calls: TranslationRequest[]): TranslationEngine {
  return {
    id,
    model,
    async translate(req) {
      calls.push(req);
      return { text: `<${model}:${req.to}> ${req.text}`, model, promptVersion: "translate-v3", inputTokens: 100, outputTokens: 50 };
    },
  };
}

function memoryIo(over: Partial<CompareCliIo> & { files?: Record<string, string> } = {}) {
  const files: Record<string, string> = { ...(over.files ?? {}) };
  const out: string[] = [];
  const err: string[] = [];
  const io: CompareCliIo = {
    env: {},
    readFile: (f) => {
      if (!(f in files)) throw new Error(`ENOENT ${f}`);
      return files[f];
    },
    writeFile: (f, text) => void (files[f] = text),
    mkdir: () => undefined,
    stdout: (t) => void out.push(t),
    stderr: (t) => void err.push(t),
    ...over,
  };
  return { io, files, out: () => out.join(""), err: () => err.join("") };
}

describe("thinking tokens in the comparison", () => {
  const thinker = (model: string, thoughts: number): TranslationEngine => ({
    id: "gemini",
    model,
    async translate(req) {
      return { text: `[${req.to}] ${req.text}`, model, promptVersion: "translate-v4", inputTokens: 100, outputTokens: 40 + thoughts, thoughtTokens: thoughts, thinking: thoughts > 0 ? "default" : "MINIMAL" };
    },
  });

  it("counts the thinking tokens per side and in the totals, and shows them in the output that names the models", async () => {
    const out = await compareTranslations({ items: [{ id: "t1", lang: "ja", body: "本文。" }], to: ["en"], engines: [thinker("quiet", 0), thinker("thinker", 900)] });
    const [a, b] = out.entries[0].sides;
    expect(a).toMatchObject({ thoughtTokens: 0, thinking: "MINIMAL", outputTokens: 40 });
    expect(b).toMatchObject({ thoughtTokens: 900, thinking: "default", outputTokens: 940 });
    expect(compareTotals(out)).toMatchObject({ A: { thoughtTokens: 0, outputTokens: 40 }, B: { thoughtTokens: 900, outputTokens: 940 } });
    const text = renderCompareMarkdown(out);
    expect(text).toMatch(/B: gemini \/ thinker, 100 input and 940 output tokens \(900 of them thinking\)/);
    expect(text).not.toMatch(/A: gemini \/ quiet.*thinking\)/);
  });

  it("adds the thinking tokens of a failed call (cut off) that was billed", async () => {
    const cut: TranslationEngine = {
      id: "gemini",
      model: "cut",
      async translate() {
        throw new LlmError("truncated", "cut off", { inputTokens: 100, outputTokens: 2100, thoughtTokens: 2000 });
      },
    };
    const out = await compareTranslations({ items: [{ id: "t1", lang: "ja", body: "本文。" }], to: ["en"], engines: [cut, thinker("ok", 0)] });
    expect(out.entries[0].sides[0]).toMatchObject({ error: "cut off", thoughtTokens: 2000, outputTokens: 2100 });
  });

  it("estimates the thinking of a gemini model that thinks by default only when GEMINI_TRANSLATION_THINKING=default", async () => {
    const items: CompareItem[] = [{ id: "t1", lang: "ja", body: "本文。".repeat(20) }];
    const withSetting = (e: TranslationEngine, thinkingSetting: "off" | "low" | "default"): TranslationEngine => ({ ...e, thinkingSetting });
    const off = estimateCompare({ items, to: ["en"], engines: [withSetting(thinker("gemini-3.5-flash", 0), "off"), withSetting(thinker("gemini-3.1-flash-lite", 0), "off")] });
    const dflt = estimateCompare({ items, to: ["en"], engines: [withSetting(thinker("gemini-3.5-flash", 0), "default"), withSetting(thinker("gemini-3.1-flash-lite", 0), "default")] });
    expect(dflt.per.A.outputTokens - off.per.A.outputTokens).toBeGreaterThan(2000);
    // the -lite model does not think by default
    expect(dflt.per.B.outputTokens).toBe(off.per.B.outputTokens);
    // low adds a smaller allowance, and a bit even to the -lite model (LOW made it think 150 to 300 tokens in the probes)
    const low = estimateCompare({ items, to: ["en"], engines: [withSetting(thinker("gemini-3.5-flash", 0), "low"), withSetting(thinker("gemini-3.1-flash-lite", 0), "low")] });
    expect(low.per.A.outputTokens - off.per.A.outputTokens).toBe(800 * 1);
    expect(low.per.B.outputTokens - off.per.B.outputTokens).toBe(300 * 1);
  });

  it("--thinking gives each model its own setting, so the same Gemini model can be compared with itself", async () => {
    const calls: Array<Record<string, any>> = [];
    const client = {
      models: {
        generateContent: async (params: Record<string, any>) => {
          calls.push(params.config);
          return { text: "x", candidates: [{ finishReason: "STOP" }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 10, thoughtsTokenCount: calls.length === 1 ? 0 : 700 } } as never;
        },
      },
    };
    const m = memoryIo({ env: { GEMINI_API_KEY: "k", TRANSLATION_PRIMARY: "gemini" }, files: { "in.json": JSON.stringify([{ id: "t1", lang: "ja", body: "本文" }]) }, deps: { geminiClient: client } });
    const code = await runCompareCli(["--models", "gemini-3.5-flash,gemini-3.5-flash", "--thinking", "off,default", "--input", "in.json", "--langs", "en", "--no-glossary", "--out", "out", "--results-json", "res.json"], m.io);
    expect(code).toBe(0);
    // A is asked for MINIMAL, B sends no thinkingConfig
    expect(calls.filter((c) => c.thinkingConfig?.thinkingLevel === "MINIMAL")).toHaveLength(1);
    expect(calls.filter((c) => c.thinkingConfig === undefined)).toHaveLength(1);
    const res = JSON.parse(m.files["res.json"]);
    expect(res.models).toEqual({ A: { engine: "gemini", model: "gemini-3.5-flash", thinking: "off" }, B: { engine: "gemini", model: "gemini-3.5-flash", thinking: "default" } });
    expect(res.totals.B.thoughtTokens).toBe(700);
    expect(m.err()).toMatch(/gemini-3\.5-flash \(thinking off\)/);
    expect(m.err()).toMatch(/\(700 of them thinking\)/);
  });

  it("sends the per-call [llm] log lines to stderr, so that stdout carries only the Markdown", async () => {
    const client = { models: { generateContent: async () => ({ text: "x", candidates: [{ finishReason: "STOP" }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3 } }) as never } };
    const m = memoryIo({ env: { GEMINI_API_KEY: "k", TRANSLATION_PRIMARY: "gemini" }, files: { "in.json": JSON.stringify([{ id: "t1", lang: "ja", body: "本文" }]) }, deps: { geminiClient: client } });
    expect(await runCompareCli(["--models", "gemini-3.5-flash,gemini-3.1-flash-lite", "--input", "in.json", "--langs", "en", "--no-glossary"], m.io)).toBe(0);
    expect(m.err()).toMatch(/\[llm\] translate gemini gemini-3\.5-flash GEMINI_TRANSLATION_THINKING=off level=MINIMAL/);
    expect(m.out()).not.toContain("[llm]");
    expect(m.out()).toContain("# Translation comparison");
  });

  it("refuses --results-json and --key-dir inside --out in blind mode (they name the model of every translation)", async () => {
    const files = { "in.json": JSON.stringify([{ id: "t1", lang: "ja", body: "本文" }]) };
    const env = { GEMINI_API_KEY: "k", TRANSLATION_PRIMARY: "gemini" };
    const base = ["--models", "gemini-3.5-flash,gemini-3.1-flash-lite", "--input", "in.json", "--langs", "en", "--no-glossary", "--blind", "--out", "readers"];
    for (const extra of [["--results-json", "readers/results.json"], ["--results-json", "./readers/sub/r.json"], ["--key-dir", "readers"], ["--key-dir", "readers/key"]]) {
      const m = memoryIo({ env, files });
      expect(await runCompareCli([...base, ...extra], m.io), extra.join(" ")).toBe(1);
      expect(m.err()).toMatch(/is inside --out readers: with --blind/);
    }
    // outside --out is fine, also a sibling whose name starts like --out, and without --blind
    for (const args of [[...base, "--results-json", "operator/results.json", "--key-dir", "operator/key"], [...base, "--results-json", "readers-private/results.json"]]) {
      const m = memoryIo({ env, files });
      expect(parseCompareArgs(args)).toMatchObject({ blind: true });
      expect(m.err()).toBe("");
    }
    expect(parseCompareArgs(["--models", "a,b", "--input", "x", "--out", "readers", "--results-json", "readers/results.json"]).resultsJson).toBe("readers/results.json");
  });

  it("still refuses the same model twice with the same setting, and a bad --thinking", async () => {
    const files = { "in.json": JSON.stringify([{ id: "t1", lang: "ja", body: "本文" }]) };
    const env = { GEMINI_API_KEY: "k", TRANSLATION_PRIMARY: "gemini" };
    const same = memoryIo({ env, files });
    expect(await runCompareCli(["--models", "gemini-3.5-flash,gemini-3.5-flash", "--thinking", "low,low", "--input", "in.json", "--langs", "en", "--no-glossary"], same.io)).toBe(1);
    expect(same.err()).toMatch(/the two models must differ/);
    const unset = memoryIo({ env, files });
    expect(await runCompareCli(["--models", "gemini-3.5-flash,gemini-3.5-flash", "--input", "in.json", "--langs", "en", "--no-glossary"], unset.io)).toBe(1);
    const bad = memoryIo({ env, files });
    expect(await runCompareCli(["--models", "a,b", "--thinking", "off,high", "--input", "in.json"], bad.io)).toBe(1);
    expect(bad.err()).toMatch(/--thinking takes two settings/);
    expect(() => parseCompareArgs(["--models", "a,b", "--thinking", "off", "--input", "x"])).toThrow(/--thinking takes two settings/);
    expect(parseCompareArgs(["--models", "a,b", "--thinking", " OFF, Default ", "--input", "x"]).thinking).toEqual(["off", "default"]);
    expect(parseCompareArgs(["--models", "a,b", "--input", "x"]).thinking).toEqual([null, null]);
  });
});

describe("compareTranslations (the shared part)", () => {
  it("translates every text into every language but its own with both models, title and body, with the production prompt path", async () => {
    const out = await compareTranslations({ items: ITEMS, to: ["ja", "en", "fr", "zh-Hant"], engines: [fakeA(), fakeB()] });
    // t1(ja): en fr zh-Hant、t2(en): ja fr zh-Hant、t3(zh-Hans): ja en fr zh-Hant
    expect(out.entries.map((e) => `${e.itemId}:${e.to}`)).toEqual(["t1:en", "t1:fr", "t1:zh-Hant", "t2:ja", "t2:fr", "t2:zh-Hant", "t3:ja", "t3:en", "t3:fr", "t3:zh-Hant"]);
    const first = out.entries[0];
    expect(first.sides.map((s) => [s.slot, s.model, s.title, s.body, s.error])).toEqual([
      ["A", "fake-a", "[en/fake-a] ソフトの安全", "[en/fake-a] 整合性について議論したい。\n\n二段落目|縦線あり。", null],
      ["B", "fake-b", "[en/fake-b] ソフトの安全", "[en/fake-b] 整合性について議論したい。\n\n二段落目|縦線あり。", null],
    ]);
    // An untitled text has no title translation.
    expect(out.entries.find((e) => e.itemId === "t2" && e.to === "ja")!.sides[0].title).toBeNull();
    expect(out.models).toEqual({ A: { engine: "fake", model: "fake-a" }, B: { engine: "fake", model: "fake-b" } });
    expect(out.blind).toBe(false);
    // Simplified-to-Traditional Chinese is also performed as translation.
    expect(out.entries.find((e) => e.itemId === "t3" && e.to === "zh-Hant")!.sides[0].body).toBe("[zh-Hant/fake-a] 这是一个关于网络的帖子。");
    const totals = compareTotals(out);
    expect(totals.A).toMatchObject({ model: "fake-a", failed: 0, flagged: 0 });
    expect(totals.A.calls).toBe(10 * 2 - 3); // Titled texts require two calls, title and body; untitled texts one. Only t2 lacks a title.
  });

  it("passes the title and the context of the text to the body translation, the way the post pipeline does, and the glossary of the pair", async () => {
    const seen: TranslationRequest[] = [];
    await compareTranslations({
      items: [ITEMS[1], ITEMS[0]],
      to: ["fr"],
      engines: [counting("gemini", "m-a", seen), counting("gemini", "m-b", []) ],
      glossary: (from, to, text) => (text.includes("thread") ? [{ term: "thread", candidates: ["fil"] }] : []).concat(from === "ja" && to === "fr" ? [{ term: "整合性", candidates: ["alignement"] }] : []),
    });
    const reply = seen.find((r) => r.text === "A reply that needs the thread.")!;
    expect(reply).toMatchObject({ from: "en", to: "fr", context: "The post above.", glossary: [{ term: "thread", candidates: ["fil"] }] });
    const body = seen.find((r) => r.text.startsWith("整合性"))!;
    expect(body).toMatchObject({ title: "ソフトの安全", glossary: [{ term: "整合性", candidates: ["alignement"] }] });
    // Do not pass context for title translation.
    expect(seen.find((r) => r.text === "ソフトの安全")!.title).toBeUndefined();
  });

  it("records a failure of one model in its side, and goes on", async () => {
    const failing: TranslationEngine = { id: "gemini", model: "bad", translate: async () => { throw new Error("quota exceeded"); } };
    const out = await compareTranslations({ items: [ITEMS[0]], to: ["fr"], engines: [failing, fakeB()] });
    expect(out.entries[0].sides[0]).toMatchObject({ slot: "A", body: null, title: null, error: "quota exceeded" });
    expect(out.entries[0].sides[1]).toMatchObject({ slot: "B", error: null });
    expect(compareTotals(out).A.failed).toBe(1);
    expect(renderCompareMarkdown(out)).toContain("(failed: quota exceeded)");
  });
});

describe("the Markdown output", () => {
  it("puts the original and the two translations side by side in one table row, per language, with the models named when it is not blind", async () => {
    const out = await compareTranslations({ items: ITEMS, to: ["fr", "zh-Hant"], engines: [fakeA(), fakeB()] });
    const fr = renderCompareMarkdown(out, { lang: "fr" });
    expect(fr).toContain("# Translation comparison (fr)");
    expect(fr).toContain("Model A: fake / fake-a. Model B: fake / fake-b.");
    expect(fr).toContain("## t1 · ja → fr");
    expect(fr).toContain("| Original (ja) | A: fake-a | B: fake-b |");
    // Rows: source, translation A, translation B. Titles are bold, newlines use <br>, and vertical bars use \|.
    expect(fr).toContain("| **ソフトの安全**<br><br>整合性について議論したい。<br><br>二段落目\\|縦線あり。 | **[fr/fake-a] ソフトの安全**<br><br>[fr/fake-a] 整合性について議論したい。<br><br>二段落目\\|縦線あり。 | **[fr/fake-b] ソフトの安全**");
    expect(fr).toContain("- A: fake / fake-a, ");
    expect(fr).not.toContain("zh-Hant");
    expect(fr).not.toContain("## t3 · zh-Hans → zh-Hant");
    const all = renderCompareMarkdown(out);
    expect(all).toContain("## t3 · zh-Hans → zh-Hant");
    expect(all.match(/^## /gm)).toHaveLength(out.entries.length);
  });

  it("shows the structure-check marks, and tells when a second attempt was needed", async () => {
    // The text returns untranslated with the untranslated flag, including on the second attempt.
    const copying: TranslationEngine = { id: "gemini", model: "copy", translate: async (req) => ({ text: req.text, model: "copy", promptVersion: "v", inputTokens: 1, outputTokens: 1 }) };
    const out = await compareTranslations({
      items: [{ id: "long", lang: "ja", body: "これは二十文字を超える、訳されずに返ってくる本文です。" }],
      to: ["en"],
      engines: [copying, fakeB()],
    });
    expect(out.entries[0].sides[0]).toMatchObject({ flags: ["untranslated"], retried: true, attempts: 2 });
    expect(renderCompareMarkdown(out)).toContain("- A: check marks: untranslated (after a second attempt)");
  });
});

describe("--blind", () => {
  const many: CompareItem[] = Array.from({ length: 40 }, (_, i) => ({ id: `n${i}`, lang: "ja" as const, body: `文${i}。` }));

  it("swaps the two models per pair at random, the same way for the same seed, and shows neither model names nor costs", async () => {
    const run = (seed: number) => compareTranslations({ items: many, to: ["en", "fr"], engines: [neutral("model-one", "ALPHA"), neutral("model-two", "BETA")], blind: true, seed });
    const a = await run(1);
    const b = await run(1);
    const c = await run(2);
    const order = (o: Awaited<ReturnType<typeof run>>) => o.entries.map((e) => e.sides[0].slot).join("");
    expect(order(a)).toBe(order(b));
    expect(order(a)).not.toBe(order(c));
    // Each ordering occurs roughly half the time.
    const swapped = a.entries.filter((e) => e.swapped).length;
    expect(swapped).toBeGreaterThan(20);
    expect(swapped).toBeLessThan(60);
    expect(a.blind).toBe(true);
    expect(a.seed).toBe(1);
    // The left column actually contains that model's translation.
    for (const e of a.entries) {
      expect(e.sides[0].body).toContain(e.sides[0].slot === "A" ? "ALPHA:" : "BETA:");
      expect(e.swapped).toBe(e.sides[0].slot === "B");
    }
    const md = renderCompareMarkdown(a, { lang: "en" });
    expect(md).toContain("| Original (ja) | Translation 1 | Translation 2 |");
    for (const hidden of ["model-one", "model-two", "Model A", "tokens", "$", "gemini"]) expect(md, hidden).not.toContain(hidden);
    // The key identifies which model belongs to each column.
    const key = blindKey(a);
    expect(key.seed).toBe(1);
    expect(key.models.A.model).toBe("model-one");
    const row = key.entries.find((e) => e.id === "n0" && e.to === "en")!;
    const entry = a.entries.find((e) => e.itemId === "n0" && e.to === "en")!;
    expect(row).toMatchObject({ translation1: entry.sides[0].slot, translation2: entry.sides[1].slot });
    expect(order(await compareTranslations({ items: many, to: ["en", "fr"], engines: [neutral("model-one", "ALPHA"), neutral("model-two", "BETA")] }))).toBe("A".repeat(80));
  });
});

describe("the input file", () => {
  it("reads a JSON array (id, lang, title, body, context), numbering the texts without an id, and --from fills in a missing lang", () => {
    const items = parseCompareInput(JSON.stringify([{ id: "x", lang: "fr", body: "b", title: " T " }, { lang: "ja", body: "b2", context: "c" }, { body: "b3" }]), "en");
    expect(items).toEqual([
      { id: "x", lang: "fr", title: "T", body: "b" },
      { id: "t2", lang: "ja", body: "b2", context: "c" },
      { id: "t3", lang: "en", body: "b3" },
    ]);
  });

  it("reads Markdown whose texts are separated by a line of three hyphens, with an optional first-level heading as the title; --from is needed", () => {
    const items = parseCompareInput("# 題一\n\n本文一。\n\n二段落。\n\n---\n\n本文だけ。\n\n---\n\n", "ja");
    expect(items).toEqual([
      { id: "t1", lang: "ja", title: "題一", body: "本文一。\n\n二段落。" },
      { id: "t2", lang: "ja", body: "本文だけ。" },
    ]);
    expect(() => parseCompareInput("本文", null)).toThrow("--from");
  });

  it("refuses an input with no text, a missing body or lang, a repeated id, or invalid JSON", () => {
    expect(() => parseCompareInput("---\n---", "ja")).toThrow("no text");
    expect(() => parseCompareInput("[]", "ja")).toThrow("no text");
    expect(() => parseCompareInput('[{"lang":"ja"}]', null)).toThrow("body");
    expect(() => parseCompareInput('[{"body":"x"}]', null)).toThrow("lang");
    expect(() => parseCompareInput('[{"id":"a","lang":"ja","body":"x"},{"id":"a","lang":"ja","body":"y"}]', null)).toThrow("used twice");
    expect(() => parseCompareInput("[oops", null)).toThrow("not valid JSON");
  });
});

describe("the command line", () => {
  const input = JSON.stringify(ITEMS);

  it("parses the arguments, with defaults, and refuses mistakes", () => {
    expect(parseCompareArgs(["--models", "a,b", "--input", "f.json"])).toMatchObject({ models: ["a", "b"], input: "f.json", langs: ["ja", "en", "fr", "zh-Hans", "zh-Hant"], out: null, blind: false, seed: 0, dryRun: false, allowFake: false, maxCostUsd: 2 });
    expect(parseCompareArgs(["--models", "a, b", "--input", "f", "--langs", "fr,fr,zh-Hant", "--out", "d", "--blind", "--seed", "7", "--dry-run", "--allow-fake", "--from", "ja", "--max-cost-usd", "0.5"])).toMatchObject({
      models: ["a", "b"], langs: ["fr", "zh-Hant"], out: "d", blind: true, seed: 7, dryRun: true, allowFake: true, from: "ja", maxCostUsd: 0.5,
    });
    for (const bad of [
      ["--input", "f"],
      ["--models", "a,b"],
      ["--models", "a", "--input", "f"],
      ["--models", "a,b,c", "--input", "f"],
      ["--models", "a,", "--input", "f"],
      ["--models", "a,b", "--input", "f", "--langs", "fr,xx"],
      ["--models", "a,b", "--input", "f", "--from", "klingon"],
      ["--models", "a,b", "--input", "f", "--seed", "-1"],
      ["--models", "a,b", "--input", "f", "--max-cost-usd", "0"],
      ["--models", "a,b", "--input", "f", "--blind"],
      ["--models", "a,b", "--input", "f", "--out", ""],
      ["--models", "a,b", "--input", "f", "--wat"],
    ]) expect(() => parseCompareArgs(bad), bad.join(" ")).toThrow();
  });

  it("runs with two fake engines (--allow-fake): a Markdown file per language and results.json in --out, a summary on stderr", async () => {
    const m = memoryIo({ files: { "in.json": input }, engineFor: (_p, model) => createFakeEngine({ model }) });
    const code = await runCompareCli(["--models", "fake:fake-a,fake:fake-b", "--input", "in.json", "--langs", "fr,zh-Hant", "--out", "out", "--allow-fake"], m.io);
    expect(code).toBe(0);
    expect(Object.keys(m.files).sort()).toEqual(["in.json", "out/compare-fr.md", "out/compare-zh-Hant.md", "out/results.json"]);
    expect(m.files["out/compare-fr.md"]).toContain("| Original (ja) | A: fake-a | B: fake-b |");
    expect(m.files["out/compare-zh-Hant.md"]).toContain("## t3 · zh-Hans → zh-Hant");
    const results = JSON.parse(m.files["out/results.json"]);
    expect(results.models.A.model).toBe("fake-a");
    expect(results.totals.B).toMatchObject({ failed: 0, flagged: 0 });
    expect(m.err()).toMatch(/A: fake \/ fake-a: \d+ call\(s\)/);
    expect(m.err()).toMatch(/B: fake \/ fake-b: \d+ call\(s\)/);
    // Fake engines have no cost estimate because they are free.
    expect(m.err()).not.toContain("estimated cost");
  });

  it("writes to stdout without --out", async () => {
    const m = memoryIo({ files: { "in.json": input }, engineFor: (_p, model) => createFakeEngine({ model }) });
    expect(await runCompareCli(["--models", "fake:fake-a,fake:fake-b", "--input", "in.json", "--langs", "fr", "--allow-fake"], m.io)).toBe(0);
    expect(m.out()).toContain("# Translation comparison");
    expect(m.out()).toContain("## t1 · ja → fr");
  });

  it("with --blind writes the key apart from the Markdown files (and no results.json), reproducibly with --seed", async () => {
    const run = async (seed: string) => {
      const m = memoryIo({ files: { "in.json": input }, env: { GEMINI_API_KEY: "k" }, engineFor: (_p, model) => neutral(model, model === "model-one" ? "ALPHA" : "BETA") });
      const code = await runCompareCli(["--models", "model-one,model-two", "--input", "in.json", "--langs", "en,fr,zh-Hant", "--out", "o", "--blind", "--seed", seed], m.io);
      expect(code).toBe(0);
      return m;
    };
    const one = await run("5");
    expect(Object.keys(one.files).sort()).toEqual(["in.json", "o/blind-key.json", "o/compare-en.md", "o/compare-fr.md", "o/compare-zh-Hant.md"]);
    for (const [f, text] of Object.entries(one.files)) if (f.endsWith(".md")) for (const hidden of ["model-one", "model-two"]) expect(text, f).not.toContain(hidden);
    expect(JSON.parse(one.files["o/blind-key.json"]).entries.length).toBeGreaterThan(5);
    const again = await run("5");
    expect(again.files["o/blind-key.json"]).toBe(one.files["o/blind-key.json"]);
    expect(again.files["o/compare-fr.md"]).toBe(one.files["o/compare-fr.md"]);
    expect((await run("6")).files["o/blind-key.json"]).not.toBe(one.files["o/blind-key.json"]);
  });

  it("refuses the fake engine without --allow-fake, before any call", async () => {
    const seen: TranslationRequest[] = [];
    const m = memoryIo({ files: { "in.json": input }, engineFor: (provider, model) => (provider === "fake" ? createFakeEngine({ model }) : counting(provider, model, seen)) });
    expect(await runCompareCli(["--models", "fake:a,fake:b", "--input", "in.json"], m.io)).toBe(1);
    expect(m.err()).toMatch(/fake engine.*--allow-fake/s);
    // Reject even when only one engine is fake.
    expect(await runCompareCli(["--models", "gemini:real,fake:b", "--input", "in.json"], m.io)).toBe(1);
    expect(seen).toHaveLength(0);
    // Without keys, the default is fake, so reject.
    const keyless = memoryIo({ files: { "in.json": input } });
    expect(await runCompareCli(["--models", "m1,m2", "--input", "in.json"], keyless.io)).toBe(1);
    expect(keyless.err()).toContain("fake engine");
  });

  it("--dry-run prints the number of calls and the cost estimate to stderr and calls nothing", async () => {
    const seen: TranslationRequest[] = [];
    const m = memoryIo({ files: { "in.json": input }, env: { GEMINI_API_KEY: "k" }, engineFor: (provider, model) => counting(provider, model, seen) });
    expect(await runCompareCli(["--models", "gemini-3.1-flash-lite,gemini-3.5-flash", "--input", "in.json", "--langs", "fr,zh-Hans", "--dry-run"], m.io)).toBe(0);
    expect(seen).toHaveLength(0);
    expect(m.err()).toMatch(/3 text\(s\), fr, zh-Hans; \d+ call\(s\) at least \(\d+ per model\); estimated cost \$\d+\.\d{4}/);
    expect(m.err()).toContain("gemini-3.1-flash-lite: $");
    expect(m.err()).toContain("--dry-run: nothing was called");
    expect(m.out()).toBe("");
    expect(Object.keys(m.files)).toEqual(["in.json"]);
  });

  it("stops before calling when the estimate is over --max-cost-usd", async () => {
    const seen: TranslationRequest[] = [];
    const m = memoryIo({ files: { "in.json": JSON.stringify([{ lang: "ja", body: "あ".repeat(5000) }]) }, env: { GEMINI_API_KEY: "k", TRANSLATION_PRIMARY: "gemini" }, engineFor: (provider, model) => counting(provider, model, seen) });
    expect(await runCompareCli(["--models", "claude:claude-opus-5-5,claude:claude-opus-5", "--input", "in.json", "--max-cost-usd", "0.0001"], m.io)).toBe(1);
    expect(m.err()).toContain("over --max-cost-usd");
    expect(seen).toHaveLength(0);
  });

  it("calls the real-engine path, prints progress to stderr, and exits 1 when a model failed (with the failure in the output)", async () => {
    const failing: TranslationEngine = { id: "gemini", model: "bad", translate: async () => { throw new Error("boom"); } };
    const m = memoryIo({ files: { "in.json": input }, env: { GEMINI_API_KEY: "k" }, engineFor: (provider, model) => (model === "bad" ? failing : counting(provider, model, [])) });
    expect(await runCompareCli(["--models", "good,bad", "--input", "in.json", "--langs", "fr"], m.io)).toBe(1);
    expect(m.err()).toContain("translations:compare: 3/3");
    expect(m.err()).toMatch(/B: gemini \/ bad: .*3 failed/);
    expect(m.out()).toContain("(failed: boom)");
  });

  it("refuses two identical models, a model of another provider than the primary, and a missing input file; the usage is printed", async () => {
    const m = memoryIo({ files: { "in.json": input }, env: { GEMINI_API_KEY: "k" } });
    expect(await runCompareCli(["--models", "gemini-3.5-flash,gemini-3.5-flash", "--input", "in.json"], m.io)).toBe(1);
    expect(m.err()).toContain("must differ");
    const other = memoryIo({ files: { "in.json": input }, env: { GEMINI_API_KEY: "k", ANTHROPIC_API_KEY: "a" } });
    expect(await runCompareCli(["--models", "gemini-3.5-flash,claude-sonnet-5-5", "--input", "in.json"], other.io)).toBe(1);
    // Before calling a provider-mismatched model name, stop with instructions to align TRANSLATION_PRIMARY or add a <provider>: prefix.
    expect(other.err()).toContain('"claude-sonnet-5-5" is a claude model, but the provider here is gemini');
    expect(other.err()).toContain("Set TRANSLATION_PRIMARY=claude");
    expect(other.err()).toContain("claude:claude-sonnet-5-5");
    const primaryClaude = memoryIo({ files: { "in.json": input }, env: { TRANSLATION_PRIMARY: "claude", ANTHROPIC_API_KEY: "a" } });
    expect(await runCompareCli(["--models", "claude-haiku-4-5,gemini-3.5-flash", "--input", "in.json"], primaryClaude.io)).toBe(1);
    expect(primaryClaude.err()).toContain('"gemini-3.5-flash" is a gemini model, but the provider here is claude');
    // An explicit provider permits mixed-provider combinations and requires keys.
    const named = memoryIo({ files: { "in.json": input }, env: { GEMINI_API_KEY: "k", ANTHROPIC_API_KEY: "a" }, engineFor: (provider, model) => counting(provider, model, []) });
    expect(await runCompareCli(["--models", "gemini-3.5-flash,claude:claude-sonnet-5-5", "--input", "in.json", "--langs", "fr", "--no-glossary"], named.io)).toBe(0);
    const noFile = memoryIo({ env: { GEMINI_API_KEY: "k" } });
    await expect(runCompareCli(["--models", "a,b", "--input", "missing.json"], noFile.io)).rejects.toThrow("ENOENT");
    const usage = memoryIo();
    expect(await runCompareCli(["--models", "a"], usage.io)).toBe(1);
    expect(usage.err()).toContain("usage: pnpm translations:compare");
  });
});

describe("the Claude path with a fake client (request shapes; no key and no network)", () => {
  function claudeStub() {
    const create = vi.fn(async (_body: unknown, _options?: unknown) => ({ content: [{ type: "text", text: "TRAD", citations: null }], stop_reason: "end_turn", usage: { input_tokens: 20, output_tokens: 10 } }) as unknown as ClaudeMessage);
    return { client: { messages: { create } } satisfies ClaudeClient, create };
  }

  it("compares two Claude models without sampling overrides and prices them from the table", async () => {
    const stub = claudeStub();
    const m = memoryIo({ files: { "in.json": JSON.stringify([{ lang: "ja", body: "こんにちは世界。" }]) }, env: { TRANSLATION_PRIMARY: "claude", ANTHROPIC_API_KEY: "a" }, deps: { claudeClient: stub.client } });
    const code = await runCompareCli(["--models", "claude-haiku-4-5,claude-sonnet-5-5", "--input", "in.json", "--langs", "fr,zh-Hant", "--out", "o"], m.io);
    expect(code).toBe(0);
    const bodies = stub.create.mock.calls.map((c) => c[0] as Record<string, unknown>);
    expect(bodies).toHaveLength(4);
    const haiku = bodies.filter((b) => b.model === "claude-haiku-4-5");
    const sonnet = bodies.filter((b) => b.model === "claude-sonnet-5-5");
    expect(haiku).toHaveLength(2);
    expect(sonnet).toHaveLength(2);
    for (const b of bodies) expect(b).not.toHaveProperty("temperature");
    for (const b of sonnet) {
      expect(b).not.toHaveProperty("temperature");
      expect(b).toMatchObject({ thinking: { type: "between_tools" } });
    }
    // The production prompt also passes target-language instructions for Traditional Chinese to Claude.
    expect(bodies.some((b) => String(b.system).includes("Target language:") && String(b.system).includes("Taiwan"))).toBe(true);
    const results = JSON.parse(m.files["o/results.json"]);
    // 20 input + 10 output tokens × two calls. claude-sonnet-5-5 costs $2/$10 per million tokens: (20*2000 + 10*10000)/1000 = 140 microdollars × 2.
    expect(results.totals.B).toMatchObject({ model: "claude-sonnet-5-5", calls: 2, costUsdMicro: 280 });
    expect(results.totals.A).toMatchObject({ model: "claude-haiku-4-5", calls: 2, costUsdMicro: 140 });
    expect(m.err()).toContain("estimated cost");
  });
});

describe("it does not touch the database or the budget", () => {
  it("adds no row to llm_usage (compareTranslations takes no database)", async () => {
    const db = await createTestDb();
    const m = memoryIo({ files: { "in.json": JSON.stringify(ITEMS) }, engineFor: (_p, model) => createFakeEngine({ model }) });
    expect(await runCompareCli(["--models", "fake:fa,fake:fb", "--input", "in.json", "--langs", "fr", "--allow-fake"], m.io)).toBe(0);
    expect(await db.select().from(llmUsage)).toHaveLength(0);
    expect(compareTranslations.length).toBe(1);
  });
});

// Failure handling must hide model names in blind output and count usage from failed calls. Pass glossary entries as preferred translations, as in production.
describe("failures in blind mode, the usage of failed calls, and the glossary", () => {
  const one = JSON.stringify([{ id: "t1", lang: "en", body: "Reward hacking is a problem." }]);

  it("never prints the raw error text of a failed translation in the blind Markdown (it can name the model); the detail goes to blind-key.json", async () => {
    const leaking: TranslationEngine = {
      id: "gemini",
      model: "secret-model-b",
      translate: async () => {
        throw new LlmError("unavailable", "429 from secret-model-b: quota exceeded");
      },
    };
    const m = memoryIo({ files: { "in.json": one }, env: { GEMINI_API_KEY: "k" }, engineFor: (provider, model) => (model === "secret-model-b" ? leaking : neutral(model, model === "a" ? "X" : "Y")) });
    const code = await runCompareCli(["--models", "a,secret-model-b", "--input", "in.json", "--langs", "fr", "--out", "o", "--blind", "--seed", "1", "--no-glossary"], m.io);
    expect(code).toBe(1);
    const markdown = m.files[path.join("o", "compare-fr.md")];
    expect(markdown).toContain("(translation failed)");
    expect(markdown).not.toContain("secret-model-b");
    expect(markdown).not.toContain("quota");
    expect(markdown).not.toContain("429");
    // Do not write to stdout either; --out leaves stdout empty. The stderr summary is for the operator.
    expect(m.out()).toBe("");
    const key = JSON.parse(m.files[path.join("o", "blind-key.json")]) as { entries: Array<{ errors?: Record<string, string> }> };
    expect(key.entries[0].errors).toEqual({ B: "429 from secret-model-b: quota exceeded" });
    // Outside blind mode, reasons remain visible as before.
    const open = memoryIo({ files: { "in.json": one }, env: { GEMINI_API_KEY: "k" }, engineFor: (provider, model) => (model === "secret-model-b" ? leaking : neutral(model, "X")) });
    await runCompareCli(["--models", "a,secret-model-b", "--input", "in.json", "--langs", "fr", "--no-glossary"], open.io);
    expect(open.out()).toContain("(failed: 429 from secret-model-b: quota exceeded)");
  });

  it("counts the usage and the cost of a call that failed after the provider answered (a refusal or a cut-off), not only the successful ones", async () => {
    const refusing: TranslationEngine = {
      id: "claude",
      model: "claude-haiku-4-5",
      translate: async () => {
        throw new LlmError("refusal", "the model declined", { inputTokens: 1000, outputTokens: 200 });
      },
    };
    const out = await compareTranslations({ items: [{ id: "t1", lang: "en", body: "Hello there, friend." }], to: ["fr"], engines: [refusing, neutral("m", "X")], env: {} });
    const [side] = out.entries[0].sides;
    expect(side).toMatchObject({ slot: "A", body: null, inputTokens: 1000, outputTokens: 200, attempts: 1 });
    expect(side.error).toContain("declined");
    expect(side.costUsdMicro).toBe(Math.ceil((1000 * 1000 + 200 * 5000) / 1000));
    expect(compareTotals(out).A).toMatchObject({ failed: 1, calls: 1, inputTokens: 1000, outputTokens: 200 });
    // Failures without a response, such as communication errors, are not billed and do not count.
    const down: TranslationEngine = { id: "gemini", model: "g", translate: async () => { throw new Error("ECONNRESET"); } };
    const none = await compareTranslations({ items: [{ id: "t1", lang: "en", body: "Hello there, friend." }], to: ["fr"], engines: [down, neutral("m", "X")], env: {} });
    expect(none.entries[0].sides[0]).toMatchObject({ attempts: 0, inputTokens: 0, costUsdMicro: 0 });
  });

  const GLOSSARY = 'format: tomola-glossary\nversion: 1\nentries:\n  - terms:\n      en: ["reward hacking"]\n      fr: ["piratage de la récompense"]\n    note: ""\n    keep_original: []\n    needs_review: [fr]\n';

  it("passes the glossary like production (the entries that appear in the text, for the pair of languages) by default, from the file that --glossary names, and not with --no-glossary", async () => {
    const calls: TranslationRequest[] = [];
    const engineFor = (provider: EngineId, model: string) => counting(provider, model, calls);
    // The default file.
    const base = { files: { "in.json": one, "docs/drafts/glossary-initial.yaml": GLOSSARY }, env: { GEMINI_API_KEY: "k" }, engineFor };
    const m = memoryIo(base);
    expect(await runCompareCli(["--models", "a,b", "--input", "in.json", "--langs", "fr"], m.io)).toBe(0);
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => JSON.stringify(c.glossary) === JSON.stringify([{ term: "reward hacking", candidates: ["piratage de la récompense"] }]))).toBe(true);
    expect(m.err()).toContain("glossary docs/drafts/glossary-initial.yaml (2 rows)");
    // Another file.
    calls.length = 0;
    const named = memoryIo({ ...base, files: { "in.json": one, "mine.yaml": GLOSSARY.replace("piratage de la récompense", "détournement de la récompense") } });
    await runCompareCli(["--models", "a,b", "--input", "in.json", "--langs", "fr", "--glossary", "mine.yaml"], named.io);
    expect(calls[0].glossary).toEqual([{ term: "reward hacking", candidates: ["détournement de la récompense"] }]);
    // Do not pass it.
    calls.length = 0;
    await runCompareCli(["--models", "a,b", "--input", "in.json", "--langs", "fr", "--no-glossary"], memoryIo(base).io);
    expect(calls.every((c) => (c.glossary ?? []).length === 0)).toBe(true);
    // Do not pass terms absent from the text or rows in the wrong direction; there are no en → ja rows.
    calls.length = 0;
    await runCompareCli(["--models", "a,b", "--input", "in.json", "--langs", "ja"], memoryIo(base).io);
    expect(calls.every((c) => (c.glossary ?? []).length === 0)).toBe(true);
  });

  it("goes on without a glossary and says so when the default file is missing, but refuses when the file named by --glossary cannot be read or is not valid", async () => {
    const engineFor = (provider: EngineId, model: string) => counting(provider, model, []);
    const missing = memoryIo({ files: { "in.json": one }, env: { GEMINI_API_KEY: "k" }, engineFor });
    expect(await runCompareCli(["--models", "a,b", "--input", "in.json", "--langs", "fr"], missing.io)).toBe(0);
    expect(missing.err()).toContain("no glossary (docs/drafts/glossary-initial.yaml was not found)");
    const named = memoryIo({ files: { "in.json": one }, env: { GEMINI_API_KEY: "k" }, engineFor });
    expect(await runCompareCli(["--models", "a,b", "--input", "in.json", "--glossary", "nope.yaml"], named.io)).toBe(1);
    expect(named.err()).toContain("cannot read the glossary nope.yaml");
    const broken = memoryIo({ files: { "in.json": one, "bad.yaml": "format: other" }, env: { GEMINI_API_KEY: "k" }, engineFor });
    expect(await runCompareCli(["--models", "a,b", "--input", "in.json", "--glossary", "bad.yaml"], broken.io)).toBe(1);
    expect(broken.err()).toContain("the glossary bad.yaml is not valid");
    expect(parseCompareArgs(["--models", "a,b", "--input", "x"]).glossary).toBe("docs/drafts/glossary-initial.yaml");
    expect(parseCompareArgs(["--models", "a,b", "--input", "x", "--no-glossary"]).glossary).toBeNull();
  });
});

// Directory input with one text per file, YAML front matter and body; --langs auto, --per-text, --key-dir, --results-json. Use only small synthetic files, not excerpts from published texts.
describe("a directory of texts with a frontmatter, one file per text", () => {
  const FILE_JA = '---\nid: "1"\nlang: ja\nkind: report\nlength: short\nsource: synthetic\nauthor: someone\nnote: SECRET-NOTE 見るところ\n---\n\n# 見出し\n\n整合性について議論したい。かもしれない。\n\n- 項目\n\n```python\nx = 1\n```\n';
  const FILE_EN = "---\nid: 02\nlang: en\nkind: comment\nlength: short\nsource: synthetic\nnote: SECRET-NOTE look at\n---\nI think it might work.\n";
  const dir = (extra: Record<string, string> = {}) => ({ "d/01-ja-report.md": FILE_JA, "d/02-en-comment.md": FILE_EN, "d/index.md": "# index: not a text", ...extra });
  const dirIo = (files: Record<string, string>, seen: TranslationRequest[] = [], env: Record<string, string> = { GEMINI_API_KEY: "k" }) =>
    memoryIo({
      files,
      env,
      isDir: (p) => p === "d",
      listDir: () => Object.keys(files).filter((f) => f.startsWith("d/")).map((f) => f.slice(2)),
      // Omit model names from translations to verify they do not leak into blind output.
      engineFor: (provider, model) => ({
        id: provider,
        model,
        async translate(req) {
          seen.push(req);
          return { text: `${model === "model-one" ? "ALPHA" : "BETA"}(${req.to}) ${req.text}`, model, promptVersion: "translate-v3", inputTokens: 100, outputTokens: 50 };
        },
      }),
    });

  it("reads the body only (never the frontmatter), keeps the rest of the frontmatter as metadata, and falls back to the number in the file name for the id", () => {
    const one = parseCompareFile("01-ja-report.md", FILE_JA);
    expect(one).toMatchObject({ id: "1", lang: "ja", meta: { kind: "report", length: "short", source: "synthetic", author: "someone", note: "SECRET-NOTE 見るところ" } });
    expect(one.body).toBe("# 見出し\n\n整合性について議論したい。かもしれない。\n\n- 項目\n\n```python\nx = 1\n```");
    expect(one.body).not.toContain("---");
    expect(one.body).not.toContain("SECRET-NOTE");
    expect(parseCompareFile("07-en-essay.md", "---\nlang: en\n---\nText.").id).toBe("07");
    // Convert numeric IDs to strings.
    expect(parseCompareFile("x.md", "---\nid: 02\nlang: en\n---\nText.").id).toBe("2");
    // A horizontal rule within the body remains body text.
    expect(parseCompareFile("a.md", "---\nlang: en\n---\nAbove\n\n---\n\nBelow").body).toBe("Above\n\n---\n\nBelow");
  });

  it("refuses a file with no frontmatter, a bad or missing lang, bad YAML or an empty body, and a directory with no text or a repeated id", () => {
    for (const bad of ["Just text.", "---\nlang: klingon\n---\nText.", "---\nkind: report\n---\nText.", "---\nlang: en\n---\n\n", "---\n: : bad\n  - [\n---\nText.", "---\n- a\n- b\n---\nText."]) {
      expect(() => parseCompareFile("x.md", bad), bad).toThrow();
    }
    const files = { "d/a.md": "---\nid: x\nlang: en\n---\nOne.", "d/b.md": "---\nid: x\nlang: ja\n---\n二つ。" };
    expect(() => parseCompareDirectory("d", { listDir: () => ["a.md", "b.md"], readFile: (f) => files[f as keyof typeof files] })).toThrow('the id "x" is used twice');
    expect(() => parseCompareDirectory("d", { listDir: () => ["index.md", "notes.txt"], readFile: () => "" })).toThrow("has no .md file");
    expect(() => parseCompareDirectory("d", { readFile: () => "" })).toThrow("cannot list directories");
  });

  it("parses --langs auto, --per-text, --key-dir and --results-json, and refuses --per-text without --out", () => {
    expect(parseCompareArgs(["--models", "a,b", "--input", "d", "--langs", "auto", "--out", "o", "--per-text", "--key-dir", "k", "--results-json", "r/x.json"])).toMatchObject({ langs: "auto", perText: true, keyDir: "k", resultsJson: "r/x.json" });
    expect(parseCompareArgs(["--models", "a,b", "--input", "d"])).toMatchObject({ perText: false, keyDir: null, resultsJson: null });
    for (const bad of [["--per-text"], ["--key-dir", ""], ["--results-json", ""]]) expect(() => parseCompareArgs(["--models", "a,b", "--input", "d", ...bad]), bad.join(" ")).toThrow();
  });

  it("translates ja into en and en into ja only (--langs auto), sends the body only to the engines, and writes one blind Markdown per text with an index, the key apart", async () => {
    const seen: TranslationRequest[] = [];
    const m = dirIo(dir(), seen);
    const code = await runCompareCli(["--models", "model-one,model-two", "--input", "d", "--langs", "auto", "--out", "o/ja-en", "--per-text", "--blind", "--seed", "3", "--key-dir", "k", "--results-json", "r/results.json"], m.io);
    expect(code).toBe(0);
    // Only one direction per text. Engines receive only the body, without front matter or note.
    expect(new Set(seen.map((r) => `${r.from}->${r.to}`))).toEqual(new Set(["ja->en", "en->ja"]));
    for (const r of seen) {
      expect(r.text).not.toContain("SECRET-NOTE");
      expect(r.text).not.toContain("kind:");
      expect(r.text).not.toContain("---\n");
    }
    expect(Object.keys(m.files).filter((f) => !f.startsWith("d/")).sort()).toEqual(["k/blind-key.json", "k/key.md", "o/ja-en/01-ja-en.md", "o/ja-en/02-en-ja.md", "o/ja-en/index.md", "r/results.json"]);
    const first = m.files["o/ja-en/01-ja-en.md"];
    expect(first).toContain("# 1 · ja → en");
    expect(first).toContain("## Original (ja)");
    expect(first).toContain("## Translation 1");
    expect(first).toContain("## Translation 2");
    expect(first).toContain("```python\nx = 1\n```");
    // Blind files intended for readers contain no model names, costs, note, or front-matter wording.
    for (const f of ["o/ja-en/01-ja-en.md", "o/ja-en/02-en-ja.md", "o/ja-en/index.md"]) {
      for (const hidden of ["model-one", "model-two", "SECRET-NOTE", "gemini", "$0.", "input and", "tokens"]) expect(m.files[f], `${f} ${hidden}`).not.toContain(hidden);
    }
    expect(m.files["o/ja-en/index.md"]).toContain("[1 · ja → en](01-ja-en.md): report, short, synthetic");
    expect(m.files["o/ja-en/index.md"]).toContain("[2 · en → ja](02-en-ja.md)");
    expect(m.files["o/ja-en/index.md"]).not.toContain("not a text");
    // The key lives in a separate directory; key.md is human-readable.
    expect(m.files["k/key.md"]).toContain("Model A: gemini / model-one. Model B: gemini / model-two.");
    expect(m.files["k/key.md"]).toMatch(/\| 1 \| ja → en \| [AB] \(model-(one|two)\) \| [AB] \(model-(one|two)\) \|/);
    expect(JSON.parse(m.files["k/blind-key.json"]).entries.map((e: { id: string; to: string }) => `${e.id}:${e.to}`)).toEqual(["1:en", "02:ja".replace("02", "2")]);
    // results-json includes full texts, model names, text metadata, and glossary entries or an empty list, even in blind mode.
    const results = JSON.parse(m.files["r/results.json"]);
    expect(results.blind).toBe(true);
    expect(results.models.A.model).toBe("model-one");
    expect(results.entries[0]).toMatchObject({ itemId: "1", from: "ja", to: "en", hints: [], meta: { kind: "report", note: "SECRET-NOTE 見るところ" } });
    expect(results.entries[0].sides[0].body).toContain("整合性について議論したい");
  });

  it("is reproducible with --seed, and without --blind names the models in the per-text files and writes results.json in --out", async () => {
    const run = async (extra: string[]) => {
      const m = dirIo(dir());
      expect(await runCompareCli(["--models", "model-one,model-two", "--input", "d", "--langs", "auto", "--out", "o", "--per-text", ...extra], m.io)).toBe(0);
      return m;
    };
    const a = await run(["--blind", "--seed", "9"]);
    const b = await run(["--blind", "--seed", "9"]);
    expect(b.files["o/01-ja-en.md"]).toBe(a.files["o/01-ja-en.md"]);
    // Without --key-dir, store the key inside --out.
    expect(Object.keys(a.files)).toEqual(expect.arrayContaining(["o/blind-key.json", "o/key.md"]));
    const open = await run([]);
    expect(open.files["o/01-ja-en.md"]).toContain("model-one");
    expect(open.files["o/01-ja-en.md"]).toMatch(/input and \d+ output tokens/);
    expect(JSON.parse(open.files["o/results.json"]).entries).toHaveLength(2);
  });

  it("refuses --langs auto for a text that is neither ja nor en, before any call, and still takes an explicit --langs for a directory", async () => {
    const seen: TranslationRequest[] = [];
    const bad = dirIo(dir({ "d/03-fr-comment.md": "---\nid: 3\nlang: fr\n---\nUn texte." }), seen);
    expect(await runCompareCli(["--models", "model-one,model-two", "--input", "d", "--langs", "auto"], bad.io)).toBe(1);
    expect(bad.err()).toContain("the text 3 is fr");
    expect(seen).toEqual([]);
    const ok = dirIo(dir(), seen);
    expect(await runCompareCli(["--models", "model-one,model-two", "--input", "d", "--langs", "fr", "--out", "o", "--per-text"], ok.io)).toBe(0);
    expect(new Set(seen.map((r) => r.to))).toEqual(new Set(["fr"]));
    expect(Object.keys(ok.files).filter((f) => f.startsWith("o/")).sort()).toEqual(["o/01-ja-fr.md", "o/02-en-fr.md", "o/index.md", "o/results.json"]);
  });

  it("estimates the cost per text with its own target before calling", async () => {
    const m = dirIo(dir());
    expect(await runCompareCli(["--models", "model-one,model-two", "--input", "d", "--langs", "auto", "--dry-run"], m.io)).toBe(0);
    // Two texts × one direction × two models, without titles, gives four calls.
    expect(m.err()).toContain("4 call(s) at least");
    expect(m.err()).toContain("ja<->en (auto)");
  });
});
