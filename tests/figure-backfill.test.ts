import sharp from "sharp";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { backfillFigures } from "~/lib/figure-backfill.server";
import { figureCostProfile, estimateFigureTranslation } from "~/lib/figure-cost.server";
import { entries, figureMedia, figureReadings, figureTranslations, jobs, llmUsage, media, villages } from "~/lib/db/schema";
import { putMedia, deleteMedia } from "~/lib/media-store.server";
import { createTopic, createReply } from "~/lib/entries.server";
import { availableFigures, enqueuePublicFigures, readingKeyOf, readFigureTranslation } from "~/lib/figure-translation.server";
import { FIGURE_VERSION, figurePath, type FigureReading } from "~/lib/figure";
import { prepareEntryFigureDisplay } from "~/lib/figure-display.server";
import { createFigureReader, parseFigureReading } from "~/lib/figure-reading.server";
import { createFigureHandlers } from "~/lib/jobs/figure-jobs.server";
import { createFakeEngine } from "~/lib/llm/engines/fake.server";
import { runDueJobs } from "~/lib/jobs/queue.server";
import { runFigureBackfill } from "../scripts/figure-backfill";
import { addMember, createTestDb } from "./helpers/db";
import { captureCli } from "./helpers/cli";
import { quietLogger } from "./helpers/logger";

// Keep the queue reference after the pinned test clock so newly enqueued
// PostgreSQL jobs are due despite their sub-millisecond run_at precision.
const jobNow = new Date("2026-10-01T00:00:00Z");
const env = { TRANSLATION_PRIMARY: "fake", FIGURE_TRANSLATION: "0", ENABLED_LANGS: "ja,en" };
beforeEach(() => { vi.stubEnv("FIGURE_TRANSLATION", "0"); vi.stubEnv("ENABLED_LANGS", "ja,en"); });
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

async function fixture() {
  const db = await createTestDb();
  await addMember(db, "backfill-a", "backfill_a"); await addMember(db, "backfill-b", "backfill_b");
  const image = async (owner = "backfill-a", color = "#eeeeee", opts: { avatar?: boolean; villageId?: string } = {}) => {
    const width = opts.avatar ? 256 : 320, height = opts.avatar ? 256 : 180;
    const bytes = await sharp({ create: { width, height, channels: 3, background: color } }).webp({ lossless: true }).toBuffer();
    return putMedia(db, owner, { bytes, width, height }, opts);
  };
  const post = async (url: string, owner = "backfill-a") => {
    const result = await createTopic(db, owner, { title: "Backfill source", body: `![caption](${url})`, lang: "en" });
    if (!result.ok) throw Error(result.error);
    return result.id;
  };
  return { db, image, post };
}

it("previews distinct authored public images without jobs, caches or provider calls", async () => {
  const { db, image, post } = await fixture();
  const a = await image(), b = await image("backfill-b");
  const topic = await post(a.url); await post(a.url); await post(b.url, "backfill-b");
  await createReply(db, "backfill-a", topic, { body: `![caption](${a.url})`, lang: "en" });
  await image("backfill-a", "#123456"); // Unpublished upload.
  const hidden = await post((await image("backfill-a", "#234567")).url);
  await createReply(db, "backfill-a", hidden, { body: `![caption](${(await image("backfill-a", "#345678")).url})`, lang: "en" });
  await db.update(entries).set({ hiddenAt: new Date() }).where(eq(entries.id, hidden));
  const deleted = await post((await image("backfill-a", "#456789")).url);
  await db.update(entries).set({ deletedAt: new Date() }).where(eq(entries.id, deleted));
  const [closedVillage] = await db.insert(villages).values({ kind: "open", slug: null }).returning({ id: villages.id });
  const closed = await post((await image("backfill-a", "#56789a")).url);
  await db.update(entries).set({ villageId: closedVillage.id }).where(eq(entries.id, closed));
  await post((await image("backfill-a", "#6789ab", { avatar: true })).url);
  const icon = await image("backfill-a", "#789abc", { villageId: closedVillage.id });
  await post(icon.url);
  const copied = await image("backfill-b", "#89abcd"); await post(copied.url); // Only another author's reference.
  const originalJobs = await db.select().from(jobs);
  const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(Error("Unexpected network request"));
  const result = await captureCli(output => runFigureBackfill([], env, async () => db, output));
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ mode: "preview", eligibleImages: 2, uniqueContents: 1, readingsNeeded: 1, registeredImages: 0, totalUsdMicro: 0 });
  expect(await db.select().from(jobs)).toEqual(originalJobs);
  expect(await db.select().from(figureMedia)).toEqual([]); expect(await db.select().from(figureReadings)).toEqual([]); expect(await db.select().from(llmUsage)).toEqual([]);
  expect(fetch).not.toHaveBeenCalled();
  vi.stubEnv("FIGURE_TRANSLATION", "1");
  expect(await db.transaction(tx => enqueuePublicFigures(tx, [icon.url.slice(7, 71)], { ...env, FIGURE_TRANSLATION: "1" }))).toBe(0);
});

it("only enqueues with an explicit opt-in, deduplicates content, and skips finished work", async () => {
  const { db, image, post } = await fixture();
  await post((await image()).url); await post((await image("backfill-b")).url, "backfill-b");
  const open = vi.fn(async () => db);
  expect((await captureCli(output => runFigureBackfill(["--enqueue"], env, open, output))).status).toBe(1); expect(open).not.toHaveBeenCalled();
  vi.stubEnv("FIGURE_TRANSLATION", "1");
  const enabled = { ...env, FIGURE_TRANSLATION: "1" };
  expect((await captureCli(output => runFigureBackfill(["--enqueue"], enabled, open, output))).status).toBe(0);
  expect(await db.select().from(figureMedia)).toHaveLength(2); expect(await db.select().from(figureReadings)).toHaveLength(1);
  expect(await db.select().from(jobs).where(eq(jobs.kind, "read_figure"))).toHaveLength(1);
  await backfillFigures(db, { enqueue: true, env: enabled });
  expect(await db.select().from(jobs).where(eq(jobs.kind, "read_figure"))).toHaveLength(1);
  expect(await runDueJobs(db, createFigureHandlers({ llm: { env: enabled } }), { now: jobNow, logger: quietLogger })).toMatchObject({ failed: 0 });
  expect(await db.select().from(figureTranslations)).toHaveLength(2);
  expect(await backfillFigures(db, { env: enabled })).toMatchObject({ readingsNeeded: 0, translationCallsEstimated: 0, totalUsdMicro: 0 });
});

it.each(["skipped", "ready"] as const)("reuses a current-version %s mixed-language reading without another reading call", async state => {
  const { db, image, post } = await fixture();
  const upload = await image(), id = upload.url.slice(7, 71), entryId = await post(upload.url);
  const [stored] = await db.select({ bytes: media.bytes }).from(media).where(eq(media.id, id));
  const key = readingKeyOf(stored.bytes!);
  const reading: FigureReading = { lang: "ja", confidence: 1, regions: [
    { text: "日本語", lang: "ja", confidence: 1, orientation: "horizontal", x: 0.1, y: 0.2, width: 0.8, height: 0.5 },
    { text: "AI".repeat(400), lang: "en", confidence: 0.1, orientation: "vertical", x: 0.01, y: 0.01, width: 0.02, height: 0.02 },
  ] };
  await db.insert(figureReadings).values({ key, version: FIGURE_VERSION, state, reading, engine: "fake", model: "cached-reader", promptVersion: "figure-reading-v3" });
  await db.insert(figureMedia).values({ mediaId: id, readingKey: key });
  const [before] = await db.select().from(figureReadings);
  const previewEnv = { ...env, TRANSLATION_PRIMARY: "gemini" };
  const profile = figureCostProfile(previewEnv);
  const cost = estimateFigureTranslation(profile, "ja", "en", previewEnv, ["日本語"], []).estimatedUsdMicro;
  expect(cost).toBeLessThan(estimateFigureTranslation(profile, "ja", "en", previewEnv, reading.regions.map(region => region.text), []).estimatedUsdMicro);
  expect(await backfillFigures(db, { env: previewEnv })).toMatchObject({ readingsNeeded: 0, cachedSkippedImages: 0, translationCallsEstimated: 1, readingUsdMicro: 0, translationUsdMicro: cost });
  expect((await db.select().from(figureReadings))[0]).toEqual(before);
  expect(await db.select().from(jobs).where(eq(jobs.kind, "translate_figure"))).toEqual([]);
  vi.stubEnv("FIGURE_TRANSLATION", "1");
  const enabled = { ...env, FIGURE_TRANSLATION: "1" };
  const reader = createFigureReader(enabled), read = vi.spyOn(reader, "read");
  const engine = createFakeEngine(), translate = vi.spyOn(engine, "translate").mockResolvedValue({
    text: JSON.stringify(["Label"]), model: engine.model, promptVersion: "test", inputTokens: 10, outputTokens: 10,
  });
  const result = await captureCli(output => runFigureBackfill(["--enqueue"], enabled, async () => db, output));
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ readingsNeeded: 0, cachedSkippedImages: 0, registeredImages: 1, translationCallsEstimated: 1 });
  expect((await db.select().from(figureReadings))[0]).toEqual({ ...before, state: "ready" });
  expect(await db.select().from(jobs).where(eq(jobs.kind, "read_figure"))).toEqual([]);
  const [entry] = await db.select().from(entries).where(eq(entries.id, entryId));
  expect((await prepareEntryFigureDisplay(db, [entryId], "en"))(entryId, entry.html!)).toBe(entry.html);
  const handlers = createFigureHandlers({ reader, llm: { env: enabled, engines: { primary: engine, secondary: null, judge: null } } });
  expect(await runDueJobs(db, handlers, { now: jobNow, logger: quietLogger })).toMatchObject({ done: 1, failed: 0 });
  expect(read).not.toHaveBeenCalled();
  expect(translate).toHaveBeenCalledTimes(1);
  expect(translate.mock.calls[0][0]).toMatchObject({ from: "ja", to: "en", text: JSON.stringify(["日本語"]) });
  expect(await db.select().from(figureTranslations)).toEqual([expect.objectContaining({ readingKey: key, lang: "en", state: "ready", labels: expect.any(Array) })]);
  expect((await prepareEntryFigureDisplay(db, [entryId], "en"))(entryId, entry.html!)).toContain(figurePath(id, 320, 180, "en"));
  expect((await prepareEntryFigureDisplay(db, [entryId], "ja"))(entryId, entry.html!)).toBe(entry.html);
  expect(await backfillFigures(db, { enqueue: true, env: enabled })).toMatchObject({ readingsNeeded: 0, translationCallsEstimated: 0 });
  expect(await runDueJobs(db, handlers, { now: jobNow, logger: quietLogger })).toMatchObject({ done: 0, failed: 0 });
  expect(translate).toHaveBeenCalledTimes(1);
});

it.each([1, 2, 3].flatMap(version => (["skipped", "ready"] as const).map(state => ({ version, state }))))("requeues a v$version $state reading, serves the original while pending and removes both versions on withdrawal", async ({ version, state }) => {
  const { db, image, post } = await fixture();
  const upload = await image(), id = upload.url.slice(7, 71), entryId = await post(upload.url);
  const [stored] = await db.select({ bytes: media.bytes }).from(media).where(eq(media.id, id));
  const currentKey = readingKeyOf(stored.bytes!), oldKey = currentKey.replace(/:v\d+$/, `:v${version}`);
  expect(FIGURE_VERSION).toBe(12);
  expect(currentKey).toMatch(new RegExp(`:v${FIGURE_VERSION}$`));
  expect(currentKey).not.toBe(oldKey);
  const reader = createFigureReader({ TRANSLATION_PRIMARY: "fake" });
  const reading = parseFigureReading((await reader.read(stored.bytes!)).text);
  expect(reading).not.toBeNull();
  await db.insert(figureReadings).values({ key: oldKey, version, state, reading: state === "ready" ? reading : null });
  await db.insert(figureMedia).values({ mediaId: id, readingKey: oldKey });
  if (state === "ready") await db.insert(figureTranslations).values({ mediaId: id, readingKey: oldKey, lang: "ja", bytes: stored.bytes, labels: ["Previous label"], engine: "fake", model: "old-figure", promptVersion: "old" });
  vi.stubEnv("FIGURE_TRANSLATION", "1");
  const enabled = { ...env, FIGURE_TRANSLATION: "1" };
  expect(await backfillFigures(db, { env: enabled })).toMatchObject({ readingsNeeded: 1, cachedSkippedImages: 0 });
  const result = await captureCli(output => runFigureBackfill(["--enqueue"], enabled, async () => db, output));
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ readingsNeeded: 1, registeredImages: 1 });
  const pending = await db.select().from(figureReadings).where(eq(figureReadings.key, currentKey));
  expect(pending).toEqual([expect.objectContaining({ version: FIGURE_VERSION, state: "pending", reading: null })]);
  const queued = await db.select().from(jobs).where(eq(jobs.kind, "read_figure"));
  expect(queued).toEqual([expect.objectContaining({ payload: { key: currentKey }, status: "queued" })]);
  const [entry] = await db.select().from(entries).where(eq(entries.id, entryId));
  expect(await availableFigures(db, [id], "ja")).toEqual(new Map());
  expect((await prepareEntryFigureDisplay(db, [entryId], "ja"))(entryId, entry.html!)).toBe(entry.html);
  expect(await readFigureTranslation(db, id, "ja", FIGURE_VERSION)).toBeNull();
  expect((await readFigureTranslation(db, id, "ja", version))?.key ?? null).toBe(state === "ready" ? oldKey : null);
  const read = vi.spyOn(reader, "read");
  expect(await runDueJobs(db, createFigureHandlers({ reader, llm: { env: enabled } }), { now: jobNow, logger: quietLogger })).toMatchObject({ failed: 0 });
  expect(read).toHaveBeenCalledTimes(1);
  expect(await availableFigures(db, [id], "ja")).toEqual(new Map([[id, { hasImage: true, results: expect.any(Array) }]]));
  expect((await prepareEntryFigureDisplay(db, [entryId], "ja"))(entryId, entry.html!)).toContain(figurePath(id, 320, 180, "ja"));
  expect((await readFigureTranslation(db, id, "ja", FIGURE_VERSION))?.key).toBe(currentKey);
  expect((await readFigureTranslation(db, id, "ja", version))?.key ?? null).toBe(state === "ready" ? oldKey : null);
  expect(await db.select().from(figureReadings)).toHaveLength(2);
  await deleteMedia(db, id);
  expect(await db.select().from(figureReadings)).toEqual([]);
  expect(await db.select().from(figureMedia)).toEqual([]);
  expect(await db.select().from(figureTranslations)).toEqual([]);
  for (const job of await db.select().from(jobs).where(eq(jobs.kind, "read_figure"))) {
    expect(job.status).toBe("done");
    expect(job.payload).toEqual({ discardPaidTranslationCalls: true });
  }
});

it("rechecks visibility before registration and scans more than one page", async () => {
  const { db, image, post } = await fixture();
  const first = await image(), id = await post(first.url);
  expect((await backfillFigures(db, { env })).eligibleImages).toBe(1);
  await db.update(entries).set({ hiddenAt: new Date() }).where(eq(entries.id, id));
  expect(await db.transaction(tx => enqueuePublicFigures(tx, [first.url.slice(7, 71)], { ...env, FIGURE_TRANSLATION: "1" }))).toBe(0);
  for (let i = 0; i < 26; i++) await post((await image("backfill-a", `rgb(${i}, 12, 34)`)).url);
  expect(await backfillFigures(db, { env })).toMatchObject({ eligibleImages: 26, uniqueContents: 26, readingsNeeded: 26 });
});

it("uses the configured primary model, prices and thinking for the cost preview", () => {
  const configured = { TRANSLATION_PRIMARY: "gemini", TRANSLATION_GEMINI_MODEL: "gemini-3.8-flash", GEMINI_TRANSLATION_THINKING: "low" };
  const profile = figureCostProfile(configured);
  expect(profile.reader.model).toBe("gemini-3.5-flash-lite");
  expect(profile.primary).toMatchObject({ model: "gemini-3.8-flash", thinking: "low", inputUsdPerMillion: 1.5, outputUsdPerMillion: 7.5 });
  const estimate = estimateFigureTranslation(profile, "en", "ja", configured);
  const liteEnv = { ...configured, TRANSLATION_GEMINI_MODEL: "gemini-3.5-flash-lite" };
  expect(estimate.estimatedUsdMicro).toBeGreaterThan(estimateFigureTranslation(figureCostProfile(liteEnv), "en", "ja", liteEnv).estimatedUsdMicro);
  expect(estimate.estimatedUsdMicro).toBeGreaterThan(estimate.textOnlyUsdMicro);
  const override = { ...configured, LLM_PRICE_GEMINI_3_8_FLASH: "2,9" };
  expect(figureCostProfile(override).primary).toMatchObject({ priceSource: "env", inputUsdPerMillion: 2, outputUsdPerMillion: 9 });
});

it("previews and rereads only rejected readings, preserving text-free and accepted caches", async () => {
  const { db, image, post } = await fixture();
  const cases = ["rejected", "old-rejected", "text-free", "accepted", "pending", "missing", "hidden"] as const;
  const keys = new Map<string, string>(), ids = new Map<string, string>();
  for (const [i, kind] of cases.entries()) {
    const upload = await image("backfill-a", `rgb(${i * 20}, 30, 40)`), id = upload.url.slice(7, 71);
    const topic = await post(upload.url);
    const [stored] = await db.select({ bytes: media.bytes }).from(media).where(eq(media.id, id));
    const key = readingKeyOf(stored.bytes!);
    keys.set(kind, key); ids.set(kind, id);
    if (kind === "missing") continue;
    const rejected = kind === "rejected" || kind === "old-rejected" || kind === "hidden";
    const reader = createFigureReader(env);
    const reading = rejected || kind === "pending" ? null : kind === "text-free" ? { lang: null, confidence: 1, regions: [] } : parseFigureReading((await reader.read(stored.bytes!)).text);
    const savedKey = kind === "old-rejected" ? key.replace(/:v\d+$/, ":v4") : key;
    await db.insert(figureReadings).values({ key: savedKey, version: kind === "old-rejected" ? 4 : FIGURE_VERSION, state: rejected || kind === "text-free" ? "skipped" : kind === "pending" ? "pending" : "ready", reading, promptVersion: "figure-reading-v4" });
    await db.insert(figureMedia).values({ mediaId: id, readingKey: savedKey });
    if (kind === "hidden") await db.update(entries).set({ hiddenAt: new Date() }).where(eq(entries.id, topic));
  }
  // Repeated content is read once even when it belongs to two public uploads.
  const [rejectedBytes] = await db.select({ bytes: media.bytes }).from(media).where(eq(media.id, ids.get("rejected")!));
  const duplicate = await putMedia(db, "backfill-b", { bytes: rejectedBytes.bytes!, width: 320, height: 180 });
  await post(duplicate.url, "backfill-b");
  const before = await db.select().from(figureReadings), beforeJobs = await db.select().from(jobs);
  const configured = { ...env, TRANSLATION_PRIMARY: "gemini" };
  const preview = await captureCli(output => runFigureBackfill(["--reread-rejected"], configured, async () => db, output));
  expect(preview.status).toBe(0);
  const estimate = JSON.parse(preview.stdout);
  expect(estimate).toMatchObject({ mode: "preview", selection: "rejected", eligibleImages: 3, uniqueContents: 2, readingsNeeded: 2, cachedSkippedImages: 0, registeredImages: 0 });
  expect(estimate.readingUsdMicro).toBe(2 * figureCostProfile(configured).reader.estimatedUsdMicro);
  expect(estimate.totalUsdMicro).toBeGreaterThan(0);
  expect(await db.select().from(figureReadings)).toEqual(before);
  expect(await db.select().from(jobs)).toEqual(beforeJobs);
  vi.stubEnv("FIGURE_TRANSLATION", "1");
  const enabled = { ...configured, FIGURE_TRANSLATION: "1" };
  const enqueue = await captureCli(output => runFigureBackfill(["--reread-rejected", "--enqueue"], enabled, async () => db, output));
  expect(enqueue.status).toBe(0);
  expect(JSON.parse(enqueue.stdout)).toMatchObject({ ...estimate, mode: "enqueue", registeredImages: 3 });
  const pending = await db.select().from(jobs).where(eq(jobs.kind, "read_figure"));
  expect(pending.map(job => (job.payload as { key: string }).key).sort()).toEqual([keys.get("rejected"), keys.get("old-rejected")].sort());
  for (const row of before.filter(row => row.key !== keys.get("rejected"))) {
    expect((await db.select().from(figureReadings).where(eq(figureReadings.key, row.key)))[0]).toEqual(row);
  }
  expect(await backfillFigures(db, { rereadRejected: true, enqueue: true, env: enabled })).toMatchObject({ eligibleImages: 0, readingsNeeded: 0, registeredImages: 0 });
  expect(await db.select().from(llmUsage)).toEqual([]);
});

it("handles help and invalid options before opening a database", async () => {
  const open = vi.fn();
  expect((await captureCli(output => runFigureBackfill(["--help"], env, open, output))).status).toBe(0);
  expect((await captureCli(output => runFigureBackfill(["--invalid"], env, open, output))).status).toBe(1);
  expect(open).not.toHaveBeenCalled();
  expect((await captureCli(output => runFigureBackfill([], env, async () => { throw Error("Synthetic database failure"); }, output))).status).toBe(1);
});

it.each([4, 5, 6, 7, 8, 9, 10, 11].flatMap(version => (["ready", "skipped"] as const).map(state => ({ version, state }))))("rebuilds v$version $state variants with the cached reading and no reading call", async ({ version, state }) => {
  const { db, image, post } = await fixture();
  const upload = await image(), id = upload.url.slice(7, 71);
  await post(upload.url);
  const [stored] = await db.select({ bytes: media.bytes }).from(media).where(eq(media.id, id));
  const key = readingKeyOf(stored.bytes!), oldKey = key.replace(/:v\d+$/, `:v${version}`);
  const reader = createFigureReader({ TRANSLATION_PRIMARY: "fake" });
  const reading = parseFigureReading((await reader.read(stored.bytes!)).text)!;
  await db.insert(figureReadings).values({ key: oldKey, version, state: "ready", reading, engine: "fake", model: "cached-reader", promptVersion: "figure-reading-v4" });
  await db.insert(figureMedia).values({ mediaId: id, readingKey: oldKey });
  await db.insert(figureTranslations).values({ mediaId: id, readingKey: oldKey, lang: "ja", state, bytes: state === "ready" ? stored.bytes : null, labels: state === "ready" ? ["旧ラベル"] : null, engine: "fake", model: "old-model", promptVersion: "figure-translation-v1" });
  const oldReadings = await db.select().from(figureReadings), oldVariants = await db.select().from(figureTranslations);
  vi.stubEnv("FIGURE_TRANSLATION", "1");
  const enabled = { ...env, FIGURE_TRANSLATION: "1" };
  expect(await backfillFigures(db, { env: enabled })).toMatchObject({ readingsNeeded: 0, translationCallsEstimated: 1, readingUsdMicro: 0 });
  expect(await db.select().from(figureReadings)).toEqual(oldReadings);
  await backfillFigures(db, { enqueue: true, env: enabled });
  expect(await db.select().from(jobs).where(eq(jobs.kind, "read_figure"))).toEqual([]);
  const read = vi.spyOn(reader, "read"), engine = createFakeEngine(), translate = vi.spyOn(engine, "translate");
  expect(await runDueJobs(db, createFigureHandlers({ reader, llm: { env: enabled, engines: { primary: engine, secondary: null, judge: null } } }), { now: jobNow, logger: quietLogger })).toMatchObject({ done: 1, failed: 0 });
  expect(read).not.toHaveBeenCalled(); expect(translate).toHaveBeenCalledTimes(1);
  expect(await db.select().from(figureReadings).where(eq(figureReadings.key, oldKey))).toEqual(oldReadings);
  expect(await db.select().from(figureTranslations).where(eq(figureTranslations.readingKey, oldKey))).toEqual(oldVariants);
  expect(await readFigureTranslation(db, id, "ja", FIGURE_VERSION)).toMatchObject({ key });
  expect(await backfillFigures(db, { enqueue: true, env: enabled })).toMatchObject({ readingsNeeded: 0, translationCallsEstimated: 0 });
  await deleteMedia(db, id);
  expect(await db.select().from(figureReadings)).toEqual([]);
  expect(await db.select().from(figureTranslations)).toEqual([]);
});

it.each([
  { translated: "Volume vs. water level ε", status: "rendered", reason: null },
  { translated: "Volume vs. water level", status: "external", reason: "math_mismatch" },
])("normalizes cached v7 TeX labels for $status results without rewriting readings", async ({ translated, status, reason }) => {
  const { db, image, post } = await fixture();
  const upload = await image(), id = upload.url.slice(7, 71), entryId = await post(upload.url);
  const [stored] = await db.select({ bytes: media.bytes }).from(media).where(eq(media.id, id));
  const key = readingKeyOf(stored.bytes!), oldKey = key.replace(/:v\d+$/, ":v7");
  const source = "“水位” \\epsilon の増加に対する体積の依存性", normalized = "“水位” ε の増加に対する体積の依存性";
  const reading: FigureReading = { lang: "ja", confidence: 1, regions: [{ text: source, lang: "ja", confidence: 1, x: 0.1, y: 0.2, width: 0.8, height: 0.5, orientation: "horizontal" }] };
  await db.insert(figureReadings).values({ key: oldKey, version: 7, state: "ready", reading, engine: "fake", model: "cached-reader", promptVersion: "figure-reading-v4" });
  await db.insert(figureMedia).values({ mediaId: id, readingKey: oldKey });
  const [oldReading] = await db.select().from(figureReadings);
  vi.stubEnv("FIGURE_TRANSLATION", "1");
  const enabled = { ...env, FIGURE_TRANSLATION: "1" };
  const result = await captureCli(output => runFigureBackfill(["--enqueue"], enabled, async () => db, output));
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ readingsNeeded: 0, translationCallsEstimated: 1, readingUsdMicro: 0 });
  expect(await db.select().from(jobs).where(eq(jobs.kind, "read_figure"))).toEqual([]);
  const reader = createFigureReader(enabled), read = vi.spyOn(reader, "read");
  const engine = createFakeEngine(), translate = vi.spyOn(engine, "translate").mockResolvedValue({ text: JSON.stringify([translated]), model: engine.model, promptVersion: "test", inputTokens: 10, outputTokens: 20 });
  expect(await runDueJobs(db, createFigureHandlers({ reader, llm: { env: enabled, engines: { primary: engine, secondary: null, judge: null } } }), { now: jobNow, logger: quietLogger })).toMatchObject({ done: 1, failed: 0 });
  expect(read).not.toHaveBeenCalled();
  expect(translate).toHaveBeenCalled();
  for (const [request] of translate.mock.calls) expect(request).toMatchObject({ from: "ja", to: "en", text: JSON.stringify([normalized]) });
  const [saved] = await db.select().from(figureTranslations).where(eq(figureTranslations.readingKey, key));
  expect(saved.labelResults).toMatchObject([{ source: normalized, translation: translated, status, reason }]);
  expect(saved.bytes !== null).toBe(status === "rendered");
  expect(await db.select().from(figureReadings).where(eq(figureReadings.key, oldKey))).toEqual([oldReading]);
  expect((await db.select().from(figureReadings).where(eq(figureReadings.key, key)))[0]).toMatchObject({ version: FIGURE_VERSION, reading, promptVersion: "figure-reading-v4" });
  const [entry] = await db.select().from(entries).where(eq(entries.id, entryId));
  const html = (await prepareEntryFigureDisplay(db, [entryId], "en"))(entryId, entry.html!);
  if (status === "rendered") expect(html).toContain(figurePath(id, 320, 180, "en"));
  else {
    expect(html).toContain(normalized);
    expect(html).not.toContain("\\epsilon");
    expect(html).toContain("data-figure-fallback");
  }
});

it("retains a settled v4 rejection without paying for another reading", async () => {
  const { db, image, post } = await fixture();
  const upload = await image(), id = upload.url.slice(7, 71);
  await post(upload.url);
  const [stored] = await db.select({ bytes: media.bytes }).from(media).where(eq(media.id, id));
  const key = readingKeyOf(stored.bytes!), oldKey = key.replace(/:v\d+$/, ":v4");
  await db.insert(figureReadings).values({ key: oldKey, version: 4, state: "skipped", reading: null, engine: "fake", model: "refused-reader", promptVersion: "figure-reading-v4" });
  await db.insert(figureMedia).values({ mediaId: id, readingKey: oldKey });
  vi.stubEnv("FIGURE_TRANSLATION", "1");
  const beforeJobs = await db.select().from(jobs);
  expect(await backfillFigures(db, { enqueue: true, env: { ...env, FIGURE_TRANSLATION: "1" } })).toMatchObject({ readingsNeeded: 0, cachedSkippedImages: 1, translationCallsEstimated: 0, registeredImages: 1 });
  expect(await db.select().from(jobs)).toEqual(beforeJobs);
  expect(await db.select().from(figureReadings).where(eq(figureReadings.key, key))).toEqual([expect.objectContaining({ state: "skipped", reading: null, promptVersion: "figure-reading-v4" })]);
  expect(await db.select().from(llmUsage)).toEqual([]);
});
