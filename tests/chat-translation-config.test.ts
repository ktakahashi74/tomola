import { expect, it, vi } from "vitest";
import { FinishReason } from "@google/genai";
import { assertStartupConfig, assertNoFakeEngines } from "~/lib/startup-checks.server";
import { chatTranslationConcurrency, resolveEngines } from "~/lib/llm/config.server";
import { resetThinkingFallbacks } from "~/lib/llm/engines/gemini.server";
import { chatMonthlyBudgetMicro } from "~/lib/llm/usage.server";

const flags = { NODE_ENV: "test", VILLAGES: "1", VILLAGE_CHAT: "1" };
it("validates chat configuration only behind its gate", () => {
  for (const [name, bad] of [["CHAT_TRANSLATION_CONCURRENCY", "0"], ["CHAT_TRANSLATION_CONCURRENCY", "1.5"], ["CHAT_TRANSLATION_THINKING", "high"], ["CHAT_LLM_MONTHLY_BUDGET_USD", "-1"], ["CHAT_LLM_MONTHLY_BUDGET_USD", "Infinity"], ["CHAT_TRANSLATION_MODEL", "claude-wrong-provider"]]) {
    const env = { ...flags, TRANSLATION_PRIMARY: "gemini", GEMINI_API_KEY: "test-key", [name]: bad };
    expect(() => assertStartupConfig({ TOMOLA_OPERATOR_DIR: process.env.TOMOLA_OPERATOR_DIR, ...env })).toThrow(name);
    expect(() => assertStartupConfig({ TOMOLA_OPERATOR_DIR: process.env.TOMOLA_OPERATOR_DIR, ...env, VILLAGE_CHAT: "" })).not.toThrow();
  }
  expect(chatMonthlyBudgetMicro({})).toBe(2_000_000); expect(chatMonthlyBudgetMicro({ CHAT_LLM_MONTHLY_BUDGET_USD: "0" })).toBe(0);
});
it("caps chat concurrency to fit bounded connection pools", () => {
  expect(chatTranslationConcurrency({ CHAT_TRANSLATION_CONCURRENCY: "16" })).toBe(16);
  for (const value of ["17", "32", "1000000"]) {
    expect(() => chatTranslationConcurrency({ CHAT_TRANSLATION_CONCURRENCY: value })).toThrow("16");
    expect(() => assertStartupConfig({ TOMOLA_OPERATOR_DIR: process.env.TOMOLA_OPERATOR_DIR, ...flags, CHAT_TRANSLATION_CONCURRENCY: value })).toThrow("16");
    expect(() => assertStartupConfig({ TOMOLA_OPERATOR_DIR: process.env.TOMOLA_OPERATOR_DIR, ...flags, VILLAGE_CHAT: "", CHAT_TRANSLATION_CONCURRENCY: value })).not.toThrow();
  }
});
it("names chat thinking in call logs and fallback warnings without logging rejected source data", async () => {
  resetThinkingFallbacks(); const lines: string[] = [];
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  let calls = 0;
  try {
    const engines = resolveEngines({ ...flags, TRANSLATION_PRIMARY: "gemini", CHAT_TRANSLATION_MODEL: "gemini-chat-config-test" }, {
      log: line => lines.push(line), geminiClient: { models: { async generateContent() {
        if (++calls === 1) throw Object.assign(new Error("Invalid thinking_level: MINIMAL is not supported. Private source data."), { status: 400 });
        return { text: "Hello", candidates: [{ finishReason: FinishReason.STOP }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } };
      } } },
    });
    await engines.chat!.translate({ text: "こんにちは", from: "ja", to: "en", chat: { context: [] } });
    expect(lines.join("\n")).toContain("CHAT_TRANSLATION_THINKING=off");
    expect(String(warning.mock.calls[0][0])).toContain("CHAT_TRANSLATION_THINKING=off");
    expect(String(warning.mock.calls[0][0])).not.toContain("Private source data");
  } finally { warning.mockRestore(); resetThinkingFallbacks(); }
});
it("uses independent chat model/thinking and rejects production fake chat", () => {
  const set = resolveEngines({ ...flags, TRANSLATION_PRIMARY: "gemini", GEMINI_API_KEY: "test-key", TRANSLATION_GEMINI_MODEL: "gemini-3.8-flash", GEMINI_TRANSLATION_THINKING: "low" });
  expect(set.primary.model).toBe("gemini-3.8-flash"); expect(set.primary.thinkingSetting).toBe("low");
  expect(set.chat!.model).toBe("gemini-3.5-flash-lite"); expect(set.chat!.thinkingSetting).toBe("off");
  expect(() => assertNoFakeEngines({ ...flags, NODE_ENV: "production", TRANSLATION_PRIMARY: "fake" })).toThrow("the chat translation engine");
});
