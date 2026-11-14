import { chatNushiEnabled } from "./chat-nushi-config.server";
import { createHash } from "node:crypto";
import { sourceHash as hashPost } from "./source-hash.server";
import { and, count, eq, inArray, isNull, like, notInArray, sql } from "drizzle-orm";
import type { Db } from "./db/client.server";
import { entries, nushiAnswers, nushiRequests, nushiReservations, nushiSources, profiles, villageMembers, villageDepartures, villages } from "./db/schema";
import { rootTopic, rootTopicOn, visibleWithTopic } from "./visibility.server";
import { nushiInVillage, nushiLimits } from "./nushi-config.server";
import { findLiteral } from "./combined-search.server";
import { closeResults, findSimilar } from "./search.server";
import { resolveEmbeddingEngine } from "./llm/config.server";
import { isUsableEmbedding } from "./llm/index.server";
import { embeddingEstimate, meteredCall } from "./llm/metering.server";
import { boundQuestionMaterials, projectQuestionSource, type AiQuestionMaterials, type AiQuestionSource } from "./ai-question-materials.server";
import { loadMdTranslations } from "./md/translations.server";
import { loadReplyLocations } from "./reply-locations.server";
import { authorLabel } from "./deleted-member";
import { retainedAuthorColumn } from "./deleted-member.server";
import { clipQuestionText } from "./ai-questions";
import { isLang, type Lang, type SourceLang } from "./languages";
import type { EmbeddingEngine, LlmEnv } from "./llm/types";

export async function nushiPlace(db: Db, threadId: number, env: LlmEnv = process.env) {
  return (await nushiPlaces(db, [threadId], env))[0] ?? null;
}
export async function nushiPlaces(db: Db, threadIds: readonly number[], env: LlmEnv = process.env) {
  if (!threadIds.length) return [];
  const rows = await db.select({ topic: entries, village: villages }).from(entries)
    .innerJoin(villages, eq(villages.id, entries.villageId))
    .where(and(inArray(entries.id, [...threadIds]), eq(entries.kind, "topic"), isNull(entries.hiddenAt), isNull(entries.deletedAt)));
  return rows.filter(row => !row.topic.nushiDisabled && nushiInVillage(row.village, env));
}
export async function nushiCaller(db: Db, request: typeof nushiRequests.$inferSelect, env: LlmEnv = process.env) {
  const place = await nushiPlace(db, request.threadId, env);
  if (!place || place.village.id !== request.villageId || !request.callerId) return null;
  const [entry] = await db.select().from(entries).where(and(eq(entries.id, request.entryId), isNull(entries.deletedAt), isNull(entries.hiddenAt)));
  if (!entry || (entry.threadId ?? entry.id) !== request.threadId || entry.sourceHash !== request.sourceHash || entry.mentionRevision !== request.revision) return null;
  let parent: typeof entries.$inferSelect | undefined;
  if (entry.parentId !== null) {
    [parent] = await db.select().from(entries).where(and(eq(entries.id, entry.parentId), eq(entries.threadId, request.threadId), isNull(entries.deletedAt), isNull(entries.hiddenAt)));
    if (!parent) return null;
  }
  // An earlier AI reply is context only. A hidden reply cannot be revived by a follow-up.
  let previous: typeof nushiAnswers.$inferSelect | undefined;
  if (entry.nushiParentId !== null) {
    [previous] = await db.select({ answer: nushiAnswers }).from(nushiAnswers).innerJoin(nushiRequests, eq(nushiRequests.id, nushiAnswers.requestId))
      .where(and(eq(nushiAnswers.id, entry.nushiParentId), eq(nushiRequests.threadId, request.threadId), isNull(nushiAnswers.hiddenAt))).then(rows => rows.map(row => row.answer));
    if (!previous) return null;
  }
  return { ...place, entry, parent, previous };
}
export type NushiSnapshot = { id: number; revision: number; sourceHash: string; authorId: string; author: string; createdAt: Date };
export type NushiMaterials = { materials: AiQuestionMaterials; snapshots: NushiSnapshot[]; dates: { from: string | null; to: string | null }; language: Lang; answerLanguage: SourceLang; answerLangCode: string | null; context: unknown; query: string };
export type NushiMaterialIndex = Array<{ id: string; chars: number; translation?: { chars: number; hash: string } }>;
const snapshotHash = (entry: { title: string | null; body: string; lang: string; langCode: string | null }) => createHash("sha256").update(JSON.stringify([hashPost(entry.title, entry.body, entry.lang), entry.langCode])).digest("hex");
const translationHash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function nushiMaterialIndex(sources: readonly AiQuestionSource[]): NushiMaterialIndex {
  return sources.map(source => ({ id: source.id, chars: source.original.length, ...(source.translation ? { translation: { chars: source.translation.text.length, hash: translationHash(source.translation) } } : {}) }));
}

// Reconstruct the exact bounded source fields for an opted-in error report.
// The persisted index contains lengths and hashes, never material text.
export async function reconstructNushiMaterials(db: Db, index: NushiMaterialIndex, language: Lang): Promise<AiQuestionSource[] | null> {
  const ids = [...new Set(index.map(item => Number(/^e-(\d+)-/.exec(item.id)![1])))];
  if (!ids.length) return [];
  const rows = await db.select({ entry: entries, author: retainedAuthorColumn(entries.authorId, profiles.handle, "handle") }).from(entries).innerJoin(rootTopic, rootTopicOn()).leftJoin(profiles, eq(profiles.userId, entries.authorId)).where(and(inArray(entries.id, ids), visibleWithTopic()));
  const translations = await loadMdTranslations(db, rows.map(({ entry }) => ({ id: entry.id, lang: entry.lang as SourceLang, sourceHash: entry.sourceHash })), language);
  const locations = await loadReplyLocations(db, [...new Set(rows.map(({ entry }) => entry.threadId ?? entry.id))], rows.filter(({ entry }) => entry.kind === "reply").map(({ entry }) => entry.id));
  const sources: AiQuestionSource[] = [];
  for (const item of index) {
    const parsed = /^e-(\d+)-(title|body)$/.exec(item.id);
    if (!parsed) return null;
    const row = rows.find(({ entry }) => entry.id === Number(parsed[1]));
    if (!row) return null;
    const { entry, author } = row, field = parsed[2] as "title" | "body";
    const picked = translations.shown.get(entry.id)?.[0];
    const translated = field === "title" ? picked?.title : picked?.text;
    const location = locations.get(entry.id);
    const href = entry.kind === "topic" ? `/t/${entry.id}` : location?.state === "visible" ? location.href : null;
    if (!href) return null;
    const source = await projectQuestionSource<AiQuestionSource>({ id: item.id, kind: entry.kind === "topic" ? "post" : "reply", field, author: authorLabel(author), lang: entry.langCode ?? entry.lang, original: entry[field] ?? "", sourceHash: entry.sourceHash, href,
      ...(item.translation && picked && translated ? { translation: { text: translated, lang: language, stale: picked.stale } } : {}) });
    source.original = clipQuestionText(source.original, item.chars);
    if (source.translation && item.translation) source.translation.text = clipQuestionText(source.translation.text, item.translation.chars);
    if (item.translation && (!source.translation || translationHash(source.translation) !== item.translation.hash)) return null;
    sources.push(source);
  }
  return sources;
}

export type NushiRetrievalOptions = { env: LlmEnv; now: Date; clock: () => Date; signal?: AbortSignal; embedding?: EmbeddingEngine };
export async function collectNushiMaterials(db: Db, input: { villageId: string; callerId: string | null; callingPost: string; language: Lang; excludeEntryId?: number; priorityEntryIds?: readonly number[] }, options: NushiRetrievalOptions) {
  const language = input.language;
  const exhausted = chatNushiEnabled(options.env) ? (await db.execute(sql`select key from (select key, day from nushi_reservations union all select key, day from chat_nushi_reservations) shared where day = ${options.now.toISOString().slice(0, 10)} and key like 'author:%' group by key having count(*) >= ${nushiLimits(options.env).author}`) as { rows: { key: string }[] }).rows : await db.select({ key: nushiReservations.key }).from(nushiReservations)
    .where(and(eq(nushiReservations.day, options.now.toISOString().slice(0, 10)), like(nushiReservations.key, "author:%")))
    .groupBy(nushiReservations.key).having(sql`${count()} >= ${nushiLimits(options.env).author}`);
  const excludedAuthors = exhausted.map(row => row.key.slice(7)).filter(id => id !== input.callerId);
  const query = clipQuestionText(input.callingPost.replace(/[@＠](?:nushi|village-ai)\b/giu, "").trim(), 200);
  const found = new Map<number, unknown>();
  // Calling topics and reply targets pass the same evidence gate as search hits.
  for (const id of input.priorityEntryIds ?? []) if (id !== input.excludeEntryId) found.set(id, null);
  const opts = { readLangs: [] as Lang[], displayLang: language, limit: 20, villageId: input.villageId, excludedAuthorIds: excludedAuthors };
  if (query) {
    // Keep literal matches ahead of semantic matches, using the same search SQL.
    for (const term of [query, ...query.split(/\s+/u).filter(word => word.length >= 3).slice(0, 3)]) {
      for (const row of await findLiteral(db, term, opts)) if (row.id !== input.excludeEntryId) found.set(row.id, row);
    }
    const engine = options.embedding ?? resolveEmbeddingEngine(options.env);
    const req = { text: query, task: "query" as const, signal: options.signal };
    const { result } = await meteredCall(db, {
      engine: engine.id, model: engine.model, purpose: "ask_village", role: "ask",
      estimateMicro: embeddingEstimate(engine.id, engine.model, req, options.env),
      now: options.now, clock: options.clock, env: options.env, signal: options.signal,
    }, () => engine.embed(req), value => ({ inputTokens: value.inputTokens, outputTokens: 0 }));
    if (isUsableEmbedding(result.vector)) for (const row of closeResults(await findSimilar(db, result.vector, engine.model, 20, input.villageId, excludedAuthors), query)) if (row.id !== input.excludeEntryId && !found.has(row.id)) found.set(row.id, row);
  }
  const ids = [...found.keys()].slice(0, 20);
  const rows = ids.length ? await db.select({ entry: entries, author: retainedAuthorColumn(entries.authorId, profiles.handle, "handle") }).from(entries)
    .innerJoin(rootTopic, rootTopicOn()).leftJoin(profiles, eq(profiles.userId, entries.authorId))
    .where(and(inArray(entries.id, ids), eq(rootTopic.villageId, input.villageId), visibleWithTopic(), excludedAuthors.length ? notInArray(entries.authorId, excludedAuthors) : undefined)) : [];
  rows.sort((a, b) => ids.indexOf(a.entry.id) - ids.indexOf(b.entry.id));
  const [translated, locations] = await Promise.all([
    loadMdTranslations(db, rows.map(({ entry }) => ({ id: entry.id, lang: entry.lang as SourceLang, sourceHash: entry.sourceHash })), language),
    loadReplyLocations(db, [...new Set(rows.map(({ entry }) => entry.threadId ?? entry.id))], rows.filter(({ entry }) => entry.kind === "reply").map(({ entry }) => entry.id)),
  ]);
  const inputs: AiQuestionSource[] = [];
  for (const { entry, author } of rows) {
    const location = entry.kind === "topic" ? { state: "visible", href: `/t/${entry.id}` } : locations.get(entry.id);
    if (location?.state !== "visible") continue;
    const tr = translated.shown.get(entry.id)?.[0];
    for (const field of ["title", "body"] as const) {
      if (!entry[field]?.trim()) continue;
      const text = field === "title" ? tr?.title : tr?.text;
      inputs.push({ id: `e-${entry.id}-${field}`, kind: entry.kind === "topic" ? "post" : "reply", field, author: authorLabel(author), original: entry[field]!, lang: entry.langCode ?? entry.lang, href: location.href, sourceHash: entry.sourceHash,
        ...(text && tr ? { translation: { text, lang: language, stale: tr.stale } } : {}) });
    }
  }
  const materials = await boundQuestionMaterials(inputs, found.size > ids.length);
  const used = new Set(materials.sources.map(source => Number(/^e-(\d+)-/.exec(source.id)![1])));
  const dependencies = new Map(rows.filter(({ entry }) => used.has(entry.id)).map(row => [row.entry.id, row]));

  for (const id of [...new Set(rows.map(({ entry }) => entry.threadId ?? entry.id))]) {
    if (!dependencies.has(id)) {
      const [row] = await db.select({ entry: entries, author: retainedAuthorColumn(entries.authorId, profiles.handle, "handle") }).from(entries).leftJoin(profiles, eq(profiles.userId, entries.authorId)).where(eq(entries.id, id));
      if (row) dependencies.set(id, row);
    }
  }
  const snapshots = [...dependencies.values()].map(({ entry, author }) => ({ id: entry.id, revision: entry.mentionRevision, sourceHash: snapshotHash(entry), authorId: entry.authorId, author: authorLabel(author), createdAt: entry.createdAt }));
  const dates = rows.filter(({ entry }) => used.has(entry.id)).map(({ entry }) => entry.createdAt.toISOString()).sort();
  return { materials, snapshots, query, dates: { from: dates[0] ?? null, to: dates.at(-1) ?? null } };
}

// The query and all source text stay in memory. Jobs and usage rows contain IDs and numbers.
export async function nushiMaterials(db: Db, request: typeof nushiRequests.$inferSelect, options: { env: LlmEnv; now: Date; clock: () => Date; signal?: AbortSignal; embedding?: EmbeddingEngine }): Promise<NushiMaterials | null> {
  const caller = await nushiCaller(db, request, options.env);
  if (!caller) return null;
  const contextText = async (original: string, field: "title" | "body" = "body") => (await projectQuestionSource({ kind: "post", field, author: "", original })).original;
  const callingPost = await contextText(caller.entry.body);
  const language = isLang(caller.entry.lang) ? caller.entry.lang : "en";
  const collected = await collectNushiMaterials(db, { villageId: request.villageId, callerId: request.callerId, callingPost, language, excludeEntryId: request.entryId, priorityEntryIds: [request.threadId, ...(caller.parent ? [caller.parent.id] : [])] }, options);
  const dependencies = new Map<number, { entry: typeof entries.$inferSelect; author: string | null }>();
  // Track calling context as well as evidence, so an edit cannot leave old context public.
  for (const id of [request.entryId, request.threadId, caller.entry.parentId].filter((id): id is number => id !== null)) {
    if (!dependencies.has(id)) {
      const [row] = await db.select({ entry: entries, author: retainedAuthorColumn(entries.authorId, profiles.handle, "handle") }).from(entries).leftJoin(profiles, eq(profiles.userId, entries.authorId)).where(eq(entries.id, id));
      if (row) dependencies.set(id, row);
    }
  }
  const snapshots = [...dependencies.values()].map(({ entry, author }) => ({ id: entry.id, revision: entry.mentionRevision, sourceHash: snapshotHash(entry), authorId: entry.authorId, author: authorLabel(author), createdAt: entry.createdAt }));
  return { ...collected, snapshots: [...collected.snapshots, ...snapshots.filter(source => !collected.snapshots.some(existing => existing.id === source.id))], language, answerLanguage: caller.entry.lang as SourceLang, answerLangCode: caller.entry.langCode, context: { callingPost: clipQuestionText(callingPost, 2000), parentPost: caller.parent ? clipQuestionText(await contextText(caller.parent.body), 2000) : null, topic: { title: caller.topic.title === null ? null : await contextText(caller.topic.title, "title"), body: clipQuestionText(await contextText(caller.topic.body), 2000) }, previousAiReply: caller.previous ? clipQuestionText(JSON.stringify(caller.previous.answer), 4000) : null } };
}

export async function snapshotsCurrent(db: Db, snapshots: readonly NushiSnapshot[], villageId: string): Promise<boolean> {
  const rows = snapshots.length ? await db.select({ entry: entries }).from(entries).innerJoin(rootTopic, rootTopicOn())
    .where(and(inArray(entries.id, snapshots.map(source => source.id)), eq(rootTopic.villageId, villageId), visibleWithTopic())) : [];
  return snapshots.every(source => rows.some(({ entry }) => entry.id === source.id && snapshotHash(entry) === source.sourceHash && entry.mentionRevision === source.revision && entry.authorId === source.authorId));
}

export async function nushiSourceLabels(db: Db, answerId: number) {
  // Membership is shown at read time; it is not a claim that a former member agrees now.
  const rows = await db.select({ source: nushiSources, publicId: profiles.publicId, present: sql<boolean>`not exists (select 1 from ${villageDepartures} where ${villageDepartures.villageId} = ${nushiRequests.villageId} and ${villageDepartures.userId} = ${nushiSources.authorId}) or exists (select 1 from ${villageMembers} where ${villageMembers.villageId} = ${nushiRequests.villageId} and ${villageMembers.userId} = ${nushiSources.authorId})` })
    .from(nushiSources).leftJoin(profiles, eq(profiles.userId, nushiSources.authorId)).innerJoin(nushiAnswers, eq(nushiAnswers.id, nushiSources.answerId)).innerJoin(nushiRequests, eq(nushiRequests.id, nushiAnswers.requestId)).where(eq(nushiSources.answerId, answerId));
  return rows.map(({ source, present, publicId }) => ({ id: source.entryId, author: source.author, authorHref: publicId ? `/u/id/${publicId}` : null, date: source.createdAt.toISOString(), left: !present }));
}
