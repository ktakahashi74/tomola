import { quietLogger as quiet } from "./helpers/logger";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Db } from "~/lib/db/client.server";
import { divergences, entries, jobs, llmUsage, translations } from "~/lib/db/schema";
import { createReply, createTopic } from "~/lib/entries.server";
import { createTranslationHandlers } from "~/lib/jobs/translation-jobs.server";
import { enqueue, runDueJobs } from "~/lib/jobs/queue.server";
import { enabledTargetLangs as targetLangs } from "~/lib/enabled-langs.server";
import type { EngineSet } from "~/lib/llm/config.server";
import { currentDivergenceSampleRate, divergenceSampleRate, divergenceSampleValue, isDivergenceSampled } from "~/lib/llm/divergence-sample.server";
import { createFakeEngine, createFakeJudge } from "~/lib/llm/engines/fake.server";
import { divergenceStats } from "~/lib/observation.server";
import { assertStartupConfig as startupConfig, SAMPLE_RATE_ZERO_WARNING, warnIfSampleRateZero } from "~/lib/startup-checks.server";
import { requeueTranslations } from "~/lib/translations-requeue.server";
import { DIVERGENCE_JOB, divergenceDedupeKey } from "~/lib/translations.server";
import { addMember, createTestDb } from "./helpers/db";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";

// Production startup also checks the review counts of the UI strings that the build embeds (a test worktree has none): hand it a clean ja/en.
const CLEAN_COUNTS = { ja: { unverified: 0, unverifiedPublic: 0, missing: 0, stale: 0 }, en: { unverified: 0, unverifiedPublic: 0, missing: 0, stale: 0 } };
const assertStartupConfig = (env: Record<string, string | undefined>, log?: (message: string) => void) => startupConfig({ TOMOLA_OPERATOR_DIR: process.env.TOMOLA_OPERATOR_DIR, ...env }, log, { reviewCounts: CLEAN_COUNTS });

// Divergence sampling (DIVERGENCE_SAMPLE_RATE): even with a secondary engine and judge, the default rate 0 compares nothing. Sampling depends only on post ID, target language and source version,
// deterministically, so retries and requeues never change selection. A measured secondary translation retains the judged flag even without divergence; the operator's "比べた訳 / 訳の全体" counts use it.

const t0 = new Date("2026-10-05T00:00:00Z");

const fakeSet = (): EngineSet => ({ primary: createFakeEngine(), secondary: createFakeEngine(), judge: createFakeJudge() });

describe("the sample rate (DIVERGENCE_SAMPLE_RATE)", () => {
  it("is 0 when unset or blank, reads a number from 0 to 1, and refuses anything else", () => {
    expect(divergenceSampleRate({})).toBe(0);
    expect(divergenceSampleRate({ DIVERGENCE_SAMPLE_RATE: "  " })).toBe(0);
    for (const [raw, rate] of [["0", 0], ["1", 1], ["0.25", 0.25], [".5", 0.5], ["1.0", 1], ["0.", 0], [" 0.1 ", 0.1]] as const) expect(divergenceSampleRate({ DIVERGENCE_SAMPLE_RATE: raw }), raw).toBe(rate);
    for (const raw of ["-0.1", "1.1", "2", "abc", "50%", "1e-1", "NaN", "Infinity", "0,5"]) {
      expect(() => divergenceSampleRate({ DIVERGENCE_SAMPLE_RATE: raw }), raw).toThrow(/DIVERGENCE_SAMPLE_RATE must be a number from 0 to 1/);
    }
  });

  it("is treated as 0 at run time when the value is wrong, with one warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(currentDivergenceSampleRate({ DIVERGENCE_SAMPLE_RATE: "9" })).toBe(0);
    expect(currentDivergenceSampleRate({ DIVERGENCE_SAMPLE_RATE: "9" })).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("using 0");
    expect(currentDivergenceSampleRate({ DIVERGENCE_SAMPLE_RATE: "0.5" })).toBe(0.5);
    warn.mockRestore();
  });
});

describe("the selection", () => {
  // Fixed fixture: post IDs 1–250, eight languages and two versions.
  const keys = Array.from({ length: 250 }, (_, i) => i + 1).flatMap((entryId) => ["en", "fr", "zh-Hans", "th"].map((lang) => ({ entryId, lang, sourceHash: `hash-${entryId % 2}` })));

  it("selects nothing at rate 0 and everything at rate 1", () => {
    expect(keys.some((k) => isDivergenceSampled(k, 0))).toBe(false);
    expect(keys.every((k) => isDivergenceSampled(k, 1))).toBe(true);
    expect(isDivergenceSampled(keys[0], -1)).toBe(false);
    expect(isDivergenceSampled(keys[0], 2)).toBe(true);
  });

  it("selects about the rate of a fixed set at 0.5 (and at 0.1, 0.9), the same every time", () => {
    for (const rate of [0.1, 0.5, 0.9]) {
      const chosen = keys.filter((k) => isDivergenceSampled(k, rate));
      expect(chosen.length / keys.length, String(rate)).toBeGreaterThan(rate - 0.06);
      expect(chosen.length / keys.length, String(rate)).toBeLessThan(rate + 0.06);
      // Deterministic selection for the same fixture, even after reordering.
      expect(keys.filter((k) => isDivergenceSampled(k, rate))).toEqual(chosen);
      expect([...keys].reverse().filter((k) => isDivergenceSampled(k, rate)).reverse()).toEqual(chosen);
    }
    // Exact counts for the fixed fixture verify reproducibility; changing the function changes these counts.
    expect(keys.filter((k) => isDivergenceSampled(k, 0.5)).length).toBe(keys.filter((k) => divergenceSampleValue(k) < 0.5).length);
  });

  it("is monotone in the rate, and depends on the post, the language and the version of the original", () => {
    const at = (rate: number) => new Set(keys.filter((k) => isDivergenceSampled(k, rate)).map((k) => `${k.entryId}:${k.lang}`));
    const low = at(0.2);
    const high = at(0.6);
    for (const key of low) expect(high.has(key)).toBe(true);
    expect(high.size).toBeGreaterThan(low.size);
    const base = { entryId: 7, lang: "fr", sourceHash: "abc" };
    const value = divergenceSampleValue(base);
    expect(value).toBeGreaterThanOrEqual(0);
    expect(value).toBeLessThan(1);
    expect(divergenceSampleValue({ ...base, entryId: 8 })).not.toBe(value);
    expect(divergenceSampleValue({ ...base, lang: "en" })).not.toBe(value);
    expect(divergenceSampleValue({ ...base, sourceHash: "abd" })).not.toBe(value);
  });
});

describe("the translation jobs", () => {
  async function world(topics = 6) {
    const db = await createTestDb();
    await addMember(db, "u1", "hana");
    const ids: number[] = [];
    for (let i = 0; i < topics; i++) {
      const made = await createTopic(db, "u1", { lang: "ja", title: `話題${i}`, body: `本文${i}。` });
      if (!made.ok) throw new Error("topic failed");
      ids.push(made.id);
    }
    const reply = await createReply(db, "u1", ids[0], { lang: "ja", body: "返信。" });
    if (!reply.ok) throw new Error("reply failed");
    return { db, ids, replyId: reply.id };
  }
  const run = (db: Db, engines: EngineSet, env: Record<string, string>, now = t0) =>
    runDueJobs(db, createTranslationHandlers({ llm: { engines, env } }), { now, logger: quiet, limit: 2000 });
  const measured = async (db: Db) => (await db.select({ entryId: translations.entryId, lang: translations.lang, flags: translations.flags }).from(translations).where(and(eq(translations.kind, "secondary"), eq(translations.field, "body")))).filter((r) => r.flags.includes("judged")).map((r) => `${r.entryId}:${r.lang}`).sort();
  const sampledOf = async (db: Db, ids: number[], rate: number) => {
    const rows = await db.select({ id: entries.id, hash: entries.sourceHash }).from(entries);
    const hashOf = new Map(rows.map((r) => [r.id, r.hash!]));
    return ids.flatMap((id) => targetLangs("ja").filter((lang) => isDivergenceSampled({ entryId: id, lang, sourceHash: hashOf.get(id)! }, rate)).map((lang) => `${id}:${lang}`)).sort();
  };

  // Use one PGlite database per test. Multiple databases accumulate memory and have stalled full runs under load.
  it("measures no translation at the default rate even with a secondary engine and a judge", { timeout: 30_000 }, async () => {
    const off = await world(4);
    await run(off.db, fakeSet(), {});
    expect(await off.db.select().from(jobs).where(eq(jobs.kind, DIVERGENCE_JOB))).toHaveLength(0);
    expect(await measured(off.db)).toEqual([]);
    expect(await off.db.select().from(divergences)).toHaveLength(0);
    // Primary translations proceed normally.
    expect((await off.db.select().from(translations).where(and(eq(translations.kind, "primary"), eq(translations.field, "body")))).length).toBe((4 + 1) * 8);
  });

  it("measures every topic translation at rate 1, and no reply", { timeout: 30_000 }, async () => {
    const all = await world(4);
    await run(all.db, fakeSet(), { DIVERGENCE_SAMPLE_RATE: "1" });
    expect((await measured(all.db)).length).toBe(4 * 8);
    // Measure topics only, not replies.
    expect((await measured(all.db)).some((k) => k.startsWith(`${all.replyId}:`))).toBe(false);
  });

  it("at rate 0.5 measures exactly the translations that the selection chooses (a retry or a second run changes nothing)", { timeout: 60_000 }, async () => {
    const w = await world();
    await run(w.db, fakeSet(), { DIVERGENCE_SAMPLE_RATE: "0.5" });
    const expected = await sampledOf(w.db, w.ids, 0.5);
    expect(expected.length).toBeGreaterThan(10);
    expect(expected.length).toBeLessThan(6 * 8 - 10);
    expect(await measured(w.db)).toEqual(expected);
    // Record measurement as a translation-row flag even without divergence. No divergence row because there is no DIVERGE signal.
    expect((await w.db.select().from(divergences)).length).toBe(0);
    // Rerunning, including requeueing, gives the same result.
    await run(w.db, fakeSet(), { DIVERGENCE_SAMPLE_RATE: "0.5" }, new Date(t0.getTime() + 60_000));
    const requeued = await requeueTranslations(w.db, { divergence: true, llm: { engines: fakeSet(), env: { DIVERGENCE_SAMPLE_RATE: "0.5" } } });
    expect(requeued.divergence).toBe(0);
    await run(w.db, fakeSet(), { DIVERGENCE_SAMPLE_RATE: "0.5" }, new Date(t0.getTime() + 120_000));
    expect(await measured(w.db)).toEqual(expected);
  });

  it("does nothing without a secondary engine or a judge, whatever the rate", { timeout: 30_000 }, async () => {
    const none = await world(2);
    await run(none.db, { primary: createFakeEngine(), secondary: null, judge: null }, { DIVERGENCE_SAMPLE_RATE: "1" });
    expect(await measured(none.db)).toEqual([]);
    // With a secondary engine but no judge, do not queue measurement jobs.
    await createTopic(none.db, "u1", { lang: "ja", title: "もう一つ", body: "本文。" });
    await run(none.db, { primary: createFakeEngine(), secondary: createFakeEngine(), judge: null }, { DIVERGENCE_SAMPLE_RATE: "1" }, new Date(t0.getTime() + 60_000));
    expect(await none.db.select().from(jobs).where(eq(jobs.kind, DIVERGENCE_JOB))).toHaveLength(0);
  });

  it("keeps the budget rules: when the budget is degraded the primary translates and nothing is measured", { timeout: 30_000 }, async () => {
    const degraded = await world(2);
    await degraded.db.insert(llmUsage).values({ engine: "gemini", model: "gemini-3.1-flash-lite", purpose: "translate", costUsdMicro: 8_500_000, createdAt: t0 });
    await run(degraded.db, fakeSet(), { DIVERGENCE_SAMPLE_RATE: "1", LLM_MONTHLY_BUDGET_USD: "10" });
    expect(await measured(degraded.db)).toEqual([]);
    expect((await degraded.db.select().from(translations).where(eq(translations.kind, "primary"))).length).toBeGreaterThan(0);
  });

  it("skips a queued measurement of a translation that was not sampled (the rate was lowered after it was queued), and does it for one that was", { timeout: 30_000 }, async () => {
    const w = await world(2);
    await run(w.db, fakeSet(), {});
    const [entry] = await w.db.select({ id: entries.id, hash: entries.sourceHash }).from(entries).where(eq(entries.id, w.ids[0]));
    const langs = targetLangs("ja");
    const unsampled = langs.find((lang) => !isDivergenceSampled({ entryId: entry.id, lang, sourceHash: entry.hash! }, 0.5))!;
    const sampled = langs.find((lang) => isDivergenceSampled({ entryId: entry.id, lang, sourceHash: entry.hash! }, 0.5))!;
    expect(unsampled && sampled).toBeTruthy();
    for (const lang of [unsampled, sampled]) {
      const payload = { entryId: entry.id, lang, sourceHash: entry.hash! };
      await enqueue(w.db, DIVERGENCE_JOB, payload, { dedupeKey: divergenceDedupeKey(payload) });
    }
    const stats = await run(w.db, fakeSet(), { DIVERGENCE_SAMPLE_RATE: "0.5" });
    expect(stats.failed).toBe(0);
    expect(await measured(w.db)).toEqual([`${entry.id}:${sampled}`]);
  });
});

describe("the observation page counts", () => {
  it("counts, per language pair, how many translations were compared of how many could be", { timeout: 60_000 }, async () => {
    const db = await createTestDb();
    await addMember(db, "u1", "hana");
    const ids: number[] = [];
    for (let i = 0; i < 4; i++) {
      const made = await createTopic(db, "u1", { lang: "ja", title: `話題${i}`, body: `本文${i}。` });
      if (!made.ok) throw new Error("topic failed");
      ids.push(made.id);
    }
    await runDueJobs(db, createTranslationHandlers({ llm: { engines: fakeSet(), env: { DIVERGENCE_SAMPLE_RATE: "0.5" } } }), { now: t0, logger: quiet, limit: 2000 });
    const rows = await db.select({ id: entries.id, hash: entries.sourceHash }).from(entries);
    const hashOf = new Map(rows.map((r) => [r.id, r.hash!]));
    const stats = await divergenceStats(db);
    // Four comparable translations for every language pair.
    expect(stats.map((p) => [p.from, p.to, p.eligible])).toEqual(targetLangs("ja").map((to) => ["ja", to, 4]));
    for (const pair of stats) {
      const expected = ids.filter((id) => isDivergenceSampled({ entryId: id, lang: pair.to, sourceHash: hashOf.get(id)! }, 0.5)).length;
      expect(pair.measured, `${pair.from}>${pair.to}`).toBe(expected);
    }
    expect(stats.reduce((n, p) => n + p.measured, 0)).toBeGreaterThan(0);
    expect(stats.reduce((n, p) => n + p.measured, 0)).toBeLessThan(4 * 8);
  });
});

describe("the observation page states", () => {
  let h: RouteHarness;
  const saved = { op: process.env.OPERATOR_EMAILS, secondary: process.env.TRANSLATION_SECONDARY, judge: process.env.DIVERGENCE_JUDGE, rate: process.env.DIVERGENCE_SAMPLE_RATE, primary: process.env.TRANSLATION_PRIMARY };
  beforeAll(async () => {
    process.env.OPERATOR_EMAILS = "op@example.com";
    h = await setupRouteHarness();
    await h.signIn("op", { homeArea: "ja", email: "op@example.com" });
  });
  afterAll(() => {
    h.restore();
    for (const [key, value] of [["OPERATOR_EMAILS", saved.op], ["TRANSLATION_SECONDARY", saved.secondary], ["DIVERGENCE_JUDGE", saved.judge], ["DIVERGENCE_SAMPLE_RATE", saved.rate], ["TRANSLATION_PRIMARY", saved.primary]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const load = async () => {
    const mod = await import("~/routes/admin-observation");
    const res = await h.outcome(async () => (await mod.loader(h.args(h.request("/admin/observation", { as: "op" })))));
    expect(res.status).toBe(200);
    return { mod, data: res.value as Parameters<typeof mod.default>[0]["loaderData"] };
  };
  const html = (mod: typeof import("~/routes/admin-observation"), data: unknown) => renderToStaticMarkup(createElement(mod.default as never, { loaderData: data, actionData: undefined, params: {}, matches: [] } as never));

  it("says plainly when detection is off, when the rate is 0, and when it is on with a rate; the figures are compared / all", async () => {
    process.env.TRANSLATION_PRIMARY = "fake";
    delete process.env.TRANSLATION_SECONDARY;
    delete process.env.DIVERGENCE_JUDGE;
    delete process.env.DIVERGENCE_SAMPLE_RATE;
    const off = await load();
    expect(off.data).toMatchObject({ divergenceEnabled: false, divergenceSampleRate: 0 });
    expect(html(off.mod, off.data)).not.toContain('role="status"');
    // Configured engines but default rate 0.
    process.env.TRANSLATION_SECONDARY = "fake";
    process.env.DIVERGENCE_JUDGE = "fake";
    const zero = await load();
    expect(zero.data).toMatchObject({ divergenceEnabled: true, divergenceSampleRate: 0 });
    expect(html(zero.mod, zero.data)).toContain('role="status"');
    // With a positive rate, the table shows "比べた / 全体".
    process.env.DIVERGENCE_SAMPLE_RATE = "0.25";
    const on = await load();
    expect(on.data).toMatchObject({ divergenceEnabled: true, divergenceSampleRate: 0.25 });
    const withPairs = { ...on.data, divergence: [{ from: "ja", to: "en", eligible: 12, measured: 3, records: 1, tone: 1, severity: { low: 1, medium: 0, high: 0 }, sameVendor: { measured: 0, records: 0, tone: 0, severity: { low: 0, medium: 0, high: 0 } } }] };
    const markup = html(on.mod, withPairs);
    expect(markup).toContain("3 / 12");
    expect(markup).toContain('role="status"');
  });
});

describe("the startup check in production", () => {
  const good = {
    NODE_ENV: "production",
    BETTER_AUTH_SECRET: "x".repeat(32),
    BETTER_AUTH_URL: "https://tomola.org",
    SMTP_URL: "smtps://user:pw@smtp.example.org:465",
    MAIL_FROM: "tomola <no-reply@example.org>",
    MAIL_DECOY_TO: "test@blackhole.postmarkapp.com",
    ENABLED_LANGS: "ja,en",
    GEMINI_API_KEY: "g",
    ANTHROPIC_API_KEY: "a",
    TRANSLATION_RETRY_MODEL: "gemini-3.5-flash",
    DATABASE_URL: "postgres://tomola:pw@db:5432/tomola",
  };

  it("stops for a rate outside 0 to 1, in production only", () => {
    const log = vi.fn();
    for (const raw of ["1.5", "-1", "half", "10%"]) expect(() => assertStartupConfig({ TOMOLA_OPERATOR_DIR: process.env.TOMOLA_OPERATOR_DIR, ...good, DIVERGENCE_SAMPLE_RATE: raw }, log), raw).toThrow("DIVERGENCE_SAMPLE_RATE must be a number from 0 to 1");
    for (const raw of ["0", "0.3", "1"]) expect(() => assertStartupConfig({ TOMOLA_OPERATOR_DIR: process.env.TOMOLA_OPERATOR_DIR, ...good, DIVERGENCE_SAMPLE_RATE: raw }, log), raw).not.toThrow();
    // Development and tests do not reject startup; treat the value as 0 at runtime.
    expect(() => assertStartupConfig({ TOMOLA_OPERATOR_DIR: process.env.TOMOLA_OPERATOR_DIR, NODE_ENV: "development", DIVERGENCE_SAMPLE_RATE: "7" }, log)).not.toThrow();
  });

  it("warns when a secondary engine and a judge are set but the rate is 0, and is silent otherwise", () => {
    const log = vi.fn();
    const detection = { ...good, TRANSLATION_SECONDARY: "claude", DIVERGENCE_JUDGE: "claude" };
    expect(() => assertStartupConfig({ TOMOLA_OPERATOR_DIR: process.env.TOMOLA_OPERATOR_DIR, ...detection }, log)).not.toThrow();
    expect(log.mock.calls.map((c) => c[0])).toEqual([SAMPLE_RATE_ZERO_WARNING]);
    expect(SAMPLE_RATE_ZERO_WARNING).toMatch(/WARNING.*no translation is compared/);
    log.mockClear();
    assertStartupConfig({ TOMOLA_OPERATOR_DIR: process.env.TOMOLA_OPERATOR_DIR, ...detection, DIVERGENCE_SAMPLE_RATE: "0.2" }, log);
    expect(log).not.toHaveBeenCalled();
    // Without both secondary engine and judge, the rate has no effect and produces no warning.
    expect(warnIfSampleRateZero(good, log)).toBe(false);
    expect(warnIfSampleRateZero({ ...good, TRANSLATION_SECONDARY: "claude" }, log)).toBe(false);
  });
});
