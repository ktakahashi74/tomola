import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "~/lib/db/client.server";
import { entries, translations } from "~/lib/db/schema";
import { isUsablePrimary } from "~/lib/display";
import { enqueue } from "~/lib/jobs/queue.server";
import { FLAG_JUDGED, FLAG_PROVISIONAL_TITLE, NEAR_COPY_FLAGS } from "~/lib/llm/flags";
import { isDivergenceAvailable, type LlmOptions } from "~/lib/llm/index.server";
import { currentDivergenceSampleRate, isDivergenceSampled } from "~/lib/llm/divergence-sample.server";
import { enabledLangs, enabledTargetLangs } from "~/lib/enabled-langs.server";
import type { Lang } from "~/lib/languages";
import {
  DIVERGENCE_JOB,
  enqueueTitleTranslation,
  divergenceDedupeKey,
  TRANSLATE_JOB,
  TRANSLATE_MAX_ATTEMPTS,
  translateDedupeKey,
  type TranslateJobPayload,
} from "~/lib/translations.server";

// Requeue translations (`pnpm translations:requeue`) to recover posts without translations, failed jobs, and divergence measurements skipped during budget degradation
// (only sampled translations are measured: DIVERGENCE_SAMPLE_RATE; app/lib/llm/divergence-sample.server.ts).
// Enqueue translate_entry for (post × language) pairs without a current-version primary translation, or with a suppressed translation. Near-copy flags (untranslated_script, untranslated_similar)
// remain displayed, so skip them by default; includeFlagged includes them.
// dedupe_key prevents duplicate unfinished jobs across repeated runs. With divergence: true, also enqueue measure_divergence for topics not yet measured,
// provided secondary and judge engines are available.
// Only the enabled languages (ENABLED_LANGS) are queued. opts.langs narrows it further (pnpm langs:open <tag> names the language being opened; a language that is not enabled is an error).
// Topics are queued first, newest activity first. Mail and title jobs take priority; within each tier, due time and ID preserve this ordering.

export type RequeueResult = {
  // Number of inspected posts, excluding deleted and hidden posts.
  entries: number;
  // Number of newly queued translate_entry jobs.
  translate: number;
  // Number of newly queued measure_divergence jobs.
  divergence: number;
  // Why requested divergence jobs were skipped: missing secondary or judge engine, or degraded budget.
  divergenceSkipped: string | null;
  // Only with dryRun: the number of (post x language) pairs that would be queued and the total number of characters of their originals (title and body), for the cost estimate
  // (pnpm langs:open --dry-run). A job that is already queued and waiting counts as a target too.
  dryRun?: { targets: number; chars: number };
};

type Row = typeof translations.$inferSelect;

// opts.langs named a language that is not enabled.
export class RequeueLangError extends Error {
  readonly code = "not_enabled";
  constructor(readonly langs: readonly string[]) {
    super(`not_enabled: ${langs.join(", ")} is not in ENABLED_LANGS (add it to ENABLED_LANGS and restart the app first)`);
  }
}

// includeFlagged: also translate again the translations that carry a near-copy flag (untranslated_script, untranslated_similar). They are shown to readers, and a second run would
// usually give the same result (and bill it again), so they are skipped by default.
export async function requeueTranslations(
  db: Db,
  opts: { divergence?: boolean; includeFlagged?: boolean; llm?: LlmOptions; langs?: readonly Lang[]; dryRun?: boolean; env?: Record<string, string | undefined> } = {},
): Promise<RequeueResult> {
  const enabled = enabledLangs(opts.env);
  const notEnabled = (opts.langs ?? []).filter((l) => !enabled.includes(l));
  if (notEnabled.length > 0) throw new RequeueLangError(notEnabled);
  const wanted = opts.langs ?? enabled;
  // Replies under a topic that is deleted or hidden are not queued (nobody reads them: the thread is gone or redacted). The text of the posts is not read: only for a dry run, the length
  // of the title and the body is computed in the database for the cost estimate.
  const thread = alias(entries, "thread");
  const all = await db
    .select({
      id: entries.id,
      kind: entries.kind,
      lang: entries.lang,
      title: entries.title,
      chars: opts.dryRun ? sql<number>`char_length(${entries.body}) + coalesce(char_length(${entries.title}), 0)` : sql<number>`0`,
      sourceHash: entries.sourceHash,
    })
    .from(entries)
    .leftJoin(thread, eq(thread.id, entries.threadId))
    .where(and(isNull(entries.deletedAt), isNull(entries.hiddenAt), or(eq(entries.kind, "topic"), and(isNull(thread.deletedAt), isNull(thread.hiddenAt)))))
    .orderBy(desc(sql`${entries.kind} = 'topic'`), desc(entries.lastActivityAt), desc(entries.id));
  const rows = await db.select().from(translations).where(eq(translations.kind, "primary"));
  const secondary = opts.divergence ? await db.select().from(translations).where(and(eq(translations.kind, "secondary"), eq(translations.field, "body"))) : [];
  const byKey = new Map<string, Row>();
  for (const r of rows) byKey.set(`${r.entryId}:${r.field}:${r.lang}`, r);
  const secondaryByKey = new Map<string, Row>();
  for (const r of secondary) secondaryByKey.set(`${r.entryId}:${r.lang}`, r);

  let divergenceSkipped: string | null = null;
  let divergenceOn = false;
  const rate = currentDivergenceSampleRate(opts.llm?.env);
  if (opts.divergence) {
    divergenceOn = await isDivergenceAvailable(db, opts.llm);
    if (!divergenceOn) divergenceSkipped = "no secondary engine or judge is configured, or the monthly budget is degraded";
    else if (rate <= 0) {
      divergenceOn = false;
      divergenceSkipped = "DIVERGENCE_SAMPLE_RATE is 0 (no translation is sampled for the comparison)";
    }
  }

  const result: RequeueResult = { entries: all.length, translate: 0, divergence: 0, divergenceSkipped, ...(opts.dryRun ? { dryRun: { targets: 0, chars: 0 } } : {}) };
  for (const entry of all) {
    if (entry.sourceHash === null) continue;
    const fields = entry.kind === "topic" && entry.title?.trim() ? (["title", "body"] as const) : (["body"] as const);
    for (const lang of enabledTargetLangs(entry.lang, opts.env).filter((l) => wanted.includes(l))) {
      const payload: TranslateJobPayload = { entryId: entry.id, lang: lang as Lang, sourceHash: entry.sourceHash, ...(opts.includeFlagged ? { redoFlagged: true as const } : {}) };
      const done = fields.every((f) => {
        const row = byKey.get(`${entry.id}:${f}:${lang}`);
        if (row === undefined || !isUsablePrimary(row, entry.sourceHash) || (f === "title" && row.flags.includes(FLAG_PROVISIONAL_TITLE))) return false;
        return !(opts.includeFlagged && row.flags.some((flag) => NEAR_COPY_FLAGS.includes(flag)));
      });
      if (!done) {
        if (result.dryRun) {
          result.dryRun.targets++;
          result.dryRun.chars += Number(entry.chars);
          continue;
        }
        const title = byKey.get(`${entry.id}:title:${lang}`);
        if (entry.kind === "topic" && entry.title?.trim() && title?.sourceHash !== entry.sourceHash) await enqueueTitleTranslation(db, payload, entry.lang, { priority: 5 });
        const res = await enqueue(db, TRANSLATE_JOB, payload, { dedupeKey: translateDedupeKey(payload, entry.lang), maxAttempts: TRANSLATE_MAX_ATTEMPTS, priority: 5 });
        if (res.created) result.translate++;
        continue;
      }
      if (!opts.dryRun && divergenceOn && entry.kind === "topic" && isDivergenceSampled({ entryId: entry.id, lang, sourceHash: entry.sourceHash }, rate)) {
        const second = secondaryByKey.get(`${entry.id}:${lang}`);
        const measured = second !== undefined && second.sourceHash === entry.sourceHash && second.flags.includes(FLAG_JUDGED);
        if (!measured) {
          const res = await enqueue(db, DIVERGENCE_JOB, payload, { dedupeKey: divergenceDedupeKey(payload), priority: 5 });
          if (res.created) result.divergence++;
        }
      }
    }
  }
  return result;
}
