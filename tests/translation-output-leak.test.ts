import { afterEach, describe, expect, it, vi } from "vitest";
import { hasTranslationOutputLeak } from "~/lib/llm/output-leak.core.server";
import { inspectTranslation } from "~/lib/llm/translation-inspect.core.server";
import { translateChecked } from "~/lib/llm/translate.server";
import { createFakeEngine } from "~/lib/llm/engines/fake.server";
import type { TranslationRequest } from "~/lib/llm/types";
import { leakedReasoning as leak } from "./helpers/translation-leak";

afterEach(() => vi.restoreAllMocks());
const req: TranslationRequest = { text: "この村では反応の多い順にも並べられます。", from: "ja", to: "fr" };

describe("translation output breakdowns", () => {
  it("catches a short source expanded into a long single paragraph, even without English markers", () => {
    expect(hasTranslationOutputLeak(req, "Une longue discussion des traductions possibles. ".repeat(60))).toBe(true);
    expect(hasTranslationOutputLeak({ ...req, chat: { context: [] } }, "Une longue discussion. ".repeat(100))).toBe(true);
  });

  it("rejects runaway output inside an unclosed code fence before ordinary structure inspection", () => {
    const fenced = "```text\n" + leak.repeat(20);
    expect(hasTranslationOutputLeak(req, fenced)).toBe(true);
    expect(inspectTranslation(req, fenced, "gemini").flags).toEqual(["output_leak"]);
  });

  it("detects line explosions below the absolute length floor", () => {
    const output = Array.from({ length: 12 }, (_, i) => `Alternative ${i}: une phrase différente.`).join("\n");
    expect(hasTranslationOutputLeak(req, output)).toBe(true);
  });

  it("detects repeated reasoning starts and shares the flag with ordinary output inspection", () => {
    expect(hasTranslationOutputLeak(req, leak)).toBe(true);
    expect(inspectTranslation(req, leak, "gemini").flags).toContain("output_leak");
    for (const start of ["Wait,", "Let's", "Let’s", "Let me", "I need to", "The user", "Rule:", "Translation:"]) {
      expect(hasTranslationOutputLeak(req, Array(3).fill(`${start} consider the wording and all possible meanings carefully.`).join("\n"))).toBe(true);
    }
  });

  it("allows normal short translations, compact-script expansion, long text and preserved line structure", () => {
    for (const [source, output] of [
      ["村", "Un espace communautaire"],
      [req.text, "Dans ce village, vous pouvez aussi classer les messages par nombre de réactions."],
      ["字".repeat(100), "a".repeat(750)],
      ["長い原文の一節。".repeat(300), "Une section du texte original. ".repeat(300)],
      [Array(20).fill("- 項目とその説明。").join("\n"), Array(20).fill("- Un élément et son explication.").join("\n")],
      [Array(20).fill("原文の行。").join("\n"), Array(20).fill("Une ligne traduite.").join("\n")],
    ]) expect(hasTranslationOutputLeak({ ...req, text: source }, output)).toBe(false);
    expect(hasTranslationOutputLeak({ text: "A".repeat(200), from: "en", to: "ja" }, "字".repeat(700))).toBe(false);
    expect(hasTranslationOutputLeak({ text: "A".repeat(200), from: "en", to: "fr" }, "B".repeat(1100))).toBe(false);
  });

  it("allows faithful English reasoning translated from another language, including long documents", () => {
    const source = "待って、この表現にはいくつか訳し方がある。\nメッセージの文脈に合う語を考えよう。\n規則：すべての候補を検討してから訳文を返す。";
    for (const count of [1, 20]) {
      expect(hasTranslationOutputLeak({ text: Array(count).fill(source).join("\n\n"), from: "ja", to: "en" }, Array(count).fill(leak).join("\n\n"))).toBe(false);
    }
  });

  it("ignores code, math and quoted reasoning, including markers mentioned in source prose", () => {
    const code = "```text\n" + leak.repeat(8) + "\n```";
    for (const [source, output] of [
      ["例。\n\n" + code, "Exemple.\n\n" + code],
      ["例。\n\n`" + leak.replaceAll("\n", " ") + "`", "Exemple.\n\n`" + leak.replaceAll("\n", " ") + "`"],
      ["引用。\n\n" + leak.split("\n").map(line => `> ${line}`).join("\n"), "Citation.\n\n" + leak.split("\n").map(line => `> ${line}`).join("\n")],
      ["計算。\n\n$$\n" + "x + ".repeat(200) + "y\n$$", "Calcul.\n\n$$\n" + "x + ".repeat(200) + "y\n$$"],
      ["Wait, Let's and Rule: are examples of reasoning markers.", leak],
      [leak, leak],
    ]) expect(hasTranslationOutputLeak({ text: source, from: "en", to: "fr" }, output)).toBe(false);
    const quoted = leak.split("\n").map(line => `“${line}”`).join("\n");
    expect(hasTranslationOutputLeak({ ...req, text: "引用文。".repeat(20) }, quoted)).toBe(false);
  });
});

describe("one checked retry before terminal failure", () => {
  it.each([false, true])("reports zero leak detections for ordinary output, with structure retry=%s", async retry => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const engine = createFakeEngine();
    const good = "Une traduction correcte.";
    const call = vi.spyOn(engine, "translate")
      .mockResolvedValueOnce({ text: retry ? "```\nadded code\n```" : good, model: "fake-1", promptVersion: "test", inputTokens: 1, outputTokens: 1 })
      .mockResolvedValueOnce({ text: good, model: "fake-1", promptVersion: "test", inputTokens: 1, outputTokens: 1 });
    expect(await translateChecked(engine, req)).toMatchObject({ text: good, flags: [], attempts: retry ? 2 : 1, leakDetections: 0 });
    expect(call).toHaveBeenCalledTimes(retry ? 2 : 1);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each(["title", "body", "chat"] as const)("retries %s without retaining the rejected text and totals both calls", async field => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const requests: TranslationRequest[] = [];
    const engine = { ...createFakeEngine(), async translate(request: TranslationRequest) {
      requests.push(request);
      return { text: requests.length === 1 ? leak : "Une traduction correcte.", model: "fake-1", promptVersion: "test", inputTokens: 10, outputTokens: 20, thoughtTokens: 3 };
    } };
    const request = { ...req, ...(field === "chat" ? { chat: { context: [] } } : { field }) };
    const result = await translateChecked(engine, request);
    expect(requests).toHaveLength(2);
    expect(requests[1].retryNote).toEqual(expect.stringMatching(/\S/));
    expect(requests[1].retryNote).not.toBe(requests[0].retryNote);
    expect(result).toMatchObject({ text: "Une traduction correcte.", flags: [], attempts: 2, leakDetections: 1, inputTokens: 20, outputTokens: 40, thoughtTokens: 6 });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("detections=1");
    expect(warn.mock.calls[0][0]).not.toContain(req.text);
    expect(warn.mock.calls[0][0]).not.toContain("Wait,");
  });

  it("fails permanently after a second leak, with one content-free count log", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const engine = createFakeEngine();
    const call = vi.spyOn(engine, "translate").mockResolvedValue({ text: leak, model: "fake-1", promptVersion: "test", inputTokens: 1, outputTokens: 1 });
    await expect(translateChecked(engine, req)).rejects.toMatchObject({ code: "output_leak", retryable: false });
    expect(call).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("detections=2");
    expect(warn.mock.calls[0][0]).not.toContain("Wait,");
  });

  it("also rejects a leak introduced by the retry for a different check", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const engine = createFakeEngine();
    vi.spyOn(engine, "translate").mockResolvedValueOnce({ text: "```\nadded code\n```", model: "fake-1", promptVersion: "test", inputTokens: 1, outputTokens: 1 })
      .mockResolvedValueOnce({ text: leak, model: "fake-1", promptVersion: "test", inputTokens: 1, outputTokens: 1 });
    await expect(translateChecked(engine, req)).rejects.toMatchObject({ code: "output_leak", retryable: false });
  });
});
