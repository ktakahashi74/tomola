import { loadDisplayNames, selectDisplayName } from "./display-names.server";
import { publicTopicPlace } from "~/lib/visibility.server";
import { retainedAuthorColumn } from "./deleted-member.server";
import { replyPagesOf } from "~/lib/reply-pages.server";
import { and, eq, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "~/lib/db/client.server";
import { entries, entryEmbeddings, profiles } from "~/lib/db/schema";
import { isStale, wantsTranslation, type ShownKind } from "~/lib/display";
import { loadPickedTranslations, loadTopicLineTranslations, topicLine } from "~/lib/entry-display.server";
import { replyLocationAt } from "~/lib/entries.server";
import type { Lang } from "~/lib/languages";
import { embed, resolveEmbeddingEngine, type LlmOptions } from "~/lib/llm/index.server";
import { plainExcerpt } from "~/lib/plain-text.server";
import { availabilityKey, loadTranslationAvailability } from "~/lib/translation-availability.server";
import { FLAG_STRUCTURE_MISMATCH } from "~/lib/llm/flags";

// Multilingual semantic search: embed query with the posting model (task=query), then return cosine-nearest entry_embeddings,
// up to SEARCH_LIMIT. Multilingual embeddings find other-language posts from any query language.
// Exclude deleted/hidden posts and replies to deleted/hidden topics, preventing title exposure. Those posts lack embeddings, but verify again here.
// Use display rules (app/lib/display.ts) for titles/excerpts: original if its language is readable or the display language;
// otherwise display-language translation if available, or original with 「翻訳待ち」.
// HNSW finds candidates before model/deletion filters. Iterative scanning (hnsw.iterative_scan in findSimilar)
// avoids underfilling 20 results with hidden/old-model candidates. Return fewer only when fewer than 20 eligible rows exist overall.

export const SEARCH_LIMIT = 20;
// Cosine distance above which a post is not a result (nothing is "close"). A post whose title contains the query as written is kept and listed first whatever its distance.
// The number is a first estimate for the production embedding model and has not been measured on real posts; with the fake model of the tests it only removes the unrelated.
export const SEARCH_MAX_DISTANCE = 0.7;
export { checkQuery, MAX_QUERY_LENGTH, type QueryCheck } from "~/lib/search";
const EXCERPT_CHARS = 200;

export type SearchTranslation = { kind: ShownKind; engine: string | null; model: string | null; fallback: boolean; stale: boolean; structureMismatch?: boolean };

export type SearchHit = {
  id: number;
  createdAt: Date;
  kind: "topic" | "reply";
  threadId: number;
  lang: Lang;
  authorHandle: string | null;
  authorName?: string | null;
  // Cosine distance: 0 same direction, 2 opposite.
  distance: number;
  // The title of the topic (for a reply, the title of the topic of its thread); the translation in the display language if there is one. For a topic without a title, the beginning of its body (fromBody; the same rule as loadTitleDisplays).
  title: { text: string; lang: Lang; translation: SearchTranslation | null; pending: boolean; fromBody: boolean };
  // Post-body excerpt, using display-language translation when available.
  excerpt: { text: string; lang: Lang; translation: SearchTranslation | null; pending: boolean; unavailable?: boolean };
  // Human page URL; replies include page/anchor.
  href: string;
};

export type SearchFound = {
  id: number;
  createdAt: Date;
  kind: string;
  threadId: number;
  lang: string;
  title: string | null;
  body: string;
  sourceHash: string | null;
  authorHandle: string | null;
  distance: number;
  topicTitle: string | null;
  // The body of the topic (only for a topic without a title; null otherwise). Used to make the heading of a result for a topic without a title (the beginning of the body).
  topicBody: string | null;
  topicLang: string;
  topicSourceHash: string | null;
};

// Top limit visible, undeleted posts by similarity.
export async function findSimilar(db: Db, vector: readonly number[], model: string, limit: number = SEARCH_LIMIT): Promise<SearchFound[]> {
  const topic = alias(entries, "topic");
  const literal = JSON.stringify(vector);
  // HNSW first retrieves ef_search candidates (default 40), then filters models/deletions. Old-model or
  // hidden-topic neighbors can leave fewer than 20. pgvector 0.8 hnsw.iterative_scan continues scanning more candidates until enough pass.
  // relaxed_order can slightly disorder results; outer query re-sorts distance ascending.
  // Settings are transaction-local (set local). No-op on pgvector versions lacking the setting, where current_setting is null.
  return db.transaction(async (tx) => {
    const present = (await tx.execute(sql`select current_setting('hnsw.iterative_scan', true) as v`)) as unknown as { rows: Array<{ v: string | null }> };
    if (present.rows[0]?.v != null) await tx.execute(sql`set local hnsw.iterative_scan = relaxed_order`);
    const distance = sql<number>`${entryEmbeddings.embedding} <=> ${literal}::vector`;
    const nearest = tx
      .select({
        id: entries.id,
        createdAt: entries.createdAt,
        kind: entries.kind,
        threadId: sql<number>`coalesce(${entries.threadId}, ${entries.id})`.as("thread_id"),
        lang: entries.lang,
        title: entries.title,
        body: entries.body,
        sourceHash: entries.sourceHash,
        authorHandle: retainedAuthorColumn(entries.authorId),
        distance: distance.as("distance"),
        // Alias topic columns to avoid duplicate subquery names.
        topicTitle: sql<string | null>`${topic.title}`.as("topic_title"),
        topicBody: sql<string | null>`case when ${topic.title} is null then ${topic.body} end`.as("topic_body"),
        topicLang: sql<string>`${topic.lang}`.as("topic_lang"),
        topicSourceHash: sql<string | null>`${topic.sourceHash}`.as("topic_source_hash"),
      })
      .from(entryEmbeddings)
      .innerJoin(entries, eq(entries.id, entryEmbeddings.entryId))
      .innerJoin(topic, eq(topic.id, sql`coalesce(${entries.threadId}, ${entries.id})`))
      .leftJoin(profiles, eq(profiles.userId, entries.authorId))
      .where(and(eq(entryEmbeddings.model, model), isNull(entries.deletedAt), isNull(entries.hiddenAt), isNull(topic.deletedAt), isNull(topic.hiddenAt), publicTopicPlace(topic)))
      .orderBy(distance)
      .limit(limit)
      .as("nearest");
    const rows = await tx.select().from(nearest).orderBy(nearest.distance);
    return rows.map((r) => ({ ...r, threadId: Number(r.threadId), distance: Number(r.distance) }));
  });
}

export type SearchOptions = {
  readLangs: readonly Lang[];
  displayLang: Lang;
  // Carry result-link ?lang= for this page's display-language override.
  carryLang?: string | null;
  limit?: number;
  llm?: LlmOptions;
};

// Scripts written without spaces between words: a query in them is matched anywhere in a title.
const SPACELESS = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;

// Does the title of a post hold the query as written? Languages with spaces between words match on word edges ("ai" is in "AI safety", not in "said"); the others match anywhere.
export function titleHoldsQuery(title: string | null, needle: string): boolean {
  if (!title || needle === "") return false;
  const text = title.toLocaleLowerCase();
  if (SPACELESS.test(needle)) return text.includes(needle);
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "u").test(text);
}

// Keep what is close (SEARCH_MAX_DISTANCE) and the topics whose own title has the query as written; the latter come first, each group in the order of distance.
// A reply is not lifted by the title of the topic it belongs to.
export function closeResults(found: readonly SearchFound[], query: string): SearchFound[] {
  const needle = query.trim().toLocaleLowerCase();
  const literal = (row: SearchFound) => row.kind === "topic" && titleHoldsQuery(row.title, needle);
  const kept = found.filter(row => row.distance <= SEARCH_MAX_DISTANCE || literal(row));
  return [...kept.filter(literal), ...kept.filter(row => !literal(row))];
}

// Embed a checkQuery-validated query and find similar posts without display rules; twins expose originals.
// Stopped budget throws BudgetPausedError; engine failure throws LlmError. Caller shows temporary search unavailability.
export async function searchFound(db: Db, query: string, opts: { limit?: number; llm?: LlmOptions } = {}): Promise<SearchFound[]> {
  const engine = opts.llm?.embeddingEngine ?? resolveEmbeddingEngine(opts.llm?.env);
  const out = await embed(db, { text: query, task: "query" }, { ...opts.llm, embeddingEngine: engine });
  return closeResults(await findSimilar(db, out.vector, engine.model, opts.limit ?? SEARCH_LIMIT), query);
}

// Search and apply reader display-language rules for the screen.
export async function searchEntries(db: Db, query: string, opts: SearchOptions): Promise<SearchHit[]> {
  return toHits(db, await searchFound(db, query, { limit: opts.limit, llm: opts.llm }), opts, true);
}

const asTranslation = (row: { kind: ShownKind; engine: string | null; model: string | null; fallback: boolean; flags: string[] }): SearchTranslation => ({
  kind: row.kind,
  engine: row.engine,
  model: row.model,
  fallback: row.fallback,
  stale: isStale(row.flags),
  ...(row.flags.includes(FLAG_STRUCTURE_MISMATCH) ? { structureMismatch: true } : {}),
});

// Apply display rules with batched translation-row reads for result posts and their thread topics.
export async function toHits(db: Db, found: readonly SearchFound[], opts: Pick<SearchOptions, "readLangs" | "displayLang" | "carryLang">, typeset = false): Promise<SearchHit[]> {
  if (found.length === 0) return [];
  const names = await loadDisplayNames(db, found.map(f => f.authorHandle));
  const bodyInputs = found.map((f) => ({ id: f.id, kind: f.kind as "topic" | "reply", lang: f.lang as Lang, sourceHash: f.sourceHash }));
  const topics = [...new Map(found.map((f) => [f.threadId, { id: f.threadId, kind: "topic" as const, lang: f.topicLang as Lang, sourceHash: f.topicSourceHash, title: f.topicTitle, body: f.topicBody ?? undefined }])).values()];
  const [pages, bodies, lines] = await Promise.all([
    replyPagesOf(db, found.filter(f => f.kind === "reply")),
    loadPickedTranslations(db, bodyInputs, opts.displayLang, ["body"]),
    // The line of a thread's topic: its title, or (without a title) the beginning of its body. The same rule as loadTitleDisplays.
    loadTopicLineTranslations(db, topics, opts.displayLang),
  ]);
  const availability = await loadTranslationAvailability(db, [
    ...bodyInputs.filter(e => !bodies.get(e.id)?.body && wantsTranslation(e.lang, opts.readLangs, opts.displayLang)),
    ...topics.filter(e => !lines.get(e.id)?.hasBody && wantsTranslation(e.lang, opts.readLangs, opts.displayLang)),
  ], [opts.displayLang]);
  return Promise.all(
    found.map(async (f): Promise<SearchHit> => {
      const bodyWants = wantsTranslation(f.lang, opts.readLangs, opts.displayLang);
      const bodyRow = bodies.get(f.id)?.body ?? null;
      const showBody = bodyWants && bodyRow !== null;
      const line = (await topicLine({ id: f.threadId, lang: f.topicLang as Lang, title: f.topicTitle, body: f.topicBody ?? undefined }, lines.get(f.threadId), wantsTranslation(f.topicLang, opts.readLangs, opts.displayLang), opts.displayLang, typeset));
      return {
        id: f.id,
        createdAt: f.createdAt,
        kind: f.kind as "topic" | "reply",
        threadId: f.threadId,
        lang: f.lang as Lang,
        authorHandle: f.authorHandle,
        authorName: selectDisplayName(names.get(f.authorHandle ?? "")),
        distance: f.distance,
        title: { text: line.text, lang: line.lang, translation: line.row ? asTranslation(line.row) : null, pending: line.pending && availability.get(availabilityKey(f.threadId, opts.displayLang)) !== "unavailable", fromBody: line.fromBody },
        excerpt: showBody
          ? { text: (await plainExcerpt(bodyRow.text, EXCERPT_CHARS)), lang: opts.displayLang, translation: asTranslation(bodyRow), pending: false }
          : { text: (await plainExcerpt(f.body, EXCERPT_CHARS)), lang: f.lang as Lang, translation: null, pending: bodyWants && availability.get(availabilityKey(f.id, opts.displayLang)) !== "unavailable", ...(bodyWants && availability.get(availabilityKey(f.id, opts.displayLang)) === "unavailable" ? { unavailable: true } : {}) },
        href: f.kind === "reply" ? replyLocationAt(f.threadId, f.id, pages.get(f.id) ?? 1, { lang: opts.carryLang }) : `/t/${f.threadId}${opts.carryLang ? `?lang=${opts.carryLang}` : ""}`,
      };
    }),
  );
}
