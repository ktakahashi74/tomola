import { recordUntranslatable } from "./source-language-jobs.server";
import { completeTranslationReports } from "../translation-report-results.server";
import { lockReviewableEntry, rootTopic, rootTopicOn, reviewableWithTopic } from "../visibility.server";
import { recordTranslationGeneration } from "../eval/signals.server";
import { safeErrorText } from "~/lib/error-text.server";
import { MarkdownBusyError } from "../markdown-budget.server";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "~/lib/db/client.server";
import { divergences, entries, jobs, translationReports, translations } from "~/lib/db/schema";
import { isUsablePrimary, pickTranslation, SHOWN_KINDS } from "~/lib/display";
import { tryRenderTranslationHtml } from "~/lib/entries.server";
import { FLAG_JUDGED, FLAG_MARKDOWN_BUDGET, FLAG_PROVISIONAL_TITLE, FLAG_RETRIED_AFTER_REPORT, HIDDEN_PRIMARY_FLAGS, NEAR_COPY_FLAGS } from "~/lib/llm/flags";
import { JUDGE_PROMPT_VERSION } from "~/lib/llm/prompt.server";
import { LlmError } from "~/lib/llm/errors.server";
import { BudgetPausedError, hasSavedTranslation, isSecondaryAvailable, jobLlmOptions, judgeDivergence, shouldMeasureDivergence, translate, type LlmOptions, type TranslationOutcome } from "~/lib/llm/index.server";
import type { GlossaryHint, TranslationRequest } from "~/lib/llm/types";
import { isEnabledLang } from "~/lib/enabled-langs.server";
import { LANGS, type Lang, type SourceLang } from "~/lib/languages";
import { RENDER_VERSION } from "~/lib/markdown.server";
import { resolveSourceMentions } from "~/lib/mentions.server";
import {
  currentSourceHash,
  TITLE_TRANSLATE_JOB,
  DIVERGENCE_JOB,
  divergenceDedupeKey,
  getGlossaryVersion,
  loadGlossary,
  loadSentences,
  matchGlossary,
  RETRANSLATE_REPORT_JOB,
  type TranslateJobPayload,
} from "~/lib/translations.server";
import { recordRevision } from "~/lib/translation-revisions.server";
import { titleBodyContext, TITLE_BODY_MAX_CHARS } from "~/lib/translation-terms";
import { postTerminologyBodies, translationTermsFor } from "~/lib/translation-terms.server";
import { firstSeenAtForSource } from "~/lib/translation-first-seen.server";
import { joinResponsePostLine, localizeResponseBodies, prepareResponsePostTranslation } from "~/lib/response-line.server";
import { DeferJob, enqueue, isFinalJobFailure, jobAttemptLimit, type JobContext, type JobHandler, type JobHandlers, type JobRow } from "./queue.server";

// Translation jobs.
// - translate_entry (entry × target language × source revision): translate title for topics and body with the primary engine, saving kind=primary.
//   Then queue measure_divergence for topics only, excluding comments.
// - measure_divergence (topics only): translate body with the secondary engine (kind=secondary), then record judged disagreements with the primary, hidden in the UI.
// Budget-limit stops wait without failure. BudgetPausedError is DeferJob, so rethrow unchanged.
// Use secondary translation immediately on primary refusal, or from FALLBACK_AFTER_ATTEMPTS for other failures (earlier when the attempt limit is smaller).
// Save the secondary output as kind = primary with fallback, shown in UI/Markdown. If secondary is absent or budget is degraded/stopped, do not substitute;
// retain the original failure: refusal becomes failed, other failures retry. Skip disagreement measurement for this language because the primary output already came from the secondary.
// Both jobs finish without doing anything (the job is done) when the language of the payload is not enabled (ENABLED_LANGS) at the time of running, so that a job queued before a language
// was closed does not make a translation after it was closed. When the language is opened again, pnpm langs:open queues the work again.

const payloadSchema = z.object({
  entryId: z.number().int().positive(),
  lang: z.enum(LANGS),
  sourceHash: z.string().min(1),
  redoFlagged: z.literal(true).optional(),
});

function parsePayload(job: JobRow): TranslateJobPayload {
  const parsed = payloadSchema.safeParse(job.payload);
  if (!parsed.success) throw new Error(`Invalid ${job.kind} payload: ${parsed.error.issues[0]?.message ?? "invalid"}`);
  return parsed.data;
}

// Reuse the existing context budget, including the translated body's terms.
export const TITLE_CONTEXT_MAX_CHARS = TITLE_BODY_MAX_CHARS;

async function contextForTitle(db: Db, entry: EntryForJob, lang: Lang, title: string): Promise<string> {
  const rows = await db.select().from(translations).where(and(eq(translations.entryId, entry.id), eq(translations.field, "body"), eq(translations.lang, lang), inArray(translations.kind, [...SHOWN_KINDS])));
  const chosen = pickTranslation(rows, entry.sourceHash, entry.mentionRevision);
  const body = chosen && !chosen.flags.includes("stale") && isUsablePrimary(chosen, entry.sourceHash, entry.mentionRevision) ? chosen : undefined;
  const context = postTerminologyBodies(entry, body);
  return titleBodyContext(context.body, context.translation, title);
}

type EntryForJob = {
  id: number;
  kind: string;
  lang: SourceLang;
  threadId: number | null;
  parentId: number | null;
  title: string | null;
  body: string;
  sourceHash: string | null;
  mentionRevision: number;
};

// Whether the source revision remains current. After edits, a new-revision job exists; old-revision jobs do nothing.
async function loadEntry(db: Db, p: TranslateJobPayload): Promise<EntryForJob | null> {
  const [row] = await db
    .select({
      id: entries.id,
      kind: entries.kind,
      lang: entries.lang,
      threadId: entries.threadId,
      parentId: entries.parentId,
      title: entries.title,
      body: entries.body,
      sourceHash: entries.sourceHash,
      mentionRevision: entries.mentionRevision,
      deletedAt: entries.deletedAt,
      hiddenAt: entries.hiddenAt,
    })
    .from(entries)
    .where(eq(entries.id, p.entryId));
  // Do not translate deleted/hidden entries. Requeue when unhidden.
  if (!row || row.deletedAt || row.hiddenAt || row.sourceHash !== p.sourceHash || row.lang === p.lang) return null;
  return { ...row, lang: row.lang as SourceLang };
}

// Default primary failure count (claims/attempts) before trying secondary; a smaller error-specific job limit brings fallback forward to its final attempt.
export const FALLBACK_AFTER_ATTEMPTS = 4;

async function existingTranslation(db: Db, entryId: number, field: string, lang: string, kind: string) {
  const [row] = await db
    .select({ id: translations.id, text: translations.text, sourceHash: translations.sourceHash, mentionRevision: translations.mentionRevision, flags: translations.flags, fallback: translations.fallback })
    .from(translations)
    .where(and(eq(translations.entryId, entryId), eq(translations.field, field), eq(translations.lang, lang), eq(translations.kind, kind)));
  return row;
}

type SaveInput = {
  entryId: number;
  field: "title" | "body";
  lang: Lang;
  kind: "primary" | "secondary";
  text: string;
  engine: string;
  model: string;
  promptVersion: string;
  glossaryVersion: string | null;
  sourceHash: string;
  flags: string[];
  // Translated by secondary because the primary refused/failed.
  fallback?: boolean;
  // Rendered translated-body HTML, rendered inside the job and saved together. Clear the cache if absent (titles or secondary translations). cardHtml: the card version (a topic body only; null when the body was not cut).
  html?: string;
  cardHtml?: string | null;
  mentionRevision?: number;
  onlyIfMissing?: boolean;
};

// Save translations in a transaction that locks the entry (exclusive for titles, shared for bodies) and rechecks current revision, deletion, and hidden state before writing
// so intervening edits/deletion/hiding cannot leave stale or undisplayable translations. Deletion/hiding waits for this shared lock,
// then deletion cleanup removes translations after this save. Replace render cache with supplied HTML; clear if absent for re-render on display. Return true when saved.
async function saveTranslation(db: Db, input: SaveInput, now: Date): Promise<boolean> {
  const values = {
    text: input.text,
    engine: input.engine,
    model: input.model,
    promptVersion: input.promptVersion,
    glossaryVersion: input.glossaryVersion,
    sourceHash: input.sourceHash,
    mentionRevision: input.mentionRevision ?? null,
    flags: input.flags,
    fallback: input.fallback ?? false,
    html: input.html ?? null,
    cardHtml: input.cardHtml ?? null,
    htmlVersion: input.html === undefined ? 0 : RENDER_VERSION,
    updatedAt: now,
  };
  return db.transaction(async (tx) => {
    if (!(await entryStillCurrent(tx, input.entryId, input.sourceHash, input.mentionRevision, input.field === "title" ? "no key update" : "share"))) return false;
    const current = await existingTranslation(tx, input.entryId, input.field, input.lang, input.kind);
    // Serialize title saves so a slower provisional job cannot replace a completed title.
    if (input.onlyIfMissing) {
      if (current?.sourceHash === input.sourceHash && (current.mentionRevision === null || current.mentionRevision === input.mentionRevision)) return false;
    }
    // A hidden refinement must not replace a visible provisional title. Keep its text and provenance,
    // and finalize only that current source revision while holding the same title-save lock.
    if (input.field === "title" && input.kind === "primary" && !input.onlyIfMissing && input.flags.some(f => HIDDEN_PRIMARY_FLAGS.includes(f))) {
      if (current?.flags.includes(FLAG_PROVISIONAL_TITLE) && isUsablePrimary(current, input.sourceHash, input.mentionRevision)) {
        await tx.update(translations).set({ flags: current.flags.filter(f => f !== FLAG_PROVISIONAL_TITLE), updatedAt: now }).where(eq(translations.id, current.id));
        return true;
      }
    }
    // Preserve the previous row in history before overwriting for retranslation, unless its contents are identical.
    await recordRevision(tx, { entryId: input.entryId, field: input.field, lang: input.lang, kind: input.kind }, "retranslate", now, {
      text: input.text,
      engine: input.engine,
      model: input.model,
      sourceHash: input.sourceHash,
      fallback: input.fallback ?? false,
    });
    await tx
      .insert(translations)
      .values({ entryId: input.entryId, field: input.field, lang: input.lang, kind: input.kind, ...values, createdAt: now })
      .onConflictDoUpdate({ target: [translations.entryId, translations.field, translations.lang, translations.kind], set: { ...values, firstSeenAt: firstSeenAtForSource(input.sourceHash, input.mentionRevision ?? null) } });
    // Count a source revision once per field/language. Refining a provisional
    // title or redoing a flagged output does not create another source revision.
    const newRevision = !current || current.sourceHash !== input.sourceHash || (current.mentionRevision ?? null) !== (input.mentionRevision ?? null);
    if (input.kind === "primary" && newRevision && !input.flags.some(f => HIDDEN_PRIMARY_FLAGS.includes(f) || NEAR_COPY_FLAGS.includes(f))) {
      const [source] = await tx.select({ lang: entries.lang }).from(entries).where(eq(entries.id, input.entryId));
      await recordTranslationGeneration(tx, "post", source.lang, input.lang);
    }
    return true;
  });
}

// Check that the entry still has this source revision and is undeleted/unhidden. Call within a transaction, locking with FOR SHARE so edits, deletion, and hiding
// wait until writing finishes.
export async function entryStillCurrent(tx: Db, entryId: number, sourceHash: string, mentionRevision?: number, lock: "share" | "no key update" = "share"): Promise<boolean> {
  const [row] = await tx
    .select({ sourceHash: entries.sourceHash, mentionRevision: entries.mentionRevision, deletedAt: entries.deletedAt, hiddenAt: entries.hiddenAt })
    .from(entries)
    .where(eq(entries.id, entryId))
    .for(lock);
  return row !== undefined && !row.deletedAt && !row.hiddenAt && row.sourceHash === sourceHash && (mentionRevision === undefined || row.mentionRevision === mentionRevision);
}

export type TranslationJobDeps = {
  // LLM call options; tests inject engines, environment variables, and time.
  llm?: LlmOptions;
};

// Glossary for this language pair and entries whose terms occur in the source text.
async function glossaryFor(db: Db, from: SourceLang, to: Lang, text: string): Promise<{ hints: GlossaryHint[]; version: string | null }> {
  if (from === "other") return { hints: [], version: null };
  const rows = await loadGlossary(db, from, to);
  return { hints: matchGlossary(rows, text), version: rows.length > 0 ? await getGlossaryVersion(db) : null };
}

const isRefusal = (error: unknown) => error instanceof LlmError && error.code === "refusal";

const retranslatePayloadSchema = z.object({
  reportId: z.number().int().positive(),
  entryId: z.number().int().positive(),
});

// Automatically close retry reports when source edits made the reported translation obsolete.
async function resolveAutomatically(db: Db, reportId: number, now: Date): Promise<void> {
  await db.transaction(async tx => {
    const [peek] = await tx.select().from(translationReports).where(and(eq(translationReports.id, reportId), eq(translationReports.status, "open")));
    if (!peek) return;
    const entry = await lockReviewableEntry(tx, peek.entryId);
    if (!entry) return;
    const [current] = await tx.select().from(translationReports).where(eq(translationReports.id, reportId)).for("update");
    if (!current || current.status !== "open" || current.route !== "retry" || entry.sourceHash === current.sourceHash) return;
    await completeTranslationReports(tx, eq(translationReports.id, reportId), "source_updated", now);
  });
}

export function createTranslationHandlers(deps: TranslationJobDeps = {}): JobHandlers {
  const llm = (ctx: JobContext): LlmOptions => jobLlmOptions(ctx, deps.llm);

  // Translate with primary; substitute secondary on refusal or repeated failure only when available. skipPrimary means this execution found primary failing; do not try it for later fields.
  const translateWithFallback = async (
    job: JobRow,
    ctx: JobContext,
    req: Parameters<typeof translate>[2],
    state: { skipPrimary: boolean },
    response: Awaited<ReturnType<typeof prepareResponsePostTranslation>> = null,
  ): Promise<{ out: TranslationOutcome; fallback: boolean }> => {
    if (response) req = { ...req, text: response.body };
    const restored = (out: TranslationOutcome, fallback: boolean) => ({
      out: response ? { ...out, text: joinResponsePostLine(response.line, response.body ? out.text : "") } : out, fallback,
    });
    const options = llm(ctx);
    // Resume inspection of a paid fallback before attempting primary again.
    if (hasSavedTranslation("secondary", req, options)) {
      try { return restored(await translate(ctx.db, "secondary", req, options), true); }
    catch (error) {
      if (isRefusal(error)) Object.assign(error as object, { sourceContentFailure: (job.payload as { primaryRefused?: boolean }).primaryRefused === true });
      throw error;
    }
    }
    if (!state.skipPrimary) {
      try {
        return restored(await translate(ctx.db, "primary", req, options), false);
      } catch (error) {
        // Budget waits remain waits without fallback.
        if (error instanceof DeferJob || error instanceof MarkdownBusyError) throw error;
        if (error instanceof LlmError && error.code === "output_leak") throw error;
        if (!(isRefusal(error) || job.attempts >= Math.min(FALLBACK_AFTER_ATTEMPTS, jobAttemptLimit(job, error))) || !(await isSecondaryAvailable(ctx.db, options))) throw error;
        if (!isRefusal(error)) state.skipPrimary = true;
        job.payload = { ...job.payload as object, primaryRefused: isRefusal(error) };
        await ctx.db.update(jobs).set({ payload: sql`${jobs.payload} || ${JSON.stringify({ primaryRefused: isRefusal(error) })}::jsonb` }).where(eq(jobs.id, job.id));
        console.warn(`[translate] primary failed for job ${job.id} (${safeErrorText(error)}); translating with the secondary engine`);
      }
    }
    // Rethrow fallback failures unchanged. Refusal immediately becomes failed; other failures trigger job retries.
    try { return restored(await translate(ctx.db, "secondary", req, options), true); }
    catch (error) {
      if (isRefusal(error)) Object.assign(error as object, { sourceContentFailure: (job.payload as { primaryRefused?: boolean }).primaryRefused === true });
      throw error;
    }
  };

  const translateTitle: JobHandler = async (job, ctx) => {
    const p = parsePayload(job);
    if (!isEnabledLang(p.lang)) return;
    const entry = await loadEntry(ctx.db, p);
    if (!entry || entry.kind !== "topic" || !entry.title?.trim()) return;
    const done = await existingTranslation(ctx.db, entry.id, "title", p.lang, "primary");
    if (done?.sourceHash === p.sourceHash && (done.mentionRevision === null || done.mentionRevision === entry.mentionRevision)) return;
    const glossary = await glossaryFor(ctx.db, entry.lang, p.lang, entry.title);
    const terminology = await translationTermsFor(ctx.db, entry, p.lang);
    const { out, fallback } = await translateWithFallback(job, ctx, {
      text: entry.title, field: "title", from: entry.lang, to: p.lang, glossary: glossary.hints,
      ...(terminology ? { terminology } : {}),
    }, { skipPrimary: false });
    await saveTranslation(ctx.db, {
      entryId: entry.id, field: "title", lang: p.lang, kind: "primary",
      text: out.text, engine: out.engine, model: out.model, promptVersion: out.promptVersion,
      glossaryVersion: glossary.version, sourceHash: p.sourceHash,
      flags: [...out.flags, FLAG_PROVISIONAL_TITLE], fallback,
      mentionRevision: entry.mentionRevision, onlyIfMissing: true,
    }, ctx.now);
  };

  const translateEntry: JobHandler = async (job, ctx) => {
    const { db } = ctx;
    const p = parsePayload(job);
    if (!isEnabledLang(p.lang)) return;
    const entry = await loadEntry(db, p);
    if (!entry) return;
    const fields = entry.kind === "topic" ? (["body", "title"] as const) : (["body"] as const);
    const response = entry.kind === "topic" ? await prepareResponsePostTranslation(db, entry.body, entry.lang, p.lang) : null;
    const terminology = await translationTermsFor(db, entry, p.lang);
    if (entry.kind === "topic" && terminology) {
      const body = await existingTranslation(db, entry.id, "body", p.lang, "primary");
      if (!body || !isUsablePrimary(body, p.sourceHash, entry.mentionRevision)) {
        // A body-only edit can carry an unchanged title into this revision. Its
        // terms still need refinement after translating the updated body. Keep
        // that obligation through budget waits and retries without another call.
        await db.update(translations).set({ flags: sql`array_append(array_remove(${translations.flags}, ${FLAG_PROVISIONAL_TITLE}), ${FLAG_PROVISIONAL_TITLE})` }).where(and(
          eq(translations.entryId, entry.id), eq(translations.field, "title"), eq(translations.lang, p.lang), eq(translations.kind, "primary"), eq(translations.sourceHash, p.sourceHash),
          sql`(${translations.mentionRevision} is null or ${translations.mentionRevision} = ${entry.mentionRevision})`,
        ));
      }
    }
    const fallbackState = { skipPrimary: false };
    for (const field of fields) {
      // Do not retranslate after budget-stop resumption or for unchanged fields carried into the new source revision.
      // Retry translations with exclusion flags link_mismatch/untranslated.
      const done = await existingTranslation(db, entry.id, field, p.lang, "primary");
      if (done && isUsablePrimary(done, p.sourceHash, entry.mentionRevision) && !(field === "title" && done.flags.includes(FLAG_PROVISIONAL_TITLE)) && !(p.redoFlagged && done.flags.some((f) => NEAR_COPY_FLAGS.includes(f)))) continue;
      // A topic without a title has no title to translate (and no empty one is sent).
      const text = field === "title" ? entry.title : entry.body;
      if (!text || text.trim() === "") continue;
      const glossary = await glossaryFor(db, entry.lang, p.lang, field === "body" ? response?.body ?? text : text);
      // The @mentions of the source body (the members it names) are kept as written; the translation is rendered with the members of the source only.
      const source = field === "body" ? await resolveSourceMentions(db, entry.body, entry.id) : null;
      const { out, fallback } = await translateWithFallback(
        job,
        ctx,
        {
          text,
          field,
          from: entry.lang,
          to: p.lang,
          glossary: glossary.hints,
          ...(field === "title" ? { titleBodyContext: await contextForTitle(db, entry, p.lang, text) } : {}),
          ...(terminology ? { terminology } : {}),
          ...(source && source.mentions.length > 0 ? { mentions: source.mentions } : {}),
        },
        fallbackState,
        field === "body" ? response : null,
      );
      // Render and save translated bodies here inside jobs. Read requests render only when caches are absent or versions are old.
      let rendered: Awaited<ReturnType<typeof tryRenderTranslationHtml>> | undefined;
      try {
        rendered = source !== null && !out.flags.includes(FLAG_MARKDOWN_BUDGET) ? (await tryRenderTranslationHtml(entry.kind as "topic" | "reply", entry.id, p.lang, out.text, source.targets, true)) : undefined;
      } catch (error) {
        if (!(error instanceof MarkdownBusyError)) throw error;
        // Keep the charged text. htmlVersion 0 uses the existing read/rebuild path
        // to render later without another translation call.
      }
      if (rendered === null) out.flags.push(FLAG_MARKDOWN_BUDGET);
      await saveTranslation(
        db,
        {
          entryId: entry.id,
          field,
          lang: p.lang,
          kind: "primary",
          text: out.text,
          engine: out.engine,
          model: out.model,
          promptVersion: out.promptVersion,
          glossaryVersion: glossary.version,
          sourceHash: p.sourceHash,
          flags: out.flags,
          fallback,
          mentionRevision: entry.mentionRevision,
          ...(rendered == null ? {} : { html: rendered.html, cardHtml: rendered.cardHtml }),
        },
        ctx.now,
      );
    }
    // Queue disagreement measurement for topics only when secondary/judge are available and this translation was sampled (DIVERGENCE_SAMPLE_RATE). Skip if degraded or unconfigured.
    if (entry.kind === "topic" && (await shouldMeasureDivergence(db, { entryId: entry.id, lang: p.lang, sourceHash: p.sourceHash }, llm(ctx)))) {
      await enqueue(db, DIVERGENCE_JOB, p, { dedupeKey: divergenceDedupeKey(p) });
    }
  };

  const measureDivergence: JobHandler = async (job, ctx) => {
    const { db } = ctx;
    const p = parsePayload(job);
    if (!isEnabledLang(p.lang)) return;
    const entry = await loadEntry(db, p);
    if (!entry || entry.kind !== "topic") return;
    // Skip measurement without waiting if secondary/judge are absent, budget is degraded/stopped, or the translation is unsampled (DIVERGENCE_SAMPLE_RATE, possibly reduced since queuing).
    if (!(await shouldMeasureDivergence(db, { entryId: entry.id, lang: p.lang, sourceHash: p.sourceHash }, llm(ctx)))) return;
    const primary = await existingTranslation(db, entry.id, "body", p.lang, "primary");
    if (!primary || primary.sourceHash !== p.sourceHash || (primary.mentionRevision !== null && primary.mentionRevision !== entry.mentionRevision)) return;
    // If primary output came from secondary after primary failure/refusal, skip measurement because it would compare the same secondary engine.
    if (primary.fallback) return;
    try {
      const existing = await existingTranslation(db, entry.id, "body", p.lang, "secondary");
      // A current secondary translation already judged is measured, such as carried translations/disagreements after a title-only edit. Do not repeat.
      const secondaryCurrent = existing && existing.sourceHash === p.sourceHash && (existing.mentionRevision === null || existing.mentionRevision === entry.mentionRevision);
      if (secondaryCurrent && existing.flags.includes(FLAG_JUDGED)) return;
      let secondary = existing;
      // Reuse a current secondary after a judge failure rather than translating again.
      if (!secondaryCurrent) {
        const { mentions } = await resolveSourceMentions(db, entry.body, entry.id);
        const response = await prepareResponsePostTranslation(db, entry.body, entry.lang, p.lang);
        const glossary = await glossaryFor(db, entry.lang, p.lang, response?.body ?? entry.body);
        const out = await translate(
          db,
          "secondary",
          { text: response?.body ?? entry.body, from: entry.lang, to: p.lang, glossary: glossary.hints, terminology: await translationTermsFor(db, entry, p.lang), ...(mentions.length > 0 ? { mentions } : {}) },
          llm(ctx),
        );
        if (response) out.text = joinResponsePostLine(response.line, response.body ? out.text : "");
        const saved = await saveTranslation(
          db,
          {
            entryId: entry.id,
            field: "body",
            lang: p.lang,
            kind: "secondary",
            text: out.text,
            engine: out.engine,
            model: out.model,
            promptVersion: out.promptVersion,
            glossaryVersion: glossary.version,
            sourceHash: p.sourceHash,
            mentionRevision: entry.mentionRevision,
            flags: out.flags,
          },
          ctx.now,
        );
        if (!saved) return;
        secondary = await existingTranslation(db, entry.id, "body", p.lang, "secondary");
      }
      if (!secondary || secondary.sourceHash !== p.sourceHash || (secondary.mentionRevision !== null && secondary.mentionRevision !== entry.mentionRevision)) return;
      const comparedSecondary = secondary;
      const sentences = await loadSentences(db, entry.id, entry.body, entry.lang);
      const compared = await localizeResponseBodies(db, [
        { entryId: entry.id, field: "body", kind: "primary", lang: p.lang, text: primary.text },
        { entryId: entry.id, field: "body", kind: "secondary", lang: p.lang, text: comparedSecondary.text },
      ]);
      const verdict = await judgeDivergence(
        db,
        { segments: sentences, from: entry.lang, to: p.lang, translationA: compared[0].text, translationB: compared[1].text },
        llm(ctx),
      );
      if ((await currentSourceHash(db, entry.id)) !== p.sourceHash) return;
      await db.transaction(async (tx) => {
        // Lock the entry immediately before writing and recheck revision/deleted/hidden state. Do not write if a change intervened during judging.
        if (!(await entryStillCurrent(tx, entry.id, p.sourceHash, entry.mentionRevision))) return;
        // Writers lock the entry before replacing primary, then secondary. Lock
        // both rows in that order so neither can change between this check and
        // saving the verdict. No locks are held while waiting for the judge.
        const current = await tx.select().from(translations)
          .where(and(eq(translations.entryId, entry.id), eq(translations.field, "body"), eq(translations.lang, p.lang), inArray(translations.kind, ["primary", "secondary"])))
          .orderBy(translations.kind).for("update");
        for (const [kind, compared] of [["primary", primary], ["secondary", comparedSecondary]] as const) {
          const row = current.find(row => row.kind === kind);
          if (!row || row.id !== compared.id || row.text !== compared.text || row.sourceHash !== compared.sourceHash
            || row.mentionRevision !== compared.mentionRevision || row.fallback !== compared.fallback) {
            // Retry this running job through its bounded attempt/backoff policy.
            // Enqueuing the same dedupe key here would be absorbed by this job.
            throw new Error("Compared translations changed during divergence judging");
          }
        }
        if (current.find(row => row.kind === "secondary")!.flags.includes(FLAG_JUDGED)) return;
        // Mark this translation measured even if no disagreements were found.
        await tx
          .update(translations)
          .set({
            flags: sql`array_append(array_remove(${translations.flags}, ${FLAG_JUDGED}), ${FLAG_JUDGED})`,
            updatedAt: ctx.now,
          })
          .where(and(eq(translations.entryId, entry.id), eq(translations.field, "body"), eq(translations.lang, p.lang), eq(translations.kind, "secondary")));
        await tx.delete(divergences).where(and(eq(divergences.entryId, entry.id), eq(divergences.lang, p.lang)));
        if (verdict.divergences.length > 0) {
          await tx.insert(divergences).values(
            verdict.divergences.map((d) => ({
              entryId: entry.id,
              lang: p.lang,
              segmentIdx: d.sentence,
              severity: d.severity,
              category: d.category,
              note: d.note,
              judgeEngine: verdict.engine,
              judgeModel: verdict.model,
              sourceHash: p.sourceHash,
              judgePromptVersion: verdict.promptVersion || JUDGE_PROMPT_VERSION,
              createdAt: ctx.now,
            })),
          );
        }
      });
    } catch (error) {
      // Disagreement measurement is auxiliary. If budget degrades/stops during measurement, finish without waiting.
      if (error instanceof BudgetPausedError) return;
      throw error;
    }
  };

  // One automatic retranslation after the first mistranslation report (payload { reportId, entryId }).
  // Use a higher model (TRANSLATION_RETRY_MODEL, retry role) for only the reported field (title/body).
  // Keep reporter text for moderators only. Replace kind = primary, preserving the previous row in translation_revisions with reason report_retry and flagging retried_after_report. After saving, mark the report resolved
  // with resolved_by null. Replacing body invalidates its old disagreement measurement: clear secondary judged flag and disagreement rows. Record cost under purpose retry.
  // No progress: do nothing unless report is open with route retry. For deleted/hidden entries, route to moderator and finish. If source was edited (a separate job will retranslate it), resolve the report and finish.
  // If the displayed translation is human, route to moderator. Refusal routes there immediately; other failures route there after exhausting attempts.
  // While budget is degraded/stopped, wait without calling. BudgetPausedError is DeferJob and keeps the job queued.
  const retranslateAfterReport: JobHandler = async (job, ctx) => {
    const { db } = ctx;
    const payload = retranslatePayloadSchema.safeParse(job.payload);
    if (!payload.success) throw new Error(`Invalid ${job.kind} payload: ${payload.error.issues[0]?.message ?? "invalid"}`);
    const [report] = await db.select().from(translationReports).where(eq(translationReports.id, payload.data.reportId));
    if (!report || report.status !== "open" || report.route !== "retry" || report.sourceHash === null) return;
    const sourceHash = report.sourceHash;
    const lang = report.lang as Lang;
    const field = report.field as "title" | "body";
    const toModerator = () => db.update(translationReports).set({ route: "moderator" }).where(and(eq(translationReports.id, report.id), eq(translationReports.status, "open")));
    // A language that is not enabled any more (it was closed after the report was made) is not translated again: no engine call, no paid retry. The report goes to the moderators.
    if (!isEnabledLang(lang)) {
      await toModerator();
      return;
    }

    const [row] = await db
      .select({
        id: entries.id,
        kind: entries.kind,
        lang: entries.lang,
        threadId: entries.threadId,
        parentId: entries.parentId,
        title: entries.title,
        body: entries.body,
        sourceHash: entries.sourceHash,
        mentionRevision: entries.mentionRevision,
        deletedAt: entries.deletedAt,
        hiddenAt: entries.hiddenAt,
      })
      .from(entries)
      .innerJoin(rootTopic, rootTopicOn())
      .where(and(eq(entries.id, report.entryId), reviewableWithTopic()));
    const settle = async (current: { deletedAt: Date | null; hiddenAt: Date | null; sourceHash: string | null } | undefined) => {
      if (!current || current.deletedAt || current.hiddenAt) await toModerator();
      else if (current.sourceHash !== sourceHash) await resolveAutomatically(db, report.id, ctx.now);
    };
    if (!row || row.deletedAt || row.hiddenAt || row.sourceHash !== sourceHash || row.lang === lang) {
      await settle(row ? { deletedAt: row.deletedAt, hiddenAt: row.hiddenAt, sourceHash: row.sourceHash } : undefined);
      if (row && row.lang === lang) await toModerator();
      return;
    }
    const entry: EntryForJob = { ...row, lang: row.lang as SourceLang };

    // If this field's current displayed translation is human, there is no retry target; route to moderator.
    const shownRows = await db
      .select()
      .from(translations)
      .where(and(eq(translations.entryId, entry.id), eq(translations.lang, lang), eq(translations.field, field), inArray(translations.kind, [...SHOWN_KINDS])));
    if (pickTranslation(shownRows, sourceHash, entry.mentionRevision)?.kind !== "primary") {
      await toModerator();
      return;
    }

    // Retranslate only the reported field, never the other with the expensive model. Also avoid retranslating the same field twice after a budget wait.
    const sourceMentions = field === "body" ? await resolveSourceMentions(db, entry.body, entry.id) : { targets: new Map(), mentions: [] as string[], mentionRevision: undefined };
    const results: Array<{ field: "title" | "body"; out: TranslationOutcome; glossaryVersion: string | null }> = [];
    try {
      const text = field === "title" ? entry.title : entry.body;
      if (text && text.trim() !== "") {
        const response = entry.kind === "topic" ? await prepareResponsePostTranslation(db, entry.body, entry.lang, lang) : null;
        const glossary = await glossaryFor(db, entry.lang, lang, field === "body" ? response?.body ?? text : text);
        const request: TranslationRequest = {
          text: field === "body" ? response?.body ?? text : text,
          field,
          from: entry.lang,
          to: lang,
          glossary: glossary.hints,
          ...(field === "title" ? { titleBodyContext: await contextForTitle(db, entry, lang, text) } : {}),
          terminology: await translationTermsFor(db, entry, lang),
          ...(field === "body" && sourceMentions.mentions.length > 0 ? { mentions: sourceMentions.mentions } : {}),
        };
        const out = await translate(db, "retry", request, llm(ctx));
        if (field === "body" && response) out.text = joinResponsePostLine(response.line, response.body ? out.text : "");
        results.push({ field, out, glossaryVersion: glossary.version });
      }
    } catch (error) {
      // Budget waits remain waits.
      if (error instanceof DeferJob || error instanceof MarkdownBusyError) throw error;
      if (error instanceof LlmError && error.code === "output_leak") {
        await toModerator();
        throw error;
      }
      // Route refusal immediately. Missing retry engine after configuration changes and invalid configuration cannot recover by waiting. Other failures route to moderators after the attempt limit.
      if (isFinalJobFailure(job, error) || (error instanceof LlmError && (error.code === "unavailable" || error.code === "config"))) {
        console.warn(`[translate] the retry for report ${report.id} gave up (${safeErrorText(error)}); the report goes to the moderators`);
        await toModerator();
        return;
      }
      throw error;
    }
    // If retry output has link_mismatch/untranslated exclusion flags, retain the current translation and route to moderator.
    // The near-copy flags (untranslated_script, untranslated_similar) do not hide a translation in the first pass, but a re-translation after a report exists to fix a bad one: a result
    // that still looks like a copy does not replace the current translation either.
    if (results.length === 0 || results.some((r) => r.out.flags.some((f) => HIDDEN_PRIMARY_FLAGS.includes(f) || NEAR_COPY_FLAGS.includes(f)))) {
      await toModerator();
      return;
    }

    // Replace under locks in root topic → entry → report order, matching deletion cleanup and manual-correction saves.
    // Reversing the order deadlocks: deletion holds the entry waiting for the report, while this code holds the report waiting for the entry.
    // FOR SHARE on the entry: recheck current revision/deleted/hidden status before writing. Concurrent edits, deletion, or hiding must wait for this save or occur afterward.
    const saved = await db.transaction(async (tx) => {
      const current = await lockReviewableEntry(tx, entry.id);
      if (!current || current.sourceHash !== sourceHash || current.mentionRevision !== entry.mentionRevision) return "gone" as const;
      const [locked] = await tx.select({ status: translationReports.status, route: translationReports.route }).from(translationReports).where(eq(translationReports.id, report.id)).for("update");
      if (!locked || locked.status !== "open" || locked.route !== "retry") return "skipped" as const;
      // Do not replace a manual correction added during translation. Its save normally resolves the report before this point, but another report path may also add one.
      const nowRows = await tx
        .select()
        .from(translations)
        .where(and(eq(translations.entryId, entry.id), eq(translations.lang, lang), eq(translations.field, field), inArray(translations.kind, [...SHOWN_KINDS])));
      const previous = pickTranslation(nowRows, sourceHash, entry.mentionRevision);
      if (previous?.kind !== "primary") return "human" as const;
      const compared = await localizeResponseBodies(tx as Db, [previous, ...results.map(({ out }) => ({ ...previous, text: out.text }))]);
      const normalized = (text: string) => text.normalize("NFC").trim().replace(/\s+/g, " ");
      const excerpt = normalized(report.excerpt);
      if (compared.slice(1).some(out => normalized(compared[0].text) === normalized(out.text) ||
        (excerpt !== "" && normalized(compared[0].text).includes(excerpt) && normalized(out.text).includes(excerpt)))) return "unchanged" as const;
      for (const { field: f, out, glossaryVersion } of results) {
        const rendered = f === "body" ? (await tryRenderTranslationHtml(entry.kind as "topic" | "reply", entry.id, lang, out.text, sourceMentions.targets, true)) : undefined;
        if (rendered === null) return "budget" as const;
        await recordRevision(tx, { entryId: entry.id, field: f, lang, kind: "primary" }, "report_retry", ctx.now, {
          text: out.text,
          engine: out.engine,
          model: out.model,
          sourceHash,
          fallback: false,
        });
        const values = {
          text: out.text,
          engine: out.engine,
          model: out.model,
          promptVersion: out.promptVersion,
          glossaryVersion,
          sourceHash,
          mentionRevision: entry.mentionRevision,
          flags: [...out.flags, FLAG_RETRIED_AFTER_REPORT],
          fallback: false,
          html: rendered?.html ?? null,
          cardHtml: rendered?.cardHtml ?? null,
          htmlVersion: rendered === undefined ? 0 : RENDER_VERSION,
          updatedAt: ctx.now,
        };
        await tx
          .insert(translations)
          .values({ entryId: entry.id, field: f, lang, kind: "primary", ...values, createdAt: ctx.now })
          .onConflictDoUpdate({ target: [translations.entryId, translations.field, translations.lang, translations.kind], set: { ...values, firstSeenAt: firstSeenAtForSource(sourceHash, entry.mentionRevision) } });
        await recordTranslationGeneration(tx, "post", entry.lang, lang);
        if (f === "body") {
          // Measurements compared the replaced translation. Clear secondary's measured flag and disagreements so observation ratios of compared/all translations do not count obsolete measurements.
          await tx
            .update(translations)
            .set({ flags: sql`array_remove(${translations.flags}, ${FLAG_JUDGED})`, updatedAt: ctx.now })
            .where(and(eq(translations.entryId, entry.id), eq(translations.field, "body"), eq(translations.lang, lang), eq(translations.kind, "secondary")));
          await tx.delete(divergences).where(and(eq(divergences.entryId, entry.id), eq(divergences.lang, lang)));
        }
      }
      await completeTranslationReports(tx, eq(translationReports.id, report.id), "machine_retranslated", ctx.now, { correctedAt: ctx.now });
      return "saved" as const;
    });
    if (saved === "human" || saved === "budget" || saved === "unchanged") await toModerator();
    else if (saved === "gone") {
      const [current] = await db.select({ deletedAt: entries.deletedAt, hiddenAt: entries.hiddenAt, sourceHash: entries.sourceHash }).from(entries)
        .innerJoin(rootTopic, rootTopicOn()).where(and(eq(entries.id, entry.id), reviewableWithTopic()));
      await settle(current);
    }
  };

  return { [TITLE_TRANSLATE_JOB]: translateTitle, translate_entry: async (job, ctx) => {
    const p = parsePayload(job);
    if (!p) return;
    const entry = await loadEntry(ctx.db, p);
    if (!entry) return;
    try { await translateEntry(job, ctx); }
    catch (error) {
      if (!(error instanceof DeferJob) && !(error instanceof MarkdownBusyError) && !ctx.signal?.aborted && isFinalJobFailure(job, error)) await recordUntranslatable(job, ctx, isRefusal(error) && (error as { sourceContentFailure?: boolean }).sourceContentFailure !== false, entry.mentionRevision, false);
      throw error;
    }
    await recordUntranslatable(job, ctx, false, entry.mentionRevision);
  },  measure_divergence: measureDivergence, [RETRANSLATE_REPORT_JOB]: retranslateAfterReport };
}
