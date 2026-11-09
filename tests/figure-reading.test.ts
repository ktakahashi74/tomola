import sharp from "sharp";
import { renderFigure } from "./helpers/figure-render";
import { renderFigureLabels } from "~/lib/figure-render.server";
import Anthropic from "@anthropic-ai/sdk";
import { FinishReason, GoogleGenAI } from "@google/genai";
import { describe, expect, it, vi } from "vitest";
import { createFigureReader, FIGURE_READING_PROMPT, FIGURE_READING_PROMPT_VERSION, FIGURE_READING_OVERLAP_RETRY, figureTranslationEnabled, parseFigureReading } from "~/lib/figure-reading.server";
import { decorateFigureHtml } from "~/lib/figure-display.server";
import { figurePath, FIGURE_VERSION, normalizeFigureReading, preservesFigureMath, type FigureReading } from "~/lib/figure";
import { parseTranslatedMediaPath } from "~/lib/media";
import { inspectTranslation } from "~/lib/llm/translation-inspect.core.server";
import { buildTranslationPrompt, PROMPT_VERSION } from "~/lib/llm/prompt.server";
import { LANGS } from "~/lib/languages";

vi.mock("~/paraglide/messages.js", async () => ({ m: (await import("./helpers/messages-json")).jsonMessages() }));

const reading: FigureReading = { lang: "en", confidence: 1, regions: [{ text: "label", lang: "en", confidence: 1, x: 0.1, y: 0.1, width: 0.8, height: 0.5, orientation: "horizontal", weight: "normal" }] };
const boxReading = { lang: "en", confidence: 1, regions: [{ text: "label", lang: "en", confidence: 1, box_2d: [100, 100, 600, 900], orientation: "horizontal" }] };
const withBox = (box_2d: unknown) => ({ ...boxReading, regions: [{ ...boxReading.regions[0], box_2d }] });

it("requires an explicit opt-in and validates the reading model without making a request", () => {
  expect(figureTranslationEnabled({})).toBe(false); expect(figureTranslationEnabled({ FIGURE_TRANSLATION: "0" })).toBe(false);
  expect(figureTranslationEnabled({ FIGURE_TRANSLATION: "1" })).toBe(true);
  expect(() => figureTranslationEnabled({ FIGURE_TRANSLATION: "yes" })).toThrow();
  expect(() => createFigureReader({ TRANSLATION_PRIMARY: "gemini", FIGURE_READING_MODEL: "claude-haiku-4-5" })).toThrow();
});

const acceptedReadings = [
  ["native boxes", boxReading, reading],
  ["bold labels", { ...boxReading, regions: [{ ...boxReading.regions[0], weight: "bold" }] }, { ...reading, regions: [{ ...reading.regions[0], weight: "bold" }] }],
  ["asymmetric axes", withBox([200, 100, 300, 400]), { ...reading, regions: [{ ...reading.regions[0], y: 0.2, width: 0.3, height: 0.1 }] }],
  ["full-image endpoints", withBox([0, 0, 1000, 1000]), { ...reading, regions: [{ ...reading.regions[0], x: 0, y: 0, width: 1, height: 1 }] }],
  ["five-unit edge overshoot", withBox([-5, -5, 1005, 1005]), { ...reading, regions: [{ ...reading.regions[0], x: 0, y: 0, width: 1, height: 1 }] }],
  ["one-unit boxes without scale guessing", withBox([0, 0, 1, 1]), { ...reading, regions: [{ ...reading.regions[0], x: 0, y: 0, width: 0.001, height: 0.001 }] }],
  ["no text", { lang: null, confidence: 1, regions: [] }, { lang: null, confidence: 1, regions: [] }],
  ["identical duplicates", { ...boxReading, regions: [boxReading.regions[0], boxReading.regions[0]] }, reading],
  ["duplicates at exactly 90 percent IoU", { ...boxReading, regions: [boxReading.regions[0], { ...boxReading.regions[0], box_2d: [100, 100, 600, 820], confidence: 0.5 }] }, { ...reading, regions: [{ ...reading.regions[0], confidence: 0.5 }] }],
  ["duplicates after edge clamping", { ...boxReading, regions: [{ ...boxReading.regions[0], box_2d: [-5, -5, 1005, 1005] }, { ...boxReading.regions[0], box_2d: [0, 0, 1000, 1000] }] }, { ...reading, regions: [{ ...reading.regions[0], x: 0, y: 0, width: 1, height: 1 }] }],
  ["touching boxes", { ...boxReading, regions: [{ ...boxReading.regions[0], box_2d: [0, 0, 100, 100] }, { ...boxReading.regions[0], box_2d: [0, 100, 100, 200] }] }, { ...reading, regions: [{ ...reading.regions[0], x: 0, y: 0, width: 0.1, height: 0.1 }, { ...reading.regions[0], x: 0.1, y: 0, width: 0.1, height: 0.1 }] }],
] as const;

it.each(acceptedReadings)("accepts %s from a fake Gemini client and converts to stored fractions", async (_name, input, expected) => {
  const generateContent = vi.fn(async () => ({ text: JSON.stringify(input), candidates: [{ finishReason: FinishReason.STOP }] }));
  const reader = createFigureReader({ TRANSLATION_PRIMARY: "gemini" }, { geminiClient: { models: { generateContent } } });
  const result = await reader.read(Buffer.from("synthetic WebP payload"));
  const log = vi.fn();
  expect(parseFigureReading(result.text, log)).toEqual(expected);
  expect(result.promptVersion).toBe("figure-reading-v4");
  expect(log).not.toHaveBeenCalled();
  expect(generateContent).toHaveBeenCalledTimes(1);
});

const invalidReadings = [
  ["large overshoot", withBox([100, 100, 600, 1200])],
  ...[0, 1, 2, 3].flatMap(index => [-6, 1006].map(value => {
    const box = [100, 100, 600, 900]; box[index] = value;
    return [`coordinate ${index} outside the five-unit tolerance at ${value}`, withBox(box)] as const;
  })),
  ["reversed horizontal endpoints", withBox([100, 900, 600, 100])],
  ["reversed vertical endpoints", withBox([600, 100, 100, 900])],
  ["zero width", withBox([100, 100, 600, 100])],
  ["zero height", withBox([100, 100, 100, 900])],
  ["width collapsed by clamping", withBox([100, -5, 600, 0])],
  ["height collapsed by clamping", withBox([1000, 100, 1005, 900])],
  ["fractional coordinates", withBox([100, 100.5, 600, 900])],
  ["string coordinates", withBox([100, "100", 600, 900])],
  ["null coordinates", withBox([100, null, 600, 900])],
  ["too few coordinates", withBox([100, 100, 600])],
  ["too many coordinates", withBox([100, 100, 600, 900, 1000])],
  ["missing orientation", { ...boxReading, regions: [{ ...boxReading.regions[0], orientation: undefined }] }],
  ["unknown orientation", { ...boxReading, regions: [{ ...boxReading.regions[0], orientation: "diagonal" }] }],
  ["unknown weight", { ...boxReading, regions: [{ ...boxReading.regions[0], weight: "heavy" }] }],
  ["conflicting duplicate weights", { ...boxReading, regions: [boxReading.regions[0], { ...boxReading.regions[0], weight: "bold" }] }],
  ["missing box", { ...boxReading, regions: [{ ...boxReading.regions[0], box_2d: undefined }] }],
  ["old fractional format", reading],
  ["old thousand-point extent format", { ...reading, regions: [{ ...reading.regions[0], x: 100, y: 100, width: 800, height: 500 }] }],
  ["unknown region fields", { ...boxReading, regions: [{ ...boxReading.regions[0], x: 100 }] }],
  ["confidence above one", { ...boxReading, confidence: 99 }],
  ["region confidence above one", { ...boxReading, regions: [{ ...boxReading.regions[0], confidence: 99 }] }],
  ["unsupported language", { ...boxReading, lang: "unsupported" }],
  ["too many regions before deduplication", { ...boxReading, regions: Array(65).fill(boxReading.regions[0]) }],
  ["excessive label text", { ...boxReading, regions: [{ ...boxReading.regions[0], text: "x".repeat(1001) }] }],
  ["excessive total text", { ...boxReading, regions: Array.from({ length: 9 }, (_, i) => ({ ...boxReading.regions[0], box_2d: [0, i * 100, 50, i * 100 + 50], text: "x".repeat(1000) })) }],
  ["different text in identical boxes", { ...boxReading, regions: [boxReading.regions[0], { ...boxReading.regions[0], text: "other" }] }],
  ["different case in identical boxes", { ...boxReading, regions: [boxReading.regions[0], { ...boxReading.regions[0], text: "Label" }] }],
  ["different languages in identical boxes", { ...boxReading, regions: [boxReading.regions[0], { ...boxReading.regions[0], lang: "ja" }] }],
  ["different orientations in identical boxes", { ...boxReading, regions: [boxReading.regions[0], { ...boxReading.regions[0], orientation: "vertical" }] }],
  ["same text just below 90 percent IoU", { ...boxReading, regions: [boxReading.regions[0], { ...boxReading.regions[0], box_2d: [100, 100, 600, 819] }] }],
  ["contained label with half the area", { ...boxReading, regions: [boxReading.regions[0], { ...boxReading.regions[0], box_2d: [100, 100, 600, 500] }] }],
  ["a discarded duplicate overlapping another label", { ...boxReading, regions: [boxReading.regions[0], { ...boxReading.regions[0], box_2d: [100, 110, 600, 910] }, { ...boxReading.regions[0], text: "neighbour", box_2d: [100, 900, 600, 1000] }] }],
] as const;

it.each(invalidReadings)("rejects %s returned by a fake Gemini client", async (_name, input) => {
  const generateContent = vi.fn(async () => ({ text: JSON.stringify(input), candidates: [{ finishReason: FinishReason.STOP }] }));
  const reader = createFigureReader({ TRANSLATION_PRIMARY: "gemini" }, { geminiClient: { models: { generateContent } } });
  const result = await reader.read(Buffer.from("synthetic WebP payload"));
  const log = vi.fn();
  expect(parseFigureReading(result.text, log)).toBeNull();
  expect(log).toHaveBeenCalledTimes(1);
  expect(generateContent).toHaveBeenCalledTimes(1);
});

it("logs one bounded rejection category without image text, unknown keys, or raw JSON", () => {
  const secret = "PRIVATE IMAGE TEXT\nsecond line";
  const malformed = vi.fn(), shape = vi.fn(), overlap = vi.fn();
  expect(parseFigureReading(secret, malformed)).toBeNull();
  expect(malformed.mock.calls).toEqual([["[figure-reading] rejected reason=invalid_json"]]);
  expect(parseFigureReading(JSON.stringify({ ...boxReading, [secret]: secret, regions: [{ ...boxReading.regions[0], text: secret, orientation: undefined, confidence: 99 }] }), shape)).toBeNull();
  expect(shape).toHaveBeenCalledTimes(1);
  expect(shape.mock.calls[0][0]).toContain("reason=invalid_shape");
  expect(shape.mock.calls[0][0]).toContain("regions.0.orientation:invalid_value");
  expect(shape.mock.calls[0][0]).toContain("regions.0.confidence:too_big");
  expect(shape.mock.calls[0][0]).not.toMatch(/PRIVATE|second line|\n/);
  const many = vi.fn();
  parseFigureReading(JSON.stringify({ ...boxReading, regions: Array(64).fill({ ...boxReading.regions[0], orientation: "unknown" }) }), many);
  expect(many.mock.calls[0][0].split("issues=")[1].split(",")).toHaveLength(5);
  expect(parseFigureReading(JSON.stringify({ ...boxReading, regions: [boxReading.regions[0], { ...boxReading.regions[0], text: "other" }] }), overlap)).toBeNull();
  expect(overlap.mock.calls).toEqual([["[figure-reading] rejected reason=overlapping_regions"]]);
});

it("drops every member of an overlapping component, including its duplicates, and logs only the count", () => {
  const label = boxReading.regions[0];
  const input = { ...boxReading, regions: [
    label, { ...label, box_2d: [100, 110, 600, 910] },
    { ...label, text: "Private neighbour", box_2d: [100, 900, 600, 1000] },
    { ...label, text: "Keep", box_2d: [700, 100, 800, 300] },
  ] };
  const log = vi.fn(), overlap = vi.fn();
  const parsed = parseFigureReading(JSON.stringify(input), log, { discardOverlaps: true, onOverlap: overlap });
  expect(parsed?.regions.map(r => r.text)).toEqual(["Keep"]);
  expect(parsed?.protectedBoxes).toHaveLength(3);
  expect(parsed?.protectedBoxes?.[0]).toEqual({ x: .1, y: .1, width: .8, height: .5 });
  expect(overlap).toHaveBeenCalledTimes(1);
  expect(log.mock.calls).toEqual([["[figure-reading] discarded reason=overlapping_regions count=3"]]);
  expect(parseFigureReading(JSON.stringify({ ...input, regions: input.regions.slice(0, 3) }), log, { discardOverlaps: true })).toBeNull();
});

describe("provider image requests with real SDKs and a fake HTTP transport", () => {
  it.each(["gemini", "claude"] as const)("sends stored bytes inline to %s, normalizes its response and accounts for tokens", async provider => {
    const captured: any[] = [];
    const fetch: typeof globalThis.fetch = async (_input, init) => {
      captured.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify(provider === "gemini" ? {
        candidates: [{ content: { role: "model", parts: [{ text: JSON.stringify(boxReading) }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 1200, candidatesTokenCount: 200, thoughtsTokenCount: 5 },
      } : { id: "test-message", type: "message", role: "assistant", model: "claude-haiku-4-5", content: [{ type: "text", text: JSON.stringify(boxReading) }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1200, output_tokens: 200 } }), { headers: { "Content-Type": "application/json" } });
    };
    const deps = provider === "gemini" ? { geminiClient: new GoogleGenAI({ apiKey: "test", httpOptions: { fetch } }) } : { claudeClient: new Anthropic({ apiKey: "test", fetch }) };
    const reader = createFigureReader({ TRANSLATION_PRIMARY: provider }, deps);
    const bytes = Buffer.from("synthetic WebP payload"); const result = await reader.read(bytes);
    expect(parseFigureReading(result.text)).toEqual(reading); expect(result.inputTokens).toBe(1200); expect(result.outputTokens).toBe(provider === "gemini" ? 205 : 200);
    expect(captured).toHaveLength(1);
    expect(result.promptVersion).toBe(FIGURE_READING_PROMPT_VERSION);
    expect(result.model).toBe(provider === "gemini" ? "gemini-3.5-flash-lite" : "claude-haiku-4-5");
    expect(FIGURE_READING_PROMPT).toContain("[ymin, xmin, ymax, xmax]");
    expect(provider === "gemini" ? captured[0].systemInstruction.parts[0].text : captured[0].system).toBe(FIGURE_READING_PROMPT);
    if (provider === "gemini") {
      const config = captured[0].generationConfig;
      expect(config.thinkingConfig).toEqual({ thinkingLevel: "MINIMAL" });
      expect(config.responseMimeType).toBe("application/json");
      const schema = config.responseJsonSchema;
      expect(schema.required).toEqual(expect.arrayContaining(["lang", "confidence", "regions"]));
      expect(schema.properties.lang.anyOf).toEqual([{ type: "string", enum: [...LANGS] }, { type: "null" }]);
      // The Gemini API answers 400 INVALID_ARGUMENT when maxItems is sent.
      expect(JSON.stringify(schema)).not.toContain('"maxItems"');
      const region = schema.properties.regions.items;
      expect(region.required).toEqual(expect.arrayContaining(["text", "lang", "confidence", "box_2d", "orientation", "weight"]));
      expect(region.properties.weight.enum).toEqual(["bold", "normal"]);
      expect(region.properties.lang.enum).toEqual([...LANGS]);
      expect(region.properties.orientation.enum).toEqual(["horizontal", "vertical", "curved"]);
      expect(region.properties.box_2d).toEqual({ type: "array", items: { type: "integer", minimum: 0, maximum: 1000 } });
      expect(region.properties.confidence).toEqual({ type: "number", minimum: 0, maximum: 1 });
      expect(schema.properties.confidence).toEqual({ type: "number", minimum: 0, maximum: 1 });
    }
    const content = provider === "gemini" ? captured[0].contents[0].parts : captured[0].messages[0].content;
    const image = provider === "gemini" ? content.find((part: any) => part.inlineData).inlineData : content[0].source;
    expect(image.data).toBe(bytes.toString("base64")); expect(image.mimeType ?? image.media_type).toBe("image/webp");
    expect(JSON.stringify(captured[0])).not.toContain("/media/");
    await reader.read(bytes, undefined, true);
    const retry = captured[1];
    expect(provider === "gemini" ? retry.systemInstruction.parts[0].text : retry.system).toBe(FIGURE_READING_PROMPT);
    const retryContent = provider === "gemini" ? retry.contents[0].parts : retry.messages[0].content;
    expect(retryContent.find((part: any) => part.text)?.text).toContain(FIGURE_READING_OVERLAP_RETRY);

  });
});

it("uses the existing translation rules and checks each plain label while preserving the array", () => {
  const req = { text: JSON.stringify(["Label one", "Label two"]), from: "en" as const, to: "ja" as const, figure: true };
  const normal = buildTranslationPrompt({ ...req, figure: false }, "same"); const figure = buildTranslationPrompt(req, "same");
  // Common rules and language instructions remain the same; figure-specific
  // formula preservation belongs to the label envelope.
  expect(normal.system.split("3.")[1]).toBe(figure.system.split("3.")[1]);
  expect(figure.system).toContain("Do not rewrite symbols as LaTeX commands");
  expect(inspectTranslation(req, JSON.stringify(["一番", "二番"]), "fake").flags).toEqual([]);
  expect(inspectTranslation(req, JSON.stringify(["一番"]), "fake").flags).not.toEqual([]);
  expect(inspectTranslation(req, '{"label":"一番"}', "fake").flags).not.toEqual([]);
  expect(PROMPT_VERSION).toMatch(/^translate-v\d+$/);
});

it("decorates only actual managed image tags and preserves the displayed alt and surrounding markup", () => {
  const id = "a".repeat(64), url = `/media/${id}-320x180.webp`;
  const original = `<p><img src="${url}" alt="A &#x26; B" width="320" height="180"></p>`;
  const translated = `<p title='look <img src="${url}">'>text</p><!-- <img src="${url}"> --><p><img src="${url}" alt="Changed" width="320" height="180"></p>`;
  const decorated = decorateFigureHtml(translated, original, new Map([[id, { hasImage: true, results: [] }]]), "ja");
  expect(decorated.match(/data-translated-figure/g)).toHaveLength(1);
  expect(decorated).toContain('alt="Changed"'); expect(decorated).toContain(`href="${url}"`);
  expect(decorated).toContain(`src="${figurePath(id, 320, 180, "ja")}"`);
  expect(decorated.slice(0, decorated.indexOf("<span"))).toBe(translated.slice(0, translated.lastIndexOf("<img")));
  expect(decorateFigureHtml(original, original, new Map(), "ja")).toBe(original);
  expect(decorateFigureHtml(translated, original, new Map(), "ja")).toBe(translated);
  expect(decorateFigureHtml(`<img src="${url}">`, original, new Map([[id, { hasImage: true, results: [] }]]), "ja")).not.toContain(' alt=');
  expect(parseTranslatedMediaPath(figurePath(id, 320, 180, "zh-Hant"))).toMatchObject({ id, lang: "zh-Hant", version: FIGURE_VERSION });
  expect(parseTranslatedMediaPath(figurePath(id, 320, 180, "ja").replace(".ja.", ".invalid."))).toBeNull();
});

it("keeps the original when a translated label contains a code point absent from bundled fonts", async () => {
  const bytes = await sharp({ create: { width: 320, height: 180, channels: 3, background: "white" } }).webp().toBuffer();
  const result = await renderFigureLabels(bytes, reading, ["Missing \u0378 glyph"], "en");
  expect(result.bytes).toBeNull();
  expect(result.results[0]).toMatchObject({ reason: "font_missing", status: "external", translation: "Missing \u0378 glyph" });
});

it("erases old letters against a transparent background without making the surrounding image opaque", async () => {
  const bytes = await sharp({ create: { width: 320, height: 180, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite([
    { input: { create: { width: 8, height: 8, channels: 4, background: "black" } }, left: 33, top: 19 },
  ]).webp({ lossless: true }).toBuffer();
  const output = await renderFigure(bytes, reading, ["Translated"], "en"); expect(output).not.toBeNull();
  const raw = await sharp(output!).ensureAlpha().raw().toBuffer();
  expect(raw[(19 * 320 + 33) * 4 + 3]).toBe(0); expect(raw[3]).toBe(0);
});

it.each([
  ["“水位” \\epsilon の増加", "“水位” ε の増加"],
  ["\\alpha + \\vartheta + \\Gamma + \\partial K(w)", "α + θ + Γ + ∂ K(w)"],
  ["\\sum \\prod \\int \\infty \\leq \\times", "∑ ∏ ∫ ∞ ≤ ×"],
  ["\\section{はじめに} \\d+ C:\\data\\out \\n \\constructor", "\\section{はじめに} \\d+ C:\\data\\out \\n \\constructor"],
  ["\\epsilonExtra \\Partial \\varepsilon", "\\epsilonExtra \\Partial ε"],
])("normalizes only known symbol commands in reading text %s", (source, expected) => {
  const input: FigureReading = { ...reading, regions: [{ ...reading.regions[0], text: source }, { ...reading.regions[0], lang: "ja", text: source }] };
  const before = structuredClone(input), normalized = normalizeFigureReading(input);
  expect(normalized).toEqual({ ...input, regions: input.regions.map(region => ({ ...region, text: expected })) });
  expect(input).toEqual(before);
  expect(normalizeFigureReading(normalized)).toEqual(normalized);
});

it.each([
  ["∂wK(w) = 0", "dw K(w) = 0", false],
  ["水位 ϵ の増加", "Water level \\epsilon (increase)", false],
  ["水位 ϵ の増加", "Water level \\epsilon", false],
  ["条件 ∂", "Condition \\partial", false],
  ["係数 α", "Coefficient \\alpha", false],
  ["水位 ϵ の増加", "Increase in water level ε", true],
  ["水位 ϵ", "Water level ε (\\epsilon)", false],
  ["水位 ε", "Water level \\epsilon", false],
  ["水位 ε", "Water level ε", true],
  ["水位 ε", "Water level", false],
  ["係数 α + θ", "Coefficients α + θ", true],
  ["条件 ∂ K(w)", "Condition ∂ K(w)", true],
  ["条件 ∂ K(w)", "Condition K(w)", false],
  ["保存先 C:\\data\\out", "Save to C:\\data\\out", true],
  ["\\section{はじめに}", "\\section{Introduction}", true],
  ["正規表現 \\d+", "regex \\d+", true],
  ["改行は \\n", "newline is \\n", true],
  ["保存先 C:\\data\\out", "Save to C:\\data\\data\\out", false],
  ["保存先 C:\\data\\out", "Save to C:\\Data\\out", false],
  ["正規表現 \\d+ と \\d+", "regex \\d+", false],
  ["\\constructor{はじめに}", "\\constructor{Introduction}", true],
  ["普通の題", "A title \\section{Introduction}", false],
  ["∑ αᵢ² + β = K(w)", "∑ ai2 + b = K(w)", false],
  ["∂wK(w) = 0", "∂wK(v) = 0", false],
  ["α + α", "α", false],
  ["x_i + R^2", "xi + R2", false],
  ["α_i", "αi", false],
  ["xᵢ", "xi", false],
  ["ℝ", "R", false],
  ["条件 ∂wK(w) = 0", "Condition ∂wK(w) = 0", true],
  ["合計 ∑ αᵢ² + β = K(w)", "Total ∑ αᵢ² + β = K(w)", true],
  ["普通の題", "An ordinary title", true],
  ["Real-time data", "リアルタイムのデータ", true],
  ["State-of-the-art model", "最先端のモデル", true],
  ["Input/Output", "入出力", true],
  ["入力/出力", "Input and output", true],
  ["*注：概算", "Note: estimate", true],
  ["Pre-training → Fine-tuning", "事前学習 → 微調整", true],
  ["x − y", "x - y", true],
  ["x － y", "x − y", true],
  ["x − y", "x y", false],
  ["x − y − z", "x - y z", false],
  ["K(-1)", "K(−1)", true],
  ["ϵ ＋ ϑ ＝ ϕ − ϱ ／ ϖ", "ε + θ = φ - ρ / π", true],
  ["K（ϵ） ＞ ϑ", "K(ε) > θ", true],
  ["α + α", "α + β", false],
])("preserves formula tokens in %s", (source, translated, valid) => {
  expect(preservesFigureMath(source, translated)).toBe(valid);
  const req = { text: JSON.stringify([source]), from: "ja" as const, to: "en" as const, figure: true };
  const checked = inspectTranslation(req, JSON.stringify([translated]), "fake");
  expect(checked.flags.includes("quality_mismatch")).toBe(!valid);
});

it("ignores unknown saved fallback reasons without hiding valid translations", () => {
  const id = "a".repeat(64), html = `<img src="/media/${id}-320x180.webp">`;
  const results = JSON.parse('[{"source":"future","translation":"未来","status":"external","reason":"future_reason"},{"source":"known","translation":"既知","status":"external","reason":"does_not_fit"}]');
  const decorated = decorateFigureHtml(html, html, new Map([[id, { hasImage: false, results }]]), "ja");
  expect(decorated).toContain("既知"); expect(decorated).not.toContain("未来");
  expect(decorateFigureHtml(html, html, new Map([[id, { hasImage: false, results: results.slice(0, 1) }]]), "ja")).not.toContain("data-figure-fallback");
});

it("shows one reason when every saved label has no usable translation", () => {
  const id = "a".repeat(64), html = `<img src="/media/${id}-320x180.webp">`;
  const results = ["first", "second"].map(source => ({ source, translation: null, status: "external" as const, reason: "invalid_translation" as const }));
  const decorated = decorateFigureHtml(html, html, new Map([[id, { hasImage: false, results }]]), "ja");
  expect(decorated).toContain("data-figure-fallback"); expect(decorated).not.toContain('role="listitem"');
  expect(decorated.match(/使える訳を作れませんでした。/g)).toHaveLength(1);
  expect(decorated).not.toContain("図の外に添えた訳");
});
