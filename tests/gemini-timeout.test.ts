import { FinishReason } from "@google/genai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGeminiEngine, geminiComplete, resetThinkingFallbacks, type GeminiClient } from "~/lib/llm/engines/gemini.server";
import { translationTimeoutMs } from "~/lib/llm/request-timeout";

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); resetThinkingFallbacks(); });
const response = { text: "Translated.", candidates: [{ finishReason: FinishReason.STOP }] };

describe("Gemini deadlines", () => {
  it("scales the visible-output deadline from two minutes up to fifteen", () => {
    expect(translationTimeoutMs(2048)).toBe(120_000);
    expect(translationTimeoutMs(21_024)).toBe(410_400);
    expect(translationTimeoutMs(64_000)).toBe(900_000);
  });

  it.each([10, 10_000, 100_000])("passes matching HTTP and abort deadlines for a %i-character post", async length => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const generateContent = vi.fn(async () => response);
    await createGeminiEngine({ client: { models: { generateContent } } }).translate({ text: "a".repeat(length), from: "en", to: "ja", field: "body", postTranslation: true });
    const expected = length === 10 ? 120_000 : length === 10_000 ? 410_400 : 900_000;
    expect(timeout).toHaveBeenCalledWith(expected);
    const config = (generateContent.mock.calls[0] as unknown as [Parameters<GeminiClient["models"]["generateContent"]>[0]])[0].config!;
    expect(config.httpOptions!.timeout).toBeGreaterThanOrEqual(expected - 20);
    expect(config.httpOptions!.timeout).toBeLessThanOrEqual(expected);
    expect(config.abortSignal!.aborted).toBe(false);
  });

  it.each([{}, { chat: { context: [] } }, { village: "description" as const }, { invitationNote: true }, { figure: true }])("keeps interactive translation at two minutes: %j", async extra => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const generateContent = vi.fn(async () => response);
    await createGeminiEngine({ client: { models: { generateContent } } }).translate({ text: "a".repeat(100_000), from: "en", to: "ja", ...extra });
    expect(timeout).toHaveBeenCalledWith(120_000);
  });

  it("keeps ordinary completions at two minutes regardless of output size", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    await geminiComplete({ models: { generateContent: async () => response } }, { model: "fake", system: "", user: "", maxOutputTokens: 64_000 });
    expect(timeout).toHaveBeenCalledWith(120_000);
  });

  it("shares one abort signal and remaining HTTP time across thinking fallbacks", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const generateContent = vi.fn<GeminiClient["models"]["generateContent"]>()
      .mockImplementationOnce(async () => { now += 180_000; throw Object.assign(new Error("thinking setting unsupported"), { status: 400 }); })
      .mockResolvedValue(response);
    await createGeminiEngine({ client: { models: { generateContent } }, thinking: "off" }).translate({ text: "a".repeat(100_000), from: "en", to: "ja", postTranslation: true });
    expect(timeout).toHaveBeenCalledTimes(1);
    const configs = generateContent.mock.calls.map(([params]) => params.config!);
    expect(configs[0].abortSignal).toBe(configs[1].abortSignal);
    expect(configs[0].httpOptions!.timeout).toBe(900_000);
    expect(configs[1].httpOptions!.timeout).toBe(720_000);
  });
});
