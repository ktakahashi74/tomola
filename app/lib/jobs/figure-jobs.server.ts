import { createHash } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { figureMedia, figureReadings, figureTranslations, media } from "~/lib/db/schema";
import { enabledTargetLangs, isEnabledLang } from "~/lib/enabled-langs.server";
import { FIGURE_VERSION, figureTranslationRegions, normalizeFigureReading } from "~/lib/figure";
import { createFigureReader, FIGURE_IMAGE_TOKEN_BOUND, FIGURE_READING_OUTPUT_TOKENS, FIGURE_READING_PROMPT, FIGURE_READING_PROMPT_VERSION, figureTranslationEnabled, figureReadingUser, parseFigureReading, type FigureReader } from "~/lib/figure-reading.server";
import { assertFigureFontsAvailable } from "~/lib/figure-fonts.server";
import type { TranslationResult } from "~/lib/llm/types";
import { createFigureRenderer, usableFigure } from "~/lib/figure-render.server";
import { enqueueEntryFigures, enqueueFigureTranslations, PREPARE_FIGURES_JOB, READ_FIGURE_JOB, TRANSLATE_FIGURE_JOB } from "~/lib/figure-translation.server";
import { readFigureSource, readMediaBatch } from "~/lib/media-store.server";
import { jobLlmOptions, LlmError, translate, type LlmOptions } from "~/lib/llm/index.server";
import { primaryEngineId, primaryModelOf } from "~/lib/llm/config.server";
import { promptVersionOf } from "~/lib/llm/prompt.server";
import { completionEstimate, meteredCall } from "~/lib/llm/metering.server";
import { costMicro } from "~/lib/llm/pricing.server";
import { HIDDEN_PRIMARY_FLAGS } from "~/lib/llm/flags";
import { inspectTranslation } from "~/lib/llm/translation-inspect.core.server";
import { preservesFigureMath } from "~/lib/figure";
import { loadGlossary, matchGlossary } from "~/lib/translations.server";
import { paidTranslationCall } from "./paid-translation.server";
import { currentJobSignal } from "./signal.server";
import type { JobHandlers } from "./queue.server";

const keySchema = z.string().regex(/^[a-f0-9]{64}:v[1-9]\d{0,5}$/);
const readPayload = z.object({ key: keySchema }).strict();
const translatePayload = z.object({ key: keySchema, mediaId: z.string().regex(/^[a-f0-9]{64}$/), lang: z.string() }).strict();

export function createFigureHandlers(deps: { reader?: FigureReader; llm?: LlmOptions } = {}): JobHandlers {
  return {
    async [PREPARE_FIGURES_JOB](job, ctx) {
      if (!figureTranslationEnabled(deps.llm?.env)) return;
      const payload = z.object({ entryId: z.number().int().positive() }).strict().safeParse(job.payload);
      if (payload.success) await ctx.db.transaction(tx => enqueueEntryFigures(tx, payload.data.entryId));
    },
    async [READ_FIGURE_JOB](job, ctx) {
      const options = jobLlmOptions(ctx, deps.llm);
      if (!figureTranslationEnabled(options.env)) return;
      const payload = readPayload.safeParse(job.payload);
      if (!payload.success) return;
      const key = payload.data.key;
      const [saved] = await ctx.db.select().from(figureReadings).where(and(eq(figureReadings.key, key), eq(figureReadings.version, FIGURE_VERSION)));
      if (!saved) return;
      const image = await readFigureSource(ctx.db, key);
      if (!image?.bytes) return;
      let reading = saved.reading;
      if (saved.state === "pending") {
        const reader = deps.reader ?? createFigureReader(options.env);
        const signal = options.signal ?? currentJobSignal();
        let result: TranslationResult | null = null;
        for (let attempt = 0; attempt < 2; attempt++) {
          const retryOverlap = attempt === 1;
          // Publication can be withdrawn while the first request is in flight.
          if (retryOverlap && !(await readFigureSource(ctx.db, key))?.bytes) return;
          try {
            const callKey = `figure-reading:${key}:${reader.id}:${reader.model}${retryOverlap ? ":overlap-retry" : ""}`;
            ({ result } = await paidTranslationCall(createHash("sha256").update(callKey).digest("hex"), () => meteredCall(ctx.db, {
              engine: reader.id, model: reader.model, purpose: "translate", role: "primary",
              estimateMicro: completionEstimate(reader.id, reader.model, FIGURE_READING_PROMPT, figureReadingUser(retryOverlap), FIGURE_READING_OUTPUT_TOKENS, options.env) + costMicro(reader.id, reader.model, FIGURE_IMAGE_TOKEN_BOUND, 0, options.env),
              now: options.clock?.() ?? ctx.now, clock: options.clock ?? (() => ctx.now), env: options.env, signal,
            }, () => reader.read(image.bytes!, signal, retryOverlap), result => result)));
          } catch (error) {
            if (!(error instanceof LlmError) || error.retryable) throw error;
            result = null;
          }
          let overlapping = false;
          reading = result ? parseFigureReading(result.text, undefined, { discardOverlaps: retryOverlap, onOverlap: () => { overlapping = true; } }) : null;
          if (!overlapping || retryOverlap) break;
        }
        // UPDATE only: deletion may have removed the last source and the cache.
        const [stored] = await ctx.db.update(figureReadings).set({ reading, state: reading && usableFigure(reading) ? "ready" : "skipped", engine: reader.id, model: result?.model ?? reader.model, promptVersion: result?.promptVersion ?? FIGURE_READING_PROMPT_VERSION })
          .where(eq(figureReadings.key, key)).returning({ key: figureReadings.key });
        if (!stored) return;
      }
      if (!reading || !usableFigure(reading)) return;
      // Include sources admitted during the reading call, even in another process.
      const current = await ctx.db.select({ id: figureMedia.mediaId }).from(figureMedia).where(eq(figureMedia.readingKey, key));
      for (const source of current) await enqueueFigureTranslations(ctx.db, source.id, key, reading, options.env);
    },
    async [TRANSLATE_FIGURE_JOB](job, ctx) {
      const options = jobLlmOptions(ctx, deps.llm);
      if (!figureTranslationEnabled(options.env)) return;
      const payload = translatePayload.safeParse(job.payload);
      if (!payload.success || !isEnabledLang(payload.data.lang, options.env)) return;
      const { key, mediaId, lang } = payload.data;
      const [source] = await ctx.db.select({ reading: figureReadings.reading }).from(figureMedia)
        .innerJoin(figureReadings, and(eq(figureReadings.key, figureMedia.readingKey), eq(figureReadings.state, "ready"), eq(figureReadings.version, FIGURE_VERSION)))
        .where(and(eq(figureMedia.mediaId, mediaId), eq(figureMedia.readingKey, key)));
      const reading = source?.reading ? normalizeFigureReading(source.reading) : null;
      if (!reading?.lang || !usableFigure(reading) || !enabledTargetLangs(reading.lang, options.env).includes(lang)) return;
      const [saved] = await ctx.db.select({ id: figureTranslations.mediaId }).from(figureTranslations)
        .where(and(eq(figureTranslations.mediaId, mediaId), eq(figureTranslations.readingKey, key), eq(figureTranslations.lang, lang)));
      if (saved) return;
      const [image] = await readMediaBatch(ctx.db, [mediaId]);
      if (!image?.bytes) return;
      await assertFigureFontsAvailable(lang);
      const labels = figureTranslationRegions(reading).map(region => region.text);
      const glossary = matchGlossary(await loadGlossary(ctx.db, reading.lang, lang), labels.join("\n"));
      let result: Awaited<ReturnType<typeof translate>> | null = null;
      try {
        result = await translate(ctx.db, "primary", { text: JSON.stringify(labels), from: reading.lang, to: lang, figure: true, glossary }, options);
      } catch (error) {
        if (!(error instanceof LlmError) || error.retryable) throw error;
      }
      const parseLabels = (out: typeof result, sources: string[]): (string | null)[] => {
        if (!out || out.flags.includes("markdown_budget")) return sources.map(() => null);
        try {
          const parsed = z.array(z.string().trim().min(1).max(2000)).length(sources.length).safeParse(JSON.parse(out.text));
          if (!parsed.success) return sources.map(() => null);
          return parsed.data.map((label, i) => {
            // Apply the ordinary per-label checks before the renderer records a
            // formula mismatch. A failed formula never bypasses leak/link checks.
            const checked = inspectTranslation({ text: sources[i], from: reading.lang!, to: lang, invitationNote: true }, label, out.engine);
            return checked.flags.some(flag => HIDDEN_PRIMARY_FLAGS.includes(flag)) ? null : label;
          });
        } catch { return sources.map(() => null); }
      };
      const labelsOut = parseLabels(result, labels);
      const render = await createFigureRenderer(image.bytes, reading, lang);
      let rendered = await render(labelsOut);
      const retryIndexes = rendered.results.flatMap((r, i) => r.reason === "does_not_fit" ? [i] : []);
      if (retryIndexes.length) {
        const retrySources = retryIndexes.map(i => labels[i]);
        let shortened: typeof result = null;
        try {
          shortened = await translate(ctx.db, "primary", {
            text: JSON.stringify(retrySources), from: reading.lang, to: lang, figure: true, glossary,
            figureCharacterBudgets: retryIndexes.map(i => rendered.results[i].maxCharacters!),
          }, options);
        } catch (error) {
          if (!(error instanceof LlmError) || error.retryable) throw error;
        }
        const candidates = parseLabels(shortened, retrySources);
        const proposed = [...labelsOut];
        for (const [j, i] of retryIndexes.entries()) if (candidates[j] && preservesFigureMath(labels[i], candidates[j]!)) proposed[i] = candidates[j];
        const retried = await render(proposed);
        // An unsuccessful retry must not replace the fuller external translation
        // or sacrifice a label already drawn in the first layout.
        if (rendered.results.every((r, i) => r.status !== "rendered" || retried.results[i].status === "rendered")) {
          for (const i of retryIndexes) if (retried.results[i].status !== "rendered") retried.results[i] = rendered.results[i];
          rendered = retried;
        }
      }
      const { bytes, results: labelResults } = rendered;
      const counts = new Map<string, number>();
      for (const label of labelResults) if (label.reason) counts.set(label.reason, (counts.get(label.reason) ?? 0) + 1);
      if (counts.size) console.warn(`[figure-render] external ${[...counts].sort(([a], [b]) => a.localeCompare(b)).map(([reason, count]) => `${reason}=${count}`).join(" ")}`);
      const metadata = result ?? { engine: options.engines?.primary.id ?? primaryEngineId(options.env), model: options.engines?.primary.model ?? primaryModelOf(options.env), promptVersion: promptVersionOf({ figure: true }) };
      await ctx.db.transaction(async tx => {
        // Same media lock as deletion: an in-flight result cannot restore a
        // withdrawn image or retain text after its source has been removed.
        const [active] = await tx.select({ id: media.id }).from(media).where(and(eq(media.id, mediaId), isNull(media.deletedAt))).for("update");
        if (!active || !(await readMediaBatch(tx, [mediaId])).length) return;
        const [binding] = await tx.select({ id: figureMedia.mediaId }).from(figureMedia).where(and(eq(figureMedia.mediaId, mediaId), eq(figureMedia.readingKey, key)));
        if (!binding) return;
        await tx.insert(figureTranslations).values({ mediaId, readingKey: key, lang, state: bytes ? "ready" : "skipped", bytes: bytes || null, labels: labelResults.some(r => r.translation !== null) ? labelResults.map(r => r.translation ?? "") : null, labelResults, model: metadata.model, engine: metadata.engine, promptVersion: metadata.promptVersion }).onConflictDoNothing();
      });
    },
  };
}
