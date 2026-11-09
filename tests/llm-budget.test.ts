import { quietLogger as silent } from "./helpers/logger";
import { asc, eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Db } from "~/lib/db/client.server";
import { jobs, llmUsage } from "~/lib/db/schema";
import { enqueue, runDueJobs, type JobHandler } from "~/lib/jobs/queue.server";
import type { EngineSet } from "~/lib/llm/config.server";
import { createClaudeEngine, type ClaudeClient, type ClaudeMessage } from "~/lib/llm/engines/claude.server";
import { createFakeEngine, createFakeJudge } from "~/lib/llm/engines/fake.server";
import { createGeminiEngine, type GeminiClient, type GeminiResponse } from "~/lib/llm/engines/gemini.server";
import { BudgetPausedError, LlmError } from "~/lib/llm/errors.server";
import { formatUsdMicro } from "~/lib/llm/format";
import { isDivergenceAvailable, judgeDivergence, translate } from "~/lib/llm/index.server";
import { createClaudeJudge } from "~/lib/llm/judge.server";
import { costMicro, parsePriceEnv, PRICE_TABLE, priceEnvName, priceFor } from "~/lib/llm/pricing.server";
import {
  budgetResumeAt,
  budgetStateFor,
  DEFAULT_MONTHLY_BUDGET_USD,
  getBudgetState,
  getBudgetStatus,
  getMonthlyBreakdown,
  getMonthlyCostMicro,
  monthlyBudgetMicro,
  monthRangeUtc,
  recordUsage,
} from "~/lib/llm/usage.server";
import { isOperatorEmail, operatorEmails } from "~/lib/operators.server";
import type { TranslationRequest } from "~/lib/llm/types";
import { createTestDb } from "./helpers/db";

const oct = (day: number, h = 0, min = 0, s = 0) => new Date(Date.UTC(2026, 9, day, h, min, s));
const now = oct(15, 12);
const req: TranslationRequest = { text: "こんにちは $x$", from: "ja", to: "en" };
const seed = (db: Db, micro: number, at: Date = now) =>
  db.insert(llmUsage).values({ engine: "claude", model: "claude-haiku-4-5", purpose: "translate", costUsdMicro: micro, createdAt: at });
const usageRows = (db: Db) => db.select().from(llmUsage).orderBy(asc(llmUsage.id));

afterEach(() => vi.restoreAllMocks());

describe("test environment", () => {
  it("has no LLM_PRICE_* overrides (vitest.config.ts empties them), so prices come from the table", () => {
    const set = Object.entries(process.env).filter(([name, value]) => name.startsWith("LLM_PRICE_") && value !== "");
    expect(set).toEqual([]);
    expect(costMicro("gemini", "gemini-3.1-flash-lite", 1_000_000, 0)).toBe(250_000);
  });
});

describe("cost calculation (integer micro-USD)", () => {
  it("prices the two built-in models per the spec table", () => {
    // gemini-2.5-flash-lite: $0.10 in / $0.40 out per 1M tokens
    expect(costMicro("gemini", "gemini-2.5-flash-lite", 1_000_000, 0)).toBe(100_000);
    expect(costMicro("gemini", "gemini-2.5-flash-lite", 0, 1_000_000)).toBe(400_000);
    expect(costMicro("gemini", "gemini-2.5-flash-lite", 1_000_000, 1_000_000)).toBe(500_000);
    // claude-haiku-4-5: $1 in / $5 out
    expect(costMicro("claude", "claude-haiku-4-5", 1_000_000, 1_000_000)).toBe(6_000_000);
    expect(costMicro("claude", "claude-haiku-4-5", 2_000, 500)).toBe(4_500);
    expect(costMicro("gemini", "gemini-2.5-flash-lite", 1000, 200)).toBe(180);
    // Successor model selected through TRANSLATION_GEMINI_MODEL: $0.30 input / $2.50 output.
    expect(costMicro("gemini", "gemini-3.5-flash-lite", 1_000_000, 1_000_000)).toBe(2_800_000);
    expect(costMicro("gemini", "gemini-3.5-flash-lite", 363, 24)).toBe(169);
    // gemini-3.1-flash-lite: $0.25 in / $1.50 out per 1M tokens
    expect(costMicro("gemini", "gemini-3.1-flash-lite", 1_000_000, 1_000_000)).toBe(1_750_000);
    expect(costMicro("gemini", "gemini-3.1-flash-lite", 400, 100)).toBe(250);
    // gemini-3.5-flash: $1.50 input / $9.00 output per million tokens, priced separately from -lite.
    expect(costMicro("gemini", "gemini-3.5-flash", 1_000_000, 1_000_000)).toBe(10_500_000);
  });

  it("rounds a fractional micro-dollar up and always returns an integer", () => {
    expect(costMicro("gemini", "gemini-2.5-flash-lite", 1, 0)).toBe(1); // 0.1 → 1
    expect(costMicro("gemini", "gemini-2.5-flash-lite", 0, 0)).toBe(0);
    for (const [i, o] of [[123, 456], [7, 9], [999_999, 1]]) {
      expect(Number.isInteger(costMicro("gemini", "gemini-2.5-flash-lite", i, o))).toBe(true);
    }
  });

  it("charges nothing for the fake engine", () => {
    expect(costMicro("fake", "fake-1", 1_000_000, 1_000_000)).toBe(0);
  });

  it("estimates a model that is not in the table at the highest price of its provider, never below a model that is in the table", () => {
    expect(priceFor("mystery-model", {}).source).toBe("fallback");
    // Infer provider from the called engine: Claude's highest price, $10/$50, no cheaper than any Claude model in the table.
    expect(costMicro("claude", "mystery-model", 1_000_000, 1_000_000, {})).toBe(60_000_000);
    expect(priceFor("claude-brand-new-9", {})).toEqual({ price: { inputNano: 10_000, outputNano: 50_000 }, source: "fallback" });
    // Gemini uses its highest price, gemini-3.5-flash at $1.5/$9.
    expect(priceFor("gemini-9-pro", {})).toEqual({ price: { inputNano: 1500, outputNano: 9000 }, source: "fallback" });
    expect(costMicro("gemini", "mystery-model", 1_000_000, 1_000_000, {})).toBe(10_500_000);
    // If neither engine nor name prefix identifies the provider, use the entire table's maximum.
    expect(priceFor("mystery-model", {}).price).toEqual({ inputNano: 10_000, outputNano: 50_000 });
    for (const [name, price] of Object.entries(PRICE_TABLE)) {
      const fallback = priceFor(`${name.startsWith("claude-") ? "claude" : "gemini"}-unlisted-model`, {}).price;
      expect(fallback.inputNano, name).toBeGreaterThanOrEqual(price.inputNano);
      expect(fallback.outputNano, name).toBeGreaterThanOrEqual(price.outputNano);
    }
  });

  it("has the prices of the Fable, Mythos and Opus 4.x models in the table (priced, not estimated)", () => {
    for (const model of ["claude-fable-5-1", "claude-fable-5", "claude-mythos-5-1", "claude-mythos-5"]) {
      expect(priceFor(model, {}), model).toEqual({ price: { inputNano: 10_000, outputNano: 50_000 }, source: "table" });
    }
    for (const model of ["claude-opus-4-8", "claude-opus-4-7"]) {
      expect(priceFor(model, {}), model).toEqual({ price: { inputNano: 5000, outputNano: 25_000 }, source: "table" });
    }
    // Resolve dated snapshot names to the table model name too.
    expect(priceFor("claude-fable-5-1-20261101", {}).source).toBe("table");
    expect(costMicro("claude", "claude-fable-5-1", 1000, 100, {})).toBe(Math.ceil((1000 * 10_000 + 100 * 50_000) / 1000));
  });

  it("takes a price from LLM_PRICE_<name> (USD per 1M tokens), also to override a table model", () => {
    expect(priceEnvName("gemini-2.5-flash-lite")).toBe("LLM_PRICE_GEMINI_2_5_FLASH_LITE");
    expect(priceEnvName("Claude_X.1")).toBe("LLM_PRICE_CLAUDE_X_1");
    const env = { LLM_PRICE_MYSTERY_MODEL: "0.30,2.50", LLM_PRICE_CLAUDE_HAIKU_4_5: " 2 / 10 " };
    expect(priceFor("mystery-model", env).source).toBe("env");
    expect(costMicro("claude", "mystery-model", 1_000_000, 1_000_000, env)).toBe(2_800_000);
    expect(costMicro("claude", "claude-haiku-4-5", 1_000_000, 1_000_000, env)).toBe(12_000_000);
    expect(parsePriceEnv("0.1,0.4")).toEqual({ inputNano: 100, outputNano: 400 });
    expect(parsePriceEnv("abc")).toBeNull();
    expect(parsePriceEnv("1")).toBeNull();
    expect(parsePriceEnv("-1,2")).toBeNull();
  });

  it("warns once and ignores an unreadable LLM_PRICE_ value", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const env = { LLM_PRICE_BROKEN_MODEL: "cheap" };
    expect(priceFor("broken-model", env).source).toBe("fallback");
    expect(priceFor("broken-model", env).source).toBe("fallback");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("matches a dated snapshot to its table entry, but not a different model", () => {
    expect(priceFor("claude-haiku-4-5-20251001", {}).source).toBe("table");
    expect(priceFor("gemini-2.5-flash-lite-preview-09-2025", {}).source).toBe("table");
    expect(priceFor("claude-haiku-4-50", {}).source).toBe("fallback");
    expect(priceFor("gemini-2.5-flash", {}).source).toBe("fallback");
  });
});

describe("monthly budget and states", () => {
  it("uses UTC month boundaries", () => {
    expect(monthRangeUtc(oct(15))).toEqual({ start: oct(1), end: new Date(Date.UTC(2026, 10, 1)) });
    expect(monthRangeUtc(oct(31, 23, 59, 59)).end).toEqual(new Date(Date.UTC(2026, 10, 1)));
    expect(monthRangeUtc(new Date(Date.UTC(2026, 10, 1)))).toEqual({ start: new Date(Date.UTC(2026, 10, 1)), end: new Date(Date.UTC(2026, 11, 1)) });
    expect(monthRangeUtc(new Date(Date.UTC(2026, 11, 31, 23)))).toEqual({ start: new Date(Date.UTC(2026, 11, 1)), end: new Date(Date.UTC(2027, 0, 1)) });
    // The beginning of a month in Japan still belongs to the previous month in UTC.
    expect(monthRangeUtc(new Date("2026-11-01T08:00:00+09:00")).start).toEqual(oct(1));
  });

  it("reads LLM_MONTHLY_BUDGET_USD (default 20), falling back with a warning on bad values", () => {
    expect(DEFAULT_MONTHLY_BUDGET_USD).toBe(20);
    expect(monthlyBudgetMicro({})).toBe(20_000_000);
    expect(monthlyBudgetMicro({ LLM_MONTHLY_BUDGET_USD: "" })).toBe(20_000_000);
    expect(monthlyBudgetMicro({ LLM_MONTHLY_BUDGET_USD: "5" })).toBe(5_000_000);
    expect(monthlyBudgetMicro({ LLM_MONTHLY_BUDGET_USD: " 12.5 " })).toBe(12_500_000);
    expect(monthlyBudgetMicro({ LLM_MONTHLY_BUDGET_USD: "0" })).toBe(0);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(monthlyBudgetMicro({ LLM_MONTHLY_BUDGET_USD: "20USD" })).toBe(20_000_000);
    expect(monthlyBudgetMicro({ LLM_MONTHLY_BUDGET_USD: "-3" })).toBe(20_000_000);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("is normal under 80%, degraded from 80% to under 100%, stopped from 100%", () => {
    const b = 20_000_000;
    expect(budgetStateFor(0, b)).toBe("normal");
    expect(budgetStateFor(15_999_999, b)).toBe("normal");
    expect(budgetStateFor(16_000_000, b)).toBe("degraded");
    expect(budgetStateFor(19_999_999, b)).toBe("degraded");
    expect(budgetStateFor(20_000_000, b)).toBe("stopped");
    expect(budgetStateFor(35_000_000, b)).toBe("stopped");
    // A zero cap always pauses.
    expect(budgetStateFor(0, 0)).toBe("stopped");
  });

  it("records usage with a computed cost and sums only the current UTC month", async () => {
    const db = await createTestDb();
    expect(await recordUsage(db, { engine: "claude", model: "claude-haiku-4-5", purpose: "judge", inputTokens: 2000, outputTokens: 500, now })).toBe(4500);
    expect(await recordUsage(db, { engine: "fake", model: "fake-1", purpose: "translate", inputTokens: 9, outputTokens: 9, now })).toBe(0);
    const [row] = await usageRows(db);
    expect(row).toMatchObject({ engine: "claude", model: "claude-haiku-4-5", purpose: "judge", inputTokens: 2000, outputTokens: 500, costUsdMicro: 4500, createdAt: now });
    expect(await getMonthlyCostMicro(db, now)).toBe(4500);
    // Month boundaries: exclude late September, include early and late October, exclude early November.
    await seed(db, 1_000_000, new Date(Date.UTC(2026, 8, 30, 23, 59, 59, 999)));
    await seed(db, 10, oct(1));
    await seed(db, 20, oct(31, 23, 59, 59));
    await seed(db, 1_000_000, new Date(Date.UTC(2026, 10, 1)));
    expect(await getMonthlyCostMicro(db, now)).toBe(4500 + 10 + 20);
    expect(await getMonthlyCostMicro(db, new Date(Date.UTC(2026, 10, 15)))).toBe(1_000_000);
  });

  it("degrades at 80% and stops at 100% of the budget, and recovers on the next month or a higher budget", async () => {
    const db = await createTestDb();
    const env = { LLM_MONTHLY_BUDGET_USD: "10" };
    expect(await getBudgetState(db, now, env)).toBe("normal");
    await seed(db, 7_999_999);
    expect(await getBudgetState(db, now, env)).toBe("normal");
    await seed(db, 1);
    expect(await getBudgetState(db, now, env)).toBe("degraded");
    await seed(db, 1_999_999);
    expect(await getBudgetState(db, now, env)).toBe("degraded");
    await seed(db, 1);
    expect(await getBudgetState(db, now, env)).toBe("stopped");
    const status = await getBudgetStatus(db, now, env);
    expect(status).toMatchObject({ state: "stopped", usedMicro: 10_000_000, budgetMicro: 10_000_000, percent: 100, monthStart: oct(1), monthEnd: new Date(Date.UTC(2026, 10, 1)) });
    // Raising the cap resumes work.
    expect(await getBudgetState(db, now, { LLM_MONTHLY_BUDGET_USD: "20" })).toBe("normal");
    expect(await getBudgetState(db, now, { LLM_MONTHLY_BUDGET_USD: "12" })).toBe("degraded");
    // The next month resumes work.
    expect(await getBudgetState(db, new Date(Date.UTC(2026, 10, 1)), env)).toBe("normal");
  });

  it("checks again in 15 minutes, but never later than the start of the next month", () => {
    expect(budgetResumeAt(now)).toEqual(oct(15, 12, 15));
    expect(budgetResumeAt(oct(31, 23, 50))).toEqual(new Date(Date.UTC(2026, 10, 1)));
  });

  it("breaks the month down by engine, model and purpose, most expensive first", async () => {
    const db = await createTestDb();
    await recordUsage(db, { engine: "gemini", model: "gemini-2.5-flash-lite", purpose: "translate", inputTokens: 1000, outputTokens: 1000, now });
    await recordUsage(db, { engine: "gemini", model: "gemini-2.5-flash-lite", purpose: "translate", inputTokens: 1000, outputTokens: 1000, now });
    await recordUsage(db, { engine: "claude", model: "claude-haiku-4-5", purpose: "judge", inputTokens: 1000, outputTokens: 100, now });
    await recordUsage(db, { engine: "claude", model: "claude-haiku-4-5", purpose: "judge", inputTokens: 5, outputTokens: 5, now: new Date(Date.UTC(2026, 8, 1)) });
    expect(await getMonthlyBreakdown(db, now)).toEqual([
      { engine: "claude", model: "claude-haiku-4-5", purpose: "judge", calls: 1, inputTokens: 1000, outputTokens: 100, costMicro: 1500 },
      { engine: "gemini", model: "gemini-2.5-flash-lite", purpose: "translate", calls: 2, inputTokens: 2000, outputTokens: 2000, costMicro: 2 * 500 },
    ]);
  });

  it("formats micro-USD", () => {
    expect(formatUsdMicro(12_345)).toBe("$0.0123");
    expect(formatUsdMicro(20_000_000, 2)).toBe("$20.00");
    expect(formatUsdMicro(0)).toBe("$0.0000");
  });
});

// Test engines use real engine wrappers with fake clients; no network.
function geminiWith(responses: Array<Partial<GeminiResponse>>) {
  let i = 0;
  const client: GeminiClient = { models: { generateContent: async () => responses[Math.min(i++, responses.length - 1)] as GeminiResponse } };
  return createGeminiEngine({ client });
}
function claudeWith(messages: Array<Partial<ClaudeMessage>>) {
  let i = 0;
  const client: ClaudeClient = {
    messages: {
      create: async () =>
        ({
          content: [{ type: "text", text: "ok", citations: null }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
          ...messages[Math.min(i++, messages.length - 1)],
        }) as ClaudeMessage,
    },
  };
  return { client, engine: createClaudeEngine({ client }) };
}
const gem = (text: string, promptTokenCount = 1000, candidatesTokenCount = 200): Partial<GeminiResponse> => ({
  text,
  candidates: [{ finishReason: "STOP" } as never],
  usageMetadata: { promptTokenCount, candidatesTokenCount },
});
const fakeSet = (): EngineSet => ({ primary: createFakeEngine(), secondary: createFakeEngine(), judge: createFakeJudge() });

describe("translate (budget gating and ledger)", () => {
  it("records each call in the ledger with its cost", async () => {
    const db = await createTestDb();
    const engines: EngineSet = { primary: geminiWith([gem("Hello $x$")]), secondary: null, judge: null };
    const out = await translate(db, "primary", req, { now, engines });
    expect(out).toMatchObject({ text: "Hello $x$", engine: "gemini", model: "gemini-3.5-flash-lite", flags: [], attempts: 1, inputTokens: 1000, outputTokens: 200, costUsdMicro: 800 });
    expect(await usageRows(db)).toMatchObject([
      { engine: "gemini", model: "gemini-3.5-flash-lite", purpose: "translate", inputTokens: 1000, outputTokens: 200, costUsdMicro: 800, createdAt: now },
    ]);
    expect(await getMonthlyCostMicro(db, now)).toBe(800);
  });

  it("records a call at the time given by the clock (the call time), and judges the budget at `now`", async () => {
    const db = await createTestDb();
    const engines: EngineSet = { primary: geminiWith([gem("Hello $x$")]), secondary: null, judge: null };
    const later = oct(15, 12, 0, 95);
    await translate(db, "primary", req, { now, clock: () => later, engines });
    expect(await usageRows(db)).toMatchObject([{ purpose: "translate", costUsdMicro: 800, createdAt: later }]);
    // a clock that returns the end of the month puts the cost in the next month
    const nov = new Date(Date.UTC(2026, 10, 1, 0, 0, 3));
    await translate(db, "primary", req, { now: oct(31, 23, 59, 59), clock: () => nov, engines: { primary: geminiWith([gem("Hello $x$")]), secondary: null, judge: null } });
    expect(await getMonthlyCostMicro(db, now)).toBe(800);
    expect(await getMonthlyCostMicro(db, nov)).toBe(800);
  });

  it("records both calls when the structure check forces a retry, and reports the total cost", async () => {
    const db = await createTestDb();
    // First output drops a math dollar sign and fails structure validation; the second succeeds.
    const engines: EngineSet = { primary: geminiWith([gem("Hello x", 1000, 200), gem("Hello $x$", 1100, 210)]), secondary: null, judge: null };
    const out = await translate(db, "primary", req, { now, engines });
    expect(out).toMatchObject({ text: "Hello $x$", attempts: 2, flags: [], inputTokens: 2100, outputTokens: 410 });
    const rows = await usageRows(db);
    expect(rows.map((r) => [r.inputTokens, r.outputTokens])).toEqual([[1000, 200], [1100, 210]]);
    expect(out.costUsdMicro).toBe(rows.reduce((sum, r) => sum + r.costUsdMicro, 0));
    expect(out.costUsdMicro).toBe(800 + 855);
  });

  it("flags quality_mismatch when the retry still loses a formula", async () => {
    const db = await createTestDb();
    const engines: EngineSet = { primary: geminiWith([gem("Hello x"), gem("Hello y")]), secondary: null, judge: null };
    expect(await translate(db, "primary", req, { now, engines })).toMatchObject({ text: "Hello y", flags: ["quality_mismatch"], attempts: 2 });
    expect(await usageRows(db)).toHaveLength(2);
  });

  it("records the billed usage of a call that was refused or truncated, then throws", async () => {
    const db = await createTestDb();
    const truncated: EngineSet = {
      primary: geminiWith([{ text: "cut", candidates: [{ finishReason: "MAX_TOKENS" } as never], usageMetadata: { promptTokenCount: 800, candidatesTokenCount: 300 } }]),
      secondary: null,
      judge: null,
    };
    await expect(translate(db, "primary", req, { now, engines: truncated })).rejects.toMatchObject({ code: "truncated" });
    const { engine } = claudeWith([{ stop_reason: "refusal", usage: { input_tokens: 500, output_tokens: 0 } as never }]);
    await expect(translate(db, "secondary", req, { now, engines: { primary: createFakeEngine(), secondary: engine, judge: null } })).rejects.toMatchObject({ code: "refusal" });
    expect(await usageRows(db)).toMatchObject([
      { engine: "gemini", inputTokens: 800, outputTokens: 300 },
      { engine: "claude", inputTokens: 500, outputTokens: 0, costUsdMicro: 500 },
    ]);
  });

  it("records nothing when the call fails without a response (network error)", async () => {
    const db = await createTestDb();
    const client: GeminiClient = { models: { generateContent: async () => Promise.reject(new Error("ECONNRESET")) } };
    const engines: EngineSet = { primary: createGeminiEngine({ client }), secondary: null, judge: null };
    await expect(translate(db, "primary", req, { now, engines })).rejects.toThrow("ECONNRESET");
    expect(await usageRows(db)).toHaveLength(0);
  });

  it("records the fake engine at zero cost", async () => {
    const db = await createTestDb();
    const out = await translate(db, "primary", req, { now, engines: fakeSet() });
    expect(out).toMatchObject({ text: "[en] こんにちは $x$", engine: "fake", costUsdMicro: 0 });
    expect(await usageRows(db)).toMatchObject([{ engine: "fake", model: "fake-1", purpose: "translate", costUsdMicro: 0 }]);
  });

  it("degraded (80%): the secondary engine and the judge are paused, the primary keeps working", async () => {
    const db = await createTestDb();
    const env = { LLM_MONTHLY_BUDGET_USD: "10" };
    await seed(db, 8_000_000);
    const opts = { now, env, engines: fakeSet() };
    await expect(translate(db, "secondary", req, opts)).rejects.toBeInstanceOf(BudgetPausedError);
    await expect(judgeDivergence(db, { segments: ["a"], from: "ja", to: "en", translationA: "x", translationB: "y" }, opts)).rejects.toMatchObject({ name: "BudgetPausedError", state: "degraded", role: "judge" });
    expect(await translate(db, "primary", req, opts)).toMatchObject({ engine: "fake" });
    expect(await isDivergenceAvailable(db, opts)).toBe(false);
    // Blocked calls add nothing to the ledger.
    expect(await usageRows(db)).toHaveLength(2);
    const paused = await translate(db, "secondary", req, opts).catch((e) => e as BudgetPausedError);
    expect(paused).toMatchObject({ state: "degraded", role: "secondary", until: budgetResumeAt(now) });
  });

  it("stopped (100%): the primary engine is paused too, and nothing is called or recorded", async () => {
    const db = await createTestDb();
    const env = { LLM_MONTHLY_BUDGET_USD: "10" };
    await seed(db, 10_000_000);
    const generateContent = vi.fn(async () => gem("Hello $x$") as GeminiResponse);
    const engines: EngineSet = { primary: createGeminiEngine({ client: { models: { generateContent } } }), secondary: createFakeEngine(), judge: createFakeJudge() };
    const err = await translate(db, "primary", req, { now, env, engines }).catch((e) => e);
    expect(err).toBeInstanceOf(BudgetPausedError);
    expect(err).toMatchObject({ state: "stopped", role: "primary", until: budgetResumeAt(now) });
    await expect(translate(db, "secondary", req, { now, env, engines })).rejects.toBeInstanceOf(BudgetPausedError);
    expect(generateContent).not.toHaveBeenCalled();
    expect(await usageRows(db)).toHaveLength(1);
    // Resume next month.
    const next = new Date(Date.UTC(2026, 10, 2));
    expect(await translate(db, "primary", req, { now: next, env, engines })).toMatchObject({ engine: "gemini" });
    expect(generateContent).toHaveBeenCalledTimes(1);
  });

  it("stopped jobs wait (no failure, no attempt) and resume when the budget is raised", async () => {
    const db = await createTestDb();
    await seed(db, 10_000_000);
    const env: Record<string, string> = { LLM_MONTHLY_BUDGET_USD: "10" };
    const handler: JobHandler = async (job, ctx) => {
      const p = job.payload as { text: string };
      await translate(ctx.db, "primary", { text: p.text, from: "ja", to: "en" }, { now: ctx.now, env, engines: fakeSet() });
    };

    const { id } = await enqueue(db, "translate_entry", { text: "本文" }, { maxAttempts: 1 });
    const stats = await runDueJobs(db, { translate_entry: handler }, { now, logger: silent });
    expect(stats).toMatchObject({ ran: 1, deferred: 1, failed: 0 });
    const [waiting] = await db.select().from(jobs).where(eq(jobs.id, id));
    expect(waiting).toMatchObject({ status: "queued", attempts: 0, runAt: budgetResumeAt(now) });
    expect(waiting.lastError).toMatch(/budget stopped/);
    // No execution while waiting.
    expect(await runDueJobs(db, { translate_entry: handler }, { now: oct(15, 12, 10), logger: silent })).toMatchObject({ ran: 0 });
    // Run after raising the cap and waiting out the delay.
    env.LLM_MONTHLY_BUDGET_USD = "50";
    expect(await runDueJobs(db, { translate_entry: handler }, { now: oct(15, 12, 16), logger: silent })).toMatchObject({ ran: 1, done: 1 });
    expect((await db.select().from(jobs).where(eq(jobs.id, id)))[0]).toMatchObject({ status: "done", attempts: 1 });
  });

  it("throws unavailable when the role has no engine", async () => {
    const db = await createTestDb();
    const engines: EngineSet = { primary: createFakeEngine(), secondary: null, judge: null };
    await expect(translate(db, "secondary", req, { now, engines })).rejects.toMatchObject({ code: "unavailable" });
    await expect(translate(db, "secondary", req, { now, engines })).rejects.toBeInstanceOf(LlmError);
    await expect(judgeDivergence(db, { segments: ["a"], from: "ja", to: "en", translationA: "x", translationB: "y" }, { now, engines })).rejects.toMatchObject({ code: "unavailable" });
  });

  it("picks the engines from the environment when none are given (fake without keys)", async () => {
    const db = await createTestDb();
    const out = await translate(db, "primary", req, { now, env: {} });
    expect(out.engine).toBe("fake");
    await expect(translate(db, "secondary", req, { now, env: {} })).rejects.toMatchObject({ code: "unavailable" });
  });
});

describe("judgeDivergence (budget gating and ledger)", () => {
  const judgeReq = { segments: ["一。", "二。"], from: "ja", to: "en", translationA: "A", translationB: "B" } as const;
  const segments = [...judgeReq.segments];

  it("records the judge call with purpose judge and returns the divergences", async () => {
    const db = await createTestDb();
    const { client } = claudeWith([
      {
        content: [{ type: "text", text: '{"divergences":[{"sentence":1,"severity":"medium","note":"differs"}]}', citations: null }] as never,
        usage: { input_tokens: 2000, output_tokens: 500 } as never,
      },
    ]);
    const engines: EngineSet = { primary: createFakeEngine(), secondary: createFakeEngine(), judge: createClaudeJudge({ client }) };
    const out = await judgeDivergence(db, { ...judgeReq, segments }, { now, engines });
    expect(out).toMatchObject({ engine: "claude", model: "claude-haiku-4-5", divergences: [{ sentence: 1, severity: "medium", note: "differs" }], costUsdMicro: 4500 });
    expect(await usageRows(db)).toMatchObject([{ engine: "claude", model: "claude-haiku-4-5", purpose: "judge", inputTokens: 2000, outputTokens: 500, costUsdMicro: 4500 }]);
  });

  it("still records the cost when the judge output is invalid, then throws", async () => {
    const db = await createTestDb();
    const { client } = claudeWith([{ content: [{ type: "text", text: "sorry, no JSON", citations: null }] as never, usage: { input_tokens: 100, output_tokens: 10 } as never }]);
    const engines: EngineSet = { primary: createFakeEngine(), secondary: null, judge: createClaudeJudge({ client }) };
    await expect(judgeDivergence(db, { ...judgeReq, segments }, { now, engines })).rejects.toMatchObject({ code: "invalid_output" });
    expect(await usageRows(db)).toMatchObject([{ purpose: "judge", inputTokens: 100, outputTokens: 10, costUsdMicro: 150 }]);
  });

  it("is available only when a secondary engine and a judge exist and the budget is normal", async () => {
    const db = await createTestDb();
    const env = { LLM_MONTHLY_BUDGET_USD: "10" };
    expect(await isDivergenceAvailable(db, { now, env, engines: fakeSet() })).toBe(true);
    expect(await isDivergenceAvailable(db, { now, env, engines: { ...fakeSet(), judge: null } })).toBe(false);
    expect(await isDivergenceAvailable(db, { now, env, engines: { ...fakeSet(), secondary: null } })).toBe(false);
    await seed(db, 8_000_000);
    expect(await isDivergenceAvailable(db, { now, env, engines: fakeSet() })).toBe(false);
  });
});

describe("OPERATOR_EMAILS", () => {
  it("parses a comma-separated list, ignoring case, spaces and empty items", () => {
    expect([...operatorEmails({ OPERATOR_EMAILS: " Hana@Example.com , ,bob@example.com," })].sort()).toEqual(["bob@example.com", "hana@example.com"]);
    expect(operatorEmails({}).size).toBe(0);
    expect(operatorEmails({ OPERATOR_EMAILS: "" }).size).toBe(0);
  });

  it("compares emails case-insensitively", () => {
    const env = { OPERATOR_EMAILS: "Hana@Example.com" };
    expect(isOperatorEmail("hana@example.com", env)).toBe(true);
    expect(isOperatorEmail(" HANA@EXAMPLE.COM ", env)).toBe(true);
    expect(isOperatorEmail("hana@example.org", env)).toBe(false);
    expect(isOperatorEmail("", env)).toBe(false);
    expect(isOperatorEmail("hana@example.com", {})).toBe(false);
  });
});
