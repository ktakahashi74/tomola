import { loadDisplayNames, selectDisplayName } from "./display-names.server";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { retainedAuthorColumn } from "./deleted-member.server";
import type { Db } from "~/lib/db/client.server";
import { entries, profiles } from "~/lib/db/schema";
import { wantsTranslation } from "~/lib/display";
import { loadPickedTranslations, loadTitleDisplays, type TitleDisplay } from "~/lib/entry-display.server";
import { replyLocationAt } from "~/lib/entries.server";
import type { Lang } from "~/lib/languages";
import { pageCount, REPLIES_PER_PAGE } from "~/lib/pagination";
import { plainExcerpt } from "~/lib/plain-text.server";
import { OBJECTION_PANEL_LIMIT } from "~/lib/stances";
import { publicTopicPlace } from "~/lib/visibility.server";

// Question-formulation objection panel: always on question pages, showing alternative questions and objection-marked replies.
// Neither side is declared correct: two lists only, without ranking/labels. Exclude hidden/deleted content even for authors/moderators.
// Omit alternatives/objections by excluded members (operator exclude_reactions) from the panel and 「すべて見る」, like reasons: limited exposure should not go to accounts
// deemed manipulative. One latest item per non-excluded author. Do not apply this to machine-readable alternatives/objections in twins,
// so undoing exclusion or deciding an appeal does not change the original question's content_hash.

export type AltItem = { id: number; lang: Lang; title: TitleDisplay; authorHandle: string; authorName?: string | null; createdAt: Date };
// excerpt lang is display language for translations, original language otherwise. location gives reply page/anchor.
export type ObjectionItem = { id: number; threadId: number; lang: Lang; excerpt: string; authorHandle: string; authorName?: string | null; createdAt: Date; location: string };
export type ObjectionPanel = { alternatives: AltItem[]; objections: ObjectionItem[] };

// The excerpt is plain text (Markdown removed), this many characters.
const EXCERPT_LENGTH = 160;
const PAGE_SIZE = 50;

type Langs = { readLangs: readonly Lang[]; displayLang: Lang };

// Exclude reactions_excluded_at authors from panel/「すべて見る」. Posts with no author profile are not excluded.
const writerNotExcluded = isNull(profiles.reactionsExcludedAt);

// Alternatives: undeleted, unhidden topics pointing to the original via alt_of.
const altFilter = (questionId: number) => and(eq(entries.altOf, questionId), eq(entries.kind, "topic"), isNull(entries.deletedAt), isNull(entries.hiddenAt), publicTopicPlace());
// Objections: undeleted, unhidden replies marked objection in that question's thread.
const objectionFilter = (questionId: number) =>
  and(eq(entries.threadId, questionId), eq(entries.kind, "reply"), eq(entries.stanceTag, "objection"), isNull(entries.deletedAt), isNull(entries.hiddenAt));

const columns = {
  id: entries.id,
  threadId: entries.threadId,
  lang: entries.lang,
  title: entries.title,
  body: entries.body,
  sourceHash: entries.sourceHash,
  authorId: entries.authorId,
  authorHandle: retainedAuthorColumn(entries.authorId),
  createdAt: entries.createdAt,
};

// Latest item per author via DISTINCT ON, newest first up to limit, equally for alternatives and objections.
function latestPerAuthor(db: Db, filter: ReturnType<typeof and>, limit: number) {
  const latest = db
    .selectDistinctOn([entries.authorId], columns)
    .from(entries)
    .leftJoin(profiles, eq(profiles.userId, entries.authorId))
    .where(filter)
    .orderBy(entries.authorId, desc(entries.createdAt), desc(entries.id))
    .as("latest");
  return db.select().from(latest).orderBy(desc(latest.createdAt), desc(latest.id)).limit(limit);
}

// All items, without per-author grouping, newest first; read limit+1 to detect the next page.
function allNewest(db: Db, filter: ReturnType<typeof and>, limit: number, offset: number) {
  return db
    .select(columns)
    .from(entries)
    .leftJoin(profiles, eq(profiles.userId, entries.authorId))
    .where(filter)
    .orderBy(desc(entries.createdAt), desc(entries.id))
    .limit(limit)
    .offset(offset);
}

type Row = {
  id: number;
  threadId: number | null;
  lang: string;
  title: string | null;
  body: string;
  sourceHash: string | null;
  authorHandle: string | null;
  createdAt: Date;
};

async function toAltItems(db: Db, rows: readonly Row[], opts: Langs): Promise<AltItem[]> {
  const names = await loadDisplayNames(db, rows.map(row => row.authorHandle));
  const titles = await loadTitleDisplays(
    db,
    rows.map((r) => ({ id: r.id, lang: r.lang as Lang, title: r.title, sourceHash: r.sourceHash })),
    opts,
    true,
  );
  return rows.map((r) => ({
    id: r.id,
    lang: r.lang as Lang,
    // A question always has its title (the proposition), and loadTitleDisplays answers for every topic it is given.
    title: titles.get(r.id)!,
    authorHandle: r.authorHandle ?? "?",
    authorName: selectDisplayName(names.get(r.authorHandle ?? "")),
    createdAt: r.createdAt,
  }));
}

// Reply thread pages for ids in one query: rank thread replies by createdAt/id with a window function, then divide into pages of 100,
// counting deleted replies like entries.server.ts replyPage. Calling replyLocation per reply would add one query each.
export async function replyPagesOf(db: Db, threadId: number, ids: readonly number[]): Promise<Map<number, number>> {
  if (ids.length === 0) return new Map();
  const ranked = rankedReplies(db, threadId);
  const rows = await db.select({ id: ranked.id, position: ranked.position }).from(ranked).where(inArray(ranked.id, [...ids]));
  return new Map(rows.map((r) => [r.id, pageCount(Number(r.position), REPLIES_PER_PAGE)]));
}

async function toObjectionItems(db: Db, rows: readonly Row[], opts: Langs): Promise<ObjectionItem[]> {
  const names = await loadDisplayNames(db, rows.map(row => row.authorHandle));
  const picked = await loadPickedTranslations(
    db,
    rows.map((r) => ({ id: r.id, kind: "reply" as const, lang: r.lang as Lang, sourceHash: r.sourceHash })),
    opts.displayLang,
    ["body"],
  );
  // Reply locations in one query per thread; every listed reply belongs to this question's thread.
  const threadIds = [...new Set(rows.map((r) => r.threadId as number))];
  const pages = new Map<number, Map<number, number>>(await Promise.all(threadIds.map(async (threadId) => [threadId, await replyPagesOf(db, threadId, rows.filter((r) => r.threadId === threadId).map((r) => r.id))] as const)));
  return (await Promise.all(rows.map(async (r) => {
    // Display-language translated excerpts when available, following list-title rules: use originals if their language is readable.
    const translated = wantsTranslation(r.lang, opts.readLangs, opts.displayLang) ? (picked.get(r.id)?.body ?? null) : null;
    const threadId = r.threadId as number;
    return {
      id: r.id,
      threadId,
      lang: translated ? opts.displayLang : (r.lang as Lang),
      excerpt: (await plainExcerpt(translated ? translated.text : r.body, EXCERPT_LENGTH)),
      authorHandle: r.authorHandle ?? "?",
      authorName: selectDisplayName(names.get(r.authorHandle ?? "")),
      createdAt: r.createdAt,
      location: replyLocationAt(threadId, r.id, pages.get(threadId)?.get(r.id) ?? 1),
    };
  })));
}

// Panel: alternatives/objections, latest one per author, newest first up to OBJECTION_PANEL_LIMIT each.
export async function loadObjectionPanel(db: Db, questionId: number, opts: Langs & { limit?: number }): Promise<ObjectionPanel> {
  const limit = opts.limit ?? OBJECTION_PANEL_LIMIT;
  const [alternatives, objections] = await Promise.all([
    latestPerAuthor(db, and(altFilter(questionId), writerNotExcluded), limit),
    latestPerAuthor(db, and(objectionFilter(questionId), writerNotExcluded), limit),
  ]);
  const [altItems, objectionItems] = await Promise.all([toAltItems(db, alternatives, opts), toObjectionItems(db, objections, opts)]);
  return { alternatives: altItems, objections: objectionItems };
}

// /t/:id/objections: all items without author grouping, newest first, 50/page starting at 1. hasNext if either list has a next page.
export async function listObjections(
  db: Db,
  questionId: number,
  opts: Langs & { page: number },
): Promise<{ alternatives: AltItem[]; objections: ObjectionItem[]; hasNext: boolean }> {
  if (!Number.isInteger(opts.page) || opts.page < 1) throw new RangeError("page must be a positive integer");
  const offset = (opts.page - 1) * PAGE_SIZE;
  const [alternatives, objections] = await Promise.all([
    allNewest(db, and(altFilter(questionId), writerNotExcluded), PAGE_SIZE + 1, offset),
    allNewest(db, and(objectionFilter(questionId), writerNotExcluded), PAGE_SIZE + 1, offset),
  ]);
  const [altItems, objectionItems] = await Promise.all([toAltItems(db, alternatives.slice(0, PAGE_SIZE), opts), toObjectionItems(db, objections.slice(0, PAGE_SIZE), opts)]);
  return { alternatives: altItems, objections: objectionItems, hasNext: alternatives.length > PAGE_SIZE || objections.length > PAGE_SIZE };
}

// ---- All alternatives/objections for twin frontmatter/end block and manifest, without panel-style per-author filtering ----

export type AlternativeRef = { id: number; title: string; lang: Lang; authorHandle: string };
// Every undeleted, unhidden alternative question, newest first.
export async function listAlternativeRefs(db: Db, questionId: number): Promise<AlternativeRef[]> {
  const rows = await db
    .select({ id: entries.id, title: entries.title, lang: entries.lang, authorHandle: retainedAuthorColumn(entries.authorId) })
    .from(entries)
    .leftJoin(profiles, eq(profiles.userId, entries.authorId))
    .where(altFilter(questionId))
    .orderBy(desc(entries.createdAt), desc(entries.id));
  return rows.map((r) => ({ id: r.id, title: r.title ?? "", lang: r.lang as Lang, authorHandle: r.authorHandle ?? "?" }));
}

// Thread replies, including deleted/hidden, ranked position by createdAt/id. Outer filtering does not alter positions assigned by the window function before filtering.
function rankedReplies(db: Db, threadId: number) {
  return db
    .select({
      id: entries.id,
      authorId: entries.authorId,
      stanceTag: entries.stanceTag,
      deletedAt: entries.deletedAt,
      hiddenAt: entries.hiddenAt,
      createdAt: entries.createdAt,
      position: sql<number>`row_number() over (order by ${entries.createdAt}, ${entries.id})`.as("position"),
    })
    .from(entries)
    .where(and(eq(entries.threadId, threadId), eq(entries.kind, "reply")))
    .as("ranked");
}

export type ObjectionRef = { id: number; authorHandle: string; page: number };
// Every undeleted, unhidden objection-marked reply, newest first. page locates the reply in thread pages of 100 creation-ordered replies,
// including deleted ones, identical for HTML/twin. Same calculation as entries.server.ts replyPage, batched into one window-function query.
export async function listObjectionRefs(db: Db, questionId: number): Promise<ObjectionRef[]> {
  const ranked = rankedReplies(db, questionId);
  const rows = await db
    .select({ id: ranked.id, position: ranked.position, authorHandle: retainedAuthorColumn(ranked.authorId) })
    .from(ranked)
    .leftJoin(profiles, eq(profiles.userId, ranked.authorId))
    .where(and(eq(ranked.stanceTag, "objection"), isNull(ranked.deletedAt), isNull(ranked.hiddenAt)))
    .orderBy(desc(ranked.createdAt), desc(ranked.id));
  return rows.map((r) => ({ id: r.id, authorHandle: r.authorHandle ?? "?", page: pageCount(Number(r.position), REPLIES_PER_PAGE) }));
}

// Original question shown on an alternative's page, title for linking. Null if missing, non-question, deleted or hidden: show only 「元の問いは読めません」.
// /t/new?alt_of= uses the same eligibility decision for new alternatives.
export async function loadAltOrigin(db: Db, originId: number, opts: Langs): Promise<{ id: number; title: TitleDisplay } | null> {
  const [row] = await db
    .select({ id: entries.id, kind: entries.kind, asksStance: entries.asksStance, lang: entries.lang, title: entries.title, sourceHash: entries.sourceHash, deletedAt: entries.deletedAt, hiddenAt: entries.hiddenAt })
    .from(entries)
    .where(eq(entries.id, originId));
  if (!row || row.kind !== "topic" || !row.asksStance || row.deletedAt || row.hiddenAt) return null;
  const titles = await loadTitleDisplays(db, [{ id: row.id, lang: row.lang as Lang, title: row.title, sourceHash: row.sourceHash }], opts, true);
  return { id: row.id, title: titles.get(row.id)! };
}
