import { withMarkdownPersistedRead } from "./markdown-budget.server";
import { and, desc, eq, inArray, isNull, lt, ne, or, sql, type SQL } from "drizzle-orm";
import type { Db } from "~/lib/db/client.server";
import { entries, translations } from "~/lib/db/schema";
import { renderEntryHtml, renderTranslationHtml } from "~/lib/entries.server";
import { DeferJob, enqueue, type JobHandler, type JobHandlers } from "~/lib/jobs/queue.server";
import { RENDER_VERSION } from "~/lib/markdown.server";
import { resolveSavedMentionsFor, resolveTranslationMentionsFor } from "~/lib/mentions.server";

// Rebuilding the saved renders: when RENDER_VERSION goes up, every saved html (the posts, and the translations that are shown) is out of date and is
// drawn again the next time it is viewed. A list shows twenty cards at once, so without this the first reader after a deploy would wait for twenty renders. The rebuild runs first,
// newest topics first (the ones a list shows), as a job of the worker (queued at the start of the worker) or as the script `pnpm render:rebuild`. It only renders: no API is called.
// The page-view fallback (viewWithHtml, translationRender) stays for a page opened before the rebuild reaches it.

export const REBUILD_RENDER_CACHE_JOB = "rebuild_render_cache";
export const renderCacheDedupeKey = (version: number = RENDER_VERSION) => `render-cache:${version}`;
// How many rows one run of the job rebuilds: the rest is queued again, so that translation jobs are not held up behind a long rebuild.
export const REBUILD_JOB_MAX_ROWS = 200;
export const REBUILD_ROWS_PER_JOB_RUN = REBUILD_JOB_MAX_ROWS;
const DEFAULT_BATCH = 50;

// Not deleted, and not at the current version (or never rendered).
const staleEntry = (): SQL => and(isNull(entries.deletedAt), or(isNull(entries.html), ne(entries.htmlVersion, RENDER_VERSION)))!;
// The translations a reader can be shown: the body of a post, by the machine (primary) or by a person (human). The second system (secondary, only for measuring) is never shown. A title has no html.
const staleTranslation = (): SQL =>
  and(
    eq(translations.field, "body"),
    inArray(translations.kind, ["primary", "human"]),
    isNull(entries.deletedAt),
    or(isNull(translations.html), ne(translations.htmlVersion, RENDER_VERSION)),
  )!;

// How many rows are at a different version from RENDER_VERSION: the posts that are not deleted, and the translations that are shown.
export async function countStaleRenderCache(db: Db): Promise<{ entries: number; translations: number }> {
  const [e] = await db.select({ n: sql<number>`count(*)::int` }).from(entries).where(staleEntry());
  const [t] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(translations)
    .innerJoin(entries, eq(entries.id, translations.entryId))
    .where(staleTranslation());
  return { entries: Number(e.n), translations: Number(t.n) };
}

type Cursor = { at: string; id: number } | null;
const before = (cursor: Cursor, at: SQL, id: SQL): SQL | undefined =>
  cursor === null ? undefined : or(sql`${at} < ${cursor.at}::timestamptz`, and(sql`${at} = ${cursor.at}::timestamptz`, lt(id, cursor.id)));

// Preserve PostgreSQL microseconds in the cursor; a JavaScript Date would skip rows sharing a finer timestamp.
type EntryRow = { id: number; kind: string; lang: string; body: string; sourceHash: string | null; mentionRevision: number; createdAt: string };
type TranslationSource = { entryId: number; source: string; sourceHash: string | null; mentionRevision?: number; translationSourceHash: string | null; translationMentionRevision?: number | null };
type TranslationRow = TranslationSource & { id: number; lang: string; kind: string; text: string; createdAt: string };

async function readEntries(db: Db, kind: "topic" | "reply", cursor: Cursor, limit: number): Promise<EntryRow[]> {
  return db
    .select({ id: entries.id, kind: entries.kind, lang: entries.lang, body: entries.body, sourceHash: entries.sourceHash, mentionRevision: entries.mentionRevision, createdAt: sql<string>`${entries.createdAt}::text` })
    .from(entries)
    .where(and(staleEntry(), eq(entries.kind, kind), before(cursor, sql`${entries.createdAt}`, sql`${entries.id}`)))
    .orderBy(desc(entries.createdAt), desc(entries.id))
    .limit(limit);
}

async function readTranslations(db: Db, kind: "topic" | "reply", cursor: Cursor, limit: number): Promise<TranslationRow[]> {
  return db
    .select({ id: translations.id, entryId: translations.entryId, lang: translations.lang, kind: translations.kind, text: translations.text, createdAt: sql<string>`${entries.createdAt}::text`, source: entries.body, sourceHash: entries.sourceHash, mentionRevision: entries.mentionRevision, translationSourceHash: translations.sourceHash, translationMentionRevision: translations.mentionRevision })
    .from(translations)
    .innerJoin(entries, eq(entries.id, translations.entryId))
    .where(and(staleTranslation(), eq(entries.kind, kind), before(cursor, sql`${entries.createdAt}`, sql`${translations.id}`)))
    .orderBy(desc(entries.createdAt), desc(translations.id))
    .limit(limit);
}

// The guarded saves (also what the page-view fallback does): write only if the text is still the one that was rendered. Returns whether the row was written.
export async function saveRenderedEntry(db: Db, id: number, readBody: string, rendered: { html: string; cardHtml: string | null; cacheable?: boolean }, sourceHash?: string | null, mentionRevision?: number): Promise<boolean> {
  if (rendered.cacheable === false) return false;
  const saved = await db
    .update(entries)
    .set({ html: rendered.html, cardHtml: rendered.cardHtml, htmlVersion: RENDER_VERSION })
    .where(and(eq(entries.id, id), eq(entries.body, readBody), isNull(entries.deletedAt), sourceHash === undefined ? undefined : sql`${entries.sourceHash} IS NOT DISTINCT FROM ${sourceHash}`, mentionRevision === undefined ? undefined : eq(entries.mentionRevision, mentionRevision)))
    .returning({ id: entries.id });
  return saved.length > 0;
}

export async function saveRenderedTranslation(db: Db, id: number, readText: string, rendered: { html: string; cardHtml: string | null; cacheable?: boolean }, source?: TranslationSource): Promise<boolean> {
  if (rendered.cacheable === false) return false;
  return db.transaction(async tx => {
    const entryId = source?.entryId ?? (await tx.select({ entryId: translations.entryId }).from(translations).where(eq(translations.id, id)))[0]?.entryId;
    if (entryId === undefined) return false;
    // Lock the source before the translation, like an edit. An EXISTS in the translation UPDATE can retain the old MVCC snapshot after waiting for an edit's translation lock.
    const [current] = await tx.select({ body: entries.body, sourceHash: entries.sourceHash, mentionRevision: entries.mentionRevision, deletedAt: entries.deletedAt }).from(entries).where(eq(entries.id, entryId)).for("share");
    if (!current || current.deletedAt !== null) return false;
    if (source && (current.body !== source.source || current.sourceHash !== source.sourceHash)) return false;
    if (source?.mentionRevision !== undefined && current.mentionRevision !== source.mentionRevision) return false;
    const saved = await tx.update(translations)
      .set({ html: rendered.html, cardHtml: rendered.cardHtml, htmlVersion: RENDER_VERSION })
      .where(and(eq(translations.id, id), eq(translations.entryId, entryId), eq(translations.text, readText), source === undefined ? undefined : sql`${translations.sourceHash} IS NOT DISTINCT FROM ${source.translationSourceHash}`, source?.translationMentionRevision === undefined ? undefined : sql`${translations.mentionRevision} IS NOT DISTINCT FROM ${source.translationMentionRevision}`))
      .returning({ id: translations.id });
    return saved.length > 0;
  });
}

// Draws the rows at another version again and saves them, newest topics first: the topics, then the translations of topics (what a card shows), then the replies and their translations.
// Each save is guarded like the page-view one: it writes only if the text is still the one that was read (UPDATE ... WHERE id = $id AND body = $read), so a post that is edited while
// it is being rendered is not overwritten with the html of the old body. Rendering holds no locks; a translation save briefly locks its source before updating the translation. An interrupted run is
// continued by the next one (a saved row is no longer at another version). maxRows limits the rows of one call (the default: all of them); batchSize is how many are read at a time.
// `remaining` is counted at the end (rows that were being edited and were skipped are rebuilt by that edit itself).
async function rebuildRenderCacheImplementation(
  db: Db,
  opts: { batchSize?: number; maxRows?: number } = {},
): Promise<{ entries: number; translations: number; remaining: number }> {
  const batchSize = Math.max(1, opts.batchSize ?? DEFAULT_BATCH);
  let budget = opts.maxRows ?? Number.POSITIVE_INFINITY;
  let rebuiltEntries = 0;
  let rebuiltTranslations = 0;

  // The cursor walks down (created_at, id) within one call, so a row that cannot be saved (it was edited while it was rendered) is not read again in a loop.
  for (const kind of ["topic", "reply"] as const) {
    let cursor: Cursor = null;
    while (budget > 0) {
      const rows = await readEntries(db, kind, cursor, Math.min(batchSize, budget));
      if (rows.length === 0) break;
      const saved = await resolveSavedMentionsFor(db, rows);
      for (const row of rows) {
        const mentions = saved.get(row.id) ?? new Map();
        if (await saveRenderedEntry(db, row.id, row.body, (await renderEntryHtml(kind, row.id, row.body, row.lang, mentions)), row.sourceHash, row.mentionRevision)) rebuiltEntries++;
        budget--;
      }
      cursor = { at: rows[rows.length - 1].createdAt, id: rows[rows.length - 1].id };
    }

    // The translations of this kind of post.
    let tCursor: Cursor = null;
    while (budget > 0) {
      const rows = await readTranslations(db, kind, tCursor, Math.min(batchSize, budget));
      if (rows.length === 0) break;
      const saved = await resolveTranslationMentionsFor(db, rows.map(row => ({ id: row.id, entryId: row.entryId, sourceHash: row.translationSourceHash, mentionRevision: row.translationMentionRevision ?? null })));
      for (const row of rows) {
        const mentions = saved.get(row.id) ?? new Map();
        if (await saveRenderedTranslation(db, row.id, row.text, (await renderTranslationHtml(kind, row.entryId, row.lang, row.text, mentions, row.kind === "primary")), row)) rebuiltTranslations++;
        budget--;
      }
      tCursor = { at: rows[rows.length - 1].createdAt, id: rows[rows.length - 1].id };
    }
  }

  const left = await countStaleRenderCache(db);
  return { entries: rebuiltEntries, translations: rebuiltTranslations, remaining: left.entries + left.translations };
}

// Queues the rebuild if some row is at another version. Called once when the worker starts (once per process). One job at a time per version (dedupe key). Returns whether a job was queued.
export async function queueRenderRebuildIfStale(db: Db): Promise<boolean> {
  const stale = await countStaleRenderCache(db);
  if (stale.entries + stale.translations === 0) return false;
  return (await enqueue(db, REBUILD_RENDER_CACHE_JOB, { version: RENDER_VERSION }, { dedupeKey: renderCacheDedupeKey() })).created;
}

export function createRenderCacheHandlers(): JobHandlers {
  const rebuild: JobHandler = async (_job, ctx) => {
    const result = await rebuildRenderCache(ctx.db, { maxRows: REBUILD_JOB_MAX_ROWS });
    const done = result.entries + result.translations;
    if (done > 0) console.log(`[render-cache] rebuilt ${result.entries} post(s) and ${result.translations} translation(s); ${result.remaining} left`);
    // Reuse the same job and dedupe key without consuming an attempt. A run that saved nothing stops instead of spinning on rows being edited.
    if (result.remaining > 0 && done > 0) {
      throw new DeferJob(new Date(ctx.now.getTime() + 1000), "render cache rows left");
    }
  };
  return { [REBUILD_RENDER_CACHE_JOB]: rebuild };
}

export function rebuildRenderCache(...args: Parameters<typeof rebuildRenderCacheImplementation>): ReturnType<typeof rebuildRenderCacheImplementation> {
  return withMarkdownPersistedRead(() => rebuildRenderCacheImplementation(...args));
}
