import { withMarkdownPersistedRead } from "./markdown-budget.server";
import { and, asc, eq, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "~/lib/db/client.server";
import { entries, entryReferences } from "~/lib/db/schema";
import { parseEntryReferences } from "~/lib/entry-references.server";
import { loadTitleDisplays } from "~/lib/entry-display.server";
import { loadReplyLocations } from "~/lib/reply-locations.server";
import type { Lang, SourceLang } from "~/lib/languages";
import { touchQuestion } from "~/lib/questions.server";
import { publicTopicPlace } from "~/lib/visibility.server";

const source = alias(entries, "reference_source");
const target = alias(entries, "reference_target");
const sourceTopic = alias(entries, "reference_source_topic");
const targetTopic = alias(entries, "reference_target_topic");
const sourceThread = sql<number>`coalesce(${source.threadId}, ${source.id})`.mapWith(Number);
const targetThread = sql<number>`coalesce(${target.threadId}, ${target.id})`.mapWith(Number);

async function referencePairs(db: Db, entryId: number) {
  // A topic's visibility/title also affects links written in, or pointing to,
  // any of its replies. A reply affects only its own source/target pairs.
  return db.select({ sourceTopicId: sourceThread, targetTopicId: targetThread })
    .from(entryReferences).innerJoin(source, eq(source.id, entryReferences.sourceEntryId))
    .innerJoin(target, eq(target.id, entryReferences.targetEntryId))
    .where(or(eq(source.id, entryId), eq(target.id, entryId), eq(source.threadId, entryId), eq(target.threadId, entryId)));
}

async function resolvedTargets(db: Db, body: string, ownTopic: number | null) {
  const links = (await parseEntryReferences(body)).filter(link => link.topicId !== ownTopic);
  if (!links.length) return [];
  const rows = await db.select({ id: entries.id, kind: entries.kind, threadId: entries.threadId }).from(entries)
    .where(inArray(entries.id, [...new Set(links.map(link => link.entryId))]));
  return links.filter(link => rows.some(row => row.id === link.entryId && row.kind === link.kind && (row.threadId ?? row.id) === link.topicId));
}

// Take topic locks in ID order before taking a post's usual mutation locks.
// This includes both old and new references so reciprocal edits/replies do
// not each hold their own topic while waiting for the other one.
export async function lockReferenceTopics(db: Db, opts: { entryId?: number; threadId?: number; body?: string }) {
  const [entry] = opts.entryId ? await db.select({ id: entries.id, threadId: entries.threadId }).from(entries).where(eq(entries.id, opts.entryId)) : [];
  const own = opts.threadId ?? (entry ? entry.threadId ?? entry.id : null);
  const pairs = opts.entryId ? await referencePairs(db, opts.entryId) : [];
  const links = opts.body === undefined ? [] : await resolvedTargets(db, opts.body, own);
  // Always lock the owning topic before a reply. Reply creation also updates
  // its parent's history latch, so deletion must not hold that parent while
  // waiting for the topic, even when neither post contains a reference.
  const ids = [...new Set([...(own === null ? [] : [own]), ...pairs.flatMap(pair => [pair.sourceTopicId, pair.targetTopicId]), ...links.map(link => link.topicId)])].sort((a, b) => a - b);
  if (ids.length) await db.select({ id: entries.id }).from(entries).where(inArray(entries.id, ids)).orderBy(asc(entries.id)).for("no key update");
}

async function touchTopics(db: Db, ids: number[], now: Date) {
  for (const id of [...new Set(ids)].sort((a, b) => a - b)) await touchQuestion(db, id, now);
}

export async function touchReferenceTopics(db: Db, entryId: number, now: Date) {
  const pairs = await referencePairs(db, entryId);
  await touchTopics(db, pairs.flatMap(pair => [pair.sourceTopicId, pair.targetTopicId]), now);
}

// Caller already owns the posting/editing transaction and its topic locks.
// Rebuilding this derived index never touches bodies, activity times or mail.
async function syncEntryReferencesImplementation(db: Db, entryId: number, now = new Date(), indexOnly = false) {
  const [entry] = await db.select({ id: entries.id, threadId: entries.threadId, body: entries.body }).from(entries).where(eq(entries.id, entryId));
  if (!entry) return;
  const own = entry.threadId ?? entry.id;
  const previous = await referencePairs(db, entryId);
  const targets = await resolvedTargets(db, entry.body, own);
  const old = (await db.select().from(entryReferences).where(eq(entryReferences.sourceEntryId, entryId))).map(row => row.targetEntryId).sort((a, b) => a - b);
  const next = [...new Set(targets.map(link => link.entryId))].sort((a, b) => a - b);
  if (indexOnly && JSON.stringify(old) === JSON.stringify(next)) return;
  if (JSON.stringify(old) !== JSON.stringify(next)) {
    await db.delete(entryReferences).where(eq(entryReferences.sourceEntryId, entryId));
    if (next.length) await db.insert(entryReferences).values(next.map(targetEntryId => ({ sourceEntryId: entryId, targetEntryId })));
  }
  // Retitling/revising an endpoint may change its title excerpt even if the
  // links did not change. Removed links still invalidate their former topics.
  const current = await referencePairs(db, entryId);
  await touchTopics(db, [...previous, ...current].flatMap(pair => [pair.sourceTopicId, pair.targetTopicId]), now);
}

async function rebuildEntryReferencesImplementation(db: Db, opts: { fromId: number; toId: number; limit?: number; write?: boolean; now?: Date }) {
  const limit = opts.limit ?? 100;
  if (!Number.isSafeInteger(opts.fromId) || opts.fromId < 1 || !Number.isSafeInteger(opts.toId) || opts.toId < opts.fromId || !Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) throw new RangeError("Invalid entry range or batch size");
  const rows = await db.select({ id: entries.id, threadId: entries.threadId, body: entries.body }).from(entries)
    .where(and(inArray(entries.kind, ["topic", "reply"]), gte(entries.id, opts.fromId), lte(entries.id, opts.toId)))
    .orderBy(asc(entries.id)).limit(limit);
  let changed = 0;
  for (const row of rows) {
    const update = async (tx: Db) => {
      if (opts.write) await lockReferenceTopics(tx, { entryId: row.id, body: row.body });
      const [current] = await tx.select({ body: entries.body }).from(entries).where(eq(entries.id, row.id));
      if (!current) return;
      const old = (await tx.select().from(entryReferences).where(eq(entryReferences.sourceEntryId, row.id))).map(ref => ref.targetEntryId).sort((a, b) => a - b);
      const next = [...new Set((await resolvedTargets(tx, current.body, row.threadId ?? row.id)).map(link => link.entryId))].sort((a, b) => a - b);
      if (JSON.stringify(old) !== JSON.stringify(next)) {
        changed++;
        if (opts.write) await syncEntryReferences(tx, row.id, opts.now ?? new Date(), true);
      }
    };
    if (opts.write) await db.transaction(update); else await update(db);
  }
  return { checked: rows.length, changed, nextId: rows.length === limit && rows.at(-1)!.id < opts.toId ? rows.at(-1)!.id + 1 : null };
}

export type RelatedDirection = { sourceHref: string; targetHref: string };
export type RelatedDiscussion = { id: number; title: { text: string; lang: SourceLang }; incoming: RelatedDirection | null; outgoing: RelatedDirection | null };
type Display = { readLangs: readonly Lang[]; displayLang: Lang; lang?: string | null; typesetTitles?: boolean };

// Shared qualification/grouping for HTML, loader data and Markdown. Every
// endpoint and both topics must be public content, even for an operator.
export async function listRelatedDiscussions(db: Db, topicId: number, opts: Display & { inline?: boolean; page?: number }) {
  const links = await db.select({
    sourceId: source.id, targetId: target.id, authorId: source.authorId, createdAt: source.createdAt,
    sourceTopicId: sourceTopic.id, targetTopicId: targetTopic.id,
    sourceTitle: sourceTopic.title, sourceLang: sourceTopic.lang, sourceHash: sourceTopic.sourceHash,
    targetTitle: targetTopic.title, targetLang: targetTopic.lang, targetHash: targetTopic.sourceHash,
  }).from(entryReferences)
    .innerJoin(source, eq(source.id, entryReferences.sourceEntryId)).innerJoin(target, eq(target.id, entryReferences.targetEntryId))
    .innerJoin(sourceTopic, and(eq(sourceTopic.id, sourceThread), eq(sourceTopic.kind, "topic")))
    .innerJoin(targetTopic, and(eq(targetTopic.id, targetThread), eq(targetTopic.kind, "topic")))
    .where(and(or(eq(sourceTopic.id, topicId), eq(targetTopic.id, topicId)),
      publicTopicPlace(sourceTopic), publicTopicPlace(targetTopic),
      isNull(source.deletedAt), isNull(source.hiddenAt), isNull(target.deletedAt), isNull(target.hiddenAt),
      isNull(sourceTopic.deletedAt), isNull(sourceTopic.hiddenAt), isNull(targetTopic.deletedAt), isNull(targetTopic.hiddenAt)))
    .orderBy(sql`${source.createdAt} desc`, sql`${source.id} desc`, asc(target.id));
  type Group = { id: number; authorId: string; title: string | null; lang: SourceLang; sourceHash: string | null; incoming?: typeof links[number]; outgoing?: typeof links[number] };
  const groups = new Map<number, Group>();
  for (const link of links) {
    if (link.sourceTopicId === link.targetTopicId) continue;
    const outgoing = link.sourceTopicId === topicId;
    const id = outgoing ? link.targetTopicId : link.sourceTopicId;
    let group = groups.get(id);
    if (!group) {
      group = { id, authorId: link.authorId, title: outgoing ? link.targetTitle : link.sourceTitle, lang: (outgoing ? link.targetLang : link.sourceLang) as Lang, sourceHash: outgoing ? link.targetHash : link.sourceHash };
      groups.set(id, group);
    }
    const direction = outgoing ? "outgoing" : "incoming";
    group[direction] ??= link;
  }
  let chosen: Group[];
  const page = opts.page ?? 1;
  if (opts.inline) {
    const authors = new Set<string>();
    chosen = [];
    for (const group of groups.values()) {
      if (authors.has(group.authorId)) continue;
      authors.add(group.authorId);
      chosen.push(group);
      if (chosen.length === 5) break;
    }
  } else chosen = [...groups.values()].slice((page - 1) * 20, page * 20);
  const pageCount = Math.max(1, Math.ceil(groups.size / 20));
  const titles = await loadTitleDisplays(db, chosen, { readLangs: [...opts.readLangs], displayLang: opts.displayLang }, opts.typesetTitles ?? false);
  const representatives = chosen.flatMap(group => [group.incoming, group.outgoing].filter(link => link !== undefined));
  const locations = await loadReplyLocations(db, [...new Set(representatives.flatMap(link => [link.sourceTopicId, link.targetTopicId]))],
    [...new Set(representatives.flatMap(link => [link.sourceId, link.targetId]))], { lang: opts.lang });
  const href = (id: number, threadId: number) => locations.get(id)?.state === "visible" ? (locations.get(id) as { href: string }).href : `/t/${threadId}${opts.lang ? `?lang=${opts.lang}` : ""}#p-${id}`;
  const direction = (link: typeof links[number] | undefined): RelatedDirection | null => link ? { sourceHref: href(link.sourceId, link.sourceTopicId), targetHref: href(link.targetId, link.targetTopicId) } : null;
  return {
    rows: chosen.map(group => ({ id: group.id, title: { text: titles.get(group.id)!.text, lang: titles.get(group.id)!.lang }, incoming: direction(group.incoming), outgoing: direction(group.outgoing) })),
    omitted: opts.inline ? chosen.length < groups.size : false,
    hasNext: page < pageCount, pageCount,
  };
}

export function syncEntryReferences(...args: Parameters<typeof syncEntryReferencesImplementation>): ReturnType<typeof syncEntryReferencesImplementation> {
  return withMarkdownPersistedRead(() => syncEntryReferencesImplementation(...args));
}

export function rebuildEntryReferences(...args: Parameters<typeof rebuildEntryReferencesImplementation>): ReturnType<typeof rebuildEntryReferencesImplementation> {
  return withMarkdownPersistedRead(() => rebuildEntryReferencesImplementation(...args));
}
