import { ApiError } from "@google/genai";
import { and, asc, desc, eq, isNotNull, isNull, notInArray, or, sql, type SQLWrapper } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "./db/client.server";
import { entries, profiles, translations } from "./db/schema";
import { retainedAuthorColumn } from "./deleted-member.server";
import { isStale, type ShownKind } from "./display";
import { safeErrorText } from "./error-text.server";
import type { Lang, SourceLang } from "./languages";
import { BudgetPausedError, LlmError } from "./llm/index.server";
import { FLAG_STRUCTURE_MISMATCH, HIDDEN_PRIMARY_FLAGS } from "./llm/flags";
import { plainExcerpt } from "./plain-text.server";
import { SEARCH_LIMIT, searchFound, toHits, type SearchFound, type SearchHit, type SearchOptions, type SearchTranslation } from "./search.server";
import { publicTopicPlace } from "./visibility.server";

export type LiteralMatch = {
  field: "title" | "body";
  source: "original" | "translation";
  lang: SourceLang;
  text: string;
  translation: SearchTranslation | null;
};
export type CombinedFound = SearchFound & { match?: LiteralMatch };
export type CombinedHit = SearchHit & { matchKind: "literal" | "semantic"; match?: LiteralMatch };
export type CombinedResults = { found: CombinedFound[]; literalOnly: boolean };

// SQL counterpart of pickTranslation: current human, usable primary, then stale human.
// Pick before testing the text, so a hidden primary or an older alternative cannot reveal a match.
function translationRank() {
  const sameMentions = sql`(${translations.mentionRevision} is null or ${translations.mentionRevision} = ${entries.mentionRevision})`;
  const hidden = sql`array[${sql.join(HIDDEN_PRIMARY_FLAGS.map(flag => sql`${flag}`), sql`, `)}]::text[]`;
  return sql<number | null>`case
    when ${translations.kind} = 'human' then case when 'stale' = any(${translations.flags}) or not ${sameMentions} then 2 else 0 end
    when ${translations.kind} = 'primary' and ${entries.sourceHash} is not null
      and ${translations.sourceHash} = ${entries.sourceHash} and ${sameMentions}
      and not (${translations.flags} && ${hidden}) then 1
    else null end`;
}

// Exclude HTML tags and their attributes. Search saved Markdown, never cached HTML.
// strpos has no wildcard or escape syntax: %, _ and backslash are ordinary characters.
// Keep the non-greedy comment pattern separate: PostgreSQL alternation uses longest-match rules.
const HTML_COMMENT = "<!--[\\s\\S]*?-->";
const HTML_TAG = "</?[A-Za-z][A-Za-z0-9:_-]*(?:\\s+[A-Za-z_:][A-Za-z0-9_.:-]*(?:\\s*=\\s*(?:[^\\s\"'=<>`]+|'[^']*'|\"[^\"]*\"))?)*\\s*/?>";
const searchableBody = (text: SQLWrapper) => sql<string>`regexp_replace(regexp_replace(${text}, ${HTML_COMMENT}, ' ', 'g'), ${HTML_TAG}, ' ', 'g')`;

export function literalSearchQuery(db: Db, query: string, opts: Pick<SearchOptions, "readLangs" | "displayLang" | "limit"> & { villageId?: string; excludedAuthorIds?: readonly string[] }) {
  const topic = alias(entries, "literal_topic");
  const rank = translationRank();
  const picked = (field: "title" | "body") => db.select({
    text: translations.text, kind: translations.kind, engine: translations.engine,
    model: translations.model, fallback: translations.fallback, flags: translations.flags,
  }).from(translations).where(and(
    eq(translations.entryId, entries.id), eq(translations.field, field), eq(translations.lang, opts.displayLang),
    sql`${entries.lang} <> ${opts.displayLang}`,
    opts.readLangs.length ? notInArray(entries.lang, [...opts.readLangs]) : undefined,
    field === "title" ? isNotNull(entries.title) : undefined,
    sql`${rank} is not null`,
  )).orderBy(asc(rank)).limit(1).as(`literal_${field}`);
  const title = picked("title");
  const body = picked("body");
  const holds = (text: SQLWrapper) => sql<boolean>`strpos(lower(${text}), lower(${query})) > 0`;
  const ownTitle = sql`(${entries.kind} = 'topic' and ${holds(entries.title)})`;
  const translatedTitle = sql`(${entries.kind} = 'topic' and ${holds(title.text)})`;
  const ownBody = holds(searchableBody(entries.body));
  const translatedBody = holds(searchableBody(body.text));
  return db.select({
    id: entries.id, createdAt: entries.createdAt, kind: entries.kind,
    threadId: sql<number>`coalesce(${entries.threadId}, ${entries.id})`,
    lang: entries.lang, langCode: entries.langCode, title: entries.title, body: entries.body, sourceHash: entries.sourceHash,
    authorHandle: retainedAuthorColumn(entries.authorId),
    topicTitle: topic.title,
    topicBody: sql<string | null>`case when ${topic.title} is null then ${topic.body} end`,
    topicLang: topic.lang, topicSourceHash: topic.sourceHash,
    matchField: sql<"title" | "body">`case when ${ownTitle} or ${translatedTitle} then 'title' else 'body' end`,
    matchOriginal: sql<boolean>`case when ${ownTitle} then true when ${translatedTitle} then false when ${ownBody} then true else false end`,
    matchText: sql<string>`case when ${ownTitle} then ${entries.title} when ${translatedTitle} then ${title.text}
      when ${ownBody} then ${searchableBody(entries.body)} else ${searchableBody(body.text)} end`,
    titleTranslation: { kind: title.kind, engine: title.engine, model: title.model, fallback: title.fallback, flags: title.flags },
    bodyTranslation: { kind: body.kind, engine: body.engine, model: body.model, fallback: body.fallback, flags: body.flags },
  }).from(entries)
    .innerJoin(topic, eq(topic.id, sql`coalesce(${entries.threadId}, ${entries.id})`))
    .leftJoin(profiles, eq(profiles.userId, entries.authorId))
    .leftJoinLateral(title, sql`true`).leftJoinLateral(body, sql`true`)
    .where(and(
      isNull(entries.deletedAt), isNull(entries.hiddenAt), eq(topic.kind, "topic"),
      isNull(topic.deletedAt), isNull(topic.hiddenAt), publicTopicPlace(topic), opts.villageId ? eq(topic.villageId, opts.villageId) : undefined,
      opts.excludedAuthorIds?.length ? notInArray(entries.authorId, [...opts.excludedAuthorIds]) : undefined,
      or(ownTitle, translatedTitle, ownBody, translatedBody),
    ))
    .orderBy(sql`case when ${ownTitle} or ${translatedTitle} then 0 else 1 end`, desc(entries.createdAt), desc(entries.id))
    .limit(Math.min(opts.limit ?? SEARCH_LIMIT, SEARCH_LIMIT));
}

export async function findLiteral(db: Db, query: string, opts: Pick<SearchOptions, "readLangs" | "displayLang" | "limit"> & { villageId?: string; excludedAuthorIds?: readonly string[] }): Promise<CombinedFound[]> {
  return (await literalSearchQuery(db, query, opts)).map(({ matchField, matchOriginal, matchText, titleTranslation, bodyTranslation, ...row }) => {
    const tr = matchOriginal ? null : matchField === "title" ? titleTranslation : bodyTranslation;
    return {
      ...row, threadId: Number(row.threadId),
      // A literal hit has no cosine distance; machine output omits this placeholder.
      distance: 0,
      match: {
        field: matchField, source: matchOriginal ? "original" : "translation", lang: matchOriginal ? row.lang as SourceLang : opts.displayLang,
        text: matchText,
        translation: tr?.kind ? { kind: tr.kind as ShownKind, engine: tr.engine, model: tr.model, fallback: tr.fallback ?? false, stale: isStale(tr.flags ?? []), structureMismatch: tr.flags?.includes(FLAG_STRUCTURE_MISMATCH) } : null,
      },
    };
  });
}

// Recognize provider/network failures without swallowing database errors or programming exceptions.
function semanticUnavailable(error: unknown): boolean {
  return error instanceof BudgetPausedError || error instanceof LlmError || error instanceof ApiError
    || (error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError"))
    || (error instanceof TypeError && error.message === "fetch failed");
}

// Explicitly opt in here. API/MCP callers of searchFound keep their semantic contract.
// Neither path applies a rate limit: the authenticated entry point counts the request once.
export async function combinedSearch(db: Db, query: string, opts: SearchOptions): Promise<CombinedResults> {
  const limit = Math.min(opts.limit ?? SEARCH_LIMIT, SEARCH_LIMIT);
  const literal = await findLiteral(db, query, { ...opts, limit });
  let semantic: SearchFound[];
  try {
    semantic = await searchFound(db, query, { limit, llm: opts.llm, villageId: opts.villageId });
  } catch (error) {
    if (!semanticUnavailable(error)) throw error;
    console.warn("[search] unavailable: " + safeErrorText(error));
    return { found: literal, literalOnly: true };
  }
  const ids = new Set(literal.map(row => row.id));
  return { found: [...literal, ...semantic.filter(row => !ids.has(row.id))].slice(0, limit), literalOnly: false };
}

// Parse only a bounded window around the match, even when it occurs deep in a long body.
// Titles are plain text. Literal Markdown is displayed as text after removing its formatting.
export async function literalExcerpt(match: LiteralMatch, query: string): Promise<string> {
  const index = match.text.toLowerCase().indexOf(query.toLowerCase());
  const start = Math.max(0, index - 80);
  const end = Math.min(match.text.length, Math.max(index, 0) + query.length + 120);
  const window = match.text.slice(start, end);
  const plain = match.field === "title" ? window : await plainExcerpt(window, Math.max(200, [...query].length + 80));
  // Keep literal punctuation when Markdown parsing would consume the matched characters.
  const text = plain.toLowerCase().includes(query.toLowerCase()) ? plain : window.replace(/\s+/g, " ").trim();
  return `${start ? "…" : ""}${text}${end < match.text.length ? "…" : ""}`;
}

export async function combinedHits(db: Db, query: string, result: CombinedResults, opts: SearchOptions): Promise<CombinedHit[]> {
  const hits = await toHits(db, result.found, opts, true);
  return Promise.all(hits.map(async (hit, i): Promise<CombinedHit> => {
    const match = result.found[i].match;
    return { ...hit, matchKind: match ? "literal" : "semantic", ...(match ? { match: { ...match, text: await literalExcerpt(match, query) } } : {}) };
  }));
}
