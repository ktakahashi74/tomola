import { quietLogger as quiet } from "./helpers/logger";
import { and, asc, eq } from "drizzle-orm";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { TranslationLabel } from "~/components/translation-label";
import type { Db } from "~/lib/db/client.server";
import { divergences, entries, jobs, llmUsage, translationRevisions, translations } from "~/lib/db/schema";
import { createTopic, editEntry, softDeleteEntry } from "~/lib/entries.server";
import { createTranslationHandlers, FALLBACK_AFTER_ATTEMPTS } from "~/lib/jobs/translation-jobs.server";
import { runDueJobs } from "~/lib/jobs/queue.server";
import { createFakeEngine, createFakeJudge } from "~/lib/llm/engines/fake.server";
import type { EngineSet } from "~/lib/llm/config.server";
import { LlmError } from "~/lib/llm/errors.server";
import { PROMPT_VERSION } from "~/lib/llm/prompt.server";
import type { TranslationEngine } from "~/lib/llm/types";
import { buildThreadMarkdown } from "~/lib/md/thread.server";
import { createTranslationReport, resolveReportWithHumanTranslation } from "~/lib/translation-reports.server";
import { loadTitleDisplays } from "~/lib/entry-display.server";
import { addMember, createTestDb } from "./helpers/db";
import { parseBlocks } from "./helpers/md";

const t0 = new Date("2026-10-05T00:00:00Z");


async function setup() {
  const db = await createTestDb();
  await addMember(db, "u1", "hana");
  await addMember(db, "op", "opal");
  await addMember(db, "u2", "somchai", { readLangs: ["th"] });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  return db;
}

const engine = (id: "gemini" | "claude" | "fake", model: string, fail?: (n: number) => Error | null): TranslationEngine & { calls: number } => {
  const e = {
    id,
    model,
    calls: 0,
    async translate(req: { text: string; to: string }) {
      e.calls++;
      const error = fail?.(e.calls);
      if (error) throw error;
      return { text: `[${req.to}/${model}] ${req.text}`, model, promptVersion: PROMPT_VERSION, inputTokens: 10, outputTokens: 10 };
    },
  };
  return e as TranslationEngine & { calls: number };
};
const refusal = () => new LlmError("refusal", "Gemini blocked the prompt: SAFETY");
const outage = () => new Error("503 Service Unavailable");

async function newTopic(db: Db, input: { title?: string; body?: string } = {}) {
  const res = await createTopic(db, "u1", { lang: "ja", title: input.title ?? "題", body: input.body ?? "本文。" });
  if (!res.ok) throw new Error("topic failed");
  return res.id;
}

const run = (db: Db, engines: EngineSet, opts: { now?: Date; env?: Record<string, string> } = {}) =>
  runDueJobs(db, createTranslationHandlers({ llm: { engines, env: { DIVERGENCE_SAMPLE_RATE: "1", ...opts.env } } }), { now: opts.now ?? t0, logger: quiet, limit: 500 });
const rows = (db: Db, entryId: number, lang: string) =>
  db.select().from(translations).where(and(eq(translations.entryId, entryId), eq(translations.lang, lang))).orderBy(asc(translations.field), asc(translations.kind));
const revisions = (db: Db, entryId: number) => db.select().from(translationRevisions).where(eq(translationRevisions.entryId, entryId)).orderBy(asc(translationRevisions.id));

describe("fallback to the secondary engine", () => {
  it("translates with the secondary engine when the primary refuses, and marks the stored primary row as fallback", async () => {
    const db = await setup();
    const id = await newTopic(db);
    // Only the English translation is refused by the primary lineage.
    const primary = engine("gemini", "gem-1", () => null);
    const refusing: TranslationEngine = {
      ...primary,
      async translate(req) {
        if (req.to === "en") throw refusal();
        return primary.translate(req);
      },
    };
    const secondary = engine("claude", "claude-haiku-4-5");
    const stats = await run(db, { primary: refusing, secondary, judge: null });
    expect(stats.failed).toBe(0);
    const en = await rows(db, id, "en");
    expect(en.map((r) => [r.field, r.kind, r.engine, r.model, r.fallback])).toEqual([
      ["body", "primary", "claude", "claude-haiku-4-5", true],
      ["title", "primary", "claude", "claude-haiku-4-5", true],
    ]);
    expect(en[0].text).toBe("[en/claude-haiku-4-5] 本文。");
    // Other languages use primary translations without a fallback label.
    expect((await rows(db, id, "fr")).every((r) => r.engine === "gemini" && !r.fallback)).toBe(true);
    // The cost ledger records the engine actually called, claude, under translate.
    const usage = await db.select().from(llmUsage);
    expect(usage.filter((u) => u.engine === "claude").length).toBe(3);
  });

  it("does not fall back when there is no secondary engine: a refusal fails the job for good, as before", async () => {
    const db = await setup();
    await newTopic(db);
    const stats = await run(db, { primary: engine("gemini", "gem-1", () => refusal()), secondary: null, judge: null });
    expect(stats.failed).toBe(16);
    expect(await db.select().from(translations)).toEqual([]);
  });

  it("fails for good when the secondary engine refuses too", async () => {
    const db = await setup();
    await newTopic(db);
    const stats = await run(db, { primary: engine("gemini", "g", () => refusal()), secondary: engine("claude", "c", () => refusal()), judge: null });
    expect(stats.failed).toBe(16);
    expect(await db.select().from(translations)).toEqual([]);
  });

  it("retries a failure first, and falls back from the FALLBACK_AFTER_ATTEMPTS-th attempt (and does not try the primary again for the next field)", async () => {
    const db = await setup();
    const id = await newTopic(db);
    const primary = engine("gemini", "g", () => outage());
    const secondary = engine("claude", "c");
    // Claims 1-3 use only the primary, fail, and wait for retry.
    let now = t0;
    for (let attempt = 1; attempt < FALLBACK_AFTER_ATTEMPTS; attempt++) {
      const stats = await run(db, { primary, secondary, judge: null }, { now });
      expect(stats.retried, `attempt ${attempt}`).toBe(16);
      expect(secondary.calls).toBe(0);
      now = new Date(now.getTime() + 2 * 60 * 60 * 1000);
    }
    expect(await db.select().from(translations)).toEqual([]);
    const callsBefore = primary.calls;
    const stats = await run(db, { primary, secondary, judge: null }, { now });
    expect(stats).toMatchObject({ done: 16, retried: 0, failed: 0 });
    // Each title stage calls the primary once; the body stage skips another primary attempt after its title failure. The fallback handles both titles and the body.
    expect(primary.calls - callsBefore).toBe(16);
    expect(secondary.calls).toBe(24);
    const fr = await rows(db, id, "fr");
    expect(fr.map((r) => [r.field, r.engine, r.fallback])).toEqual([["body", "claude", true], ["title", "claude", true]]);
  });

  it("does not fall back while the budget is degraded or stopped (the secondary engine is paused by the budget rules)", async () => {
    const db = await setup();
    const id = await newTopic(db);
    await db.insert(llmUsage).values({ engine: "gemini", model: "x", purpose: "translate", costUsdMicro: 8_500_000, createdAt: t0 });
    const env = { LLM_MONTHLY_BUDGET_USD: "10" };
    const secondary = engine("claude", "c");
    // Degraded mode: a primary refusal stays failed without using a fallback.
    let stats = await run(db, { primary: engine("gemini", "g", () => refusal()), secondary, judge: null }, { env });
    expect(stats.failed).toBe(16);
    expect(secondary.calls).toBe(0);
    // Paused: the primary is also stopped, so defer without failing.
    await db.update(jobs).set({ status: "queued", attempts: 0, runAt: t0 }).where(eq(jobs.status, "failed"));
    await db.insert(llmUsage).values({ engine: "gemini", model: "x", purpose: "translate", costUsdMicro: 5_000_000, createdAt: t0 });
    stats = await run(db, { primary: engine("gemini", "g"), secondary, judge: null }, { env });
    expect(stats).toMatchObject({ deferred: 16, failed: 0 });
    expect(await rows(db, id, "fr")).toEqual([]);
  });

  it("does not measure the divergence for a language whose primary translation came from the secondary engine", async () => {
    const db = await setup();
    const id = await newTopic(db, { body: "DIVERGE-HIGH の文。" });
    const primary = engine("gemini", "g", () => null);
    const refusing: TranslationEngine = {
      ...primary,
      async translate(req) {
        if (req.to === "en") throw refusal();
        return primary.translate(req);
      },
    };
    const secondary: TranslationEngine = engine("claude", "c");
    await run(db, { primary: refusing, secondary, judge: createFakeJudge() });
    const secondaryRows = await db.select().from(translations).where(and(eq(translations.entryId, id), eq(translations.kind, "secondary")));
    expect(secondaryRows.map((r) => r.lang).sort()).not.toContain("en");
    expect(secondaryRows).toHaveLength(7);
    const found = await db.select().from(divergences).where(eq(divergences.entryId, id));
    expect(found.map((d) => d.lang)).not.toContain("en");
    expect(found.length).toBe(7);
  });

  it("shows the fallback mark in the label, the title display and the Markdown twin (fallback: true)", async () => {
    const db = await setup();
    const id = await newTopic(db);
    const primary = engine("gemini", "g");
    const refusing: TranslationEngine = {
      ...primary,
      async translate(req) {
        if (req.to === "en") throw refusal();
        return primary.translate(req);
      },
    };
    await run(db, { primary: refusing, secondary: engine("claude", "c-model"), judge: null });
    const html = renderToStaticMarkup(createElement(TranslationLabel, { kind: "primary", engine: "claude", fallback: true }));
    expect(html).toMatch(/<span[^>]+class="[^"]*bg-notice[^"]*"/);
    expect(renderToStaticMarkup(createElement(TranslationLabel, { kind: "primary", engine: "claude" }))).not.toContain("amber-100");
    const [entry] = await db.select({ h: entries.sourceHash }).from(entries).where(eq(entries.id, id));
    const topic = { id, lang: "ja" as const, title: "題", sourceHash: entry.h };
    const titles = await loadTitleDisplays(db, [topic], { readLangs: ["en"], displayLang: "en" });
    expect(titles.get(id)).toMatchObject({ kind: "primary", engine: "claude", fallback: true });
    const fr = await loadTitleDisplays(db, [topic], { readLangs: ["fr"], displayLang: "fr" });
    expect(fr.get(id)).toMatchObject({ kind: "primary", engine: "gemini", fallback: false });
    const md = (await buildThreadMarkdown(db, id, { page: 1, lang: "en", sentences: false, k: null }))!;
    const translation = parseBlocks(md).find((b) => b.fm.type === "translation")!;
    expect(translation.fm).toMatchObject({ lang: "en", status: "machine", engine: "claude", model: "c-model", fallback: true });
    const frMd = parseBlocks((await buildThreadMarkdown(db, id, { page: 1, lang: "fr", sentences: false, k: null }))!).find((b) => b.fm.type === "translation")!;
    expect(frMd.fm).not.toHaveProperty("fallback");
  });
});

describe("translation_revisions", () => {
  const engines = (): EngineSet => ({ primary: createFakeEngine(), secondary: null, judge: null });

  it("keeps the old machine translation when an edit makes the job translate again", async () => {
    const db = await setup();
    const id = await newTopic(db, { body: "古い本文。" });
    await run(db, engines(), { now: t0 });
    const [before] = await db.select().from(translations).where(and(eq(translations.entryId, id), eq(translations.lang, "en"), eq(translations.field, "body")));
    expect(await revisions(db, id)).toEqual([]);
    await editEntry(db, "u1", id, { title: "題", body: "新しい本文。" }, { now: new Date("2026-10-06T00:00:00Z") });
    await run(db, engines(), { now: new Date("2026-10-06T00:01:00Z") });
    const revs = (await revisions(db, id)).filter((r) => r.lang === "en");
    expect(revs).toHaveLength(1);
    expect(revs[0]).toMatchObject({
      entryId: id,
      field: "body",
      lang: "en",
      kind: "primary",
      text: "[en] 古い本文。",
      engine: "fake",
      model: "fake-1",
      sourceHash: before.sourceHash,
      fallback: false,
      reason: "retranslate",
    });
    expect(revs[0].createdAt).toEqual(before.createdAt);
    expect(revs[0].replacedAt).toEqual(new Date("2026-10-06T00:01:00Z"));
    const [now] = await db.select().from(translations).where(and(eq(translations.entryId, id), eq(translations.lang, "en"), eq(translations.field, "body")));
    expect(now.text).toBe("[en] 新しい本文。");
    // The title did not change, so its translation is neither regenerated nor added to history.
    expect((await revisions(db, id)).filter((r) => r.field === "title")).toEqual([]);
  });

  it("records an overwritten human edit, and nothing when the content did not change", async () => {
    const db = await setup();
    const id = await newTopic(db);
    await run(db, engines());
    // Human correction: the first save has no history; the second preserves the first content.
    const rep = await createTranslationReport(db, "u2", { entryId: id, lang: "th", field: "body", excerpt: "x", note: "n" }, { now: t0 });
    if (!rep.ok || rep.id === null) throw new Error("report failed");
    await resolveReportWithHumanTranslation(db, "op", rep.id, "訂正1", { now: t0 });
    expect(await revisions(db, id)).toEqual([]);
    const before = (await revisions(db, id)).length;
    const rep2 = await createTranslationReport(db, "u2", { entryId: id, lang: "th", field: "body", excerpt: "y", note: "n" }, { now: t0 });
    if (!rep2.ok || rep2.id === null) throw new Error("report failed");
    await resolveReportWithHumanTranslation(db, "op", rep2.id, "訂正2", { now: new Date(t0.getTime() + 240_000) });
    const after = await revisions(db, id);
    expect(after).toHaveLength(before + 1);
    expect(after.at(-1)).toMatchObject({ kind: "human", lang: "th", text: "訂正1", reason: "human_edit", createdBy: "op" });
    // Resaving identical content adds no history.
    const rep3 = await createTranslationReport(db, "u2", { entryId: id, lang: "th", field: "body", excerpt: "z", note: "n" }, { now: t0 });
    if (!rep3.ok || rep3.id === null) throw new Error("report failed");
    await resolveReportWithHumanTranslation(db, "op", rep3.id, "訂正2", { now: new Date(t0.getTime() + 300_000) });
    expect(await revisions(db, id)).toHaveLength(before + 1);
  });

  it("is removed together with the translations when the entry is deleted", async () => {
    const db = await setup();
    const id = await newTopic(db);
    const other = await newTopic(db, { title: "別" });
    await run(db, engines());
    for (const [entry, texts] of [[id, ["B1", "B2"]], [other, ["O1", "O2"]]] as const) {
      for (const text of texts) {
        const rep = await createTranslationReport(db, "u2", { entryId: entry, lang: "th", field: "body", excerpt: text, note: "" });
        if (!rep.ok || rep.id === null) throw new Error("report failed");
        await resolveReportWithHumanTranslation(db, "op", rep.id, text);
      }
    }
    expect(await revisions(db, id)).toHaveLength(1);
    await softDeleteEntry(db, id);
    expect(await revisions(db, id)).toEqual([]);
    expect(await revisions(db, other)).toHaveLength(1);
  });
});
