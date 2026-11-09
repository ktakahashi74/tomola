import { createHash } from "node:crypto";
import { and, eq, exists, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import type { Db } from "./db/client.server";
import { entries, entryMedia, figureMedia, figureReadings, figureTranslations, media } from "./db/schema";
import { enabledTargetLangs, isEnabledLang } from "./enabled-langs.server";
import { FIGURE_VERSION, type FigureReading, type FigureLabelResult } from "./figure";
import type { LlmEnv } from "./llm/types";
import { FIGURE_READING_PROMPT_VERSION, figureTranslationEnabled } from "./figure-reading.server";
import { usableFigure } from "./figure-render.server";
import { enqueue } from "./jobs/queue.server";
import { rootTopic, rootTopicOn, visibleWithTopic } from "./visibility.server";

export const PREPARE_FIGURES_JOB = "prepare_figures";
export const READ_FIGURE_JOB = "read_figure";
export const TRANSLATE_FIGURE_JOB = "translate_figure";
// All supported image withdrawals acquire this before locking media rows.
// Registration uses the same short transaction lock; model calls hold no lock.
export async function lockFigureMedia(db: Db): Promise<void> {
  await db.execute(sql`select pg_advisory_xact_lock(732108, 1)`);
}
export const readingKeyOf = (bytes: Buffer) => `${createHash("sha256").update(bytes).digest("hex")}:v${FIGURE_VERSION}`;

// Rendering generations reuse settled readings with the unchanged reading
// prompt. Keep previous cache generations intact.
export async function cachedFigureReadings(db: Db, keys: readonly string[]) {
  const previousKeys = (key: string) => [11, 10, 9, 8, 7, 6, 5, 4].map(version => key.replace(/:v\d+$/, `:v${version}`));
  const rows = keys.length ? await db.select().from(figureReadings).where(inArray(figureReadings.key, [...new Set(keys.flatMap(key => [key, ...previousKeys(key)]))])) : [];
  const byKey = new Map(rows.map(row => [row.key, row]));
  const reusable = new Map<string, typeof rows[number]>();
  for (const key of keys) {
    const current = byKey.get(key), previous = previousKeys(key).map(k => byKey.get(k)).find(row => row && row.state !== "pending" && row.promptVersion === FIGURE_READING_PROMPT_VERSION);
    if (current) reusable.set(key, current);
    else if (previous && previous.state !== "pending" && previous.promptVersion === FIGURE_READING_PROMPT_VERSION) reusable.set(key, previous);
  }
  return reusable;
}

export type FigureDisplay = { hasImage: boolean; results: FigureLabelResult[] };
export async function availableFigures(db: Db, ids: readonly string[], lang: string): Promise<Map<string, FigureDisplay>> {
  if (!figureTranslationEnabled() || !ids.length || !isEnabledLang(lang)) return new Map();
  const rows = await db.select({ id: figureTranslations.mediaId, state: figureTranslations.state, results: figureTranslations.labelResults }).from(figureTranslations)
    .innerJoin(figureReadings, eq(figureReadings.key, figureTranslations.readingKey))
    .innerJoin(media, and(eq(media.id, figureTranslations.mediaId), isNull(media.deletedAt)))
    .where(and(inArray(figureTranslations.mediaId, [...ids]), eq(figureTranslations.lang, lang), or(eq(figureTranslations.state, "ready"), isNotNull(figureTranslations.labelResults)), eq(figureReadings.version, FIGURE_VERSION), publicFigureCondition(db)));
  return new Map(rows.filter(row => row.state === "ready" || row.results?.some(r => r.status === "external" && r.reason)).map(row => [row.id, { hasImage: row.state === "ready", results: row.results ?? [] }]));
}

// The same authored, readable reference required before sending an image.
// Icons and avatars never become figure sources, even if their URL is copied.
export function publicFigureCondition(db: Db, entryId?: number) {
  const reference = db.select({ id: entries.id }).from(entryMedia)
    .innerJoin(entries, and(eq(entries.id, entryMedia.entryId), eq(entries.authorId, media.uploadedBy)))
    .innerJoin(rootTopic, rootTopicOn()).where(and(eq(entryMedia.mediaId, media.id), entryId === undefined ? undefined : eq(entries.id, entryId), visibleWithTopic()));
  return and(eq(media.avatar, false), isNull(media.villageId), isNull(media.deletedAt), isNotNull(media.bytes), exists(reference))!;
}

export async function enqueueFigureTranslations(db: Db, mediaId: string, key: string, reading: FigureReading, env?: LlmEnv): Promise<void> {
  if (!reading.lang) return;
  for (const lang of enabledTargetLangs(reading.lang, env)) {
    const [saved] = await db.select({ id: figureTranslations.mediaId }).from(figureTranslations)
      .where(and(eq(figureTranslations.mediaId, mediaId), eq(figureTranslations.readingKey, key), eq(figureTranslations.lang, lang)));
    if (!saved) await enqueue(db, TRANSLATE_FIGURE_JOB, { mediaId, key, lang }, { dedupeKey: `figure:${mediaId}:${key}:${lang}`, priority: 4 });
  }
}

// Publication only schedules preparation. Image/cache locks are acquired in a
// separate, short job transaction, after all post/notification locks are gone.
export async function queueEntryFigures(db: Db, entryId: number): Promise<void> {
  if (figureTranslationEnabled()) await enqueue(db, PREPARE_FIGURES_JOB, { entryId }, { dedupeKey: `figure:prepare:${entryId}`, priority: 4, rescheduleRunning: true });
}

// Called inside the preparation transaction. A copied URL never authorizes
// sending somebody else's image.
export async function enqueueEntryFigures(db: Db, entryId: number): Promise<void> {
  if (!figureTranslationEnabled()) return;
  await enqueuePublicFigures(db, undefined, process.env, entryId);
}

// Call inside a short transaction. Backfill rechecks eligibility here, so a
// source hidden or withdrawn since its preview never enters a reading job.
export async function enqueuePublicFigures(db: Db, ids: readonly string[] | undefined, env: LlmEnv = process.env, entryId?: number, rereadRejected = false): Promise<number> {
  if (!figureTranslationEnabled(env) || ids?.length === 0) return 0;
  await lockFigureMedia(db);
  const images = await db.select({ id: media.id, bytes: media.bytes }).from(media)
    .where(and(publicFigureCondition(db, entryId), ids ? inArray(media.id, [...ids]) : undefined)).for("update");
  const cache = await cachedFigureReadings(db, images.filter(image => image.bytes).map(image => readingKeyOf(image.bytes!)));
  let registered = 0;
  for (const image of images) {
    if (!image.bytes) continue;
    const key = readingKeyOf(image.bytes);
    const cached = cache.get(key);
    if (rereadRejected && !(cached?.state === "skipped" && cached.reading === null)) continue;
    await db.insert(figureReadings).values({ key, version: FIGURE_VERSION, ...(cached ? {
      state: cached.state, reading: cached.reading, engine: cached.engine, model: cached.model, promptVersion: cached.promptVersion,
    } : {}) }).onConflictDoNothing();
    if (rereadRejected) await db.update(figureReadings).set({ state: "pending" })
      .where(and(eq(figureReadings.key, key), eq(figureReadings.state, "skipped"), isNull(figureReadings.reading)));
    registered++;
    await db.insert(figureMedia).values({ mediaId: image.id, readingKey: key }).onConflictDoNothing();
    const [saved] = await db.select().from(figureReadings).where(eq(figureReadings.key, key));
    if (saved.state !== "pending" && saved.reading && usableFigure(saved.reading)) {
      // Reuse validated readings skipped by an earlier eligibility policy.
      if (saved.state === "skipped") await db.update(figureReadings).set({ state: "ready" }).where(eq(figureReadings.key, key));
      await enqueueFigureTranslations(db, image.id, key, saved.reading, env);
    }
    else if (saved.state === "pending") await enqueue(db, READ_FIGURE_JOB, { key }, { dedupeKey: `figure:read:${key}`, priority: 4, rescheduleRunning: true });
  }
  return registered;
}

export async function readFigureTranslation(db: Db, id: string, lang: string, version: number) {
  if (!figureTranslationEnabled() || !isEnabledLang(lang)) return null;
  const [row] = await db.select({ bytes: figureTranslations.bytes, key: figureTranslations.readingKey }).from(figureTranslations)
    .innerJoin(figureReadings, eq(figureReadings.key, figureTranslations.readingKey))
    .where(and(eq(figureTranslations.mediaId, id), eq(figureTranslations.lang, lang), eq(figureTranslations.state, "ready"), eq(figureReadings.version, version)));
  return row ?? null;
}
