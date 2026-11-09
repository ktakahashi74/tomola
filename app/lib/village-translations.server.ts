import { loadDisplayNames, selectDisplayName } from "./display-names.server";
import { createHash } from "node:crypto";
import { and, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import type { Db } from "./db/client.server";
import { jobs, profiles, villages, villageTranslations } from "./db/schema";
import { wantsTranslation } from "./display";
import { enabledLangs, enabledTargetLangs, isEnabledLang } from "./enabled-langs.server";
import { discardPaidTranslationCalls } from "./jobs/paid-translation.server";
import { enqueue } from "./jobs/queue.server";
import { detectLang } from "./lang-detect.core.server";
import { defaultLangOf, isLang, type Lang } from "./languages";
import type { VillageReader, WithVillageTranslation } from "./village-translation-view";
import { isSharedVillageKind } from "./villages";

// The name and description of a village, translated into the reader's language like a post: one job per village and language (translate_village), one row per village and language
// (village_translations). A row is shown only while its source_hash matches the village's current texts, so an edit hides every older translation at once.
export const TRANSLATE_VILLAGE_JOB = "translate_village";
// The error_code of a row whose texts came back as the same characters as the source: nothing to translate, so the original is read with no mark of a translation, and the
// operator's preparation does not queue it again. It is not a failure of the engine.
export const SAME_AS_SOURCE = "same_as_source";
export type VillageTranslationPayload = { villageId: string; lang: Lang; sourceHash: string };

type Source = { sourceLang: string | null; name: string; description: string; language: string | null };

// The parts that are translated. The name of a language village is made from the screen's language (villageName), so only its description can be.
export function translatableParts(village: Pick<Source, "name" | "description" | "language">): { name: string | null; description: string | null } {
  return { name: !village.language && village.name.trim() ? village.name : null, description: village.description.trim() ? village.description : null };
}

export function villageSourceHash(village: Source): string {
  const { name, description } = translatableParts(village);
  return createHash("sha256").update(JSON.stringify([village.sourceLang, name, description])).digest("hex");
}

export const villageJobKey = (villageId: string, lang: Lang, sourceHash: string) => `translate-village:${villageId}:${lang}:${sourceHash}`;
const enqueueVillage = (db: Db, payload: VillageTranslationPayload) =>
  enqueue(db, TRANSLATE_VILLAGE_JOB, payload, { dedupeKey: villageJobKey(payload.villageId, payload.lang, payload.sourceHash), maxAttempts: 5, priority: 2 });

// Bring the translations of one village up to date with its texts: drop rows and unstarted jobs of older texts or of languages that are no longer targets, then make sure each
// target language has a row with a job. Run it in the transaction that creates or changes the village (the caller holds the village row, or has just inserted it).
// Returns the number of jobs queued. `retryFailed` also requeues a language whose last attempt failed (the operator's preparation and langs:open).
export async function requestVillageTranslations(db: Db, villageId: string, opts: { retryFailed?: boolean; env?: Record<string, string | undefined> } = {}): Promise<number> {
  const [village] = await db.select().from(villages).where(eq(villages.id, villageId));
  if (!village) return 0;
  const hash = villageSourceHash(village);
  const parts = translatableParts(village);
  const targets: Lang[] = village.sourceLang && isLang(village.sourceLang) && isSharedVillageKind(village.kind) && (parts.name !== null || parts.description !== null)
    ? enabledTargetLangs(village.sourceLang, opts.env) : [];
  const rows = await db.select().from(villageTranslations).where(eq(villageTranslations.villageId, villageId));
  const stale = rows.filter(row => row.sourceHash !== hash || !targets.includes(row.lang as Lang));
  if (stale.length) await db.delete(villageTranslations).where(and(eq(villageTranslations.villageId, villageId), inArray(villageTranslations.lang, stale.map(row => row.lang))));
  const obsolete = and(eq(jobs.kind, TRANSLATE_VILLAGE_JOB), sql`${jobs.payload}->>'villageId' = ${villageId}`, sql`${jobs.payload}->>'sourceHash' is distinct from ${hash}`)!;
  await discardPaidTranslationCalls(db, obsolete);
  await db.delete(jobs).where(and(obsolete, eq(jobs.status, "queued")));
  let queued = 0;
  for (const lang of targets) {
    const row = rows.find(r => r.lang === lang && r.sourceHash === hash);
    if (row && (row.state === "ready" || (row.state === "failed" && (!opts.retryFailed || row.errorCode === SAME_AS_SOURCE)))) continue;
    if (!row) await db.insert(villageTranslations).values({ villageId, lang, sourceHash: hash }).onConflictDoNothing();
    else if (row.state === "failed") await db.update(villageTranslations).set({ state: "pending", errorCode: null, updatedAt: new Date() }).where(and(eq(villageTranslations.villageId, villageId), eq(villageTranslations.lang, lang)));
    if ((await enqueueVillage(db, { villageId, lang, sourceHash: hash })).created) queued++;
  }
  return queued;
}

// Requeue the translations that are missing or failed, for every public village (a language was opened; the operator's preparation). Returns how many jobs were queued.
export async function requestAllVillageTranslations(db: Db, opts: { retryFailed?: boolean; env?: Record<string, string | undefined> } = {}): Promise<number> {
  const rows = await db.select({ id: villages.id }).from(villages).where(isNotNull(villages.sourceLang));
  let queued = 0;
  for (const row of rows) queued += await requestVillageTranslations(db, row.id, opts);
  return queued;
}

// The village as the translation job reads it: null when the texts have changed since the job was queued, or the village is not public.
export async function villageTranslationSource(db: Db, payload: VillageTranslationPayload) {
  const [village] = await db.select().from(villages).where(eq(villages.id, payload.villageId));
  if (!village || !isSharedVillageKind(village.kind) || !isLang(village.sourceLang) || village.sourceLang === payload.lang || villageSourceHash(village) !== payload.sourceHash) return null;
  return { ...village, sourceLang: village.sourceLang };
}

export async function villageTranslationSettled(db: Db, payload: VillageTranslationPayload): Promise<boolean> {
  const [row] = await db.select({ state: villageTranslations.state }).from(villageTranslations).where(and(
    eq(villageTranslations.villageId, payload.villageId), eq(villageTranslations.lang, payload.lang), eq(villageTranslations.sourceHash, payload.sourceHash),
    inArray(villageTranslations.state, ["ready", "failed"])));
  return !!row;
}

type SavedTranslation = Partial<Pick<typeof villageTranslations.$inferInsert, "state" | "name" | "description" | "model" | "promptVersion" | "errorCode">> & { state: "ready" | "failed" };
// Save under a share lock on the village, so an edit (which holds the row exclusively) cannot slip between the check of the texts and the write.
export async function saveVillageTranslation(db: Db, payload: VillageTranslationPayload, update: SavedTranslation, options: { preserveSettled?: boolean } = {}): Promise<boolean> {
  return db.transaction(async tx => {
    const [village] = await tx.select().from(villages).where(eq(villages.id, payload.villageId)).for("share");
    if (!village || !isSharedVillageKind(village.kind) || villageSourceHash(village) !== payload.sourceHash || !isEnabledLang(payload.lang)) return false;
    const [previous] = await tx.select().from(villageTranslations).where(and(eq(villageTranslations.villageId, payload.villageId), eq(villageTranslations.lang, payload.lang)));
    // A recovered worker must not replace output that an earlier run committed.
    if (options.preserveSettled && previous?.sourceHash === payload.sourceHash && (previous.state === "ready" || previous.state === "failed")) return false;
    const values = { state: update.state, name: update.name ?? null, description: update.description ?? null, model: update.model ?? null, promptVersion: update.promptVersion ?? null, errorCode: update.errorCode ?? null, updatedAt: new Date() };
    await tx.insert(villageTranslations).values({ villageId: payload.villageId, lang: payload.lang, sourceHash: payload.sourceHash, ...values })
      .onConflictDoUpdate({ target: [villageTranslations.villageId, villageTranslations.lang], set: { sourceHash: payload.sourceHash, ...values } });
    return true;
  });
}

// ---- Reading --------------------------------------------------------------------------------------------------------------------------------------------------------

type TextRow = { slug: string | null; name: string; description?: string; language: string | null };

// Put the translated name and description into rows that carry a village's slug, name and description. A row is changed only when the reader wants a translation (the original
// is in neither their display language nor a language they read) and a current, finished translation exists; otherwise it is returned as it is, so the original is the fallback
// while a translation is pending, failed or stale. With `original`, the rows keep the original and say that a translation is available (the reader asked to read the original).
// No translation is ever made here; the jobs are queued when the village is written.
export async function localizeVillages<T extends TextRow>(db: Db, rows: readonly T[], reader: VillageReader | null | undefined, opts: { original?: boolean } = {}): Promise<Array<T & WithVillageTranslation>> {
  if (!reader) return [...rows];
  // A personal place uses its owner's display name. Generic "My village" labels stay unchanged.
  const handles = rows.flatMap(row => row.slug?.startsWith("@") && row.name === row.slug ? [row.slug.slice(1)] : []);
  const names = await loadDisplayNames(db, handles);
  const named = rows.map(row => row.slug?.startsWith("@") && row.name === row.slug
    ? { ...row, name: selectDisplayName(names.get(row.slug.slice(1))) ?? row.name } : row);
  const slugs = [...new Set(named.flatMap(row => row.slug && !row.slug.startsWith("@") ? [row.slug] : []))];
  if (!isEnabledLang(reader.displayLang) || !slugs.length) return named;
  const found = await db.select({ village: villages, translation: villageTranslations }).from(villages)
    .leftJoin(villageTranslations, and(eq(villageTranslations.villageId, villages.id), eq(villageTranslations.lang, reader.displayLang)))
    .where(and(inArray(villages.slug, slugs), isNotNull(villages.sourceLang)));
  const bySlug = new Map(found.flatMap(({ village, translation }) => {
    if (!village.slug || !isLang(village.sourceLang) || !wantsTranslation(village.sourceLang, reader.readLangs, reader.displayLang)) return [];
    if (translation?.state !== "ready" || translation.sourceHash !== villageSourceHash(village)) return [];
    return [[village.slug, { from: village.sourceLang, name: translation.name, description: translation.description }] as const];
  }));
  return named.map(row => {
    const current = row.slug ? bySlug.get(row.slug) : undefined;
    if (!current) return row;
    const info = { from: current.from, shown: !opts.original, originalName: row.name, originalDescription: row.description ?? "" };
    if (opts.original) return { ...row, translation: info };
    return { ...row, name: current.name ?? row.name, ...(row.description !== undefined ? { description: current.description ?? row.description } : {}), translation: info };
  });
}

export async function localizeVillage<T extends TextRow>(db: Db, row: T, reader: VillageReader | null | undefined, opts: { original?: boolean } = {}): Promise<T & WithVillageTranslation> {
  return (await localizeVillages(db, [row], reader, opts))[0];
}

// The reader of a mail or any text without a request: the recipient's interface language (or, if it is empty or closed, the main language), as the mail is written in it.
export function villageReaderOfMember(profile: { uiLocale: string | null; homeArea: string }, env?: Record<string, string | undefined>): VillageReader {
  const enabled = enabledLangs(env);
  const pick = [profile.uiLocale, profile.homeArea].find((lang): lang is Lang => isLang(lang) && enabled.includes(lang));
  return { displayLang: pick ?? (enabled.includes("en") ? "en" : enabled[0]), readLangs: [] };
}

// ---- The language the texts are written in -------------------------------------------------------------------------------------------------------------------------

// A language the author can name for the texts of a village: an enabled one.
export function villageSourceLang(value: unknown, env?: Record<string, string | undefined>): Lang | null {
  return typeof value === "string" && isEnabledLang(value, env) ? value : null;
}

// The default for the village someone makes: their main language; if that is "other" or closed, the language of their screen, then of reading, then the site's default.
type MemberLangs = { homeArea: string; uiLocale: string | null; displayLang: string | null; readLangs: readonly string[] };
const ownLang = (profile: MemberLangs, env?: Record<string, string | undefined>): Lang | null =>
  [profile.homeArea, profile.uiLocale, profile.displayLang, ...profile.readLangs].map(lang => villageSourceLang(lang, env)).find((lang): lang is Lang => lang !== null) ?? null;
export function memberVillageLang(profile: MemberLangs, env?: Record<string, string | undefined>): Lang {
  return ownLang(profile, env) ?? defaultLangOf(enabledLangs(env));
}

// For a village with no author to ask (a language village an operator described): what the text itself is in, if it can be told; otherwise the site's default.
export function detectedVillageLang(text: string, env?: Record<string, string | undefined>): Lang {
  const lang = detectLang(text);
  return lang && isEnabledLang(lang, env) ? lang : defaultLangOf(enabledLangs(env));
}

// The language of the texts of a village that has none yet, and how it was decided: the author's own language, else what the text is in, else the site's default.
// The operator's preparation and the owner's form (when someone other than the author edits first) must agree, so both ask here.
export type DecidedVillageLang = { lang: Lang; by: "author" | "text" | "default" };
export function decideVillageLang(parts: { name: string | null; description: string | null }, author: MemberLangs | null | undefined, env?: Record<string, string | undefined>): DecidedVillageLang {
  const own = author ? ownLang(author, env) : null;
  if (own) return { lang: own, by: "author" };
  const detected = detectLang(`${parts.name ?? ""}\n${parts.description ?? ""}`);
  if (detected && isEnabledLang(detected, env)) return { lang: detected, by: "text" };
  return { lang: defaultLangOf(enabledLangs(env)), by: "default" };
}

// Ask for one village (the author is read from its creator).
export async function decideVillageLangOf(db: Db, village: { name: string; description: string; language: string | null; createdBy: string | null }, env?: Record<string, string | undefined>): Promise<DecidedVillageLang> {
  const [author] = village.createdBy ? await db.select({ homeArea: profiles.homeArea, uiLocale: profiles.uiLocale, displayLang: profiles.displayLang, readLangs: profiles.readLangs }).from(profiles).where(eq(profiles.userId, village.createdBy)) : [];
  return decideVillageLang(translatableParts(village), author, env);
}

// ---- The operator's preparation ---------------------------------------------------------------------------------------------------------------------------------

// What the operator's preparation (pnpm villages:prepare) would do for the texts of villages made before they had a language: name the language of each text (its author's main
// language; the language of the text itself when there is no author), and queue the translations that are missing. `pairs` counts the (village, language) translations still to be made.
export async function planVillageTexts(db: Db, env?: Record<string, string | undefined>) {
  const rows = await db.select({ village: villages, author: { homeArea: profiles.homeArea, uiLocale: profiles.uiLocale, displayLang: profiles.displayLang, readLangs: profiles.readLangs } })
    .from(villages).leftJoin(profiles, eq(profiles.userId, villages.createdBy)).where(inArray(villages.kind, ["open", "invite_public"]));
  const done = await db.select({ villageId: villageTranslations.villageId, lang: villageTranslations.lang, sourceHash: villageTranslations.sourceHash }).from(villageTranslations)
    .where(or(eq(villageTranslations.state, "ready"), and(eq(villageTranslations.state, "failed"), eq(villageTranslations.errorCode, SAME_AS_SOURCE))));
  const fill: Array<{ id: string; slug: string | null; lang: Lang; by: DecidedVillageLang["by"] }> = [];
  let pairs = 0;
  for (const { village, author } of rows) {
    const parts = translatableParts(village);
    if (parts.name === null && parts.description === null) continue;
    let sourceLang = isLang(village.sourceLang) ? village.sourceLang : null;
    if (sourceLang === null) {
      const decided = decideVillageLang(parts, author, env);
      sourceLang = decided.lang;
      fill.push({ id: village.id, slug: village.slug, lang: decided.lang, by: decided.by });
    }
    const hash = villageSourceHash({ ...village, sourceLang });
    pairs += enabledTargetLangs(sourceLang, env).filter(lang => !done.some(row => row.villageId === village.id && row.lang === lang && row.sourceHash === hash)).length;
  }
  return { fill, pairs };
}

// Write the plan: set the missing languages, then bring every village's translations up to date (a failed one is tried again).
export async function applyVillageTexts(db: Db, plan: Awaited<ReturnType<typeof planVillageTexts>>, env?: Record<string, string | undefined>): Promise<number> {
  for (const row of plan.fill) await db.update(villages).set({ sourceLang: row.lang }).where(and(eq(villages.id, row.id), isNull(villages.sourceLang)));
  return requestAllVillageTranslations(db, { retryFailed: true, env });
}
