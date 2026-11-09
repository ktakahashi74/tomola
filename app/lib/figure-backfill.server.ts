import { and, eq, gt, inArray } from "drizzle-orm";
import type { Db } from "./db/client.server";
import { figureTranslations, media } from "./db/schema";
import { enabledTargetLangs } from "./enabled-langs.server";
import { LANGS } from "./languages";
import type { LlmEnv } from "./llm/types";
import { figureTranslationRegions } from "./figure";
import { figureTranslationEnabled } from "./figure-reading.server";
import { usableFigure } from "./figure-render.server";
import { publicFigureCondition, enqueuePublicFigures, readingKeyOf, cachedFigureReadings } from "./figure-translation.server";
import { estimateFigureTranslation, figureCostProfile, FIGURE_COST_ASSUMPTIONS } from "./figure-cost.server";
import { loadGlossary, matchGlossary } from "./translations.server";

export async function backfillFigures(db: Db, opts: { enqueue?: boolean; rereadRejected?: boolean; env?: LlmEnv } = {}) {
  const env = opts.env ?? process.env;
  if (opts.enqueue && !figureTranslationEnabled(env)) throw new Error("FIGURE_TRANSLATION=1 is required to enqueue figures");
  const profile = figureCostProfile(env);
  const summary = { mode: opts.enqueue ? "enqueue" : "preview", selection: opts.rereadRejected ? "rejected" : "all", eligibleImages: 0, uniqueContents: 0, readingsNeeded: 0, cachedSkippedImages: 0,
    translationCallsEstimated: 0, readingUsdMicro: 0, translationUsdMicro: 0, totalUsdMicro: 0, registeredImages: 0 };
  const seen = new Set<string>(), glossary = new Map<string, Awaited<ReturnType<typeof loadGlossary>>>();
  const unknown = LANGS.map(from => {
    const targets = enabledTargetLangs(from, env);
    return { calls: targets.length, cost: targets.reduce((cost, to) => cost + estimateFigureTranslation(profile, from, to, env).estimatedUsdMicro, 0) };
  }).reduce((a, b) => b.cost > a.cost || b.cost === a.cost && b.calls > a.calls ? b : a);
  let cursor: string | undefined;
  for (;;) {
    // At most fifty MiB of original bytes per page, independent of site size.
    const page = await db.select({ id: media.id, bytes: media.bytes }).from(media).where(and(publicFigureCondition(db), cursor ? gt(media.id, cursor) : undefined)).orderBy(media.id).limit(25);
    if (!page.length) break;
    cursor = page[page.length - 1].id;
    const keys = page.map(image => readingKeyOf(image.bytes!));
    const saved = await cachedFigureReadings(db, keys);
    const variants = new Set((await db.select({ id: figureTranslations.mediaId, key: figureTranslations.readingKey, lang: figureTranslations.lang }).from(figureTranslations).where(inArray(figureTranslations.mediaId, page.map(image => image.id)))).map(row => `${row.id}:${row.key}:${row.lang}`));
    const rejectedIds: string[] = [], continuedIds: string[] = [];
    for (let i = 0; i < page.length; i++) {
      const image = page[i], key = keys[i], reading = saved.get(key);
      const continued = seen.has(key);
      if (opts.rereadRejected && !continued && !(reading?.state === "skipped" && reading.reading === null)) continue;
      (continued ? continuedIds : rejectedIds).push(image.id);
      summary.eligibleImages++;
      if (!seen.has(key)) {
        seen.add(key);
        if (opts.rereadRejected || !reading || reading.state === "pending") { summary.readingsNeeded++; summary.readingUsdMicro += profile.reader.estimatedUsdMicro; }
      }
      const reusable = reading?.state !== "pending" && reading?.reading && usableFigure(reading.reading) ? reading.reading : null;
      if (!opts.rereadRejected && reading?.state === "skipped" && !reusable) { summary.cachedSkippedImages++; continue; }
      if (reusable?.lang) {
        const labels = figureTranslationRegions(reusable).map(region => region.text), from = reusable.lang;
        for (const to of enabledTargetLangs(from, env)) {
          if (variants.has(`${image.id}:${key}:${to}`)) continue;
          const pair = `${from}:${to}`;
          if (!glossary.has(pair)) glossary.set(pair, await loadGlossary(db, from, to));
          summary.translationCallsEstimated++;
          summary.translationUsdMicro += estimateFigureTranslation(profile, from, to, env, labels, matchGlossary(glossary.get(pair)!, labels.join("\n"))).estimatedUsdMicro;
        }
      } else {
        // Until OCR is available, report the most expensive possible source
        // language among supported tags, rather than assuming the post's language.
        summary.translationCallsEstimated += unknown.calls;
        summary.translationUsdMicro += unknown.cost;
      }
    }
    if (opts.enqueue) summary.registeredImages += await db.transaction(async tx => {
      if (!opts.rereadRejected) return enqueuePublicFigures(tx, page.map(image => image.id), env);
      // Recheck rejection and public visibility under the registration lock.
      // Later pages can bind further images to a reading already reset here.
      return await enqueuePublicFigures(tx, rejectedIds, env, undefined, true) + await enqueuePublicFigures(tx, continuedIds, env);
    });
  }
  summary.uniqueContents = seen.size;
  summary.totalUsdMicro = summary.readingUsdMicro + summary.translationUsdMicro;
  return { ...summary, profile, assumptions: {
    unknownReadingLabels: FIGURE_COST_ASSUMPTIONS.labels.length,
    unknownReadingCharacters: FIGURE_COST_ASSUMPTIONS.labels.join("").length,
    readingOutputTokens: FIGURE_COST_ASSUMPTIONS.readingOutputTokens,
    overlapRetriesPerReading: 1,
    translationTextOutputTokens: FIGURE_COST_ASSUMPTIONS.translationTextOutputTokens,
    note: "Character-based estimates, not a spending limit. Reading cost assumes one call per content; overlap can add one reading call. Unread figures assume two glossary hints and the most expensive supported source language. Thinking uses the configured output allowance; actual usage, retries and image processing can differ. Pending jobs are included; no provider calls are made here.",
  } };
}
