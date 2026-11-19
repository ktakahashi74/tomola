import { and, asc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import type { Db } from "./db/client.server";
import { entries, translations } from "./db/schema";
import { isStale } from "./display";
import { loadPickedTranslations, type DisplayInput, type PickedTranslations } from "./entry-display.server";
import { availabilityKey, loadTranslationAvailability } from "./translation-availability.server";
import { getBudgetStatus } from "./llm/usage.server";
import { translationEstimate } from "./llm/metering.server";
import { primaryEngineId, primaryModelOf } from "./llm/config.server";
import { readPostTranslationWait } from "./translation-wait.server";
import { translationWaitForAvailability } from "./translation-wait";
import { enqueueCurrentBodyTranslation } from "./translations.server";
import type { Lang } from "./languages";
import { checkPagination, pageCount, REPLIES_PER_PAGE } from "./pagination";
import type { StanceTag } from "./stances";
import { readThreadReplyPage } from "./thread-page.server";
import { publicTopicPlace } from "./visibility.server";

export const TRANSLATION_READ_BATCH_MAX = 101; // A topic and its page of 100 replies.
export const TRANSLATION_READ_MEMBER_HOURLY = 300;
export const TRANSLATION_READ_IP_HOURLY = 120;
// Status checks back off throughout the wait. Display reports share this limit.
export const TRANSLATION_READ_CALLS_HOURLY = 3600;

// Match the thread's page boundaries, including deleted and hidden reply slots
// in unfiltered pages, without loading or rendering any post content.
export async function translationPageInputs(db: Db, threadId: number, opts: { page?: number; stanceTag?: StanceTag } = {}): Promise<DisplayInput[] | null> {
  const paging = checkPagination(opts, REPLIES_PER_PAGE);
  const columns = { id: entries.id, kind: entries.kind, lang: entries.lang, sourceHash: entries.sourceHash };
  const [topic] = await db.select(columns).from(entries)
    .where(and(eq(entries.id, threadId), eq(entries.kind, "topic"), isNull(entries.deletedAt), isNull(entries.hiddenAt), publicTopicPlace()));
  if (!topic) return null;
  const { replies, replyTotal } = await readThreadReplyPage(db, threadId, paging, columns, opts);
  if (paging.page > pageCount(replyTotal, paging.limit)) return null;
  return [topic, ...replies.filter(row => row.visibility === "visible")]
    .map(row => ({ id: row.id, kind: row.kind as DisplayInput["kind"], lang: row.lang as Lang, sourceHash: row.sourceHash }));
}

function hasCurrentBody(entry: DisplayInput, picked: PickedTranslations | undefined): boolean {
  const body = picked?.body;
  return !!body && body.sourceHash === entry.sourceHash && !isStale(body.flags);
}

// Call with only the readable posts of this page. Source locks make enqueueing
// atomic with edits/deletion. Each post still gets its own deduplicated job.
export async function requestBodyTranslations(db: Db, inputs: readonly DisplayInput[], lang: Lang, requestWork: boolean) {
  const picked = await loadPickedTranslations(db, inputs, lang, ["body"]);
  const ready = inputs.filter(e => e.lang === lang || hasCurrentBody(e, picked.get(e.id))).map(e => e.id);
  const missing = inputs.filter(e => !ready.includes(e.id));
  const availability = await loadTranslationAvailability(db, missing, [lang], undefined, { currentOnly: true });
  const unavailable = missing.filter(e => availability.get(availabilityKey(e.id, lang)) === "unavailable").map(e => e.id);
  const wait = await readPostTranslationWait(async () => db);
  let stopped = missing.length > 0 && wait.kind === "stopped";
  const paused = missing.filter(e => availability.get(availabilityKey(e.id, lang)) !== "unavailable" &&
    translationWaitForAvailability(wait, availability.get(availabilityKey(e.id, lang))).kind === "stopped").map(e => e.id);
  if (requestWork && !stopped) {
    const wanted = new Map(missing.filter(e => !unavailable.includes(e.id) && !paused.includes(e.id)).map(e => [e.id, e]));
    if (wanted.size) {
      stopped = await db.transaction(async tx => {
        // Use a consistent lock order for overlapping requests and source edits.
        const rows = await tx.select({ id: entries.id, sourceHash: entries.sourceHash, lang: entries.lang, body: entries.body, mentionRevision: entries.mentionRevision }).from(entries)
          .where(and(inArray(entries.id, [...wanted.keys()]), isNull(entries.deletedAt), isNull(entries.hiddenAt)))
          .orderBy(asc(entries.id)).for("no key update");
        const current = rows.flatMap(row => {
          const input = wanted.get(row.id);
          return input && row.sourceHash && row.sourceHash === input.sourceHash && row.lang === input.lang
            ? [{ input, row: { ...row, sourceHash: row.sourceHash } }] : [];
        });
        const found = await loadPickedTranslations(tx, current.map(({ input }) => input), lang, ["body"]);
        const pending = current.filter(({ input }) => !hasCurrentBody(input, found.get(input.id)));
        if (!pending.length) return false;

        // Use one settled-cost snapshot. Each post is eligible against the same
        // remaining amount. Workers reserve the cost of each actual model call.
        const budget = await getBudgetStatus(tx);
        if (budget.state === "stopped") return true;
        const engine = primaryEngineId();
        const model = primaryModelOf();
        for (const { input, row } of pending) {
          const estimate = translationEstimate(engine, model, { text: row.body, from: input.lang, to: lang, field: "body" });
          if (budget.usedMicro + estimate > budget.budgetMicro) paused.push(row.id);
          else await enqueueCurrentBodyTranslation(tx, row, lang, { priority: 1 });
        }
        return false;
      });
    }
  }
  return { ready, unavailable, paused, stopped };
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
