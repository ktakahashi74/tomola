import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveEngines } from "~/lib/llm/config.server";
import { claudeRequestShape, createClaudeEngine, type ClaudeClient, type ClaudeMessage } from "~/lib/llm/engines/claude.server";
import { createGeminiEngine, type GeminiClient, type GeminiResponse } from "~/lib/llm/engines/gemini.server";
import { isRetryConfigured } from "~/lib/llm/index.server";
import { PROMPT_VERSION } from "~/lib/llm/prompt.server";
import { priceFor } from "~/lib/llm/pricing.server";
import { currentRetryCaps, retryCaps } from "~/lib/llm/retry-caps.server";
import { assertStartupConfig as startupConfig, RETRY_MODEL_SAME_AS_PRIMARY_WARNING, RETRY_MODEL_WARNING, warnIfNoRetryModel, warnIfRetryModelIsPrimary } from "~/lib/startup-checks.server";
import type { TranslationRequest } from "~/lib/llm/types";

// Production startup also checks the review counts of the UI strings that the build embeds (a test worktree has none): hand it a clean ja/en.
const CLEAN_COUNTS = { ja: { unverified: 0, unverifiedPublic: 0, missing: 0, stale: 0 }, en: { unverified: 0, unverifiedPublic: 0, missing: 0, stale: 0 } };
const assertStartupConfig = (env: Record<string, string | undefined>, log?: (message: string) => void) => startupConfig({ TOMOLA_OPERATOR_DIR: process.env.TOMOLA_OPERATOR_DIR, ...env }, log, { reviewCounts: CLEAN_COUNTS });


// TRANSLATION_RETRY_MODEL selects automatic retranslation after a report. Use a model from the same provider as the primary, such as Claude claude-sonnet-5-5 during testing or a higher-tier Gemini model in production.
// If unset, there is no automatic retranslation and reports go directly to moderators. Production startup warns but does not error.
// Do not call real APIs. Fake clients verify Claude and Gemini request shapes, as with embeddings.

afterEach(() => vi.restoreAllMocks());

const req: TranslationRequest = { text: "こんにちは", from: "ja", to: "zh-Hant", title: "題", report: { excerpt: "x", note: "y" } };

function claudeStub() {
  const create = vi.fn(async (_body: unknown, _options?: unknown) => ({ content: [{ type: "text", text: "你好", citations: null }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 } }) as unknown as ClaudeMessage);
  return { client: { messages: { create } } satisfies ClaudeClient, create };
}

function geminiStub() {
  const generateContent = vi.fn(async (_params: unknown) => ({ text: "你好", candidates: [{ finishReason: "STOP" }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } }) as unknown as GeminiResponse);
  return { client: { models: { generateContent } } satisfies GeminiClient, generateContent };
}

describe("resolveEngines: the retry engine", () => {
  it("is null when TRANSLATION_RETRY_MODEL is not set (or blank), whatever the primary engine is", () => {
    expect(resolveEngines({}).retry).toBeNull();
    expect(resolveEngines({ GEMINI_API_KEY: "g" }).retry).toBeNull();
    expect(resolveEngines({ GEMINI_API_KEY: "g", TRANSLATION_RETRY_MODEL: "  " }).retry).toBeNull();
    expect(isRetryConfigured({ env: {} })).toBe(false);
    expect(isRetryConfigured({ env: { GEMINI_API_KEY: "g" } })).toBe(false);
  });

  it("is a model of the same provider as the primary engine: gemini, claude or fake", () => {
    const gemini = resolveEngines({ GEMINI_API_KEY: "g", TRANSLATION_RETRY_MODEL: "gemini-3.5-flash" });
    expect(gemini.primary).toMatchObject({ id: "gemini", model: "gemini-3.5-flash-lite" });
    expect(gemini.retry).toMatchObject({ id: "gemini", model: "gemini-3.5-flash" });
    // With Claude as primary during testing, use another Claude model and ANTHROPIC_API_KEY.
    const claude = resolveEngines({ TRANSLATION_PRIMARY: "claude", ANTHROPIC_API_KEY: "a", TRANSLATION_RETRY_MODEL: "claude-sonnet-5-5" });
    expect(claude.primary).toMatchObject({ id: "claude", model: "claude-haiku-4-5" });
    expect(claude.retry).toMatchObject({ id: "claude", model: "claude-sonnet-5-5" });
    const fake = resolveEngines({ TRANSLATION_PRIMARY: "fake", TRANSLATION_RETRY_MODEL: "fake-retry" });
    expect(fake.retry).toMatchObject({ id: "fake", model: "fake-retry" });
    expect(isRetryConfigured({ env: { TRANSLATION_PRIMARY: "claude", ANTHROPIC_API_KEY: "a", TRANSLATION_RETRY_MODEL: "claude-sonnet-5-5" } })).toBe(true);
  });

  it("refuses a model of another provider (a configuration error), and a missing key", () => {
    expect(() => resolveEngines({ GEMINI_API_KEY: "g", TRANSLATION_RETRY_MODEL: "claude-sonnet-5-5" })).toThrow(/same provider as TRANSLATION_PRIMARY \(gemini\)/);
    expect(() => resolveEngines({ TRANSLATION_PRIMARY: "claude", ANTHROPIC_API_KEY: "a", TRANSLATION_RETRY_MODEL: "gemini-3.5-flash" })).toThrow(/same provider as TRANSLATION_PRIMARY \(claude\)/);
    expect(() => resolveEngines({ TRANSLATION_PRIMARY: "claude", TRANSLATION_RETRY_MODEL: "claude-sonnet-5-5" })).toThrow("ANTHROPIC_API_KEY");
    // On configuration error, accept reports without retranslation and route to moderators. Log the reason once in development rather than silently proceeding; production stops at startup.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const wrong = { env: { GEMINI_API_KEY: "g", TRANSLATION_RETRY_MODEL: "claude-sonnet-9-9" } };
    expect(isRetryConfigured(wrong)).toBe(false);
    expect(isRetryConfigured(wrong)).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("reports go straight to the moderators");
    expect(String(warn.mock.calls[0][0])).toContain("TRANSLATION_RETRY_MODEL must be a model of the same provider as TRANSLATION_PRIMARY (gemini)");
  });

  it("uses the test engines that are passed in, and none when the engine set has no retry engine", () => {
    expect(isRetryConfigured({ engines: { primary: resolveEngines({}).primary, secondary: null, judge: null } })).toBe(false);
    expect(isRetryConfigured({ engines: { primary: resolveEngines({}).primary, secondary: null, judge: null, retry: resolveEngines({ TRANSLATION_PRIMARY: "fake", TRANSLATION_RETRY_MODEL: "fake-retry" }).retry } })).toBe(true);
  });
});

describe("the Claude engine with the retry model (request shapes with a fake client)", () => {
  it("sends the retry model of the claude-sonnet-5-5 generation without temperature, and with thinking turned off the way that model allows", async () => {
    const { client, create } = claudeStub();
    const engine = createClaudeEngine({ model: "claude-sonnet-5-5", client });
    expect(engine).toMatchObject({ id: "claude", model: "claude-sonnet-5-5" });
    const out = await engine.translate(req);
    expect(out).toMatchObject({ text: "你好", model: "claude-sonnet-5-5", promptVersion: PROMPT_VERSION, inputTokens: 10, outputTokens: 5 });
    const [body, options] = create.mock.calls[0] as unknown as [Record<string, unknown>, { timeout: number }];
    expect(body).toMatchObject({ model: "claude-sonnet-5-5", thinking: { type: "between_tools" } });
    expect(body).not.toHaveProperty("temperature");
    expect(body).not.toHaveProperty("output_config");
    expect(typeof body.max_tokens).toBe("number");
    expect(body.messages).toEqual([{ role: "user", content: expect.stringContaining("<source-") }]);
    expect(String(body.system)).toContain("Target language:");
    expect(String(body.system)).toContain("Taiwan");
    // Member report text never enters the model request.
    const user = (body.messages as Array<{ content: string }>)[0].content;
    expect(user).not.toContain("<report_excerpt-");
    expect(user).not.toContain("<report_note-");
    expect(options.timeout).toBeGreaterThan(60_000);
  });

  it("omits temperature for Haiku 4.5, and asks the models that cannot turn thinking off for low effort with room for it", async () => {
    const haiku = claudeStub();
    await createClaudeEngine({ client: haiku.client }).translate(req);
    expect(haiku.create.mock.calls[0][0]).toMatchObject({ model: "claude-haiku-4-5" });
    expect(haiku.create.mock.calls[0][0]).not.toHaveProperty("temperature");
    expect(haiku.create.mock.calls[0][0]).not.toHaveProperty("thinking");
    expect(haiku.create.mock.calls[0][0]).not.toHaveProperty("output_config");

    const opus = claudeStub();
    await createClaudeEngine({ model: "claude-opus-5-5", client: opus.client }).translate(req);
    const body = opus.create.mock.calls[0][0] as unknown as Record<string, unknown>;
    expect(body).toMatchObject({ model: "claude-opus-5-5", output_config: { effort: "low" } });
    expect(body).not.toHaveProperty("temperature");
    expect(body).not.toHaveProperty("thinking");
    const plain = claudeStub();
    await createClaudeEngine({ model: "claude-haiku-4-5", client: plain.client }).translate(req);
    expect(body.max_tokens as number).toBeGreaterThan((plain.create.mock.calls[0][0] as unknown as { max_tokens: number }).max_tokens);
  });

  it("keeps model-specific thinking and output limits, with no thinking field where it is off by default", () => {
    const shape = (model: string) => claudeRequestShape(model);
    for (const model of ["claude-haiku-4-5", "claude-haiku-4-5-20251001", "claude-sonnet-4-6", "claude-opus-4-6", "claude-sonnet-4-5", "claude-opus-4-7", "claude-opus-4-8", "claude-future-9"]) expect(shape(model), model).toEqual({ extraMaxTokens: 0 });
    expect(shape("claude-sonnet-5-5").thinking).toEqual({ type: "between_tools" });
    expect(shape("claude-sonnet-5").thinking).toEqual({ type: "disabled" });
    expect(shape("claude-opus-4-8").thinking).toBeUndefined();
    expect(shape("claude-opus-5-5")).toMatchObject({ effort: "low" });
    expect(shape("claude-sonnet-5-5-20260101").thinking).toEqual({ type: "between_tools" });
  });

  it("is priced in the table (claude-sonnet-5-5 and claude-opus-5-5), not at the safe fallback", () => {
    expect(priceFor("claude-sonnet-5-5", {}).source).toBe("table");
    expect(priceFor("claude-sonnet-5-5", {}).price).toEqual({ inputNano: 2000, outputNano: 10_000 });
    expect(priceFor("claude-opus-5-5", {}).price).toEqual({ inputNano: 4000, outputNano: 20_000 });
    expect(priceFor("claude-sonnet-5-5-20260101", {}).price).toEqual({ inputNano: 2000, outputNano: 10_000 });
  });
});

describe("the Gemini engine with the retry model (request shape with a fake client)", () => {
  it("sends the model of the retry setting, the system prompt of the target script without the reporter's words", async () => {
    const { client, generateContent } = geminiStub();
    const engine = createGeminiEngine({ model: "gemini-3.5-flash", client });
    expect(engine).toMatchObject({ id: "gemini", model: "gemini-3.5-flash" });
    const out = await engine.translate(req);
    expect(out).toMatchObject({ text: "你好", model: "gemini-3.5-flash", promptVersion: PROMPT_VERSION });
    const params = generateContent.mock.calls[0] as unknown as [{ model: string; contents: string; config: { systemInstruction: string } }];
    expect(params[0].model).toBe("gemini-3.5-flash");
    expect(params[0].config.systemInstruction).toContain("Target language:");
    expect(params[0].contents).not.toContain("<report_note-");
  });
});

describe("the startup check in production and TRANSLATION_RETRY_MODEL", () => {
  const good = {
    NODE_ENV: "production",
    BETTER_AUTH_SECRET: "x".repeat(32),
    BETTER_AUTH_URL: "https://tomola.org",
    SMTP_URL: "smtps://user:pw@smtp.example.org:465",
    MAIL_FROM: "tomola <no-reply@example.org>",
    MAIL_DECOY_TO: "test@blackhole.postmarkapp.com",
    ENABLED_LANGS: "ja,en",
    GEMINI_API_KEY: "test-key-not-used",
    DATABASE_URL: "postgres://tomola:pw@db:5432/tomola",
  };

  it("warns, and does not fail, when it is not set", () => {
    const log = vi.fn();
    expect(() => assertStartupConfig({ TOMOLA_OPERATOR_DIR: process.env.TOMOLA_OPERATOR_DIR, ...good }, log)).not.toThrow();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toBe(RETRY_MODEL_WARNING);
    expect(RETRY_MODEL_WARNING).toMatch(/WARNING/);
    expect(RETRY_MODEL_WARNING).toContain("TRANSLATION_RETRY_MODEL");
    expect(RETRY_MODEL_WARNING).toMatch(/moderators/);
    // Whitespace-only also counts as unset.
    expect(warnIfNoRetryModel({ ...good, TRANSLATION_RETRY_MODEL: "  " }, log)).toBe(true);
  });

  it("is silent when it is set, and fails for a model of another provider (a configuration error)", () => {
    const log = vi.fn();
    expect(() => assertStartupConfig({ TOMOLA_OPERATOR_DIR: process.env.TOMOLA_OPERATOR_DIR, ...good, TRANSLATION_RETRY_MODEL: "gemini-3.5-flash" }, log)).not.toThrow();
    expect(log).not.toHaveBeenCalled();
    expect(() => assertStartupConfig({ TOMOLA_OPERATOR_DIR: process.env.TOMOLA_OPERATOR_DIR, ...good, TRANSLATION_RETRY_MODEL: "claude-sonnet-5-5" }, log)).toThrow("same provider");
  });

  it("warns when the retry model is the same model as the primary one (the defaults, or the models set for the provider), and not for a higher model", () => {
    const log = vi.fn();
    // The default primary model is gemini-3.5-flash-lite.
    expect(() => assertStartupConfig({ TOMOLA_OPERATOR_DIR: process.env.TOMOLA_OPERATOR_DIR, ...good, TRANSLATION_RETRY_MODEL: "gemini-3.5-flash-lite" }, log)).not.toThrow();
    expect(log.mock.calls.map((c) => c[0])).toEqual([RETRY_MODEL_SAME_AS_PRIMARY_WARNING]);
    expect(RETRY_MODEL_SAME_AS_PRIMARY_WARNING).toMatch(/WARNING.*same model as the primary/);
    log.mockClear();
    // Match the primary model when configuration changes it.
    expect(warnIfRetryModelIsPrimary({ ...good, TRANSLATION_GEMINI_MODEL: "gemini-3.5-flash", TRANSLATION_RETRY_MODEL: "GEMINI-3.5-FLASH" }, log)).toBe(true);
    expect(warnIfRetryModelIsPrimary({ ...good, TRANSLATION_GEMINI_MODEL: "gemini-3.5-flash", TRANSLATION_RETRY_MODEL: "gemini-3.5-flash-lite" }, log)).toBe(false);
    // Claude primary defaults to claude-haiku-4-5.
    const claude = { ...good, TRANSLATION_PRIMARY: "claude", ANTHROPIC_API_KEY: "a" };
    expect(warnIfRetryModelIsPrimary({ ...claude, TRANSLATION_RETRY_MODEL: "claude-haiku-4-5" }, log)).toBe(true);
    expect(warnIfRetryModelIsPrimary({ ...claude, TRANSLATION_RETRY_MODEL: "claude-sonnet-5-5" }, log)).toBe(false);
    // Unset or invalid configuration is not covered by this warning.
    expect(warnIfRetryModelIsPrimary(good, log)).toBe(false);
    expect(warnIfRetryModelIsPrimary({ ...good, TRANSLATION_PRIMARY: "bogus", TRANSLATION_RETRY_MODEL: "x" }, log)).toBe(false);
    log.mockClear();
    assertStartupConfig({ TOMOLA_OPERATOR_DIR: process.env.TOMOLA_OPERATOR_DIR, ...good, TRANSLATION_RETRY_MODEL: "gemini-3.5-flash" }, log);
    expect(log).not.toHaveBeenCalled();
  });

  it("does not let the fake retry engine through in production, unless fake engines are allowed", () => {
    expect(() => assertStartupConfig({ TOMOLA_OPERATOR_DIR: process.env.TOMOLA_OPERATOR_DIR, ...good, TRANSLATION_PRIMARY: "gemini", TRANSLATION_RETRY_MODEL: "gemini-3.5-flash" }, vi.fn())).not.toThrow();
    // A fake primary stops startup there. Retry cannot alone be fake because it shares the primary provider, but it remains in the list of engines checked.
    expect(() => assertStartupConfig({ TOMOLA_OPERATOR_DIR: process.env.TOMOLA_OPERATOR_DIR, ...good, GEMINI_API_KEY: undefined, TRANSLATION_PRIMARY: "fake", TRANSLATION_RETRY_MODEL: "fake-retry" }, vi.fn())).toThrow(/retry translation engine \(TRANSLATION_RETRY_MODEL\)/);
  });

  it("is not checked outside production", () => {
    const log = vi.fn();
    expect(() => assertStartupConfig({ TOMOLA_OPERATOR_DIR: process.env.TOMOLA_OPERATOR_DIR, NODE_ENV: "development" }, log)).not.toThrow();
    expect(log).not.toHaveBeenCalled();
  });

  it("stops for a daily cap that is not a whole number of 0 or more, in production only", () => {
    const log = vi.fn();
    const set = { ...good, TRANSLATION_RETRY_MODEL: "gemini-3.5-flash" };
    for (const name of ["TRANSLATION_RETRY_MEMBER_DAILY_MAX", "TRANSLATION_RETRY_DAILY_MAX"]) {
      for (const raw of ["-1", "2.5", "many", "5/day", "1e3"]) expect(() => assertStartupConfig({ TOMOLA_OPERATOR_DIR: process.env.TOMOLA_OPERATOR_DIR, ...set, [name]: raw }, log), `${name}=${raw}`).toThrow(`${name} must be a whole number of 0 or more`);
      for (const raw of ["0", "7", " 12 ", ""]) expect(() => assertStartupConfig({ TOMOLA_OPERATOR_DIR: process.env.TOMOLA_OPERATOR_DIR, ...set, [name]: raw }, log), `${name}=${raw}`).not.toThrow();
    }
    expect(() => assertStartupConfig({ TOMOLA_OPERATOR_DIR: process.env.TOMOLA_OPERATOR_DIR, NODE_ENV: "development", TRANSLATION_RETRY_DAILY_MAX: "x" }, log)).not.toThrow();
  });
});

describe("the daily caps of the automatic re-translation", () => {
  it("default to 5 per member and 30 in total; a value of 0 is allowed (no automatic re-translation)", () => {
    expect(retryCaps({})).toEqual({ perMember: 5, total: 30 });
    expect(retryCaps({ TRANSLATION_RETRY_MEMBER_DAILY_MAX: "2", TRANSLATION_RETRY_DAILY_MAX: "0" })).toEqual({ perMember: 2, total: 0 });
    expect(retryCaps({ TRANSLATION_RETRY_MEMBER_DAILY_MAX: " ", TRANSLATION_RETRY_DAILY_MAX: "" })).toEqual({ perMember: 5, total: 30 });
  });

  it("at run time, a wrong value is replaced by the default with one warning (production stops at startup instead)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(currentRetryCaps({ TRANSLATION_RETRY_DAILY_MAX: "lots" })).toEqual({ perMember: 5, total: 30 });
    expect(currentRetryCaps({ TRANSLATION_RETRY_DAILY_MAX: "lots" })).toEqual({ perMember: 5, total: 30 });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("TRANSLATION_RETRY_DAILY_MAX");
  });
});
