import { and, asc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import type { Db } from "./db/client.server";
import { entries, jobs, translations } from "./db/schema";
import { isStale } from "./display";
import { loadPickedTranslations, type DisplayInput } from "./entry-display.server";
import { availabilityKey, loadTranslationAvailability } from "./translation-availability.server";
import { getBudgetStatus } from "./llm/usage.server";
import { translationEstimate } from "./llm/metering.server";
import { primaryEngineId, primaryModelOf } from "./llm/config.server";
import { readPostTranslationWait } from "./translation-wait.server";
import { enqueue } from "./jobs/queue.server";
import { TRANSLATE_JOB, TRANSLATE_MAX_ATTEMPTS, translateDedupeKey } from "./translations.server";
import type { Lang } from "./languages";
import { checkPagination, pageCount, REPLIES_PER_PAGE } from "./pagination";
import type { StanceTag } from "./stances";
import { publicTopicPlace } from "./visibility.server";

export const TRANSLATION_READ_BATCH_MAX = 101; // A topic and its page of 100 replies.
export const TRANSLATION_READ_MEMBER_HOURLY = 300;
export const TRANSLATION_READ_IP_HOURLY = 120;
// At most 40 status calls per two-minute wait, plus batched display reports.
export const TRANSLATION_READ_CALLS_HOURLY = 3600;

// Match the thread's page boundaries, including deleted and hidden reply slots
// in unfiltered pages, without loading or rendering any post content.
export async function translationPageInputs(db: Db, threadId: number, opts: { page?: number; stanceTag?: StanceTag } = {}): Promise<DisplayInput[] | null> {
  const { page, limit, offset } = checkPagination(opts, REPLIES_PER_PAGE);
  const replyFilter = and(eq(entries.threadId, threadId), eq(entries.kind, "reply"),
    opts.stanceTag ? and(eq(entries.stanceTag, opts.stanceTag), isNull(entries.deletedAt), isNull(entries.hiddenAt)) : undefined);
  const columns = { id: entries.id, kind: entries.kind, lang: entries.lang, sourceHash: entries.sourceHash };
  const [topic] = await db.select({ ...columns, replyTotal: db.$count(entries, replyFilter) }).from(entries)
    .where(and(eq(entries.id, threadId), eq(entries.kind, "topic"), isNull(entries.deletedAt), isNull(entries.hiddenAt), publicTopicPlace()));
  if (!topic || page > pageCount(topic.replyTotal, limit)) return null;
  const replies = await db.select({ ...columns, deletedAt: entries.deletedAt, hiddenAt: entries.hiddenAt }).from(entries)
    .where(replyFilter).orderBy(asc(entries.createdAt), asc(entries.id)).offset(offset).limit(limit);
  return [topic, ...replies.filter(row => row.deletedAt === null && row.hiddenAt === null)]
    .map(row => ({ id: row.id, kind: row.kind as DisplayInput["kind"], lang: row.lang as Lang, sourceHash: row.sourceHash }));
}

// Call with only the readable posts of this page. Source locks make enqueueing
// atomic with edits/deletion. Unfinished work stays deduplicated; remembering
// the requested revision lets restored text retain one necessary rerun.
export async function requestBodyTranslations(db: Db, inputs: readonly DisplayInput[], lang: Lang, requestWork: boolean) {
  const picked = await loadPickedTranslations(db, inputs, lang, ["body"]);
  const ready = inputs.filter(e => {
    const body = picked.get(e.id)?.body;
    return e.lang === lang || (body && body.sourceHash === e.sourceHash && !isStale(body.flags));
  }).map(e => e.id);
  const missing = inputs.filter(e => !ready.includes(e.id));
  const availability = await loadTranslationAvailability(db, missing, [lang], undefined, { currentOnly: true });
  const unavailable = missing.filter(e => availability.get(availabilityKey(e.id, lang)) === "unavailable").map(e => e.id);
  let stopped = missing.length > 0 && (await readPostTranslationWait(async () => db)).kind === "stopped";
  if (requestWork && !stopped) {
    for (const entry of missing.filter(e => !unavailable.includes(e.id)).sort((a, b) => a.id - b.id)) {
      await db.transaction(async tx => {
        const [current] = await tx.select({ sourceHash: entries.sourceHash, lang: entries.lang, body: entries.body, mentionRevision: entries.mentionRevision }).from(entries)
          .where(and(eq(entries.id, entry.id), isNull(entries.deletedAt), isNull(entries.hiddenAt))).for("no key update");
        if (!current?.sourceHash || current.sourceHash !== entry.sourceHash || current.lang !== entry.lang) return;
        const found = (await loadPickedTranslations(tx, [entry], lang, ["body"])).get(entry.id)?.body;
        if (found && found.sourceHash === entry.sourceHash && !isStale(found.flags)) return;
        const budget = await getBudgetStatus(tx);
        const estimate = translationEstimate(primaryEngineId(), primaryModelOf(), { text: current.body, from: entry.lang, to: lang, field: "body" });
        if (budget.state === "stopped" || budget.usedMicro + estimate > budget.budgetMicro) { stopped = true; return; }
        const payload = { entryId: entry.id, lang, sourceHash: entry.sourceHash!, readRevision: current.mentionRevision };
        const dedupeKey = translateDedupeKey(payload, entry.lang);
        const [existing] = await tx.select({ status: jobs.status, payload: jobs.payload }).from(jobs)
          .where(and(eq(jobs.dedupeKey, dedupeKey), inArray(jobs.status, ["queued", "running"])));
        // Identical text can return with different mention bindings. Keep one
        // rerun for that revision; repeated readers of the same revision do not
        // reschedule it. The queue locks a running job before changing run_at.
        const revision = (existing?.payload as { readRevision?: number } | undefined)?.readRevision;
        await enqueue(tx, TRANSLATE_JOB, payload, { dedupeKey, priority: 1, maxAttempts: TRANSLATE_MAX_ATTEMPTS,
          rescheduleRunning: existing?.status === "running" && revision !== current.mentionRevision });
        await tx.update(jobs).set({ priority: sql`least(${jobs.priority}, 1)`,
          payload: sql`${jobs.payload} || ${JSON.stringify({ readRevision: current.mentionRevision })}::jsonb` })
          .where(and(eq(jobs.dedupeKey, dedupeKey), inArray(jobs.status, ["queued", "running"])));
      });
    }
  }
  return { ready, unavailable, stopped };
}

// Only rows actually selectable on this page may be marked. Updating nulls in
// one statement makes concurrent reports preserve the first timestamp.
export async function markTranslationsSeen(db: Db, inputs: readonly DisplayInput[], lang: Lang, ids: readonly number[], viewerId: string | null, now = new Date()): Promise<number> {
  if (!ids.length || !inputs.length) return 0;
  const picked = await loadPickedTranslations(db, inputs, lang);
  const allowed = new Set([...picked.values()].flatMap(row => [row.body, row.title, row.bodyOlder, row.titleOlder])
    .filter(row => row !== null).map(row => row!.id));
  const wanted = [...new Set(ids)].filter(id => allowed.has(id));
  if (!wanted.length) return 0;
  return db.transaction(async tx => {
    const updated = await tx.update(translations).set({ firstSeenAt: now })
      .where(and(inArray(translations.id, wanted), isNull(translations.firstSeenAt)))
      .returning({ id: translations.id });
    // A writer's first display still records the timestamp. A later reader may
    // set lifetime reach independently; only compare identity, never store it.
    await tx.update(translations).set({ everSeen: true })
      .where(and(inArray(translations.id, wanted), eq(translations.everSeen, false),
        viewerId === null ? undefined : inArray(translations.entryId, tx.select({ id: entries.id }).from(entries).where(ne(entries.authorId, viewerId)))));
    return updated.length;
  });
}

export async function translationReadStats(db: Db) {
  const kind = sql<string>`case when ${entries.kind} = 'reply' then 'reply' when ${entries.title} is null then 'short_post' else 'topic' end`;
  return db.select({ sourceLang: entries.lang, targetLang: translations.lang, kind,
    total: sql<number>`count(*)::int`, seen: sql<number>`count(${translations.firstSeenAt})::int`,
    percent: sql<number>`round(100.0 * count(${translations.firstSeenAt}) / count(*), 2)::float8` })
    .from(translations).innerJoin(entries, eq(entries.id, translations.entryId))
    .where(and(eq(translations.field, "body"), inArray(translations.kind, ["primary", "human"])))
    .groupBy(entries.lang, translations.lang, kind).orderBy(entries.lang, translations.lang, kind);
}
