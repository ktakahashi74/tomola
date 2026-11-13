import { countReading } from "~/lib/reading-counts.server";
import type { ReadingMethod } from "~/lib/reading-sources.server";
import { historyPath, revisionCounts } from "../entry-history.server";
import { loadDisplayNames, displayNameFields } from "../display-names.server";
import { authorLabel } from "../deleted-member";
import { retainedAuthorColumn } from "../deleted-member.server";
import { villagesEnabled } from "~/lib/villages-enabled.server";
import { topicVillage } from "~/lib/villages.server";
import { and, asc, count, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "~/lib/db/client.server";
import { entries, profiles, segments, user, villages } from "~/lib/db/schema";
import { publicTopicPlace } from "~/lib/visibility.server";
import { afterPageBoundary } from "~/lib/page-boundary.server";
import { canSeeHidden, getViewer } from "~/lib/roles.server";
import { joinBlocks, mdBlock, type FmValue } from "~/lib/md/frontmatter.server";
import { loadMdTranslations, type MdTranslation } from "~/lib/md/translations.server";
import { isoSeconds, mdUrl, replyCanonical, siteUrl, threadCanonical, twinPreamble } from "~/lib/md/urls.server";
import { listAlternativeRefs, listObjectionRefs } from "~/lib/objections.server";
import { pageCount, REPLIES_PER_PAGE } from "~/lib/pagination";
import { segmentId } from "~/lib/segment";
import type { Area, Lang } from "~/lib/languages";
import { loadReactions } from "~/lib/votes.server";
import { relatedMarkdownBlock } from "~/lib/md/related.server";
import { enabledTargetLangs } from "~/lib/enabled-langs.server";
import { hasUndeletedReply } from "~/lib/reply-placeholders.server";
import { availabilityKey, loadTranslationAvailability } from "~/lib/translation-availability.server";
import { enabledLangs } from "~/lib/enabled-langs.server";
import { loadThreadOverviewCounts } from "~/lib/thread-overview.server";
import { readPostTranslationWait } from "~/lib/translation-wait.server";
import { translationWaitForAvailability } from "~/lib/translation-wait";
import { unicodeReviewCounts, unicodeReviewReasons } from "~/lib/unicode-review";

// Thread Markdown twin /t/:id.md: per-post frontmatter/body blocks separated by blank lines.
// Topic type:post, replies type:comment, followed immediately by requested ?lang= translations (type:translation); finish with
// type:index paging block. Replies paged by 100 (?page=); topic appears on page 1 only.
// Deleted replies with undeleted children retain placeholders with reply id/parent and deleted:true, no body/author.
// Moderation-hidden topics/replies likewise retain only hidden:true placeholders, without body/title/author/translations/votes.
// Twins do not expose hidden content even to its author or assigned moderator; only the screen may show it.
// Paging counts deleted and hidden replies like screen paging. canonical page equals the twin page.
//
// Questions: topic frontmatter has asks_stance:true and all visible/undeleted alternatives newest first,
// in frontmatter only. Alternative questions carry alt_of:p-<original-question-id>. Replies carry author-named stance_tag, never matched to unnamed stance choices.
// At the end of question page 1, immediately before paging type:index, append the objection-marked reply list. Do not expose lock state/time.
// Omit these fields on non-questions, and marks on hidden/deleted placeholders. Distribution has a separate endpoint and is never included here.
//
// Overview: every page of a readable thread starts with a type:index block (after the fixed warning) that counts what the reader can read now: replies_readable,
// reply_langs (in how many original languages they are written; a number only, never a count per language), and for questions stance_tags and alternatives_readable, then page, pages, replies_on_page and next. It counts only replies that are neither deleted nor hidden
// and shows nothing about the others; it is not a record of what any reader has processed. A hidden topic gets no overview. Paging and placeholders are unchanged.
// Posts whose title or body match a rule of lib/unicode-review.ts carry unicode_review_reasons: candidates for a person to check, not findings. The text is never altered.

export type ThreadMdOptions = {
  readingMethod?: ReadingMethod;
  page: number;
  // Append translations after each original; "all" selects every enabled language, null means original only.
  lang: Lang | "all" | null;
  // The reader's resolved language for related-discussion titles when all translations are requested.
  displayLang?: Lang;
  // ?sentences=1 adds original sentence ids (s-<idx>@<version>) to frontmatter.
  sentences: boolean;
  // The received k after ?k= authentication, carried to next-page and other links.
  k: string | null;
  readLangs?: readonly Lang[];
  // Authenticated reader; also used for village metadata on hidden topics, whose content stays redacted.
  readerId?: string;
};

type Row = {
  id: number;
  kind: string;
  lang: string;
  langCode?: string | null;
  title: string | null;
  body: string;
  parentId: number | null;
  authorId: string;
  handle: string | null;
  authorArea: string | null;
  aiAssistance: string | null;
  via: string;
  sourceHash: string | null;
  createdAt: Date;
  editedAt: Date | null;
  deletedAt: Date | null;
  hiddenAt: Date | null;
  asksStance: boolean;
  altOf: number | null;
  stanceTag: string | null;
};

const columns = {
  id: entries.id,
  kind: entries.kind,
  lang: entries.lang,
  langCode: entries.langCode,
  title: entries.title,
  body: entries.body,
  parentId: entries.parentId,
  authorId: entries.authorId,
  handle: retainedAuthorColumn(entries.authorId, profiles.handle, "handle"),
  authorArea: entries.authorArea,
  aiAssistance: entries.aiAssistance,
  via: entries.via,
  sourceHash: entries.sourceHash,
  createdAt: entries.createdAt,
  editedAt: entries.editedAt,
  deletedAt: entries.deletedAt,
  hiddenAt: entries.hiddenAt,
  asksStance: entries.asksStance,
  altOf: entries.altOf,
  stanceTag: entries.stanceTag,
};

// Share the topic target and content visibility with click-issued public links.
async function readThreadTopic(db: Db, threadId: number) {
  const [topic] = await db.select({ ...columns, villageId: entries.villageId, villageKind: villages.kind }).from(entries)
    .leftJoin(profiles, eq(profiles.userId, entries.authorId)).leftJoin(villages, eq(villages.id, entries.villageId))
    .where(and(eq(entries.id, threadId), eq(entries.kind, "topic"), isNull(entries.deletedAt), publicTopicPlace()));
  return topic;
}
const contentShown = (row: { deletedAt: Date | null; hiddenAt: Date | null }) => row.deletedAt === null && row.hiddenAt === null;

export async function canReadThreadPublicly(db: Db, threadId: number): Promise<boolean> {
  const topic = await readThreadTopic(db, threadId);
  return !!topic && contentShown(topic);
}

// Sentence id: s-<idx>@<first-8-source-version-characters>. Return null without source_hash: never issue unversioned sentence ids.
export function versionOf(sourceHash: string | null): string | null {
  return sourceHash ? sourceHash.slice(0, 8) : null;
}

// Thread twin: null/404 for missing/deleted topics or out-of-range pages.
export async function buildThreadMarkdown(db: Db, threadId: number, opts: ThreadMdOptions): Promise<string | null> {
  // Topic, reply total and current-page replies are independent. Pages partition 100 replies ordered by createdAt/id, including deleted replies.
  const offset = (opts.page - 1) * REPLIES_PER_PAGE;
  const replyFilter = and(eq(entries.threadId, threadId), eq(entries.kind, "reply"));
  const boundary = offset ? db.select({ createdAt: entries.createdAt, id: entries.id }).from(entries)
    .where(replyFilter).orderBy(asc(entries.createdAt), asc(entries.id)).limit(1).offset(offset - 1) : undefined;
  const [topic, [{ n: total }], replies] = await Promise.all([
    readThreadTopic(db, threadId),
    db.select({ n: count() }).from(entries).where(replyFilter),
    db
      .select({ ...columns, hasUndeletedChild: hasUndeletedReply() })
      .from(entries)
      .leftJoin(profiles, eq(profiles.userId, entries.authorId))
      .where(and(replyFilter, afterPageBoundary([entries.createdAt, entries.id], boundary)))
      .orderBy(asc(entries.createdAt), asc(entries.id))
      .limit(REPLIES_PER_PAGE) as Promise<Array<Row & { hasUndeletedChild: boolean }>>,
  ]);
  if (!topic) return null;
  const pages = pageCount(Number(total), REPLIES_PER_PAGE);
  if (opts.page > pages) return null;

  // Question page 1: alternatives and objection lists; skip reading them for hidden questions with placeholder-only twins.
  const isQuestion = topic.asksStance && topic.hiddenAt === null;
  // The overview counts alternatives on every page; the objection list stays on page 1.
  const [alternatives, objections, overview] = await Promise.all([
    isQuestion ? listAlternativeRefs(db, threadId) : [],
    isQuestion && opts.page === 1 ? listObjectionRefs(db, threadId) : [],
    topic.hiddenAt === null ? loadThreadOverviewCounts(db, threadId, { question: isQuestion }) : null,
  ]);

  // Only posts whose content is shown; deleted replies and hidden posts are placeholders.
  const isShown = contentShown;
  const shownRows: Row[] = [...(opts.page === 1 ? [topic] : []), ...replies].filter(isShown);
  const historyCounts = await revisionCounts(db, shownRows.map(e => e.id));
  const names = await loadDisplayNames(db, [...shownRows.map(e => e.handle), ...alternatives.map(a => a.authorHandle), ...objections.map(o => o.authorHandle)]);
  const inputs = shownRows.map((e) => ({ id: e.id, lang: e.lang as Lang, sourceHash: e.sourceHash }));
  type SentenceRow = { entryId: number; idx: number; start: number; end: number };
  const [reactions, tr, sentenceRows] = await Promise.all([
    loadReactions(db, shownRows.map((e) => ({ id: e.id })), null),
    loadMdTranslations(db, inputs, opts.lang),
    opts.sentences && shownRows.length > 0
      ? db
          .select({ entryId: segments.entryId, idx: segments.idx, start: segments.start, end: segments.end })
          .from(segments)
          .where(inArray(segments.entryId, shownRows.map((e) => e.id)))
          .orderBy(asc(segments.entryId), asc(segments.idx))
      : Promise.resolve<SentenceRow[]>([]),
  ]);
  const sentencesOf = new Map<number, SentenceRow[]>();
  for (const s of sentenceRows) {
    const list = sentencesOf.get(s.entryId);
    if (list) list.push(s);
    else sentencesOf.set(s.entryId, [s]);
  }

  let showVillage = false;
  const availability = await loadTranslationAvailability(db, inputs, enabledLangs(), tr.langs);
  // Remembered for a minute and never throws: a ledger that cannot be read leaves out the reason, it does not fail the page.
  const wait = await readPostTranslationWait(async () => db);
  if (villagesEnabled()) {
    showVillage = topic.hiddenAt === null || opts.readerId === topic.authorId;
    if (!showVillage && opts.readerId) {
      const [account] = await db.select({ id: user.id, email: user.email }).from(user).where(eq(user.id, opts.readerId));
      showVillage = !!account && canSeeHidden(await getViewer(db, account), topic);
    }
  }
  const village = showVillage ? await topicVillage(db, threadId) : null;
  const blocks: string[] = [];
  // Only the first block includes a fixed warning as the first line inside its frame.
  const firstBlock = () => (blocks.length === 0 ? { preamble: twinPreamble() } : {});

  const reviewReasonsOf = (e: Row) => {
    const reasons = unicodeReviewReasons(unicodeReviewCounts(e.title, e.body));
    return reasons.length > 0 ? reasons : undefined;
  };
  const link = (page: number) => mdUrl(`/t/${threadId}.md`, { k: opts.k, lang: opts.lang, sentences: opts.sentences, page });

  // The overview block comes first and carries the fixed warning. It is not built for a hidden topic.
  if (overview) {
    const shownOnPage = replies.filter(isShown).map((r) => `c-${r.id}`);
    const nextPage = opts.page < pages ? link(opts.page + 1) : undefined;
    blocks.push(
      mdBlock(
        {
          type: "index",
          thread: `p-${threadId}`,
          replies_readable: overview.replies,
          reply_langs: overview.langs,
          ...(isQuestion ? { stance_tags: overview.stanceTags, alternatives_readable: alternatives.length } : {}),
          page: opts.page,
          pages,
          replies_on_page: shownOnPage,
          next: nextPage,
          content_trust: "untrusted_user_content",
        },
        `Counts cover only the replies that can be read now (not deleted, not hidden). This is not a record of what any reader has read or processed.${isQuestion ? ` The distribution of stances is separate: ${siteUrl(`/t/${threadId}/stances.md`)}` : ""}`,
        firstBlock(),
      ),
    );
  }

  const entryBlock = (e: Row, canonical: string): string => {
    const isTopic = e.kind === "topic";
    const version = versionOf(e.sourceHash);
    const sentences = sentencesOf.get(e.id);
    const pendingLangs = enabledTargetLangs(e.lang).filter((lang) => !tr.langs.get(e.id)?.includes(lang) && availability.get(availabilityKey(e.id, lang)) !== "unavailable");
    const fields: { [key: string]: FmValue | undefined } = {
      type: isTopic ? "post" : "comment",
      ...(isTopic && village ? { village: village.slug ?? undefined } : {}),
      id: `${isTopic ? "p" : "c"}-${e.id}`,
      // A topic without a title has no title key (the body starts the text). A reader takes a missing key as "no title".
      title: isTopic ? (e.title ?? undefined) : undefined,
      lang: e.lang,
      ...(e.langCode ? { lang_code: e.langCode } : {}),
      thread: `p-${threadId}`,
      // Replies without an explicit parent reply target the topic.
      reply_to: isTopic ? null : e.parentId !== null ? `c-${e.parentId}` : `p-${threadId}`,
      author: authorLabel(e.handle),
      ...displayNameFields(names.get(e.handle ?? "")),
      author_area: (e.authorArea as Area | null) ?? null,
      endorsed: true,
      // Only when the post states one (frontmatter or the API); the line is omitted otherwise.
      ai_assistance: e.aiAssistance ?? undefined,
      via: e.via,
      // Topic questions: asks_stance, original question id for alternatives and alternatives list. Replies: author-chosen mark.
      asks_stance: isTopic && e.asksStance ? true : undefined,
      alt_of: isTopic && e.altOf !== null ? `p-${e.altOf}` : undefined,
      alternatives:
        isTopic && e.asksStance
          ? alternatives.map((a) => ({
              id: `p-${a.id}`,
              title: a.title,
              lang: a.lang,
              author: authorLabel(a.authorHandle),
              ...displayNameFields(names.get(a.authorHandle)),
              // Carry ?lang= like lists/objection blocks. Links to different threads omit ?sentences= and ?page=.
              md: mdUrl(`/t/${a.id}.md`, { k: opts.k, lang: opts.lang }),
              canonical: threadCanonical(a.id),
            }))
          : undefined,
      stance_tag: !isTopic && e.stanceTag !== null ? e.stanceTag : undefined,
      canonical,
      timestamp: isoSeconds(e.createdAt),
      edited: e.editedAt ? isoSeconds(e.editedAt) : undefined,
      updated_at: e.editedAt ? isoSeconds(e.editedAt) : isoSeconds(e.createdAt),
      revision_count: historyCounts.get(e.id) ?? 1,
      history: mdUrl(`${historyPath(e.kind, e.id)}.md`, { k: opts.k, lang: null }),
      version: version ?? undefined,
      translations: tr.langs.get(e.id) ?? [],
      translations_pending: pendingLangs,
      // A language can be paused independently of the scope's budget. No cause or date is disclosed.
      translations_pending_reason: pendingLangs.some(lang => translationWaitForAvailability(wait, availability.get(availabilityKey(e.id, lang))).kind === "stopped") ? "unavailable" : undefined,
      translations_unavailable: enabledTargetLangs(e.lang).filter((lang) => !tr.langs.get(e.id)?.includes(lang) && availability.get(availabilityKey(e.id, lang)) === "unavailable"),
      // "Insightful": the total, and from how many languages (nothing per language). Both 0 when nobody pressed it.
      insightful: reactions.get(e.id)?.insightful.total ?? 0,
      insightful_langs: reactions.get(e.id)?.insightful.langs ?? 0,
      // Candidates for a person to check (only the original title and body are judged); omitted when nothing matches.
      unicode_review_reasons: reviewReasonsOf(e),
      // Only original bodies with sentence segments; translations have none. Omit without a version.
      sentences:
        opts.sentences && version && sentences
          ? sentences.map((s) => ({ id: `${segmentId(s.idx)}@${version}`, start: s.start, end: s.end }))
          : undefined,
      content_trust: "untrusted_user_content",
    };
    return mdBlock(fields, e.body, firstBlock());
  };

  const translationBlock = (e: Row, t: MdTranslation, canonical: string): string =>
    mdBlock(
      {
        type: "translation",
        translation_id: t.id,
        title_translation_id: t.titleId ?? undefined,
        source_version: t.sourceHash ?? undefined,
        translation_of: `${e.kind === "topic" ? "p" : "c"}-${e.id}`,
        lang: t.lang,
        status: t.status,
        engine: t.engine,
        model: t.model,
        fallback: t.fallback ? true : undefined,
        title: e.kind === "topic" ? (t.title ?? undefined) : undefined,
        stale: t.stale ? true : undefined,
        structure_mismatch: t.structureMismatch ? true : undefined,
        // Report notices, only when present: open means unresolved report, check original; retranslated means retried by a higher-tier model after a report.
        report: t.report ?? undefined,
        canonical,
        content_trust: "untrusted_user_content",
      },
      t.text,
    );

  if (opts.page === 1) {
    const canonical = threadCanonical(threadId);
    if (topic.hiddenAt !== null) {
      blocks.push(
        mdBlock({ type: "post", id: `p-${threadId}`, thread: `p-${threadId}`, hidden: true, ...(village ? { village: village.slug ?? undefined } : {}), content_trust: "untrusted_user_content" }, null, firstBlock()),
      );
    } else {
      blocks.push(entryBlock(topic, canonical));
      for (const t of tr.shown.get(topic.id) ?? []) blocks.push(translationBlock(topic, t, canonical));
    }
  }
  for (const reply of replies) {
    if (reply.deletedAt !== null && !reply.hasUndeletedChild) continue;
    if (!isShown(reply)) {
      blocks.push(
        mdBlock(
          {
            type: "comment",
            id: `c-${reply.id}`,
            thread: `p-${threadId}`,
            reply_to: reply.parentId !== null ? `c-${reply.parentId}` : `p-${threadId}`,
            ...(reply.deletedAt !== null ? { deleted: true } : { hidden: true }),
            content_trust: "untrusted_user_content",
          },
          null,
          firstBlock(),
        ),
      );
      continue;
    }
    // Like screen paging, count deleted/hidden replies; canonical page equals this twin page.
    const canonical = replyCanonical(threadId, reply.id, opts.page);
    blocks.push(entryBlock(reply, canonical));
    for (const t of tr.shown.get(reply.id) ?? []) blocks.push(translationBlock(reply, t, canonical));
  }

  // End of question page 1: objection-reply list, including an empty list if none.
  if (isQuestion && opts.page === 1) {
    blocks.push(
      mdBlock(
        {
          type: "index",
          thread: `p-${threadId}`,
          objections: objections.map((o) => ({
            id: `c-${o.id}`,
            author: authorLabel(o.authorHandle),
            ...displayNameFields(names.get(o.authorHandle)),
            md: mdUrl(`/t/${threadId}.md`, { k: opts.k, lang: opts.lang, sentences: opts.sentences, page: o.page }),
            canonical: replyCanonical(threadId, o.id, o.page),
          })),
          content_trust: "untrusted_user_content",
        },
        null,
      ),
    );
  }

  if (opts.page === 1 && topic.hiddenAt === null) {
    const { block } = await relatedMarkdownBlock(db, threadId, {
      ...opts, lang: opts.lang === "all" ? opts.displayLang ?? null : opts.lang, linkLang: opts.lang, inline: true,
    });
    if (block) blocks.push(block);
  }
  const next = opts.page < pages ? link(opts.page + 1) : null;
  blocks.push(
    mdBlock(
      { type: "index", thread: `p-${threadId}`, page: opts.page, page_count: pages, next, content_trust: "untrusted_user_content" },
      next ? `Next page: ${next}` : "End of thread.",
    ),
  );
  const markdown = joinBlocks(blocks);
  if (opts.readingMethod && opts.page === 1) await countReading(db, threadId, { method: opts.readingMethod, readerId: opts.readerId,
    lang: opts.lang === "all" ? opts.displayLang ?? topic.lang as Lang : opts.lang ?? topic.lang as Lang });
  return markdown;
}
