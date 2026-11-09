import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenAI } from "@google/genai";
import { describe, expect, it, vi } from "vitest";
import { createClaudeEngine } from "~/lib/llm/engines/claude.server";
import { createGeminiEmbeddingEngine, type GeminiEmbeddingClient } from "~/lib/llm/engines/gemini-embedding.server";
import { createGeminiEngine, geminiComplete, resetThinkingFallbacks } from "~/lib/llm/engines/gemini.server";
import { createGeminiJudge, judgeTokenLimit } from "~/lib/llm/judge.server";
import { THINKING_HEADROOM } from "~/lib/llm/thinking";
import type { JudgeRequest } from "~/lib/llm/types";
import { createClaudeJudge } from "~/lib/llm/judge.server";

// Inject fake fetch into real SDK clients; interception at HTTP prevents network access.
// Verify the SDK accepts request parameter placement and timeout handling, and
// that our validation reads actual response shapes.
type Captured = { url: string; method: string; headers: Headers; body: any };

function capture(respond: (body: any) => unknown) {
  const calls: Captured[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method: init?.method ?? "GET", headers: new Headers(init?.headers), body });
    return new Response(JSON.stringify(respond(body)), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { fetch: fetch as typeof globalThis.fetch, calls };
}

it.each(["claude", "gemini", "embedding"] as const)("cancels an in-flight %s SDK request when the job is aborted", async kind => {
  const abort = new AbortController();
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const fetch = vi.fn((_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init!.signal!.addEventListener("abort", () => reject(new DOMException("job aborted", "AbortError")), { once: true });
    entered();
  }));
  const request = { text: "source", from: "en" as const, to: "ja" as const, signal: abort.signal };
  const google = new GoogleGenAI({ apiKey: "test", httpOptions: { fetch, retryOptions: { attempts: 5 } } });
  const running = kind === "claude"
    ? createClaudeEngine({ client: new Anthropic({ apiKey: "test", fetch, maxRetries: 2 }) }).translate(request)
    : kind === "gemini" ? createGeminiEngine({ client: google }).translate(request)
    : createGeminiEmbeddingEngine({ client: google }).embed({ text: "source", task: "query", signal: abort.signal });
  // Attach the rejection assertion before aborting to avoid an unhandled rejection.
  const stopped = expect(running).rejects.toThrow();
  await started;
  abort.abort();
  await stopped;
  expect(fetch).toHaveBeenCalledTimes(1);
});

describe("@anthropic-ai/sdk (real client, fake fetch)", () => {
  it("keeps the two-minute deadline while reading the response body after headers arrive", async () => {
    vi.useFakeTimers();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
      const deadline = new AbortController();
      setTimeout(() => deadline.abort(new DOMException("request deadline", "TimeoutError")), ms);
      return deadline.signal;
    });
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    let failBody: () => void = () => {};
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => new Response(new ReadableStream({
      start(controller) {
        failBody = () => { try { controller.error(new DOMException("body aborted", "AbortError")); } catch {} };
        init!.signal!.addEventListener("abort", failBody, { once: true });
        entered();
      },
    }), { headers: { "content-type": "application/json" } }));
    const client = new Anthropic({ apiKey: "test", fetch, maxRetries: 0 });
    let settled = false;
    const result = createClaudeEngine({ client }).translate({ text: "source", from: "en", to: "ja" })
      .then(value => { settled = true; return value; }, error => { settled = true; return error as Error; });
    try {
      await started;
      expect(timeout).toHaveBeenCalledWith(120_000);
      await vi.advanceTimersByTimeAsync(119_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await result).toMatchObject({ name: "TimeoutError" });
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      failBody(); await result;
      timeout.mockRestore(); vi.useRealTimers();
    }
  });
  it("does not retry a 429 even when the supplied SDK client enables retries", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "rate limited" } }), { status: 429, headers: { "content-type": "application/json" } }));
    const client = new Anthropic({ apiKey: "test", fetch, maxRetries: 2 });
    await expect(createClaudeEngine({ client }).translate({ text: "source", from: "en", to: "ja" })).rejects.toMatchObject({ status: 429 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  const message = (text: string, extra: Record<string, unknown> = {}) => ({
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-haiku-4-5",
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    stop_sequence: null,
    stop_details: null,
    usage: { input_tokens: 42, output_tokens: 7, cache_creation_input_tokens: null, cache_read_input_tokens: null },
    ...extra,
  });

  it("posts a Messages API request in the documented shape and reads the response", async () => {
    const { fetch, calls } = capture(() => message("Hello $x$"));
    const client = new Anthropic({ apiKey: "test-key", fetch, maxRetries: 0 });
    const result = await createClaudeEngine({ client }).translate({ text: "こんにちは $x$", from: "ja", to: "en", title: "T" });
    expect(result).toMatchObject({ text: "Hello $x$", model: "claude-haiku-4-5", inputTokens: 42, outputTokens: 7 });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.anthropic.com/v1/messages");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].headers.get("authorization")).toBe("Bearer test-key");
    expect(calls[0].headers.get("x-api-key")).toBeNull();
    expect(calls[0].headers.get("anthropic-version")).toBe("2026-10-21");
    expect(calls[0].body).toMatchObject({
      model: "claude-haiku-4-5",
      max_tokens: 2048,
      messages: [{ role: "user", content: expect.stringMatching(/<source-([0-9a-f]{16})>\nこんにちは \$x\$\n<\/source-\1>/) }],
    });
    expect(calls[0].body.system).toContain("from Japanese into English");
    expect(calls[0].body.stream).toBeUndefined();
    for (const key of ["temperature", "top_p", "top_k"]) expect(calls[0].body).not.toHaveProperty(key);
  });

  it.each(["claude-sonnet-4-6", "claude-sonnet-5-5", "claude-opus-5-5", "claude-future-9"])("omits removed sampling parameters for %s", async model => {
    const { fetch, calls } = capture(() => message("Hello"));
    const client = new Anthropic({ apiKey: "test-key", fetch, maxRetries: 0 });
    await createClaudeEngine({ client, model }).translate({ text: "こんにちは", from: "ja", to: "en" });
    expect(calls).toHaveLength(1);
    expect(calls[0].body.model).toBe(model);
    for (const key of ["temperature", "top_p", "top_k"]) expect(calls[0].body).not.toHaveProperty(key);
  });

  it("does not trip the SDK's non-streaming guard for a very long body (max_tokens 64000)", async () => {
    const { fetch, calls } = capture(() => message("ok"));
    const client = new Anthropic({ apiKey: "test-key", fetch, maxRetries: 0 });
    await createClaudeEngine({ client }).translate({ text: "あ".repeat(50_000), from: "ja", to: "en" });
    expect(calls[0].body.max_tokens).toBe(64_000);
  });

  it("surfaces a refusal and a cut-off as errors that keep the usage", async () => {
    const refusal = capture(() => message("", { content: [], stop_reason: "refusal", stop_details: { type: "refusal", category: "cyber", explanation: null } }));
    const client = new Anthropic({ apiKey: "k", fetch: refusal.fetch, maxRetries: 0 });
    await expect(createClaudeEngine({ client }).translate({ text: "x", from: "ja", to: "en" })).rejects.toMatchObject({
      code: "refusal",
      message: expect.stringContaining("cyber"),
      usage: { inputTokens: 42, outputTokens: 7 },
    });
    const cut = capture(() => message("partial", { stop_reason: "max_tokens" }));
    const client2 = new Anthropic({ apiKey: "k", fetch: cut.fetch, maxRetries: 0 });
    await expect(createClaudeEngine({ client: client2 }).translate({ text: "x", from: "ja", to: "en" })).rejects.toMatchObject({ code: "truncated" });
  });

  it("runs the judge through the same client", async () => {
    const { fetch, calls } = capture(() => message('```json\n{"divergences":[{"sentence":0,"severity":"low","note":"tone"}]}\n```'));
    const client = new Anthropic({ apiKey: "k", fetch, maxRetries: 0 });
    const out = await createClaudeJudge({ client }).judge({ segments: ["一。"], from: "ja", to: "en", translationA: "A", translationB: "B" });
    expect(out.divergences).toEqual([{ sentence: 0, severity: "low", category: "meaning", note: "tone" }]);
    expect(calls[0].body.max_tokens).toBe(1024);
  });
});

describe("@google/genai (real client, fake fetch)", () => {
  it("does not retry a 503 even when the supplied SDK client enables retries", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ error: { code: 503, message: "unavailable", status: "UNAVAILABLE" } }), { status: 503, headers: { "content-type": "application/json" } }));
    const client = new GoogleGenAI({ apiKey: "test", httpOptions: { fetch, retryOptions: { attempts: 5 } } });
    await expect(createGeminiEngine({ client }).translate({ text: "source", from: "en", to: "ja" })).rejects.toMatchObject({ status: 503 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  const response = (text: string, extra: Record<string, unknown> = {}, usage: Record<string, unknown> = {}) => ({
    candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason: "STOP", index: 0, ...extra }],
    usageMetadata: { promptTokenCount: 55, candidatesTokenCount: 9, totalTokenCount: 64, ...usage },
    modelVersion: "gemini-3.5-flash-lite",
  });
  const client = (respond: (body: any) => unknown) => {
    const { fetch, calls } = capture(respond);
    return { ai: new GoogleGenAI({ apiKey: "test-key", httpOptions: { fetch } }), calls };
  };

  it("posts generateContent with the system instruction and generation config, and reads text and usage", async () => {
    const { ai, calls } = client(() => response("Hello $x$"));
    const result = await createGeminiEngine({ client: ai }).translate({ text: "こんにちは $x$", from: "ja", to: "en", context: "parent" });
    expect(result).toMatchObject({ text: "Hello $x$", model: "gemini-3.5-flash-lite", inputTokens: 55, outputTokens: 9 });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("/models/gemini-3.5-flash-lite:generateContent");
    expect(calls[0].headers.get("x-goog-api-key")).toBe("test-key");
    expect(calls[0].body.systemInstruction.parts[0].text).toContain("from Japanese into English");
    expect(calls[0].body.contents[0].parts[0].text).not.toContain("parent");
    expect(calls[0].body.generationConfig).toMatchObject({ maxOutputTokens: 2048 + THINKING_HEADROOM.MINIMAL, thinkingConfig: { thinkingLevel: "MINIMAL" } });
  });

  it("counts thinking tokens as output and treats a MAX_TOKENS finish and a safety stop as errors", async () => {
    const thinking = client(() => response("ok", {}, { thoughtsTokenCount: 30 }));
    expect((await createGeminiEngine({ client: thinking.ai }).translate({ text: "x", from: "ja", to: "en" })).outputTokens).toBe(39);
    const cut = client(() => response("par", { finishReason: "MAX_TOKENS" }));
    await expect(createGeminiEngine({ client: cut.ai }).translate({ text: "x", from: "ja", to: "en" })).rejects.toMatchObject({
      code: "truncated",
      usage: { inputTokens: 55, outputTokens: 9 },
    });
    const safety = client(() => response("", { finishReason: "SAFETY" }));
    await expect(createGeminiEngine({ client: safety.ai }).translate({ text: "x", from: "ja", to: "en" })).rejects.toMatchObject({ code: "refusal", retryable: false });
    // OTHER and RECITATION are retryable errors, not refusals.
    for (const finishReason of ["OTHER", "RECITATION"]) {
      const other = client(() => response("x", { finishReason }));
      await expect(createGeminiEngine({ client: other.ai }).translate({ text: "x", from: "ja", to: "en" })).rejects.toMatchObject({
        code: "invalid_output",
        retryable: true,
        usage: { inputTokens: 55, outputTokens: 9 },
      });
    }
  });

  it("treats a blocked prompt as a refusal", async () => {
    const { ai } = client(() => ({ promptFeedback: { blockReason: "PROHIBITED_CONTENT" }, usageMetadata: { promptTokenCount: 12 } }));
    await expect(createGeminiEngine({ client: ai }).translate({ text: "x", from: "ja", to: "en" })).rejects.toMatchObject({
      code: "refusal",
      usage: { inputTokens: 12, outputTokens: 0 },
    });
  });
});

describe("@google/genai embeddings (real client, fake fetch)", () => {
  const values = (n: number) => Array.from({ length: n }, (_, i) => (i % 5) + 1);
  const client = (respond: (body: any) => unknown) => {
    const { fetch, calls } = capture(respond);
    return { ai: new GoogleGenAI({ apiKey: "test-key", httpOptions: { fetch } }), calls };
  };

  it("posts embedContent for gemini-embedding-001 with the task type, title and 768 dimensions, and reads the vector", async () => {
    const { ai, calls } = client(() => ({ embeddings: [{ values: values(768) }] }));
    const engine = createGeminiEmbeddingEngine({ client: ai as unknown as GeminiEmbeddingClient });
    const doc = await engine.embed({ text: "本文です。", title: "題です", task: "document" });
    expect(doc.vector).toHaveLength(768);
    expect(Math.hypot(...doc.vector)).toBeCloseTo(1, 10);
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toContain("/models/gemini-embedding-001:");
    expect(calls[0].headers.get("x-goog-api-key")).toBe("test-key");
    // Gemini Developer API shape: requests[] with model, content.parts[].text, taskType, title and outputDimensionality.
    const request = calls[0].body.requests[0];
    expect(request).toMatchObject({ model: "models/gemini-embedding-001", taskType: "RETRIEVAL_DOCUMENT", title: "題です", outputDimensionality: 768 });
    expect(request.content.parts[0].text).toBe("本文です。");
    const query = await engine.embed({ text: "cooperation", task: "query" });
    expect(query.vector).toHaveLength(768);
    expect(calls[1].body.requests[0]).toMatchObject({ taskType: "RETRIEVAL_QUERY", outputDimensionality: 768 });
    expect(calls[1].body.requests[0]).not.toHaveProperty("title");
  });

  it("rejects a response with another number of dimensions", async () => {
    const { ai } = client(() => ({ embeddings: [{ values: values(3072) }] }));
    await expect(createGeminiEmbeddingEngine({ client: ai as unknown as GeminiEmbeddingClient }).embed({ text: "x", task: "query" })).rejects.toMatchObject({ code: "invalid_output" });
  });
});

describe("Gemini thinking setting (real client, fake fetch)", () => {
  const ok = (usage: Record<string, unknown> = {}) => ({
    candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP", index: 0 }],
    usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 5, ...usage },
  });
  // answers with the status the callback picks for the request body (the SDK throws an ApiError for a non-2xx status)
  function fetching(answer: (body: any, n: number) => { status: number; json: unknown }) {
    const calls: Array<{ url: string; body: any }> = [];
    const fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url, body });
      const { status, json } = answer(body, calls.length);
      return new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } });
    };
    const ai = new GoogleGenAI({ apiKey: "k", httpOptions: { fetch: fetch as typeof globalThis.fetch } });
    return { ai, calls, generateContent: vi.spyOn(ai.models, "generateContent") };
  }
  const level = (body: any) => body.generationConfig.thinkingConfig?.thinkingLevel;
  // the API's answer to a level the model does not take: a 400 that is about the thinking configuration
  const rejected = { status: 400, json: { error: { code: 400, message: "Invalid value at 'generation_config.thinking_config.thinking_level': MINIMAL is not supported by this model.", status: "INVALID_ARGUMENT" } } };
  // a 400 about something else
  const otherBadRequest = { status: 400, json: { error: { code: 400, message: "Request contains an invalid argument.", status: "INVALID_ARGUMENT" } } };
  const req = { text: "x", from: "ja", to: "en" } as const;

  it("uses thinkingLevel without sampling overrides or thinkingBudget in the config and HTTP request", async () => {
    const off = fetching(() => ({ status: 200, json: ok() }));
    await createGeminiEngine({ client: off.ai }).translate(req);
    expect(off.calls[0].body.generationConfig.thinkingConfig).toEqual({ thinkingLevel: "MINIMAL" });
    const low = fetching(() => ({ status: 200, json: ok() }));
    await createGeminiEngine({ client: low.ai, thinking: "low" }).translate(req);
    expect(low.calls[0].body.generationConfig.thinkingConfig).toEqual({ thinkingLevel: "LOW" });
    const model = fetching(() => ({ status: 200, json: ok() }));
    await createGeminiEngine({ client: model.ai, thinking: "default", model: "gemini-3.5-flash" }).translate(req);
    expect(model.calls[0].url).toContain("/models/gemini-3.5-flash:generateContent");
    expect(model.calls[0].body.generationConfig).not.toHaveProperty("thinkingConfig");
    const fixed = fetching(() => ({ status: 200, json: ok() }));
    await geminiComplete(fixed.ai, { model: "gemini-3.5-flash", system: "s", user: "u", maxOutputTokens: 100, json: true, thinkingLevel: "LOW" });
    expect(fixed.calls[0].body.generationConfig.thinkingConfig).toEqual({ thinkingLevel: "LOW" });
    for (const stub of [off, low, model, fixed]) {
      const config = stub.generateContent.mock.calls[0][0].config;
      for (const key of ["temperature", "topP", "topK", "thinkingBudget", "thinkingConfig.thinkingBudget"]) {
        expect(config).not.toHaveProperty(key);
        expect(stub.calls[0].body.generationConfig).not.toHaveProperty(key);
      }
    }
  });

  it("reports the thinking tokens and the level that was sent, and logs one line per call", async () => {
    const { ai } = fetching(() => ({ status: 200, json: ok({ thoughtsTokenCount: 30 }) }));
    const lines: string[] = [];
    const result = await createGeminiEngine({ client: ai, thinking: "low", log: (l) => lines.push(l) }).translate(req);
    expect(result).toMatchObject({ inputTokens: 50, outputTokens: 35, thoughtTokens: 30, thinking: "LOW" });
    expect(lines).toEqual(["[llm] translate gemini gemini-3.5-flash-lite GEMINI_TRANSLATION_THINKING=low level=LOW input=50 output=35 thinking_tokens=30"]);
  });

  it("logs a call that came back unusable (cut off) with its tokens and the error", async () => {
    const cut = fetching(() => ({ status: 200, json: { ...ok({ thoughtsTokenCount: 2000 }), candidates: [{ content: { role: "model", parts: [] }, finishReason: "MAX_TOKENS", index: 0 }] } }));
    const lines: string[] = [];
    await expect(createGeminiEngine({ client: cut.ai, log: (l) => lines.push(l) }).translate(req)).rejects.toMatchObject({ code: "truncated", usage: { thoughtTokens: 2000 } });
    expect(lines).toEqual(["[llm] translate gemini gemini-3.5-flash-lite GEMINI_TRANSLATION_THINKING=off error=truncated input=50 output=2005 thinking_tokens=2000"]);
  });

  it("walks down MINIMAL, LOW, no thinkingConfig when the API rejects a level, and remembers what worked for that model", async () => {
    resetThinkingFallbacks();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { ai, calls } = fetching((body) => (level(body) === "MINIMAL" ? rejected : { status: 200, json: ok() }));
      const engine = createGeminiEngine({ client: ai, model: "model-without-minimal", log: () => {} });
      const first = await engine.translate(req);
      expect(calls.map((c) => level(c.body) ?? "none")).toEqual(["MINIMAL", "LOW"]);
      expect(first).toMatchObject({ thinking: "LOW" });
      // the next call starts at LOW (one request), and the notice is printed once
      await engine.translate(req);
      expect(calls.map((c) => level(c.body) ?? "none")).toEqual(["MINIMAL", "LOW", "LOW"]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toMatch(/model-without-minimal did not accept thinking level MINIMAL for GEMINI_TRANSLATION_THINKING=off \(the API said: .*thinking_level.*\); using LOW/);
      // another model is not affected
      const other = fetching(() => ({ status: 200, json: ok() }));
      await createGeminiEngine({ client: other.ai, model: "other-model", log: () => {} }).translate(req);
      expect(level(other.calls[0].body)).toBe("MINIMAL");
    } finally {
      warn.mockRestore();
      resetThinkingFallbacks();
    }
  });

  it("falls to no thinkingConfig when LOW is rejected too, and throws the API's error if even that is rejected", async () => {
    resetThinkingFallbacks();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const noThinking = fetching((body) => (body.generationConfig.thinkingConfig ? rejected : { status: 200, json: ok() }));
      const result = await createGeminiEngine({ client: noThinking.ai, model: "no-thinking-config", log: () => {} }).translate(req);
      expect(noThinking.calls.map((c) => level(c.body) ?? "none")).toEqual(["MINIMAL", "LOW", "none"]);
      expect(result).toMatchObject({ thinking: "default" });
      const alwaysRejected = fetching(() => rejected);
      await expect(createGeminiEngine({ client: alwaysRejected.ai, model: "always-rejected", log: () => {} }).translate(req)).rejects.toMatchObject({ status: 400 });
      expect(alwaysRejected.calls).toHaveLength(3);
      // nothing was learned from a model that rejected every request
      await expect(createGeminiEngine({ client: alwaysRejected.ai, model: "always-rejected", log: () => {} }).translate(req)).rejects.toMatchObject({ status: 400 });
      expect(alwaysRejected.calls.slice(3).map((c) => level(c.body) ?? "none")).toEqual(["MINIMAL", "LOW", "none"]);
    } finally {
      warn.mockRestore();
      resetThinkingFallbacks();
    }
  });

  it("does not walk down for an error that is not a 400", async () => {
    resetThinkingFallbacks();
    const missing = fetching(() => ({ status: 404, json: { error: { code: 404, message: "model not found", status: "NOT_FOUND" } } }));
    await expect(createGeminiEngine({ client: missing.ai, log: () => {} }).translate(req)).rejects.toMatchObject({ status: 404 });
    expect(missing.calls).toHaveLength(1);
  });

  it("does not walk down for the fixed level of the messages translation (thinkingLevel without a setting)", async () => {
    const { ai, calls } = fetching(() => rejected);
    await expect(geminiComplete(ai as never, { model: "m", system: "s", user: "u", maxOutputTokens: 100, thinkingLevel: "LOW" })).rejects.toMatchObject({ status: 400 });
    expect(calls).toHaveLength(1);
    expect(level(calls[0].body)).toBe("LOW");
  });
});

describe("Gemini thinking: headroom, the judge, and the fallback rules (real client, fake fetch)", () => {
  const ok = (extra: Record<string, unknown> = {}) => ({
    candidates: [{ content: { role: "model", parts: [{ text: '{"divergences":[]}' }] }, finishReason: "STOP", index: 0 }],
    usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 5, ...extra },
  });
  function fetching(answer: (body: any, n: number) => { status: number; json: unknown }) {
    const calls: Array<{ body: any }> = [];
    const fetch = async (_input: string | URL | Request, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ body });
      const { status, json } = answer(body, calls.length);
      return new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } });
    };
    return { ai: new GoogleGenAI({ apiKey: "k", httpOptions: { fetch: fetch as typeof globalThis.fetch } }), calls };
  }
  const level = (body: any) => body.generationConfig.thinkingConfig?.thinkingLevel;
  const thinkingRejected = { status: 400, json: { error: { code: 400, message: "Thinking level MINIMAL is not supported for this model (thinking_level).", status: "INVALID_ARGUMENT" } } };
  const otherRejected = { status: 400, json: { error: { code: 400, message: "Request contains an invalid argument.", status: "INVALID_ARGUMENT" } } };
  const req = { text: "x", from: "ja", to: "en" } as const;
  const judgeReq: JudgeRequest = { segments: ["一。", "二。"], from: "ja", to: "en", translationA: "A", translationB: "B" };

  it("sizes the output headroom by the level that is sent", async () => {
    for (const [setting, headroom] of [["off", THINKING_HEADROOM.MINIMAL], ["low", THINKING_HEADROOM.LOW], ["default", THINKING_HEADROOM.default]] as const) {
      const { ai, calls } = fetching(() => ({ status: 200, json: ok() }));
      await createGeminiEngine({ client: ai, thinking: setting, log: () => {} }).translate(req);
      expect(calls[0].body.generationConfig.maxOutputTokens, setting).toBe(2048 + headroom);
    }
    expect(THINKING_HEADROOM.MINIMAL).toBeLessThan(THINKING_HEADROOM.LOW);
    expect(THINKING_HEADROOM.LOW).toBeLessThan(THINKING_HEADROOM.default);
  });

  it("uses the headroom of the rung it landed on after the API rejected a level", async () => {
    resetThinkingFallbacks();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { ai, calls } = fetching((body) => (level(body) === "MINIMAL" ? thinkingRejected : { status: 200, json: ok() }));
      await createGeminiEngine({ client: ai, model: "headroom-model", log: () => {} }).translate(req);
      expect(calls.map((c) => c.body.generationConfig.maxOutputTokens)).toEqual([2048 + THINKING_HEADROOM.MINIMAL, 2048 + THINKING_HEADROOM.LOW]);
    } finally {
      warn.mockRestore();
      resetThinkingFallbacks();
    }
  });

  it("steps down only for a 400 that is about the thinking configuration", async () => {
    resetThinkingFallbacks();
    const { ai, calls } = fetching(() => otherRejected);
    await expect(createGeminiEngine({ client: ai, model: "bad-request-model", log: () => {} }).translate(req)).rejects.toMatchObject({ status: 400 });
    expect(calls).toHaveLength(1);
  });

  it("puts the API's answer in the one-time warning, and asks for the first level again after an hour", async () => {
    resetThinkingFallbacks();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const now = vi.spyOn(Date, "now");
    try {
      let rejecting = true;
      const { ai, calls } = fetching((body) => (rejecting && level(body) === "MINIMAL" ? thinkingRejected : { status: 200, json: ok() }));
      const engine = createGeminiEngine({ client: ai, model: "reprobe-model", log: () => {} });
      now.mockReturnValue(1_000_000);
      await engine.translate(req);
      expect(String(warn.mock.calls[0][0])).toContain("Thinking level MINIMAL is not supported for this model");
      expect(String(warn.mock.calls[0][0])).toMatch(/asking for MINIMAL again in an hour/);
      // within the hour: LOW straight away
      now.mockReturnValue(1_000_000 + 59 * 60 * 1000);
      await engine.translate(req);
      expect(calls.map((c) => level(c.body))).toEqual(["MINIMAL", "LOW", "LOW"]);
      // after the hour: asked for MINIMAL again, and the model accepts it now, so the lowered level is forgotten
      rejecting = false;
      now.mockReturnValue(1_000_000 + 61 * 60 * 1000);
      await engine.translate(req);
      expect(level(calls[3].body)).toBe("MINIMAL");
      await engine.translate(req);
      expect(level(calls[4].body)).toBe("MINIMAL");
    } finally {
      now.mockRestore();
      warn.mockRestore();
      resetThinkingFallbacks();
    }
  });

  it("gives the Gemini judge the thinking level (off by default) and the headroom, with JSON output", async () => {
    for (const [thinking, expected, headroom] of [[undefined, "MINIMAL", THINKING_HEADROOM.MINIMAL], ["low", "LOW", THINKING_HEADROOM.LOW], ["default", undefined, THINKING_HEADROOM.default]] as const) {
      const { ai, calls } = fetching(() => ({ status: 200, json: ok() }));
      const out = await createGeminiJudge({ client: ai, thinking }).judge(judgeReq);
      expect(out.divergences).toEqual([]);
      expect(level(calls[0].body), String(thinking)).toBe(expected);
      expect(calls[0].body.generationConfig.maxOutputTokens, String(thinking)).toBe(judgeTokenLimit(2) + headroom);
      expect(calls[0].body.generationConfig.responseMimeType).toBe("application/json");
      if (thinking === "default") expect(calls[0].body.generationConfig).not.toHaveProperty("thinkingConfig");
    }
  });

  it("names DIVERGENCE_JUDGE_THINKING in the judge's warning when the API rejects a level", async () => {
    resetThinkingFallbacks();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { ai } = fetching((body) => (level(body) === "MINIMAL" ? thinkingRejected : { status: 200, json: ok() }));
      await createGeminiJudge({ client: ai, model: "judge-model" }).judge(judgeReq);
      expect(String(warn.mock.calls[0][0])).toContain("DIVERGENCE_JUDGE_THINKING=off");
    } finally {
      warn.mockRestore();
      resetThinkingFallbacks();
    }
  });
});
