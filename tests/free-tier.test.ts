import { afterEach, describe, expect, it, vi } from "vitest";
import { createGeminiEmbeddingEngine } from "~/lib/llm/engines/gemini-embedding.server";
import { createGeminiEngine, FREE_TIER_WARNING, looksLikeFreeTierError, noteFreeTierKey, resetFreeTierWarning } from "~/lib/llm/engines/gemini.server";

// Detect free-tier Gemini keys (app/lib/llm/engines/gemini.server.ts): unusable in production because of roughly 20 daily requests and input handling. Detect API error text and warn once.
// Actual Google API 429 response text obtained during this repository's i18n run.
const REAL_429 =
  '{"error":{"code":429,"message":"You exceeded your current quota, please check your plan and billing details. \\n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 20, model: gemini-3.5-flash\\nPlease retry in 49s.","status":"RESOURCE_EXHAUSTED","details":[{"quotaId":"GenerateRequestsPerDayPerProjectPerModel-FreeTier","quotaValue":"20"}]}}';

afterEach(() => resetFreeTierWarning());

describe("looksLikeFreeTierError", () => {
  it("recognizes the free-tier quota answers of the Gemini API", () => {
    expect(looksLikeFreeTierError(new Error(REAL_429))).toBe(true);
    expect(looksLikeFreeTierError(new Error("Quota exceeded for metric: generate_content_free_tier_requests"))).toBe(true);
    expect(looksLikeFreeTierError(new Error("quotaId GenerateRequestsPerDayPerProjectPerModel-FreeTier"))).toBe(true);
    expect(looksLikeFreeTierError("PerDay... FreeTier")).toBe(true);
    expect(looksLikeFreeTierError(new Error("free tier"))).toBe(true);
  });

  it("does not take other failures for a free-tier key", () => {
    expect(looksLikeFreeTierError(new Error('{"error":{"code":503,"message":"This model is currently experiencing high demand.","status":"UNAVAILABLE"}}'))).toBe(false);
    expect(looksLikeFreeTierError(new Error("API key not valid. Please pass a valid API key."))).toBe(false);
    expect(looksLikeFreeTierError(new Error("Resource has been exhausted (e.g. check quota)."))).toBe(false);
    expect(looksLikeFreeTierError(undefined)).toBe(false);
    expect(looksLikeFreeTierError({ message: "free_tier" })).toBe(false);
  });
});

describe("noteFreeTierKey", () => {
  it("logs the warning once per process, and only for a free-tier error", () => {
    const log = vi.fn();
    expect(noteFreeTierKey(new Error("503 high demand"), log)).toBe(false);
    expect(noteFreeTierKey(new Error(REAL_429), log)).toBe(true);
    expect(noteFreeTierKey(new Error(REAL_429), log)).toBe(false);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toBe(FREE_TIER_WARNING);
    expect(FREE_TIER_WARNING).toMatch(/^\[llm\] GEMINI_API_KEY looks like a free-tier key/);
    expect(FREE_TIER_WARNING).toContain("billing enabled");
  });
});

describe("the engines", () => {
  it("log the warning when a translation call fails with a free-tier error, and still throw the error", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const failing = { models: { generateContent: vi.fn(async () => Promise.reject(new Error(REAL_429))) } };
      const engine = createGeminiEngine({ client: failing as never });
      await expect(engine.translate({ text: "x", from: "ja", to: "en" })).rejects.toThrow(/free_tier/);
      await expect(engine.translate({ text: "y", from: "ja", to: "en" })).rejects.toThrow(/free_tier/);
      expect(spy.mock.calls.filter((c) => String(c[0]).includes("looks like a free-tier key"))).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("log it for the embedding engine as well", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const failing = { models: { embedContent: vi.fn(async () => Promise.reject(new Error(REAL_429))) } };
      const engine = createGeminiEmbeddingEngine({ client: failing as never });
      await expect(engine.embed({ text: "x", task: "query" })).rejects.toThrow(/free_tier/);
      expect(spy.mock.calls.filter((c) => String(c[0]).includes("looks like a free-tier key"))).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("stay quiet for other errors", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const failing = { models: { generateContent: vi.fn(async () => Promise.reject(new Error("503 UNAVAILABLE"))) } };
      await expect(createGeminiEngine({ client: failing as never }).translate({ text: "x", from: "ja", to: "en" })).rejects.toThrow(/503/);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
