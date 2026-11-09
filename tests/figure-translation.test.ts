import { prepareEntryFigureDisplay } from "~/lib/figure-display.server";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StaticRouter } from "react-router";
import sharp from "sharp";
import { and, eq, inArray } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "~/lib/db/client.server";
import { entries, figureMedia, figureReadings, figureTranslations, jobs, llmUsage, media, translations, glossaryEntries } from "~/lib/db/schema";
import { createTopic, createReply, editEntry, softDeleteEntry } from "~/lib/entries.server";
import { figurePath, FIGURE_VERSION, type FigureReading } from "~/lib/figure";
import { inspectTranslation } from "~/lib/llm/translation-inspect.core.server";
import { createFigureReader } from "~/lib/figure-reading.server";
import { figureBox } from "~/lib/figure-space.server";
import { renderFigure } from "./helpers/figure-render";
import { enqueueEntryFigures, READ_FIGURE_JOB, TRANSLATE_FIGURE_JOB } from "~/lib/figure-translation.server";
import { createFigureHandlers } from "~/lib/jobs/figure-jobs.server";
import { runDueJobs } from "~/lib/jobs/queue.server";
import { createFakeEngine } from "~/lib/llm/engines/fake.server";
import { LlmError } from "~/lib/llm/errors.server";
import { backfillFigures } from "~/lib/figure-backfill.server";
import * as figureFonts from "~/lib/figure-fonts.server";
import * as llm from "~/lib/llm/index.server";
import { leakedReasoning } from "./helpers/translation-leak";
import { putMedia, deleteMedia, readFigureSource } from "~/lib/media-store.server";
import { loadEntryDisplays } from "~/lib/entry-display.server";
import { TranslatedEntry } from "~/components/translated-entry";
import { deleteAccount } from "~/lib/account-delete.server";
import { loader as mediaLoader } from "~/routes/media-file";
import { addMember, createTestDb } from "./helpers/db";
import { quietLogger } from "./helpers/logger";

vi.mock("~/paraglide/messages.js", async () => ({ m: (await import("./helpers/messages-json")).jsonMessages() }));
let db: Db;
vi.mock("~/lib/media-reader.server", () => ({ getMediaReader: async () => ({ db, viewer: null }) }));
const origin = "http://localhost:5455";
const kinds = [READ_FIGURE_JOB, TRANSLATE_FIGURE_JOB];
// The test clock starts in September 2026. Run later so PostgreSQL's
// sub-millisecond run_at defaults are due, including jobs created in this batch.
const jobNow = new Date("2026-10-01T00:00:00Z");
const get = (path: string, headers: Record<string, string> = {}, method = "GET") => mediaLoader({ request: new Request(origin + path, { headers, method }) });
const sourceReading: FigureReading = { lang: "en", confidence: 1, regions: [{ lang: "en", text: "A figure label", x: 0.1, y: 0.2, width: 0.8, height: 0.5, confidence: 1, orientation: "horizontal" }] };
const readingResponse = (reading: FigureReading) => JSON.stringify({ ...reading, regions: reading.regions.map(({ x, y, width, height, ...label }) => ({
  ...label, box_2d: [y, x, y + height, x + width].map(value => Math.round(value * 1000)),
})) });

beforeEach(() => {
  vi.stubEnv("FIGURE_TRANSLATION", "1"); vi.stubEnv("ENABLED_LANGS", "ja,en"); vi.stubEnv("BETTER_AUTH_URL", origin);
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

async function world(imageBytes?: Buffer) {
  db = await createTestDb();
  await addMember(db, "figure-author", "figure_author");
  const bytes = imageBytes ?? await sharp({ create: { width: 320, height: 180, channels: 3, background: "#d5e5f5" } }).webp({ lossless: true }).toBuffer();
  const upload = await putMedia(db, "figure-author", { bytes, width: 320, height: 180 });
  const alt = 'Writer & "caption"';
  const topic = await createTopic(db, "figure-author", { title: "Figure pipeline", body: `![${alt}](${upload.url})`, lang: "en" });
  if (!topic.ok) throw new Error(topic.error);
  const [entry] = await db.select().from(entries).where(eq(entries.id, topic.id));
  const id = upload.url.slice("/media/".length, "/media/".length + 64);
  const path = figurePath(id, 320, 180, "ja");
  const reader = createFigureReader({ TRANSLATION_PRIMARY: "fake" }); reader.read = vi.fn(reader.read);
  const engine = createFakeEngine(); engine.translate = vi.fn(engine.translate);
  const handlers = createFigureHandlers({ reader, llm: { engines: { primary: engine, secondary: null, judge: null } } });
  await runDueJobs(db, { prepare_figures: handlers.prepare_figures }, { now: jobNow, logger: quietLogger });
  const run = (limit = 20) => runDueJobs(db, handlers, { now: jobNow, limit, logger: quietLogger });
  return { ...upload, bytes, alt, entry, id, path, reader, engine, handlers, run };
}

describe("figure translation pipeline", () => {
  it.each([
    { source: "“水位” \\epsilon の増加に対する体積の依存性", normalized: "“水位” ε の増加に対する体積の依存性", translated: "Volume vs. water level ε", status: "rendered" },
    { source: "\\epsilon", normalized: "ε", translated: "ε", status: "unchanged" },
    { source: "\\section{はじめに}", normalized: "\\section{はじめに}", translated: "\\section{Introduction}", status: "rendered" },
  ])("normalizes a fresh reading of $source before translation and label comparison", async ({ source, normalized, translated, status }) => {
    const w = await world();
    const reading: FigureReading = { ...sourceReading, lang: "ja", regions: [{ ...sourceReading.regions[0], lang: "ja", text: source }] };
    vi.mocked(w.reader.read).mockResolvedValueOnce({ text: readingResponse(reading), model: w.reader.model, promptVersion: "figure-reading-v4", inputTokens: 10, outputTokens: 50 });
    vi.mocked(w.engine.translate).mockResolvedValue({ text: JSON.stringify([translated]), model: w.engine.model, promptVersion: "test", inputTokens: 10, outputTokens: 20 });
    expect(await w.run()).toMatchObject({ done: 2, failed: 0 });
    expect(w.reader.read).toHaveBeenCalledTimes(1);
    expect(w.engine.translate).toHaveBeenCalledTimes(1);
    expect(vi.mocked(w.engine.translate).mock.calls[0][0]).toMatchObject({ from: "ja", to: "en", text: JSON.stringify([normalized]) });
    const [saved] = await db.select().from(figureTranslations);
    expect(saved.labelResults).toMatchObject([{ source: normalized, translation: translated, status, reason: null }]);
    expect(saved.bytes !== null).toBe(status === "rendered");
    expect((await db.select().from(figureReadings))[0].reading?.regions[0].text).toBe(source);
  });

  it("reads, translates, renders, serves and displays a figure without changing the translated body's alt or Markdown source", async () => {
    const w = await world();
    expect(await w.run()).toMatchObject({ done: 2, failed: 0 });
    expect(w.reader.read).toHaveBeenCalledTimes(1); expect(w.engine.translate).toHaveBeenCalledTimes(1);
    const request = vi.mocked(w.engine.translate).mock.calls[0][0];
    expect(request).toMatchObject({ figure: true, from: "en", to: "ja" });
    expect(JSON.parse(request.text)).toHaveLength(1);
    const [saved] = await db.select().from(figureTranslations);
    expect(saved).toMatchObject({ lang: "ja", state: "ready" });
    expect(await sharp(saved.bytes!).metadata()).toMatchObject({ format: "webp", width: 320, height: 180 });
    expect(await db.select().from(llmUsage)).toHaveLength(2);
    const image = await get(w.path); expect(image.status).toBe(200);
    const original = await get(w.url); expect(original.status).toBe(200);
    expect(image.headers.get("cache-control")).toBe(original.headers.get("cache-control"));
    expect(image.headers.get("etag")).not.toBe(original.headers.get("etag"));
    expect((await get(w.path, { "If-None-Match": image.headers.get("etag")! })).status).toBe(304);
    expect((await get(w.path, {}, "HEAD")).headers.get("content-length")).toBe(String(saved.bytes!.length));
    expect((await get(w.path.replace("320x180", "1x1"))).status).toBe(404);
    expect((await get(w.path.replace(`v${FIGURE_VERSION}`, "v999"))).status).toBe(404);
    expect((await get(w.path.replace(".ja.", ".fr."))).status).toBe(404);
    await db.insert(translations).values({ entryId: w.entry.id, field: "body", kind: "primary", lang: "ja", text: `![Changed alt](${w.url})`, sourceHash: w.entry.sourceHash, engine: "fake" });
    const options = { readLangs: ["ja" as const], displayLang: "ja" as const };
    const [input] = [{ id: w.entry.id, kind: "topic" as const, lang: "en" as const, sourceHash: w.entry.sourceHash }];
    const display = (await loadEntryDisplays(db, [input], options)).get(w.entry.id)!;
    expect(display.translation!.html).toContain(`src="${w.path}"`);
    expect(display.translation!.html).toContain('alt="Changed alt"');
    expect(display.translation!.html).toContain(`href="${w.url}"`);
    const render = (shown: "original" | "translation") => renderToStaticMarkup(createElement(StaticRouter, { location: `/t/${w.entry.id}` }, createElement(TranslatedEntry, {
      id: w.entry.id, kind: "topic", lang: "en", title: w.entry.title, html: w.entry.html!, display: { ...display, shown }, meta: null,
    })));
    expect(render("translation")).toContain("data-translated-figure");
    expect(render("original")).not.toContain("data-translated-figure");
    expect(render("original")).toContain(`src="${w.url}"`);
    expect((await db.select().from(entries).where(eq(entries.id, w.entry.id)))[0].body).toBe(w.entry.body);
    expect((await db.select().from(translations))[0].text).toContain(w.url);
    expect((await db.select().from(translations))[0].html).not.toContain("data-translated-figure");
  });

  it("translates multiple labels together using the post glossary", async () => {
    const w = await world();
    const reading: FigureReading = { lang: "en", confidence: 1, regions: [
      { ...sourceReading.regions[0], text: "Alignment", x: 0.05, y: 0.1, width: 0.4, height: 0.25 },
      { ...sourceReading.regions[0], text: "Second label", x: 0.55, y: 0.5, width: 0.4, height: 0.25 },
    ] };
    await db.insert(glossaryEntries).values({ term: "Alignment", lang: "en", targetLang: "ja", candidates: ["整合性"] });
    vi.mocked(w.reader.read).mockResolvedValue({ text: readingResponse(reading), model: w.reader.model, promptVersion: "test", inputTokens: 100, outputTokens: 100 });
    await w.run(); expect(w.engine.translate).toHaveBeenCalledTimes(1);
    const request = vi.mocked(w.engine.translate).mock.calls[0][0];
    expect(JSON.parse(request.text)).toEqual(reading.regions.map(region => region.text));
    expect(request.glossary).toEqual([expect.objectContaining({ term: "Alignment", candidates: ["整合性"] })]);
    expect((await db.select().from(figureTranslations))[0].labels).toHaveLength(2);
  });

  it.each(["horizontal", "vertical", "curved"] as const)("translates only the primary-language labels and preserves an uncertain %s foreign label", async orientation => {
    const marker = await sharp({ create: { width: 64, height: 36, channels: 3, background: "#123456" } }).png().toBuffer();
    const bytes = await sharp({ create: { width: 320, height: 180, channels: 3, background: "#d5e5f5" } })
      .composite([{ input: marker, left: 128, top: 18 }]).webp({ lossless: true }).toBuffer();
    const w = await world(bytes);
    const reading: FigureReading = { lang: "ja", confidence: 1, regions: [
      { ...sourceReading.regions[0], lang: "ja", text: "最初の文字", x: 0.05, y: 0.1, width: 0.25, height: 0.3 },
      { ...sourceReading.regions[0], text: "AI", x: 0.4, y: 0.1, width: 0.2, height: 0.2, confidence: 0.1, orientation },
      { ...sourceReading.regions[0], lang: "ja", text: "次の文字", x: 0.7, y: 0.5, width: 0.25, height: 0.3 },
    ] };
    await db.insert(glossaryEntries).values([
      { term: "最初の文字", lang: "ja", targetLang: "en", candidates: ["First label"] },
      { term: "AI", lang: "ja", targetLang: "en", candidates: ["Must not be sent"] },
    ]);
    vi.mocked(w.reader.read).mockResolvedValue({ text: readingResponse(reading), model: w.reader.model, promptVersion: "test", inputTokens: 100, outputTokens: 100 });
    expect(await w.run()).toMatchObject({ done: 2, failed: 0 });
    expect(w.engine.translate).toHaveBeenCalledTimes(1);
    const request = vi.mocked(w.engine.translate).mock.calls[0][0];
    expect(request).toMatchObject({ figure: true, from: "ja", to: "en" });
    expect(JSON.parse(request.text)).toEqual(["最初の文字", "次の文字"]);
    expect(request.glossary).toEqual([expect.objectContaining({ term: "最初の文字" })]);
    const [saved] = await db.select().from(figureTranslations);
    expect(saved).toMatchObject({ lang: "en", state: "ready" });
    expect(saved.labels).toHaveLength(2);
    const original = await sharp(w.bytes).ensureAlpha().raw().toBuffer();
    const rendered = await sharp(saved.bytes!).ensureAlpha().raw().toBuffer();
    const boxes = [reading.regions[0], reading.regions[2]].map(region => figureBox(region, 320, 180));
    let changed = 0;
    for (let y = 0; y < 180; y++) for (let x = 0; x < 320; x++) {
      const offset = (y * 320 + x) * 4;
      const same = rendered.subarray(offset, offset + 4).equals(original.subarray(offset, offset + 4));
      if (boxes.some(box => x >= box.left && x < box.left + box.width && y >= box.top && y < box.top + box.height)) changed += Number(!same);
      else if (!same) {
        // Widened text may use verified background, but the preserved foreign
        // label and every diagram pixel must retain their original RGBA.
        expect([...original.subarray(offset, offset + 4)]).toEqual([0xd5, 0xe5, 0xf5, 255]);
      }
    }
    expect(changed).toBeGreaterThan(0);
    expect((await get(figurePath(w.id, 320, 180, "en"))).status).toBe(200);
    expect((await get(w.path)).status).toBe(404);
    expect(await db.select().from(figureTranslations)).toHaveLength(1);
  });

  it("rejects overlap between primary and preserved foreign labels", async () => {
    const w = await world();
    const reading: FigureReading = { ...sourceReading, lang: "ja", regions: [
      { ...sourceReading.regions[0], lang: "ja", text: "日本語" },
      { ...sourceReading.regions[0], text: "AI", confidence: 0.1, orientation: "vertical" },
    ] };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(w.reader.read).mockResolvedValue({ text: readingResponse(reading), model: w.reader.model, promptVersion: "test", inputTokens: 100, outputTokens: 100 });
    expect(await w.run()).toMatchObject({ done: 1, failed: 0 });
    expect(warn).toHaveBeenCalledWith("[figure-reading] rejected reason=overlapping_regions");
    expect((await db.select().from(figureReadings))[0]).toMatchObject({ state: "skipped", reading: null });
    expect(w.engine.translate).not.toHaveBeenCalled();
    expect(await db.select().from(figureTranslations)).toEqual([]);
  });

  it.each(["repaired", "partial", "all"] as const)("retries overlapping OCR once and settles the %s result", async outcome => {
    const w = await world();
    const kept = { ...sourceReading.regions[0], text: "Keep", x: .1, y: .1, width: .3, height: .2 };
    const a = { ...kept, text: "First", y: .5 }, b = { ...a, text: "Second", x: .2 };
    const overlapping: FigureReading = { ...sourceReading, regions: outcome === "all" ? [a, b] : [kept, a, b] };
    const final = outcome === "repaired" ? { ...overlapping, regions: [kept, a, { ...b, x: .6 }] } : overlapping;
    const response = (reading: FigureReading) => ({ text: readingResponse(reading), model: w.reader.model, promptVersion: "figure-reading-v4", inputTokens: 100, outputTokens: 50 });
    vi.mocked(w.reader.read).mockResolvedValueOnce(response(overlapping)).mockResolvedValueOnce(response(final));
    vi.mocked(w.engine.translate).mockResolvedValue({ text: JSON.stringify(outcome === "repaired" ? ["保持", "一番", "二番"] : ["保持"]), model: w.engine.model, promptVersion: "test", inputTokens: 20, outputTokens: 20 });
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await w.run()).toMatchObject({ done: outcome === "all" ? 1 : 2, failed: 0 });
    expect(w.reader.read).toHaveBeenCalledTimes(2);
    expect(vi.mocked(w.reader.read).mock.calls.map(call => call[2])).toEqual([false, true]);
    const [saved] = await db.select().from(figureReadings);
    expect(saved.state).toBe(outcome === "all" ? "skipped" : "ready");
    expect(saved.reading?.regions.map(r => r.text) ?? null).toEqual(outcome === "all" ? null : outcome === "repaired" ? ["Keep", "First", "Second"] : ["Keep"]);
    expect(saved.promptVersion).toBe("figure-reading-v4");
    if (outcome !== "repaired") expect(log).toHaveBeenCalledWith("[figure-reading] discarded reason=overlapping_regions count=2");
    if (outcome === "partial") expect(saved.reading?.protectedBoxes).toHaveLength(2);
    if (outcome === "all") expect(w.engine.translate).not.toHaveBeenCalled();
    else expect(JSON.parse(vi.mocked(w.engine.translate).mock.calls[0][0].text)).toEqual(outcome === "repaired" ? ["Keep", "First", "Second"] : ["Keep"]);
    expect(await db.select().from(llmUsage)).toHaveLength(outcome === "all" ? 2 : 3);
    expect(await w.run()).toMatchObject({ done: 0 });
    expect(w.reader.read).toHaveBeenCalledTimes(2);
  });

  it("does not resend an overlapping figure hidden during the first reading", async () => {
    const w = await world();
    const overlapping = { ...sourceReading, regions: [sourceReading.regions[0], { ...sourceReading.regions[0], text: "Other" }] };
    vi.mocked(w.reader.read).mockImplementationOnce(async () => {
      await db.update(entries).set({ hiddenAt: new Date() }).where(eq(entries.id, w.entry.id));
      return { text: readingResponse(overlapping), model: w.reader.model, promptVersion: "figure-reading-v4", inputTokens: 10, outputTokens: 20 };
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await w.run()).toMatchObject({ done: 1, failed: 0 });
    expect(w.reader.read).toHaveBeenCalledTimes(1);
    expect(await db.select().from(figureReadings)).toMatchObject([{ state: "pending", reading: null }]);
    expect(await db.select().from(figureTranslations)).toEqual([]);
    expect(w.engine.translate).not.toHaveBeenCalled();
  });

  it("meters an overlap retry separately and replays the first response after budget deferral", async () => {
    const w = await world();
    const overlapping = { ...sourceReading, regions: [sourceReading.regions[0], { ...sourceReading.regions[0], text: "Other" }] };
    vi.mocked(w.reader.read).mockImplementationOnce(async () => {
      vi.stubEnv("LLM_MONTHLY_BUDGET_USD", "0");
      return { text: readingResponse(overlapping), model: w.reader.model, promptVersion: "figure-reading-v4", inputTokens: 10, outputTokens: 20 };
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await w.run()).toMatchObject({ deferred: 1, failed: 0 });
    expect(w.reader.read).toHaveBeenCalledTimes(1);
    expect(await db.select().from(llmUsage)).toHaveLength(1);
    const [pending] = await db.select().from(jobs).where(and(eq(jobs.kind, READ_FIGURE_JOB), eq(jobs.status, "queued")));
    expect(pending.attempts).toBe(0);
    vi.stubEnv("LLM_MONTHLY_BUDGET_USD", "20");
    await db.update(jobs).set({ runAt: new Date(0) }).where(eq(jobs.id, pending.id));
    expect(await w.run()).toMatchObject({ done: 2, failed: 0 });
    expect(w.reader.read).toHaveBeenCalledTimes(2);
    expect(vi.mocked(w.reader.read).mock.calls[1][2]).toBe(true);
    expect(await db.select().from(llmUsage)).toHaveLength(3);
  });

  it("reuses one content reading across edits, replies, and independently owned identical images", async () => {
    const w = await world(); await w.run();
    expect(await editEntry(db, "figure-author", w.entry.id, { title: w.entry.title, body: `Updated.\n\n![same](${w.url})` })).toMatchObject({ ok: true });
    expect(await createReply(db, "figure-author", w.entry.id, { body: `![reply](${w.url})`, lang: "en" })).toMatchObject({ ok: true });
    await addMember(db, "figure-copy", "figure_copy");
    const copy = await putMedia(db, "figure-copy", { bytes: w.bytes, width: 320, height: 180 });
    expect(copy.url).not.toBe(w.url);
    expect(await createTopic(db, "figure-copy", { title: "Independent copy", body: `![copy](${copy.url})`, lang: "en" })).toMatchObject({ ok: true });
    await w.run();
    expect(w.reader.read).toHaveBeenCalledTimes(1);
    expect(w.engine.translate).toHaveBeenCalledTimes(2);
    expect(await db.select().from(figureReadings)).toHaveLength(1);
    expect(await db.select().from(figureTranslations)).toHaveLength(2);
    await deleteMedia(db, w.id);
    expect(await db.select().from(figureReadings)).toHaveLength(1);
    expect((await get(w.path)).status).toBe(404);
    const copyId = copy.url.slice(7, 71);
    expect((await get(figurePath(copyId, 320, 180, "ja"))).status).toBe(200);
    await deleteMedia(db, copyId);
    expect(await db.select().from(figureReadings)).toEqual([]);
  });

  it("reads an available copy when another source is hidden and excludes withdrawn copies", async () => {
    const w = await world();
    await addMember(db, "figure-visible-copy", "figure_visible_copy");
    const copy = await putMedia(db, "figure-visible-copy", { bytes: w.bytes, width: 320, height: 180 });
    const topic = await createTopic(db, "figure-visible-copy", { title: "Available source", body: `![copy](${copy.url})`, lang: "en" });
    if (!topic.ok) throw new Error(topic.error);
    await runDueJobs(db, { prepare_figures: w.handlers.prepare_figures }, { now: jobNow, logger: quietLogger });
    const [reading] = await db.select().from(figureReadings);
    await db.update(entries).set({ hiddenAt: new Date() }).where(eq(entries.id, w.entry.id));
    const copyId = copy.url.slice(7, 71);
    expect(await readFigureSource(db, reading.key)).toMatchObject({ id: copyId, bytes: w.bytes });
    await db.update(entries).set({ hiddenAt: new Date() }).where(eq(entries.id, topic.id));
    expect(await readFigureSource(db, reading.key)).toBeUndefined();
    await db.update(entries).set({ hiddenAt: null }).where(eq(entries.id, topic.id));
    expect(await w.run()).toMatchObject({ failed: 0 });
    expect(w.reader.read).toHaveBeenCalledTimes(1);
    expect(vi.mocked(w.reader.read).mock.calls[0][0]).toEqual(w.bytes);
    await deleteMedia(db, copyId);
    expect(await readFigureSource(db, reading.key)).toBeUndefined();
  });

  it.each(["uncertain", "uncertain_language", "empty", "vertical", "curved", "no_primary_labels"])("keeps the original for %s readings and does not reread it", async mode => {
    const w = await world();
    const reading = structuredClone(sourceReading);
    if (mode === "uncertain") reading.regions[0].confidence = 0.2;
    if (mode === "uncertain_language") reading.confidence = 0.2;
    if (mode === "empty") { reading.lang = null; reading.regions = []; }
    if (mode === "vertical" || mode === "curved") reading.regions[0].orientation = mode;
    if (mode === "no_primary_labels") reading.regions[0].lang = "ja";
    if (["uncertain", "vertical", "curved"].includes(mode)) reading.regions.push({
      ...sourceReading.regions[0], text: "保存", lang: "ja", x: 0, y: 0, width: 0.05, height: 0.05,
    });
    vi.mocked(w.reader.read).mockResolvedValue({ text: readingResponse(reading), model: w.reader.model, promptVersion: "test", inputTokens: 100, outputTokens: 100 });
    expect(await w.run()).toMatchObject({ done: 1, failed: 0 });
    await db.transaction(tx => enqueueEntryFigures(tx, w.entry.id)); await w.run();
    expect(w.reader.read).toHaveBeenCalledTimes(1); expect(w.engine.translate).not.toHaveBeenCalled();
    expect((await db.select().from(figureReadings))[0].state).toBe("skipped");
    expect(await db.select().from(figureTranslations)).toEqual([]);
    expect((await get(w.path)).status).toBe(404); expect((await get(w.url)).status).toBe(200);
  });

  it("does not enqueue, call engines or expose stored variants while disabled", async () => {
    vi.stubEnv("FIGURE_TRANSLATION", ""); const w = await world();
    expect(await db.select().from(jobs).where(inArray(jobs.kind, kinds))).toEqual([]);
    await w.run(); expect(w.reader.read).not.toHaveBeenCalled(); expect(w.engine.translate).not.toHaveBeenCalled();
    vi.stubEnv("FIGURE_TRANSLATION", "1"); await db.transaction(tx => enqueueEntryFigures(tx, w.entry.id)); await w.run();
    vi.stubEnv("FIGURE_TRANSLATION", "0"); expect((await get(w.path)).status).toBe(404); expect((await get(w.url)).status).toBe(200);
  });

  it.each(["reading", "translation"])("defers %s when the shared budget is stopped and resumes without using attempts", async phase => {
    const w = await world(); if (phase === "translation") await w.run(1);
    vi.stubEnv("LLM_MONTHLY_BUDGET_USD", "0");
    expect(await w.run()).toMatchObject({ deferred: 1, failed: 0 });
    const [pending] = await db.select().from(jobs).where(and(inArray(jobs.kind, kinds), eq(jobs.status, "queued")));
    expect(pending.attempts).toBe(0); expect(w.engine.translate).not.toHaveBeenCalled();
    if (phase === "reading") expect(w.reader.read).not.toHaveBeenCalled();
    vi.stubEnv("LLM_MONTHLY_BUDGET_USD", "20"); await db.update(jobs).set({ runAt: new Date(0) }).where(eq(jobs.id, pending.id));
    await w.run(); expect((await get(w.path)).status).toBe(200);
  });

  it("applies original visibility to both replies and translated images before conditional responses", async () => {
    const w = await world(); await w.run();
    const tag = (await get(w.path)).headers.get("etag")!;
    await db.update(entries).set({ hiddenAt: new Date() }).where(eq(entries.id, w.entry.id));
    expect((await get(w.path, { "If-None-Match": tag })).status).toBe(404);
    expect((await get(w.url)).status).toBe(404);
    await db.update(entries).set({ hiddenAt: null }).where(eq(entries.id, w.entry.id));
    const parent = await createTopic(db, "figure-author", { title: "Parent", body: "Parent body", lang: "en" }); if (!parent.ok) throw new Error(parent.error);
    await createReply(db, "figure-author", parent.id, { body: `![reply](${w.url})`, lang: "en" });
    await softDeleteEntry(db, w.entry.id); await softDeleteEntry(db, parent.id);
    expect((await get(w.path)).status).toBe(404); expect((await get(w.url)).status).toBe(404);
  });

  it.each(["image", "account"])("erases derived data when the %s is deleted", async mode => {
    const w = await world(); await w.run();
    if (mode === "image") await deleteMedia(db, w.id);
    else await deleteAccount(db, "figure-author", { confirmation: "figure_author", posts: "delete" });
    expect(await db.select().from(figureReadings)).toEqual([]); expect(await db.select().from(figureMedia)).toEqual([]); expect(await db.select().from(figureTranslations)).toEqual([]);
    expect((await get(w.path)).status).toBe(404);
    for (const job of await db.select().from(jobs).where(inArray(jobs.kind, kinds))) expect(JSON.stringify(job.payload)).not.toContain("paidTranslationCalls");
  });

  it("does not decorate copied image URLs after the uploader's public reference is hidden", async () => {
    const w = await world(); await w.run();
    await addMember(db, "figure-copier", "figure_copier");
    const copy = await createTopic(db, "figure-copier", { title: "Copied reference", body: `![copy](${w.url})`, lang: "en" });
    if (!copy.ok) throw new Error(copy.error);
    const [entry] = await db.select().from(entries).where(eq(entries.id, copy.id));
    await db.insert(translations).values({ entryId: copy.id, field: "body", kind: "primary", lang: "ja", text: `![copy](${w.url})`, sourceHash: entry.sourceHash, engine: "fake" });
    await db.update(entries).set({ hiddenAt: new Date() }).where(eq(entries.id, w.entry.id));
    const display = (await loadEntryDisplays(db, [{ id: copy.id, kind: "topic", lang: "en", sourceHash: entry.sourceHash }], { readLangs: ["ja"], displayLang: "ja" })).get(copy.id)!;
    expect(display.translation!.html).not.toContain("data-translated-figure");
    expect(display.translation!.html).toContain(`src="${w.url}"`);
    expect((await get(w.path)).status).toBe(404);
  });

  it.each(["reading", "translation"])("fences a source deletion during an in-flight %s", async phase => {
    const w = await world();
    if (phase === "reading") {
      const read = createFigureReader({ TRANSLATION_PRIMARY: "fake" }).read; vi.mocked(w.reader.read).mockImplementationOnce(async (...args) => { await deleteMedia(db, w.id); return read(...args); });
    } else {
      await w.run(1); const translate = createFakeEngine().translate;
      vi.mocked(w.engine.translate).mockImplementationOnce(async req => { await deleteMedia(db, w.id); return translate(req); });
    }
    await w.run();
    expect(await db.select().from(figureReadings)).toEqual([]); expect(await db.select().from(figureTranslations)).toEqual([]);
    for (const job of await db.select().from(jobs).where(inArray(jobs.kind, kinds))) expect(JSON.stringify(job.payload)).not.toContain("paidTranslationCalls");
  });

  it("does not store a translated image when its post becomes hidden during translation", async () => {
    const w = await world(); await w.run(1); const translate = createFakeEngine().translate;
    vi.mocked(w.engine.translate).mockImplementationOnce(async req => { await db.update(entries).set({ hiddenAt: new Date() }).where(eq(entries.id, w.entry.id)); return translate(req); });
    await w.run(); expect(await db.select().from(figureTranslations)).toEqual([]);
  });

  it("does not send private uploads, copied URLs or avatars for figure reading", async () => {
    db = await createTestDb(); await addMember(db, "private-figure", "private_figure"); await addMember(db, "copied-figure", "copied_figure");
    const bytes = await sharp({ create: { width: 320, height: 180, channels: 3, background: "white" } }).webp().toBuffer();
    const image = { bytes, width: 320, height: 180 };
    const privateImage = await putMedia(db, "private-figure", image);
    expect(await db.select().from(figureReadings)).toEqual([]);
    expect(await createTopic(db, "copied-figure", { title: "Copied URL", body: `![copy](${privateImage.url})`, lang: "en" })).toMatchObject({ ok: true });
    const avatar = await putMedia(db, "private-figure", image, { avatar: true });
    expect(await createTopic(db, "private-figure", { title: "Avatar reference", body: `![avatar](${avatar.url})`, lang: "en" })).toMatchObject({ ok: true });
    await runDueJobs(db, createFigureHandlers(), { now: jobNow, logger: quietLogger });
    expect(await db.select().from(jobs).where(inArray(jobs.kind, kinds))).toEqual([]);
    expect(await db.select().from(figureReadings)).toEqual([]);
  });

  it("keeps derivatives under the original retention policy when a departing member retains posts", async () => {
    const w = await world(); await w.run();
    await deleteAccount(db, "figure-author", { confirmation: "figure_author" });
    expect((await get(w.path)).status).toBe((await get(w.url)).status);
    const [source] = await db.select().from(media).where(eq(media.id, w.id));
    expect(source.deletedAt).toBeNull(); expect(await db.select().from(figureTranslations)).toHaveLength(1);
  });

  it("stores an unusable label translation as skipped rather than calling again after each edit", async () => {
    const w = await world(); await w.run(1);
    vi.mocked(w.engine.translate).mockImplementation(async () => ({ text: "{}", model: w.engine.model, promptVersion: "test", inputTokens: 10, outputTokens: 10 }));
    await w.run(); const calls = vi.mocked(w.engine.translate).mock.calls.length;
    expect(calls).toBe(2);
    expect((await db.select().from(figureTranslations))[0]).toMatchObject({ state: "skipped", bytes: null, labels: null });
    const html = (await prepareEntryFigureDisplay(db, [w.entry.id], "ja"))(w.entry.id, w.entry.html!);
    expect(html).toContain("data-figure-fallback"); expect(html).toContain("使える訳を作れませんでした。"); expect(html).not.toContain("訳なし"); expect(html).not.toContain("{}");
    await db.transaction(tx => enqueueEntryFigures(tx, w.entry.id)); await w.run();
    expect(w.engine.translate).toHaveBeenCalledTimes(calls); expect((await get(w.path)).status).toBe(404);
  });

  it.each(["refusal", "invalid_output"] as const)("settles permanent %s failures without retrying after an edit or backfill", async code => {
    const w = await world(); await w.run(1);
    const error = new LlmError(code, "Synthetic permanent translation failure");
    Object.defineProperty(error, "retryable", { value: false });
    vi.mocked(w.engine.translate).mockRejectedValue(error);
    expect(await w.run()).toMatchObject({ done: 1, failed: 0, retried: 0 });
    expect((await db.select().from(figureTranslations))[0]).toMatchObject({ mediaId: w.id, lang: "ja", state: "skipped", bytes: null, labels: null, engine: w.engine.id, model: w.engine.model });
    expect((await get(w.path)).status).toBe(404); expect((await get(w.url)).status).toBe(200);
    expect(await editEntry(db, "figure-author", w.entry.id, { title: w.entry.title, body: `Updated.\n\n![same](${w.url})` })).toMatchObject({ ok: true });
    await backfillFigures(db, { enqueue: true }); await w.run();
    expect(w.engine.translate).toHaveBeenCalledTimes(1);
    expect((await db.select().from(jobs).where(eq(jobs.kind, TRANSLATE_FIGURE_JOB)))[0].status).toBe("done");
  });

  it("does not restore a skipped variant when its source is withdrawn during a permanent failure", async () => {
    const w = await world(); await w.run(1);
    vi.mocked(w.engine.translate).mockImplementationOnce(async () => {
      await deleteMedia(db, w.id);
      throw new LlmError("refusal", "Synthetic refusal after withdrawal");
    });
    expect(await w.run()).toMatchObject({ failed: 0 });
    expect(await db.select().from(figureReadings)).toEqual([]); expect(await db.select().from(figureTranslations)).toEqual([]);
    expect((await get(w.path)).status).toBe(404);
  });

  it("retries temporary translation failures without storing a skipped variant", async () => {
    const w = await world(); await w.run(1);
    vi.mocked(w.engine.translate).mockRejectedValueOnce(new LlmError("unavailable", "Synthetic temporary failure"));
    expect(await w.run()).toMatchObject({ retried: 1, failed: 0 });
    expect(await db.select().from(figureTranslations)).toEqual([]);
    const [pending] = await db.select().from(jobs).where(eq(jobs.kind, TRANSLATE_FIGURE_JOB));
    expect(pending.status).toBe("queued");
    await db.update(jobs).set({ runAt: new Date(0) }).where(eq(jobs.id, pending.id));
    expect(await w.run()).toMatchObject({ done: 1, failed: 0 });
    expect(w.engine.translate).toHaveBeenCalledTimes(2); expect((await get(w.path)).status).toBe(200);
  });

  it.each(["before translation", "during rendering"])("retries a font failure %s without permanently skipping or paying twice", async phase => {
    const w = await world(); await w.run(1);
    const missingBold = figureFonts.createFontCoverageLookup(async (_family, weight) => weight === "bold" ? null : [[32, 126]]);
    if (phase === "before translation") {
      const preflight = figureFonts.assertFigureFontsAvailable;
      vi.spyOn(figureFonts, "assertFigureFontsAvailable").mockImplementationOnce(lang => preflight(lang, missingBold));
    } else {
      const coverage = figureFonts.canRenderFigureText;
      vi.spyOn(figureFonts, "canRenderFigureText").mockImplementationOnce((labels, lang) => coverage(labels, lang, missingBold, "bold"));
    }
    expect(await w.run()).toMatchObject({ retried: 1, failed: 0 });
    expect(await db.select().from(figureTranslations)).toEqual([]);
    expect(w.engine.translate).toHaveBeenCalledTimes(phase === "before translation" ? 0 : 1);
    expect((await get(w.url)).status).toBe(200); expect((await get(w.path)).status).toBe(404);
    const [pending] = await db.select().from(jobs).where(eq(jobs.kind, TRANSLATE_FIGURE_JOB));
    await db.update(jobs).set({ runAt: new Date(0) }).where(eq(jobs.id, pending.id));
    expect(await w.run()).toMatchObject({ done: 1, failed: 0 });
    expect(w.engine.translate).toHaveBeenCalledTimes(1); expect((await get(w.path)).status).toBe(200);
    expect(await db.select().from(llmUsage)).toHaveLength(2);
  });

  it("settles a refused reading and does not read it again after an edit or backfill", async () => {
    const w = await world();
    vi.mocked(w.reader.read).mockRejectedValue(new LlmError("refusal", "Synthetic reading refusal"));
    expect(await w.run()).toMatchObject({ done: 1, failed: 0 });
    expect((await db.select().from(figureReadings))[0]).toMatchObject({ state: "skipped", reading: null, engine: w.reader.id, model: w.reader.model });
    expect(await editEntry(db, "figure-author", w.entry.id, { title: w.entry.title, body: `Updated.\n\n![same](${w.url})` })).toMatchObject({ ok: true });
    await backfillFigures(db, { enqueue: true }); await w.run();
    expect(w.reader.read).toHaveBeenCalledTimes(1); expect(w.engine.translate).not.toHaveBeenCalled();
    expect((await get(w.url)).status).toBe(200); expect((await get(w.path)).status).toBe(404);
  });

  it("does not restore a refused reading after its last original is withdrawn", async () => {
    const w = await world();
    vi.mocked(w.reader.read).mockImplementationOnce(async () => {
      await deleteMedia(db, w.id);
      throw new LlmError("refusal", "Synthetic refusal after withdrawal");
    });
    expect(await w.run()).toMatchObject({ failed: 0 });
    expect(await db.select().from(figureReadings)).toEqual([]); expect(await db.select().from(figureTranslations)).toEqual([]);
  });

  it("retries a temporary reading failure instead of caching a refusal", async () => {
    const w = await world();
    vi.mocked(w.reader.read).mockRejectedValueOnce(new LlmError("unavailable", "Synthetic temporary reading failure"));
    expect(await w.run()).toMatchObject({ retried: 1, failed: 0 });
    expect((await db.select().from(figureReadings))[0]).toMatchObject({ state: "pending", reading: null });
    const [pending] = await db.select().from(jobs).where(eq(jobs.kind, READ_FIGURE_JOB));
    await db.update(jobs).set({ runAt: new Date(0) }).where(eq(jobs.id, pending.id));
    await w.run();
    expect(w.reader.read).toHaveBeenCalledTimes(2); expect((await get(w.path)).status).toBe(200);
  });

  it("stores a skipped variant when label inspection raises a real output_leak error", async () => {
    const w = await world(); await w.run(1);
    let failure: unknown;
    const translate = llm.translate;
    vi.spyOn(llm, "translate").mockImplementation(async (...args) => {
      try { return await translate(...args); }
      catch (error) { failure = error; throw error; }
    });
    vi.mocked(w.engine.translate).mockImplementation(async () => ({ text: JSON.stringify([leakedReasoning]), model: w.engine.model, promptVersion: "test", inputTokens: 10, outputTokens: 50 }));
    expect(await w.run()).toMatchObject({ done: 1, failed: 0, retried: 0 });
    expect(failure).toBeInstanceOf(LlmError); expect(failure).toMatchObject({ code: "output_leak", retryable: false });
    expect(w.engine.translate).toHaveBeenCalledTimes(2);
    expect(vi.mocked(w.engine.translate).mock.calls[1][0].retryNote).toBeTruthy();
    expect((await db.select().from(figureTranslations))[0]).toMatchObject({ state: "skipped", bytes: null, labels: null });
    await backfillFigures(db, { enqueue: true }); await w.run();
    expect(w.engine.translate).toHaveBeenCalledTimes(2); expect((await get(w.path)).status).toBe(404);
    for (const job of await db.select().from(jobs).where(eq(jobs.kind, TRANSLATE_FIGURE_JOB))) expect(job.payload).not.toHaveProperty("paidTranslationCalls");
  });

  it("keeps the original when translation changes a partial derivative", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const w = await world();
    vi.mocked(w.reader.read).mockResolvedValueOnce({ text: readingResponse({ ...sourceReading, regions: [{ ...sourceReading.regions[0], text: "∂wK(w) = 0" }] }), model: w.reader.model, promptVersion: "figure-reading-v4", inputTokens: 10, outputTokens: 50 });
    vi.mocked(w.engine.translate).mockResolvedValue({ text: JSON.stringify(["dw K(w) = 0"]), model: w.engine.model, promptVersion: "figure-translation-v2", inputTokens: 10, outputTokens: 50 });
    expect(await w.run()).toMatchObject({ failed: 0 });
    expect((await db.select().from(figureTranslations))[0]).toMatchObject({ state: "skipped", bytes: null, labels: ["dw K(w) = 0"], labelResults: [expect.objectContaining({ reason: "math_mismatch", status: "external" })] });
    expect((await get(w.url)).status).toBe(200); expect((await get(w.path)).status).toBe(404);
    const logs = warning.mock.calls.flatMap(([line]) => String(line).startsWith("[figure-render]") ? [line] : []);
    expect(logs).toEqual(["[figure-render] external math_mismatch=1"]);
  });

  it("persists unchanged labels and leaves the source image without an external list", async () => {
    const w = await world();
    const request = { text: JSON.stringify(["Jesse Hoogland"]), from: "en" as const, to: "ja" as const, figure: true };
    expect(inspectTranslation(request, JSON.stringify([" jesse hoogland "]), w.engine.id)).toEqual({ flags: [], notes: [] });
    vi.mocked(w.reader.read).mockResolvedValueOnce({ text: readingResponse({ ...sourceReading, regions: [{ ...sourceReading.regions[0], text: "Jesse Hoogland" }] }), model: w.reader.model, promptVersion: "figure-reading-v4", inputTokens: 10, outputTokens: 20 });
    vi.mocked(w.engine.translate).mockResolvedValue({ text: JSON.stringify([" jesse hoogland "]), model: w.engine.model, promptVersion: "test", inputTokens: 10, outputTokens: 20 });
    expect(await w.run()).toMatchObject({ failed: 0 });
    expect(w.engine.translate).toHaveBeenCalledTimes(1);
    expect((await db.select().from(figureTranslations))[0]).toMatchObject({ state: "skipped", bytes: null, labelResults: [{ source: "Jesse Hoogland", translation: "jesse hoogland", status: "unchanged", reason: null }] });
    const decorate = await prepareEntryFigureDisplay(db, [w.entry.id], "ja");
    const html = decorate(w.entry.id, w.entry.html!);
    expect(html).toContain(w.url);
    expect(html).not.toContain("data-figure-fallback");
    expect(html).not.toContain("data-figure-toggle");
  });

  it.each([
    { source: "dependence of the volume on the water level", from: "en" as const, to: "fr" as const },
    { source: "大域最適解の近傍における体積の水位に対する依存性について", from: "ja" as const, to: "en" as const },
  ])("retries copied prose labels from $from to $to and keeps failures in the external list", async ({ source, from, to }) => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const w = await world();
    vi.stubEnv("ENABLED_LANGS", `${from},${to}`);
    const request = { text: JSON.stringify([source]), from, to, figure: true };
    const checked = inspectTranslation(request, request.text, w.engine.id);
    expect(checked.flags).toContain("untranslated");
    expect(checked.notes).toEqual([expect.stringContaining("identical to the source")]);
    vi.mocked(w.reader.read).mockResolvedValueOnce({ text: readingResponse({ ...sourceReading, lang: from, regions: [{ ...sourceReading.regions[0], lang: from, text: source }] }), model: w.reader.model, promptVersion: "test", inputTokens: 10, outputTokens: 20 });
    vi.mocked(w.engine.translate).mockResolvedValue({ text: request.text, model: w.engine.model, promptVersion: "test", inputTokens: 10, outputTokens: 20 });
    expect(await w.run()).toMatchObject({ failed: 0 });
    expect(w.engine.translate).toHaveBeenCalledTimes(2);
    expect(vi.mocked(w.engine.translate).mock.calls[1][0]).toMatchObject({ from, to, retryNote: expect.stringContaining("identical to the source") });
    expect((await db.select().from(figureTranslations))[0]).toMatchObject({ lang: to, state: "skipped", bytes: null, labelResults: [{ source, translation: null, status: "external", reason: "invalid_translation" }] });
    const decorate = await prepareEntryFigureDisplay(db, [w.entry.id], to);
    const html = decorate(w.entry.id, w.entry.html!);
    expect(html).toContain("data-figure-fallback");
    const messages = (await import("./helpers/messages-json")).jsonMessages();
    expect(html).toContain(messages.figure_fallback_translation({}, { locale: to }));
    expect(html).not.toContain("data-figure-toggle");
    expect(warning).toHaveBeenCalledWith("[figure-render] external invalid_translation=1");
  });

  it("keeps every pixel outside the text box and renders all enabled scripts", async () => {
    const w = await world();
    const before = await sharp(w.bytes).removeAlpha().raw().toBuffer();
    for (const [lang, label] of [["ja", "日本語"], ["zh-Hans", "简体中文"], ["zh-Hant", "繁體中文"], ["ko", "한국어"], ["th", "ภาษาไทย"], ["vi", "Tiếng Việt"], ["fr", "Français"], ["de", "Deutsch"], ["en", "English"]] as const) {
      const rendered = await renderFigure(w.bytes, sourceReading, [label], lang); expect(rendered).not.toBeNull();
      const after = await sharp(rendered!).removeAlpha().raw().toBuffer(); let changed = 0, outsideEqual = true;
      for (let y = 0; y < 180; y++) for (let x = 0; x < 320; x++) for (let c = 0; c < 3; c++) {
        const offset = (y * 320 + x) * 3 + c;
        if (x < 32 || x >= 288 || y < 36 || y >= 126) outsideEqual &&= after[offset] === before[offset];
        else if (after[offset] !== before[offset]) changed++;
      }
      expect(outsideEqual).toBe(true); expect(changed).toBeGreaterThan(0);
    }
  });

  it("shortens only failed labels in one checked call with per-label capacity hints", async () => {
    const w = await world();
    const sources = ["First", "Second", "Third"];
    vi.mocked(w.reader.read).mockResolvedValue({ text: readingResponse({ ...sourceReading, regions: sources.map((text, i) => ({ ...sourceReading.regions[0], text, x: .05, y: .05 + i * .3, width: .2, height: .2 })) }), model: w.reader.model, promptVersion: "test", inputTokens: 10, outputTokens: 50 });
    vi.mocked(w.engine.translate).mockImplementation(async req => ({ text: JSON.stringify(req.figureCharacterBudgets ? ["短い", "短い"] : ["訳", "W".repeat(500), "V".repeat(500)]), model: w.engine.model, promptVersion: "test", inputTokens: 10, outputTokens: 50 }));
    expect(await w.run()).toMatchObject({ failed: 0 });
    expect(w.engine.translate).toHaveBeenCalledTimes(2);
    const short = vi.mocked(w.engine.translate).mock.calls[1][0];
    expect(JSON.parse(short.text)).toEqual(["Second", "Third"]);
    expect(short.figureCharacterBudgets).toEqual([expect.any(Number), expect.any(Number)]);
    expect(short.figureCharacterBudgets!.every(n => n > 0)).toBe(true);
    const [saved] = await db.select().from(figureTranslations);
    expect(saved.labels).toEqual(["訳", "短い", "短い"]);
    expect(saved.labelResults!.every(r => r.status === "rendered")).toBe(true);
    await backfillFigures(db, { enqueue: true }); await w.run();
    expect(w.engine.translate).toHaveBeenCalledTimes(2);
  });

  it.each(["malformed", "formula", "too_long", "leak"])("keeps the full external translation after a %s shortening response", async failure => {
    const w = await world();
    vi.mocked(w.reader.read).mockResolvedValue({ text: readingResponse({ ...sourceReading, regions: [{ ...sourceReading.regions[0], text: "Condition ∂ K(w)" }] }), model: w.reader.model, promptVersion: "test", inputTokens: 10, outputTokens: 50 });
    const full = "W".repeat(480) + " ∂ K(w)";
    vi.mocked(w.engine.translate).mockImplementation(async req => ({ text: req.figureCharacterBudgets && failure === "malformed" ? "{}" : JSON.stringify([req.figureCharacterBudgets && failure === "formula" ? "d K(w)" : req.figureCharacterBudgets && failure === "leak" ? "W".repeat(800) : full]), model: w.engine.model, promptVersion: "test", inputTokens: 10, outputTokens: 50 }));
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await w.run()).toMatchObject({ failed: 0 });
    expect(w.engine.translate).toHaveBeenCalledTimes(2);
    const [saved] = await db.select().from(figureTranslations);
    expect(saved).toMatchObject({ state: "skipped", bytes: null, labels: [full], labelResults: [{ source: "Condition ∂ K(w)", translation: full, status: "external", reason: "does_not_fit", required: expect.any(Object), available: expect.any(Object), maxCharacters: expect.any(Number) }] });
    const html = (await prepareEntryFigureDisplay(db, [w.entry.id], "ja"))(w.entry.id, w.entry.html!);
    expect(html).toContain("data-figure-fallback"); expect(html).toContain(full); expect(html).toContain(`src="${w.url}"`); expect(html).not.toContain("data-figure-toggle");
    expect(log.mock.calls.filter(([line]) => String(line).startsWith("[figure-render]"))).toEqual([["[figure-render] external does_not_fit=1"]]);
    await deleteMedia(db, w.id);
    expect(await db.select().from(figureTranslations)).toEqual([]);
  });

  it("does not store external text if the source is withdrawn during shortening", async () => {
    const w = await world();
    vi.mocked(w.engine.translate).mockImplementation(async req => {
      if (req.figureCharacterBudgets) await deleteMedia(db, w.id);
      return { text: JSON.stringify([req.figureCharacterBudgets ? "短い" : "W".repeat(500)]), model: w.engine.model, promptVersion: "test", inputTokens: 10, outputTokens: 50 };
    });
    expect(await w.run()).toMatchObject({ failed: 0 });
    expect(w.engine.translate).toHaveBeenCalledTimes(2);
    expect(await db.select().from(figureTranslations)).toEqual([]);
  });
});
