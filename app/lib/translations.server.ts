import { completeTranslationReports } from "./translation-report-results.server";
import { createHash } from "node:crypto";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "~/lib/db/client.server";
import { divergences, entries, glossaryEntries, jobs, segments, translationReports, translations } from "~/lib/db/schema";
import { cancelEmbeddingJobs, purgeEmbeddings } from "~/lib/embeddings.server";
import { purgeTranslationRevisions } from "~/lib/translation-revisions.server";
import { enqueue } from "~/lib/jobs/queue.server";
import { discardPaidTranslationCalls } from "~/lib/jobs/paid-translation.server";
import { cleanCandidates, termAppearsIn } from "~/lib/glossary-forms";
import { enabledTargetLangs } from "~/lib/enabled-langs.server";
import type { Lang } from "~/lib/languages";
import { eagerBodyLangs } from "./translation-eager.server";
import { segmentSentences } from "~/lib/segment";

// Small DB-facing translation pipeline functions used by posting and editing (entries.server.ts) and jobs (jobs/translation-jobs.server.ts).

export const TRANSLATE_JOB = "translate_entry";
export const TITLE_TRANSLATE_JOB = "translate_title";
export const DIVERGENCE_JOB = "measure_divergence";
// One automatic retry after the first mistranslation report (app/lib/jobs/translation-jobs.server.ts). Payload is { reportId, entryId }.
export const RETRANSLATE_REPORT_JOB = "retranslate_after_report";
export type RetranslateReportPayload = { reportId: number; entryId: number };
export const retranslateDedupeKey = (reportId: number) => `retranslate-report:${reportId}`;
// Maximum translate_entry attempts. Tolerate several hours of LLM outage: exponential delays from 30 seconds, capped at one hour; 10 attempts span about three hours.
export const TRANSLATE_MAX_ATTEMPTS = 10;

// redoFlagged: translate again even if the current translation is usable, when it carries a near-copy flag (translations:requeue --include-flagged).
export type TranslateJobPayload = { entryId: number; lang: Lang; sourceHash: string; redoFlagged?: true };

export function translateDedupeKey(p: TranslateJobPayload, sourceLang: string): string {
  return `translate:${p.entryId}:${sourceLang}:${p.lang}:${p.sourceHash}`;
}

export const titleTranslateDedupeKey = (p: TranslateJobPayload, sourceLang: string) => `translate-title:${p.entryId}:${sourceLang}:${p.lang}:${p.sourceHash}`;

export async function enqueueTitleTranslation(db: Db, payload: TranslateJobPayload, sourceLang: string, opts: { priority?: number } = {}): Promise<boolean> {
  const res = await enqueue(db, TITLE_TRANSLATE_JOB, payload, { dedupeKey: titleTranslateDedupeKey(payload, sourceLang), rescheduleRunning: true, maxAttempts: TRANSLATE_MAX_ATTEMPTS, ...opts });
  return res.created;
}

export function divergenceDedupeKey(p: TranslateJobPayload): string {
  return `divergence:${p.entryId}:${p.lang}:${p.sourceHash}`;
}

// On publication and source edits, titles go to every enabled target language;
// bodies go to the configured audience. An unfinished source/language job is not
// duplicated. Opening a language can still queue existing posts in bulk.
// May run inside tx, passed as Db. Return the number enqueued after deduplication.
export async function enqueueTranslations(
  db: Db,
  entry: { id: number; lang: string; sourceHash: string },
): Promise<number> {
  const [source] = await db.select({ kind: entries.kind, title: entries.title }).from(entries).where(eq(entries.id, entry.id));
  const bodyLangs = await eagerBodyLangs(db, entry.id);
  let created = 0;
  for (const lang of enabledTargetLangs(entry.lang)) {
    const payload: TranslateJobPayload = { entryId: entry.id, lang, sourceHash: entry.sourceHash };
    if (source?.kind === "topic" && source.title?.trim() && await enqueueTitleTranslation(db, payload, entry.lang)) created++;
    if (!bodyLangs.includes(lang)) continue;
    // The same hash can return in a later source revision while the earlier job is still running.
    // Its save guard rejects the earlier revision, so request another run rather than losing the new work.
    const res = await enqueue(db, TRANSLATE_JOB, payload, { dedupeKey: translateDedupeKey(payload, entry.lang), rescheduleRunning: true, maxAttempts: TRANSLATE_MAX_ATTEMPTS });
    if (res.created) created++;
  }
  return created;
}

// Cancel queued, not yet started translation, divergence, and embedding jobs for a post during deletion. Running jobs cannot be canceled,
// but save neither translations nor embeddings if the post is deleted before completion (currentSourceHash, entryStillCurrent). Return the number canceled.
export async function cancelEntryJobs(db: Db, entryId: number): Promise<number> {
  const matching = and(inArray(jobs.kind, [TRANSLATE_JOB, TITLE_TRANSLATE_JOB, DIVERGENCE_JOB, RETRANSLATE_REPORT_JOB]), sql`${jobs.payload}->>'entryId' = ${String(entryId)}`)!;
  await discardPaidTranslationCalls(db, matching);
  const rows = await db
    .delete(jobs)
    .where(and(matching, eq(jobs.status, "queued")))
    .returning({ id: jobs.id });
  return rows.length + (await cancelEmbeddingJobs(db, entryId));
}

// Purge post derivatives during deletion: all translations (primary, secondary, and human), translation history, sentence boundaries, divergence, embeddings, and rendered caches for source and translations.
// Translation caches disappear with translation rows; clear the source cache (entries.html). Close this post's open mistranslation reports automatically because the reported translations are gone
// (resolved, with resolved_by null). Keep route retry rows as evidence of the consumed first-report slot. Rebuild translations if the post is restored.
export async function purgeEntryDerivatives(db: Db, entryId: number, now: Date = new Date()): Promise<void> {
  await db
    .update(translationReports)
    .set({ status: "resolved", resolvedBy: null, resolvedAt: now })
    .where(and(eq(translationReports.entryId, entryId), eq(translationReports.status, "open")));
  await db.delete(translations).where(eq(translations.entryId, entryId));
  await purgeTranslationRevisions(db, entryId);
  await purgeEmbeddings(db, entryId);
  await db.delete(segments).where(eq(segments.entryId, entryId));
  await db.delete(divergences).where(eq(divergences.entryId, entryId));
  await db.update(entries).set({ html: null, cardHtml: null, htmlVersion: 0 }).where(eq(entries.id, entryId));
}

// Rebuild sentence boundaries on every creation and edit.
export async function replaceSegments(db: Db, entryId: number, body: string, lang: string): Promise<void> {
  const parts = segmentSentences(body, lang);
  await db.delete(segments).where(eq(segments.entryId, entryId));
  if (parts.length > 0) {
    await db.insert(segments).values(parts.map((p) => ({ entryId, idx: p.idx, start: p.start, end: p.end })));
  }
}

// Extract body sentences from stored boundaries in idx order. If none exist (older posts without stored boundaries), compute them immediately.
export async function loadSentences(db: Db, entryId: number, body: string, lang: string): Promise<string[]> {
  const rows = await db
    .select({ idx: segments.idx, start: segments.start, end: segments.end })
    .from(segments)
    .where(eq(segments.entryId, entryId))
    .orderBy(segments.idx);
  if (rows.length === 0) return segmentSentences(body, lang).map((p) => p.text);
  return rows.map((r) => body.slice(r.start, r.end));
}

// Carry translations of an unchanged field across source edits (title-only or body-only edits): update source_hash for all kinds of translations of that field that belonged to the immediately preceding version
// (oldHash). An unchanged field's translations remain correct, so no retranslation is needed
// and human translations remain non-stale. Do not carry translations already stale from an earlier edit (versions other than oldHash).
// Also carry divergence records when the body is unchanged. Carry open reports for the unchanged field to the new source version, switching their route to moderator: retry jobs
// ignore reports whose route is not retry. The reported translation remains unchanged, so keep the report open in the moderator queue with its notice. Preserve retry_slot
// except when another slot already exists for the new version (repeated edits restoring earlier text); clear the slot then to avoid the unique index conflict.
// Lock order: post, then report. Editing calls this after updating the post row, inside the edit transaction and before marking stale translations.
export async function carryOverUnchangedFields(
  db: Db,
  entryId: number,
  oldHash: string | null,
  newHash: string,
  unchanged: { title: boolean; body: boolean },
): Promise<void> {
  if (oldHash === null || oldHash === newHash) return;
  const [current] = await db.select({ mentionRevision: entries.mentionRevision }).from(entries).where(eq(entries.id, entryId));
  const previousRevision = current.mentionRevision - 1;
  const fields = (["title", "body"] as const).filter((f) => unchanged[f]);
  if (fields.length > 0) {
    await db
      .update(translations)
      .set({ sourceHash: newHash, mentionRevision: current.mentionRevision, firstSeenAt: null })
      .where(and(eq(translations.entryId, entryId), eq(translations.sourceHash, oldHash), inArray(translations.field, fields), sql`(${translations.mentionRevision} is null or ${translations.mentionRevision} = ${previousRevision})`));
  }
  if (fields.length > 0) {
    await db
      .update(translationReports)
      .set({
        sourceHash: newHash,
        route: "moderator",
        retrySlot: sql`(${translationReports.retrySlot} and not exists (select 1 from translation_reports as other where other.entry_id = ${translationReports.entryId} and other.lang = ${translationReports.lang} and other.field = ${translationReports.field} and other.source_hash = ${newHash} and other.retry_slot))`,
      })
      .where(and(eq(translationReports.entryId, entryId), eq(translationReports.status, "open"), eq(translationReports.sourceHash, oldHash), inArray(translationReports.field, fields)));
  }
  if (unchanged.body) {
    await db.update(divergences).set({ sourceHash: newHash }).where(and(eq(divergences.entryId, entryId), eq(divergences.sourceHash, oldHash)));
  }
}

// An edit took the title off a topic: the open reports on the translation of the title have nothing left to point at (and a title translation cannot be corrected for a topic without a
// title), so they are closed without a person (resolved, resolved_by null), as the open reports of a deleted entry are. Reports on the body stay. Like carryOverUnchangedFields, it is
// called in the edit's transaction after the entry row is updated (the order of locks: the entry, then its reports).
export async function resolveTitleReports(db: Db, entryId: number, now: Date = new Date()): Promise<void> {
  await completeTranslationReports(db, and(eq(translationReports.entryId, entryId), eq(translationReports.field, "title"))!, "source_updated", now);
}

// On source edits, retain human corrections but mark versions differing from the current source stale. Clear the flag on translations matching the current version
// so edits restoring earlier text do not leave them stale. Leave primary and secondary untouched here; they will be retranslated for the new version.
export async function markHumanTranslationsStale(db: Db, entryId: number, sourceHash: string, now: Date = new Date()): Promise<void> {
  const [current] = await db.select({ mentionRevision: entries.mentionRevision }).from(entries).where(eq(entries.id, entryId));
  await db
    .update(translations)
    .set({
      flags: sql`case when ${translations.sourceHash} = ${sourceHash} and (${translations.mentionRevision} is null or ${translations.mentionRevision} = ${current.mentionRevision}) then array_remove(${translations.flags}, 'stale') else array_append(array_remove(${translations.flags}, 'stale'), 'stale') end`,
      updatedAt: now,
    })
    .where(and(eq(translations.entryId, entryId), eq(translations.kind, "human")));
}

export type GlossaryRow = typeof glossaryEntries.$inferSelect;

// Glossary version: the first 12 characters of SHA-256 over all row contents, ordered by term, lang, target_lang, including each row's term, lang, target_lang, candidates, note, and keep_original.
// Return null for an empty glossary. As a content hash, it changes on additions, edits, and deletions,
// and returns to the same version when content is restored (using maximum updated_at failed to change the version on deletion).
export function glossaryVersionOf(rows: Array<Pick<GlossaryRow, "term" | "lang" | "targetLang" | "candidates" | "note" | "keepOriginal">>): string | null {
  if (rows.length === 0) return null;
  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  const canonical = [...rows]
    .sort((a, b) => cmp(a.term, b.term) || cmp(a.lang, b.lang) || cmp(a.targetLang, b.targetLang))
    .map((r) => [r.term, r.lang, r.targetLang, r.candidates, r.note, r.keepOriginal]);
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex").slice(0, 12);
}

// Exclude deleted_at entries from the version.
export async function getGlossaryVersion(db: Db): Promise<string | null> {
  return glossaryVersionOf(await db.select().from(glossaryEntries).where(isNull(glossaryEntries.deletedAt)));
}

// Return glossary terms appearing in the text in prompt-ready form. termAppearsIn is case-insensitive, matching Latin-script words at word boundaries and other terms as substrings.
// Parse candidate parentheses (app/lib/glossary-forms.ts): variants become separate candidates, annotations become notes. If targetLang exists on the row, use it as the candidates' language.
export function matchGlossary(
  rows: Array<Pick<GlossaryRow, "term" | "candidates" | "note" | "keepOriginal"> & { targetLang?: string }>,
  text: string,
): Array<{ term: string; candidates: string[]; note?: string; keepOriginal?: boolean }> {
  return rows
    .filter((r) => termAppearsIn(r.term, text))
    .map((r) => {
      const cleaned = cleanCandidates(r.candidates, r.targetLang);
      // Append parenthetical annotations after the note text, joining them if the text does not end in 「。」.
      const extra = cleaned.annotations.join("、");
      const note = extra === "" ? r.note : r.note === "" ? extra : `${r.note}${r.note.endsWith("。") ? "" : "。"}${extra}`;
      return {
        term: r.term,
        candidates: cleaned.candidates,
        ...(note ? { note } : {}),
        ...(r.keepOriginal ? { keepOriginal: true } : {}),
      };
    });
}

// Glossary read by translation jobs for the source/target language pair. Exclude deleted_at entries from translation.
export async function loadGlossary(db: Db, from: string, to: string): Promise<GlossaryRow[]> {
  return db
    .select()
    .from(glossaryEntries)
    .where(and(eq(glossaryEntries.lang, from), eq(glossaryEntries.targetLang, to), isNull(glossaryEntries.deletedAt)))
    .orderBy(glossaryEntries.term);
}

// Current source version used when saving translations, or null if absent. Deleted and hidden posts return null so a translation is not saved after either change during translation.
export async function currentSourceHash(db: Db, entryId: number): Promise<string | null> {
  const [row] = await db
    .select({ sourceHash: entries.sourceHash, deletedAt: entries.deletedAt, hiddenAt: entries.hiddenAt })
    .from(entries)
    .where(eq(entries.id, entryId));
  return row && !row.deletedAt && !row.hiddenAt ? row.sourceHash : null;
}
