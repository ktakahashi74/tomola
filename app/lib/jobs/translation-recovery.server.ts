import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "~/lib/db/client.server";
import { entries, jobs } from "~/lib/db/schema";
import { isEnabledLang } from "~/lib/enabled-langs.server";
import { getBudgetState } from "~/lib/llm/usage.server";
import { rootTopic, rootTopicOn, visibleWithTopic } from "~/lib/visibility.server";
import { dateOf, ensureDailyJob } from "./daily.server";
import type { JobHandler, JobHandlers } from "./queue.server";
import { titleTranslateDedupeKey, translateDedupeKey } from "~/lib/translations.server";
import { canRetryTranslationDaily } from "./transient-failure.server";

export const RETRY_FAILED_TRANSLATIONS_JOB = "retry_failed_translations";
const spec = { kind: RETRY_FAILED_TRANSLATIONS_JOB, keyPrefix: "retry-translations", hourUtc: 2 };
const payloadSchema = z.object({ entryId: z.number().int().positive(), lang: z.string(), sourceHash: z.string() }).passthrough();

export const ensureTranslationRecoveryScheduled = (db: Db, now = new Date()) => ensureDailyJob(db, spec, now);
const ensuredAt = new WeakMap<Db, number>();
export async function ensureTranslationRecoveryScheduledThrottled(db: Db, now = new Date()): Promise<void> {
  if (now.getTime() - (ensuredAt.get(db) ?? 0) < 60_000) return;
  await ensureTranslationRecoveryScheduled(db, now);
  ensuredAt.set(db, now.getTime());
}

// Only original publication/title translations are recovered here. Report-driven
// retries retain their separate one-retry policy and moderation state machine.
export async function retryFailedTranslations(db: Db, now = new Date(), env: Record<string, string | undefined> = process.env): Promise<number> {
  if (await getBudgetState(db, now, env) === "stopped") return 0;
  let count = 0;
  let cursor = 0;
  for (;;) {
    const failed = await db.select().from(jobs).where(and(eq(jobs.status, "failed"), inArray(jobs.kind, ["translate_entry", "translate_title"]), gt(jobs.id, cursor))).orderBy(asc(jobs.id)).limit(100);
    if (!failed.length) break;
    for (const job of failed) {
      const parsed = payloadSchema.safeParse(job.payload);
      if (!parsed.success || !canRetryTranslationDaily(job.kind, job.lastError ?? "", job.payload)) continue;
      const p = parsed.data;
      const lang = p.lang;
      if (!isEnabledLang(lang, env)) continue;
      const key = `translation-retry:${p.entryId}:${p.lang}:${p.sourceHash}`;
      count += await db.transaction(async tx => {
        // Serialize only the recovery allowance for this source/language pair.
        // The active-job unique index also fences ordinary concurrent enqueue.
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
        const [current] = await tx.select().from(jobs).where(and(eq(jobs.id, job.id), eq(jobs.status, "failed")));
        if (!current) return 0;
        const [visible] = await tx.select({ id: entries.id, lang: entries.lang }).from(entries).innerJoin(rootTopic, rootTopicOn())
          .where(and(eq(entries.id, p.entryId), eq(entries.sourceHash, p.sourceHash), visibleWithTopic(), sql`${entries.lang} <> ${p.lang}`));
        if (!visible || await getBudgetState(tx, now, env) === "stopped") return 0;
        const [marker] = await tx.select({ id: jobs.id, payload: jobs.payload }).from(jobs)
          .where(and(eq(jobs.kind, "translation_retry_marker"), eq(jobs.dedupeKey, key)));
        const counts = [p, marker?.payload ?? {}] as { automaticRetryCount?: number; automaticRetryDate?: string }[];
        const used = Math.max(0, ...counts.map(r => Number.isInteger(r.automaticRetryCount) ? r.automaticRetryCount! : 0));
        if (used >= 3 || counts.some(r => r.automaticRetryDate === dateOf(now))) return 0;
        const expected = job.kind === "translate_entry" ? translateDedupeKey({ ...p, lang }, visible.lang) : titleTranslateDedupeKey({ ...p, lang }, visible.lang);
        const keys = [...new Set([expected, `${job.kind === "translate_entry" ? "translate" : "translate-title"}:${p.entryId}:${p.lang}:${p.sourceHash}`, ...(job.dedupeKey ? [job.dedupeKey] : [])])];
        const [active] = await tx.select({ id: jobs.id }).from(jobs).where(and(
          eq(jobs.kind, job.kind), inArray(jobs.dedupeKey, keys), inArray(jobs.status, ["queued", "running"]),
        ));
        if (active) return 0;
        // Retain the allowance after execution logs are cleaned up.
        const markerPayload = { entryId: p.entryId, lang: p.lang, sourceHash: p.sourceHash, automaticRetryCount: used + 1, automaticRetryDate: dateOf(now) };
        if (marker) await tx.update(jobs).set({ payload: markerPayload, updatedAt: now }).where(eq(jobs.id, marker.id));
        else await tx.insert(jobs).values({ kind: "translation_retry_marker", status: "done", dedupeKey: key, payload: markerPayload, createdAt: now, updatedAt: now });
        await tx.update(jobs).set({ status: "queued", dedupeKey: expected, attempts: 0, lockedAt: null, runAt: now, updatedAt: now,
          payload: sql`${jobs.payload} || ${JSON.stringify({ automaticRetryCount: used + 1, automaticRetryDate: dateOf(now) })}::jsonb`,
        }).where(eq(jobs.id, job.id));
        return 1;
      }).catch(error => {
        // The transaction (or nested savepoint) has rolled back the marker too.
        // Ordinary enqueue does not take our advisory lock and may win after
        // the active lookup. Skip this candidate; preserve the rest of the batch.
        const cause = error && typeof error === "object" ? error.cause : undefined;
        if ([error, cause].some(e => e && typeof e === "object" && e.code === "23505" && e.constraint === "jobs_dedupe_active_idx")) return 0;
        throw error;
      });
    }
    cursor = failed[failed.length - 1].id;
  }
  return count;
}

export function createTranslationRecoveryHandlers(): JobHandlers {
  const recover: JobHandler = async (_job, ctx) => {
    await ensureTranslationRecoveryScheduled(ctx.db, ctx.now);
    await retryFailedTranslations(ctx.db, ctx.now);
  };
  return { [RETRY_FAILED_TRANSLATIONS_JOB]: recover };
}
