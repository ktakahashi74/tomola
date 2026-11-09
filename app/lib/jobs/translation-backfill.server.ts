import { and, asc, sql } from "drizzle-orm";
import type { Db } from "../db/client.server";
import { entries, jobs, translations } from "../db/schema";
import { enabledLangs } from "../enabled-langs.server";
import { getMonthlyCostMicro, monthlyBudgetMicro } from "../llm/usage.server";
import { enqueueTitleTranslation, TRANSLATE_JOB, TRANSLATE_MAX_ATTEMPTS, translateDedupeKey } from "../translations.server";
import { enqueue } from "./queue.server";
import { rootTopic, rootTopicOn, visibleWithTopic } from "../visibility.server";

export const TRANSLATION_BACKFILL_LIMIT = 100;
// Repair only genuinely absent current-version translations with no job of any
// status. Failed-job recovery remains separate. Prompt versions are irrelevant.
export async function reconcileMissingTranslations(db: Db, opts: { env?: Record<string, string | undefined>; now?: Date; limit?: number } = {}): Promise<number> {
  const env = opts.env ?? process.env, now = opts.now ?? new Date();
  if (env.TRANSLATION_BACKFILL_ENABLED !== "1") return 0;
  if (await getMonthlyCostMicro(db, now, undefined) >= monthlyBudgetMicro(env)) return 0;
  const limit = Math.max(0, Math.min(TRANSLATION_BACKFILL_LIMIT, opts.limit ?? TRANSLATION_BACKFILL_LIMIT));
  let count = 0;
  for (const lang of enabledLangs(env)) {
    if (count >= limit) break;
    await db.transaction(async tx => {
      const candidates = await tx.select({ id: entries.id, lang: entries.lang, kind: entries.kind, title: entries.title, sourceHash: entries.sourceHash }).from(entries)
        .innerJoin(rootTopic, rootTopicOn())
        .where(and(visibleWithTopic(), sql`${entries.sourceHash} is not null`, sql`${entries.lang} <> ${lang}`,
          sql`not exists (select 1 from ${jobs} where ${jobs.kind} in ('translate_entry', 'translate_title') and ${jobs.payload}->>'entryId' = ${entries.id}::text and ${jobs.payload}->>'lang' = ${lang} and ${jobs.payload}->>'sourceHash' = ${entries.sourceHash})`,
          sql`(not exists (select 1 from ${translations} where ${translations.entryId} = ${entries.id} and ${translations.lang} = ${lang} and ${translations.sourceHash} = ${entries.sourceHash} and ${translations.field} = 'body' and ${translations.kind} in ('primary', 'human'))
            or (${entries.kind} = 'topic' and coalesce(${entries.title}, '') <> '' and not exists (select 1 from ${translations} where ${translations.entryId} = ${entries.id} and ${translations.lang} = ${lang} and ${translations.sourceHash} = ${entries.sourceHash} and ${translations.field} = 'title' and ${translations.kind} in ('primary', 'human'))))`))
        .orderBy(asc(entries.id)).limit(limit - count).for("share", { of: entries });
      for (const entry of candidates) {
        if (!entry.sourceHash || await getMonthlyCostMicro(tx, now) >= monthlyBudgetMicro(env)) break;
        const payload = { entryId: entry.id, sourceHash: entry.sourceHash, lang };
        if (entry.kind === "topic" && entry.title?.trim()) await enqueueTitleTranslation(tx, payload, entry.lang, { priority: 5 });
        const queued = await enqueue(tx, TRANSLATE_JOB, payload, { dedupeKey: translateDedupeKey(payload, entry.lang), maxAttempts: TRANSLATE_MAX_ATTEMPTS, priority: 5 });
        if (queued.created) count++;
      }
    });
  }
  return count;
}
