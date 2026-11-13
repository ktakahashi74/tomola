import { postAiMaterials } from "./db/schema";
import { resolvePostLanguage } from "./lang-detect";
import { retainedAuthorColumn } from "./deleted-member.server";
import { withinEditGrace } from "./entry-history.server";
import { inspectEntrySpam, lockAbuseWriter } from "./moderation-automation.server";
import { safeErrorText } from "~/lib/error-text.server";
import { syncMediaReferences } from "~/lib/media-references.server";
import { activeEntryRender, prepareEntryRender, renderEntryForWrite, type PreparedEntryRender } from "./entry-render-preparation.server";
import { withMarkdownScope, withMarkdownRead, MarkdownBudgetError } from "./markdown-budget.server";
import { and, asc, count, desc, eq, inArray, isNotNull, isNull, lte, max, notInArray, or, sql, lt, type SQL } from "drizzle-orm";
import { villagesEnabled } from "~/lib/villages-enabled.server";
import { activePublicPostVillageCondition, activeSharedVillageCondition, lockVillageProfile, villageForTopic } from "~/lib/villages.server";
import { z } from "zod";
import { AI_ASSISTANCE, type AiAssistance } from "~/lib/ai-assistance";
import type { Db, Tx } from "~/lib/db/client.server";
import { divergences, entries, entryRevisions, follows, profiles, reports, topicListingStats, translations, villageFollows, villageMembers, villages, type SavedMentionBinding } from "~/lib/db/schema";
import { enabledLangs } from "~/lib/enabled-langs.server";
import { SOURCE_LANGS, type SourceLang, type LangSource, type Area, type Lang } from "~/lib/languages";
import { canSeeHidden, inScope, type Viewer } from "~/lib/roles.server";
import { checkStanceAttributes, STANCE_TAGS, type StanceAttrError, type StanceTag } from "~/lib/stances";
import { loadStanceAttrFacts, touchAltOriginal, touchQuestion } from "~/lib/questions.server";
import { checkPagination, pageCount, REPLIES_PER_PAGE } from "~/lib/pagination";
import { publicTopicPlace, rootTopic, rootTopicOn, undeletedTopic } from "~/lib/visibility.server";
import { afterPageBoundary } from "~/lib/page-boundary.server";
import { hasUndeletedReply } from "~/lib/reply-placeholders.server";
import {
  checkBodyBudget,
  renderEntryOrPlain,
  renderMarkdownOrPlain,
  renderMarkdownResult,
  RENDER_VERSION,
  tryRenderEntry,
  tryRenderMarkdown,
  type RenderedEntry,
} from "~/lib/markdown.server";
import { sourceHash } from "~/lib/source-hash.server";
import { entryEditVersion } from "~/lib/entry-edit-version.server";
import { matchMentions, type MentionTargets } from "~/lib/mentions-md.server";
import { bindMentionSpellings, readMentionBindings, resolveSavedMentionsFor, storeMentionSnapshot } from "~/lib/mentions.server";
import { autoFollow, unreadFollowedTopicCondition } from "~/lib/follows.server";
import { notifyForNewEntry, notifyMentions } from "~/lib/notifications.server";
import { setCarriedLang } from "~/lib/reading-lang";
import { enqueueEmbedding } from "~/lib/embeddings.server";
import { lockReferenceTopics, syncEntryReferences, touchReferenceTopics } from "~/lib/related-discussions.server";
import { cancelEntryJobs, carryOverUnchangedFields, enqueueTranslations, markHumanTranslationsStale, purgeEntryDerivatives, replaceSegments, resolveTitleReports } from "~/lib/translations.server";

export { AI_ASSISTANCE, type AiAssistance };

// Entry visibility for this viewer. visible: normal entry. hidden: hidden by moderation but readable by the author, assigned moderators, or operators, with a 「非表示」 marker.
// hidden-redacted: hidden and unreadable by this viewer, returning empty body/title/author etc. deleted: deleted, retaining only the reply position with empty content.
export type EntryVisibility = "visible" | "hidden" | "hidden-redacted" | "deleted";

export type EntryView = {
  id: number;
  visibility: EntryVisibility;
  kind: "topic" | "reply";
  lang: SourceLang;
  langCode?: string | null;
  title: string | null;
  body: string;
  // Rendered HTML, either cached or rendered and saved if absent.
  html: string;
  authorId: string;
  authorHandle: string;
  parentId: number | null;
  // The value from frontmatter or the API; null when none was stated (posts written on screen carry none).
  aiAssistance: AiAssistance | null;
  createdAt: Date;
  // Last versioned edit; null during the initial correction window.
  editedAt: Date | null;
  // Current source revision (title/body/language), used to identify translations of the current source.
  sourceHash: string | null;
  // Question status (stance-requesting topic), original question for alternative framings, and reply label. Clear for content-redacted entries (redactedView).
  asksStance: boolean;
  altOf: number | null;
  stanceTag: StanceTag | null;
  // Whether pinned by the first stance from someone other than the author. Return true only to the author and those permitted to fix typos (assigned source-language moderators/operators); always false for other viewers.
  // Never expose the pinning timestamp.
  stanceLocked: boolean;
};
// replies holds the current page (page starts at 1), retaining deleted replies only when an undeleted child refers to them. replyCount counts all undeleted replies (entries.reply_count).
// Pagination counts deleted replies too, matching Markdown order and boundaries. replyTotal counts all replies including deleted ones.
export type Thread = { topic: EntryView; replies: EntryView[]; page: number; pageSize: number; pageCount: number; replyCount: number; replyTotal: number };
export type TopicSummary = {
  id: number;
  // Hidden topic, included in listings only if this viewer may see it.
  hidden: boolean;
  lang: SourceLang;
  langCode?: string | null;
  // null: a topic without a title (a short remark). Show `loadTitleDisplays` (the title, or the beginning of the body) where a line is needed.
  title: string | null;
  sourceHash: string | null;
  authorId: string;
  authorHandle: string;
  replyCount: number;
  // When the topic was posted (the "new posts" order of the home sorts by it) and when it last had activity (the "recent replies" order).
  createdAt: Date;
  lastActivityAt: Date;
  // Whether the topic asks for a stance (a question).
  asksStance: boolean;
};
export type EntryVia = "web" | "api";
export type EntryError =
  | "village_changed"
  | "village_required"
  | "invalid_intro"
  | "invalid_title"
  | "body_required"
  | "body_too_long"
  | "body_unrenderable"
  | "body_too_complex"
  | "invalid_lang"
  | "invalid_ai"
  | "thread_not_found"
  | "parent_not_in_thread"
  // Invalid question/reply-label attribute combinations (checkStanceAttributes in app/lib/stances.ts).
  | StanceAttrError;
// Edit errors beyond invalid input. not_found: absent, deleted, or wrong kind (topic/reply). forbidden: not the author.
// locked: attempted title/body change on a question pinned by a stance. Add details in replies; create an alternative framing to change the proposition or conditions.
export type EditError = EntryError | "not_found" | "forbidden" | "locked" | "edit_conflict";
type Result = { ok: true; id: number } | { ok: false; error: EntryError; village?: string };

export const MAX_BODY_LENGTH = 50_000;
export const MAX_TITLE_LENGTH = 200;

// Footnote-id prefix. Vary by entry because a page displays multiple entries; render after the id is assigned.
// Passing lang prefixes translated bodies with `p-<id>-<lang>-`, avoiding collisions with source `p-<id>-` on the same page
// which contains both source and translated HTML for toggling.
export function entryIdPrefix(kind: "topic" | "reply", id: number, lang?: string): string {
  const base = kind === "topic" ? `p-${id}-` : `c-${id}-`;
  return lang ? `${base}${lang}-` : base;
}

// Author's home area at posting time, copied to entries.author_area. Null without a profile; read within the posting transaction.
async function authorAreaOf(db: Db, authorId: string): Promise<Area | null> {
  const [row] = await db.select({ homeArea: profiles.homeArea }).from(profiles).where(eq(profiles.userId, authorId));
  return (row?.homeArea as Area | undefined) ?? null;
}

// The members of a body that are told: in order of appearance, without the members that only appear inside a block quote (a quote is somebody else's words: it is
// shown as a mention but is not a call; it is not recorded and does not count towards the limit).
async function notifiable(body: string, mentions: MentionTargets): Promise<string[]> {
  return (await matchMentions(body, mentions)).filter((m) => !m.quoted).map((m) => m.userId);
}

const common = {
  // Original languages are independent of the enabled translation and interface languages.
  lang: z.enum(SOURCE_LANGS),
  langCode: z.string().regex(/^[a-z]{2,3}$/).nullish(),
  langSource: z.enum(["explicit", "detected", "default", "checked"]).optional(),
  // Preserve the body exactly as submitted; the source is authoritative. Use trim only to check emptiness.
  body: z
    .string()
    .max(MAX_BODY_LENGTH)
    .refine((s) => s.trim().length > 0)
    // PostgreSQL text cannot store NUL (U+0000) and would throw on save. Reject it here as an unrenderable body.
    .refine((s) => !hasNul(s), { message: "nul" }),
  // Optional: a post written on screen states none (stored as null); frontmatter and the API may set one.
  aiAssistance: z.enum(AI_ASSISTANCE).nullish(),
};
// Titles are single-line: reject NUL, newlines, other control characters (C0, DEL, C1, excluding tabs), and line separators U+2028/U+2029
// which normal UI inputs cannot enter, but direct API/form submissions could. Apply the same rules when saving drafts.
export const TITLE_CONTROL = new RegExp("[\\u0000-\\u0008\\u000a-\\u001f\\u007f-\\u009f\\u2028\\u2029]");
// Reject NUL (U+0000) in bodies because PostgreSQL text cannot store it and would throw on save.
export const hasNul = (s: string) => s.includes("\u0000");
// The title is optional: a title that is empty once trimmed means "no title" and is stored as null (never as an empty string).
// When there is one, the rules are the same as before (at most 200 characters, one line, no control characters).
const titleSchema = z
  .string()
  .trim()
  .max(MAX_TITLE_LENGTH)
  .refine((s) => !TITLE_CONTROL.test(s))
  .nullish()
  .transform((s) => (s ? s : null));
const topicSchema = z
  .object({
    ...common,
    title: titleSchema,
    // Whether the topic is a question (it asks for stances). It can be set only when the topic is created and never changes. altOf: the original question that an alternative framing points to (it can be given only when creating).
    asksStance: z.boolean().default(false),
    altOf: z.number().int().positive().nullish(),
    // A topic has no mark (giving one is an error of the attribute combination; it is accepted here and passed to the check, so that the screen and the API drafts are refused with the same class).
    stanceTag: z.enum(STANCE_TAGS).nullish(),
    village: z.unknown().optional(),
  })
  // A question (a topic that asks for stances) must have its title, the proposition. The error class is the same as for a bad title: invalid_title.
  .superRefine((v, ctx) => {
    if (v.asksStance && v.title === null) ctx.addIssue({ code: "custom", path: ["title"], message: "question_needs_title" });
  });
// Replies: labels apply only to replies to questions. asksStance/altOf are unavailable on replies; attempts yield an invalid attribute combination.
const replySchema = z.object({
  ...common,
  parentId: z.number().int().positive().optional(),
  stanceTag: z.enum(STANCE_TAGS).nullish(),
  asksStance: z.boolean().default(false),
  altOf: z.number().int().positive().nullish(),
});

function fieldError(issues: z.core.$ZodIssue[]): Exclude<EntryError, "invalid_intro" | "village_required" | "village_changed"> {
  const field = issues[0]?.path[0];
  if (field === "title") return "invalid_title";
  if (field === "lang") return "invalid_lang";
  if (field === "aiAssistance") return "invalid_ai";
  if (field === "asksStance") return "invalid_asks_stance";
  if (field === "altOf") return "invalid_alt_of";
  if (field === "stanceTag") return "invalid_stance_tag";
  if (issues[0]?.code === "custom" && issues[0].message === "nul") return "body_unrenderable";
  return issues[0]?.code === "too_big" ? "body_too_long" : "body_required";
}

// Validate entry input without saving, using createTopic/createReply rules for title, body, language, AI disclosure, and renderability.
// Used to validate API drafts before creation like UI posts. For replies, callers check target existence; this function does not.
export async function checkEntryInput(kind: "topic" | "reply", input: unknown, member?: string): Promise<Exclude<EntryError, "invalid_intro" | "village_required" | "village_changed"> | null> {
  const parsed = (kind === "topic" ? topicSchema : replySchema).safeParse(input);
  if (!parsed.success) return fieldError(parsed.error.issues);
  return checkBodyBudget(parsed.data.body, member);
}

async function createTopicImplementation(
  db: Db,
  authorId: string,
  input: unknown,
  opts: { now?: Date; via?: EntryVia; asIntroduction?: boolean; villageId?: string | null; villageDisplayed?: string; responseTo?: number | null } = {},
): Promise<Result> {
  const parsed = topicSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: fieldError(parsed.error.issues) };
  if (opts.asIntroduction && (parsed.data.asksStance || parsed.data.altOf != null)) return { ok: false, error: "invalid_intro" };
  const bodyError = await checkBodyBudget(parsed.data.body, authorId);
  if (bodyError) return { ok: false, error: bodyError };
  const renderInput = { kind: "topic" as const, body: parsed.data.body, lang: parsed.data.lang };
  const prepared = activeEntryRender(renderInput) ?? await prepareEntryRender(db, renderInput);
  const now = opts.now ?? new Date();
  const hash = sourceHash(parsed.data.title, parsed.data.body, parsed.data.lang);
  const { asksStance } = parsed.data;
  const altOf = parsed.data.altOf ?? null;
  // Create the entry, render cache, sentence boundaries, and translation jobs in one transaction, avoiding an entry without queued translation.
  const created = await db.transaction(async (tx) => {
    await lockAbuseWriter(tx, authorId);
    if (villagesEnabled()) await lockVillageProfile(tx, authorId);
    await lockReferenceTopics(tx, { body: parsed.data.body });
    const bindings = await bindMentionSpellings(tx, parsed.data.body);
    // Alternative framing: read and lock the original question with FOR NO KEY UPDATE to serialize concurrent hiding/deletion, then check attribute combinations.
    const facts = await loadStanceAttrFacts(tx, { kind: "topic", altOf, lockAltTarget: true });
    const attrError = checkStanceAttributes({ kind: "topic", mode: "create", asksStance, altOf, stanceTag: parsed.data.stanceTag ?? null, ...facts });
    if (attrError) return { ok: false as const, error: attrError };
    const destination = villagesEnabled() ? await villageForTopic(tx, authorId, parsed.data.village, opts.villageId) : null;
    const villageId = destination?.id ?? null;
    if (villagesEnabled() && villageId === null) return { ok: false as const, error: "village_required" as const };
    if (destination && opts.villageDisplayed !== undefined && opts.villageDisplayed.trim().toLowerCase() !== destination.slug) {
      return { ok: false as const, error: "village_changed" as const, village: destination.slug ?? "" };
    }
    const [row] = await tx
      .insert(entries)
      .overridingSystemValue()
      .values({
        id: prepared.id,
        kind: "topic",
        authorId,
        lang: parsed.data.lang,
        langCode: parsed.data.lang === "other" ? parsed.data.langCode ?? null : null,
        langSource: parsed.data.langSource ?? "explicit",
        title: parsed.data.title,
        body: parsed.data.body,
        sourceHash: hash,
        aiAssistance: parsed.data.aiAssistance ?? null,
        via: opts.via ?? "web",
        asksStance,
        altOf,
        authorArea: await authorAreaOf(tx, authorId),
        ...(villageId === null ? {} : { villageId }),
        createdAt: now,
        updatedAt: now,
        lastActivityAt: now,
      })
      .returning({ id: entries.id });
    const mentions = await storeMentionSnapshot(tx, { entryId: row.id, revision: 0, sourceHash: hash, body: parsed.data.body, bindings });
    const rendered = await renderEntryForWrite(prepared, { ...renderInput, id: row.id }, bindings, mentions);
    if (rendered.cacheable !== false) {
      await tx.update(entries).set({ html: rendered.html, cardHtml: rendered.cardHtml, htmlVersion: RENDER_VERSION }).where(eq(entries.id, row.id));
    }
    await replaceSegments(tx, row.id, parsed.data.body, parsed.data.lang);
    const spamHidden = await inspectEntrySpam(tx, { id: row.id, authorId, body: parsed.data.body, sourceHash: hash }, now);
    if (!spamHidden) {
      await enqueueTranslations(tx, { id: row.id, lang: parsed.data.lang, sourceHash: hash });
      await enqueueEmbedding(tx, { id: row.id, sourceHash: hash });
    }
    // The original question's Markdown changes (alternative-framing list), so emit a change for it too through meta_changed_at.
    if (altOf !== null) await touchQuestion(tx, altOf, now);
    await syncEntryReferences(tx, row.id, now);
    await syncMediaReferences(tx, row.id, parsed.data.body);
    // The author follows their own topic (a topic they took off is never followed again: autoFollow leaves an existing row alone). notifyForNewEntry is called for a topic
    // too, as the one place that tells the members mentioned in the body.
    await autoFollow(tx, authorId, row.id, now);
    if (!spamHidden) await notifyForNewEntry(tx, { entry: { id: row.id, kind: "topic", threadId: row.id, authorId }, responseTo: opts.via === "api" ? null : opts.responseTo, mentioned: (await notifiable(parsed.data.body, mentions)), now });
    if (opts.asIntroduction) await tx.update(profiles).set({ introEntryId: row.id }).where(eq(profiles.userId, authorId));
    return { ok: true as const, id: row.id };
  });
  return created;
}

async function createReplyImplementation(
  db: Db,
  authorId: string,
  threadId: number,
  input: unknown,
  opts: { now?: Date; via?: EntryVia } = {},
): Promise<Extract<Result, { ok: false }> | { ok: true; id: number; followed: boolean }> {
  const parsed = replySchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: fieldError(parsed.error.issues) };
  const bodyError = await checkBodyBudget(parsed.data.body, authorId);
  if (bodyError) return { ok: false, error: bodyError };
  const parentId = parsed.data.parentId ?? null;
  const renderInput = { kind: "reply" as const, body: parsed.data.body, lang: parsed.data.lang };
  const prepared = activeEntryRender(renderInput) ?? await prepareEntryRender(db, renderInput);
  const now = opts.now ?? new Date();
  const hash = sourceHash(null, parsed.data.body, parsed.data.lang);
  // Check topic/reply-target existence and undeleted status within the posting transaction, preventing a reply to a target deleted between validation and insertion.
  // Lock the topic row to serialize concurrent deletion (softDeleteEntry, recomputing topic aggregates) and replies.
  const created = await db.transaction(async (tx) => {
    await lockAbuseWriter(tx, authorId);
    await lockReferenceTopics(tx, { threadId, body: parsed.data.body });
    const bindings = await bindMentionSpellings(tx, parsed.data.body);
    // Lock the topic with FOR NO KEY UPDATE, serializing reply creation and deletion recounts without conflicting with foreign-key KEY SHARE checks.
    // Cannot reply to deleted or hidden topics. Keep hidden topics from sustaining discussion while their content is unavailable.
    const [topic] = await tx
      .select({ id: entries.id, authorId: entries.authorId, asksStance: entries.asksStance })
      .from(entries)
      .where(and(eq(entries.id, threadId), eq(entries.kind, "topic"), isNull(entries.deletedAt), isNull(entries.hiddenAt)))
      .for("no key update");
    if (!topic) return { ok: false as const, error: "thread_not_found" as const };
    // Reply labels apply only to replies to questions. Validate asks_stance read under the topic-row lock.
    const stanceTag = parsed.data.stanceTag ?? null;
    const attrError = checkStanceAttributes({
      kind: "reply",
      mode: "create",
      asksStance: parsed.data.asksStance,
      altOf: parsed.data.altOf ?? null,
      stanceTag,
      threadAsksStance: topic.asksStance,
    });
    if (attrError) return { ok: false as const, error: attrError };
    // The reply target must be an undeleted, unhidden entry in this topic; deleted/hidden replies cannot receive replies.
    let parentAuthorId: string | null = null;
    if (parentId !== null) {
      const [parent] = await tx
        .select({ id: entries.id, authorId: entries.authorId })
        .from(entries)
        .where(and(eq(entries.id, parentId), eq(entries.threadId, threadId), isNull(entries.deletedAt), isNull(entries.hiddenAt)));
      if (!parent) return { ok: false as const, error: "parent_not_in_thread" as const };
      parentAuthorId = parent.authorId;
    }
    const [row] = await tx
      .insert(entries)
      .overridingSystemValue()
      .values({
        id: prepared.id,
        kind: "reply",
        threadId,
        parentId,
        authorId,
        lang: parsed.data.lang,
        langCode: parsed.data.lang === "other" ? parsed.data.langCode ?? null : null,
        langSource: parsed.data.langSource ?? "explicit",
        body: parsed.data.body,
        sourceHash: hash,
        aiAssistance: parsed.data.aiAssistance ?? null,
        via: opts.via ?? "web",
        stanceTag,
        authorArea: await authorAreaOf(tx, authorId),
        createdAt: now,
        updatedAt: now,
        lastActivityAt: now,
      })
      .returning({ id: entries.id });
    const mentions = await storeMentionSnapshot(tx, { entryId: row.id, revision: 0, sourceHash: hash, body: parsed.data.body, bindings });
    const rendered = await renderEntryForWrite(prepared, { ...renderInput, id: row.id }, bindings, mentions);
    if (rendered.cacheable !== false) {
      await tx.update(entries).set({ html: rendered.html, cardHtml: rendered.cardHtml, htmlVersion: RENDER_VERSION }).where(eq(entries.id, row.id));
    }
    await replaceSegments(tx, row.id, parsed.data.body, parsed.data.lang);
    const spamHidden = await inspectEntrySpam(tx, { id: row.id, authorId, body: parsed.data.body, sourceHash: hash }, now);
    if (!spamHidden) {
      await enqueueTranslations(tx, { id: row.id, lang: parsed.data.lang, sourceHash: hash });
      await enqueueEmbedding(tx, { id: row.id, sourceHash: hash });
    }
    await syncEntryReferences(tx, row.id, now);
    await syncMediaReferences(tx, row.id, parsed.data.body);
    // Update listing aggregates (reply count and last activity) incrementally. The topic-row lock serializes concurrent replies so none are missed.
    await tx
      .update(entries)
      .set({
        replyCount: sql`${entries.replyCount} + 1`,
        historyStartedAt: sql`coalesce(${entries.historyStartedAt}, ${now.toISOString()}::timestamptz)`,
        lastActivityAt: sql`greatest(${entries.lastActivityAt}, ${now.toISOString()}::timestamptz)`,
      })
      .where(eq(entries.id, threadId));
    if (parentId !== null) await tx.update(entries)
      .set({ historyStartedAt: sql`coalesce(${entries.historyStartedAt}, ${now.toISOString()}::timestamptz)` })
      .where(eq(entries.id, parentId));
    // The replier follows the topic they replied to (unless they took it off). Then the notifications, in the same transaction: the author of the topic and of the replied-to reply,
    // then the followers of the topic (notifyForNewEntry: a reply notification is sent instead of followed_thread, never both; the author is never notified).
    const followed = await autoFollow(tx, authorId, threadId, now);
    if (!spamHidden) await notifyForNewEntry(tx, { entry: { id: row.id, kind: "reply", threadId, authorId }, topicAuthorId: topic.authorId, parentAuthorId, mentioned: (await notifiable(parsed.data.body, mentions)), now });
    return { ok: true as const, id: row.id, followed };
  });
  return created;
}

// Recompute topic reply_count/last_activity_at from undeleted replies. Used by reply deletion (softDeleteEntry; other deleted_at writers must
// call this after deletion in the same transaction). Creation updates incrementally and does not need this. Lock the topic to serialize concurrent creation/deletion.
export async function recomputeThreadActivity(db: Db, threadId: number): Promise<void> {
  await db.transaction(async (tx) => {
    const [topic] = await tx
      .select({ createdAt: entries.createdAt })
      .from(entries)
      .where(and(eq(entries.id, threadId), eq(entries.kind, "topic")))
      .for("update");
    if (!topic) return;
    const [stats] = await tx
      .select({ replyCount: count(), lastReplyAt: max(entries.createdAt) })
      .from(entries)
      .where(and(eq(entries.threadId, threadId), eq(entries.kind, "reply"), isNull(entries.deletedAt)));
    const lastReplyAt = stats.lastReplyAt ? new Date(stats.lastReplyAt) : null;
    await tx
      .update(entries)
      .set({
        replyCount: Number(stats.replyCount),
        lastActivityAt: lastReplyAt && lastReplyAt > topic.createdAt ? lastReplyAt : topic.createdAt,
      })
      .where(eq(entries.id, threadId));
  });
}

// Soft-delete a topic/reply by setting deleted_at. Callers check authority: deleteOwnEntry for authors, deleteEntry for operators.
// Perform the following in the same transaction:
//   - For replies, recompute topic reply_count/last_activity_at to keep listing aggregates consistent.
//   - Delete all translation kinds, sentence boundaries, disagreements, and render caches, keeping them out of Markdown and translation context.
//   - Cancel queued translation/measurement jobs; running jobs must not save translations for deleted entries when finishing.
//   - Close unresolved entry reports (reports.status and handler). Author deletion dismisses without handledBy; operator deletion resolves with the actor.
//   - For alternative-framing questions, advance the original's meta_changed_at (touchQuestion) so it appears in the changes feed and manifest.
// Retain votes, which appear nowhere because the entry is unreadable. moderationActionId identifies operator deletion for reversal after appeal only while that deletion persists.
export async function softDeleteEntry(
  db: Db,
  entryId: number,
  opts: { now?: Date; reports?: { status: "resolved" | "dismissed"; by: string | null }; moderationActionId?: number } = {},
): Promise<{ ok: true; threadId: number } | { ok: false; error: "not_found" }> {
  return db.transaction(async (tx) => {
    const now = opts.now ?? new Date();
    await lockReferenceTopics(tx, { entryId });
    const [row] = await tx
      .update(entries)
      .set({
        deletedAt: now,
        ...(opts.moderationActionId !== undefined ? { moderationActionId: opts.moderationActionId, moderatedAt: now } : {}),
      })
      .where(and(eq(entries.id, entryId), isNull(entries.deletedAt)))
      .returning({ id: entries.id, kind: entries.kind, threadId: entries.threadId, altOf: entries.altOf });
    if (!row) return { ok: false as const, error: "not_found" as const };
    if (row.kind === "topic" && opts.moderationActionId === undefined) await tx.delete(postAiMaterials).where(eq(postAiMaterials.topicId, row.id));
    if (row.kind === "reply" && row.threadId !== null) await recomputeThreadActivity(tx, row.threadId);
    // Deleting an alternative framing changes the original question's Markdown (alternative-framing list). Emit a change for the original too.
    if (row.altOf !== null) await touchQuestion(tx, row.altOf, now);
    await touchReferenceTopics(tx, entryId, now);
    await purgeEntryDerivatives(tx, entryId, now);
    await cancelEntryJobs(tx, entryId);
    const closing = opts.reports ?? { status: "dismissed" as const, by: null };
    await tx
      .update(reports)
      .set({ status: closing.status, handledBy: closing.by, handledAt: now })
      .where(and(eq(reports.entryId, entryId), eq(reports.status, "open")));
    return { ok: true as const, threadId: row.threadId ?? row.id };
  });
}

// Authors delete their own topics/replies. If kind is specified, another kind yields not_found. Non-authors receive forbidden.
// softDeleteEntry recounts aggregates, removes derivatives, cancels jobs, and dismisses reports. Deleted entries retain only reply positions.
export async function deleteOwnEntry(
  db: Db,
  userId: string,
  entryId: number,
  opts: { kind?: "topic" | "reply"; now?: Date } = {},
): Promise<{ ok: true; kind: "topic" | "reply"; threadId: number } | { ok: false; error: "not_found" | "forbidden" }> {
  return db.transaction(async (tx) => {
    await lockReferenceTopics(tx, { entryId });
    const [row] = await tx
      .select({ kind: entries.kind, authorId: entries.authorId, deletedAt: entries.deletedAt })
      .from(entries)
      .where(eq(entries.id, entryId))
      // FOR NO KEY UPDATE: the topic row is locked afterward for aggregate recounting. Avoid conflict with reply insertion's KEY SHARE on the reply target.
      .for("no key update");
    if (!row || row.deletedAt || (opts.kind && row.kind !== opts.kind)) return { ok: false as const, error: "not_found" as const };
    if (row.authorId !== userId) return { ok: false as const, error: "forbidden" as const };
    const res = await softDeleteEntry(tx, entryId, { now: opts.now });
    if (!res.ok) return { ok: false as const, error: "not_found" as const };
    return { ok: true as const, kind: row.kind as "topic" | "reply", threadId: res.threadId };
  });
}

// Edit input. asksStance/altOf are absent from UI forms because they cannot change after creation. If submitted values differ from current ones, reject the attribute combination
// (checkStanceAttributes with mode: "edit"). stanceTag is the reply label; undefined leaves it unchanged, null removes it.
const editAttributes = { asksStance: z.boolean().optional(), altOf: z.number().int().positive().nullish(), stanceTag: z.enum(STANCE_TAGS).nullish() };
const topicEditSchema = z.object({ title: titleSchema, body: common.body, lang: z.enum(SOURCE_LANGS).optional(), ...editAttributes });
const replyEditSchema = z.object({ body: common.body, lang: z.enum(SOURCE_LANGS).optional(), ...editAttributes });

// Editor modes. author: edit title/body (body/label for replies). author-locked: pinned question; title/body cannot change, so show guidance instead of a form.
// moderator-fix: assigned source-language moderator/operator fixes typos in a pinned question. This is moderation action fix_entry, requiring an explanation and appearing in notifications, public records, and appeals,
// with reversal restoring the previous revision. Pinning follows the first stance by a non-author member; setStance in app/lib/stances.server.ts writes stance_locked_at.
// Only authors may edit unpinned questions and non-question entries. Moderators cannot edit their own questions as moderators either, matching the own_entry action rule.
// fixEntry (app/lib/moderation.server.ts), not editEntry, accepts moderator-fix submissions. editEntry accepts author edits only.
export type EditMode = "author" | "author-locked" | "moderator-fix";

export type EditableEntry = {
  id: number;
  kind: "topic" | "reply";
  threadId: number;
  lang: SourceLang;
  langCode?: string | null;
  title: string | null;
  body: string;
  // Current source revision.
  sourceHash: string | null;
  // Question status, pinned status (first stance; stance_locked_at set), reply label, and whether the reply's topic is a question (controls label choices in the reply editor).
  asksStance: boolean;
  locked: boolean;
  stanceTag: StanceTag | null;
  threadAsksStance: boolean;
  mode: EditMode;
};

// Retrieve an editable entry for the editor: the author's own undeleted topic/reply.
// With kind specified, another kind yields not_found, so /t/:id/edit cannot open a reply id.
// Non-authors receive forbidden, except when viewer scope permits fixing a pinned question as an assigned source-language moderator/operator; return mode: "moderator-fix"
// for that typo-correction entry point. Authors of pinned questions get mode: "author-locked".
export async function getEditableEntry(
  db: Db,
  userId: string,
  entryId: number,
  opts: { kind?: "topic" | "reply"; viewer?: Viewer } = {},
): Promise<{ ok: true; entry: EditableEntry } | { ok: false; error: "not_found" | "forbidden" }> {
  const [row] = await db
    .select({
      id: entries.id,
      kind: entries.kind,
      threadId: entries.threadId,
      lang: entries.lang,
      langCode: entries.langCode,
      title: entries.title,
      body: entries.body,
      sourceHash: entries.sourceHash,
      authorId: entries.authorId,
      asksStance: entries.asksStance,
      stanceTag: entries.stanceTag,
      stanceLockedAt: entries.stanceLockedAt,
    })
    .from(entries)
    .where(and(eq(entries.id, entryId), isNull(entries.deletedAt)));
  if (!row || (opts.kind && row.kind !== opts.kind)) return { ok: false, error: "not_found" };
  const locked = row.stanceLockedAt !== null;
  const isAuthor = row.authorId === userId;
  // Non-authors may enter only if authorized within their scope to fix this pinned question.
  const fixer = !isAuthor && locked && row.kind === "topic" && row.asksStance && opts.viewer !== undefined && opts.viewer.userId === userId && inScope(opts.viewer.scope, row.lang);
  if (!isAuthor && !fixer) return { ok: false, error: "forbidden" };
  const kind = row.kind as EditableEntry["kind"];
  const facts = await loadStanceAttrFacts(db, { kind, threadId: row.threadId });
  return {
    ok: true,
    entry: {
      id: row.id,
      kind,
      threadId: row.threadId ?? row.id,
      lang: row.lang as SourceLang, langCode: row.langCode,
      title: row.title,
      body: row.body,
      sourceHash: row.sourceHash,
      asksStance: row.asksStance,
      locked,
      stanceTag: row.stanceTag as StanceTag | null,
      threadAsksStance: kind === "topic" ? row.asksStance : (facts.threadAsksStance ?? false),
      mode: fixer ? "moderator-fix" : locked ? "author-locked" : "author",
    },
  };
}

// Work after replacing title/body, shared by author editEntry, moderator fixEntry, and its reversal after appeal. Preserve the replaced revision in entry_revisions
// with editorId as the editor; update title/body, source revision, render cache, and edited_at; rebuild sentence boundaries; carry unchanged-field translations into the new revision; remove disagreements if the body changed;
// mark manual translations stale; queue machine translation/embedding jobs except for hidden entries (requeue on unhide); and emit an original-question change if an alternative framing's title changed.
// For deleted entries (reversing an edit after deletion upon successful appeal), do not recreate derivatives (boundaries, translations, embeddings, jobs): deletion removed them; restoration rebuilds them.
// Lock order: callers first acquire the entry row with FOR NO KEY UPDATE, then touch translations and report rows: entry → reports (tests/pg-concurrency.test.ts).
// tagChange updates the reply label in the same operation (label and nondecreasing meta_changed_at). Returned revisionId identifies the replaced entry_revisions row for fix_entry history and restoration after appeal.
// The caller owns the transaction, reference-topic and entry locks, and permission/state checks.
// This helper neither opens nor completes the transaction and lets exceptions propagate to its owner.
export async function applyEntryEdit(
  tx: Tx,
  input: {
    entryId: number;
    editorId: string;
    now: Date;
    before: { title: string | null; body: string; sourceHash: string | null; lang: string; hiddenAt: Date | null; deletedAt?: Date | null };
    // cardHtml: the card version of a topic body (null for a reply, or when the body was not cut).
    after: { title: string | null; body: string; lang?: string; langCode?: string | null; langSource?: LangSource; html: string; cardHtml?: string | null; bindings?: SavedMentionBinding[]; preparedRender?: PreparedEntryRender };
    tagChange?: { to: StanceTag | null };
    coalesceHistory?: boolean;
  },
): Promise<{ revisionId: number | null; sourceHash: string; mentions: MentionTargets }> {
  const { entryId, editorId, now, before, after } = input;
  const lang = after.lang ?? before.lang;
  const languageChanged = lang !== before.lang;
  const [entry] = await tx.select({ kind: entries.kind, mentionRevision: entries.mentionRevision, langCode: entries.langCode, langSource: entries.langSource }).from(entries).where(eq(entries.id, entryId));
  const previous = await readMentionBindings(tx, entryId, entry.mentionRevision);
  const bindings = after.bindings ?? await bindMentionSpellings(tx, after.body, previous);
  const bodyUnchanged = before.body === after.body && JSON.stringify(previous) === JSON.stringify(bindings);
  const hash = sourceHash(after.title, after.body, lang);
  const mentions = await storeMentionSnapshot(tx, { entryId, revision: entry.mentionRevision + 1, sourceHash: hash, body: after.body, bindings });
  const rendered = after.preparedRender
    ? await renderEntryForWrite(after.preparedRender, { id: entryId, kind: entry.kind as "topic" | "reply", body: after.body, lang }, bindings, mentions)
    : await renderEntryHtml(entry.kind as "topic" | "reply", entryId, after.body, lang, mentions);
  const [revision] = input.coalesceHistory ? [] : await tx
    .insert(entryRevisions)
    .values({ entryId, title: before.title, body: before.body, mentionRevision: entry.mentionRevision, editedAt: now, editorId })
    .returning({ id: entryRevisions.id });
  if (languageChanged) {
    await cancelEntryJobs(tx, entryId);
    await purgeEntryDerivatives(tx, entryId, now);
  }
  await tx
    .update(entries)
    .set({
      title: after.title,
      body: after.body,
      lang,
      langCode: lang === "other" ? (Object.hasOwn(after, "langCode") ? after.langCode ?? null : entry.langCode) : null,
      langSource: after.langSource ?? entry.langSource,
      sourceHash: hash,
      mentionRevision: entry.mentionRevision + 1,
      html: rendered.cacheable === false ? null : rendered.html,
      cardHtml: rendered.cacheable === false ? null : rendered.cardHtml,
      htmlVersion: RENDER_VERSION,
      editedAt: input.coalesceHistory ? null : now,
      // Even a coalesced edit changes the Markdown feed and manifest.
      metaChangedAt: sql`greatest(coalesce(${entries.metaChangedAt}, ${now.toISOString()}::timestamptz), ${now.toISOString()}::timestamptz)`,
      updatedAt: now,
      ...(input.tagChange ? { stanceTag: input.tagChange.to, metaChangedAt: sql`greatest(coalesce(${entries.metaChangedAt}, ${now.toISOString()}::timestamptz), ${now.toISOString()}::timestamptz)` } : {}),
    })
    .where(eq(entries.id, entryId));
  await syncEntryReferences(tx, entryId, now);
  await syncMediaReferences(tx, entryId, after.body);
  if (before.deletedAt) return { revisionId: revision?.id ?? null, sourceHash: hash, mentions };
  // Rebuild sentence boundaries. Carry unchanged-field translations into the new source revision for title-only/body-only edits without retranslation or marking stale.
  // If the body changed, remove its disagreements. Keep remaining human translations and mark them stale;
  // retranslate primary/secondary for the new revision. Hide primary translations with a different source_hash until retranslated.
  await replaceSegments(tx, entryId, after.body, lang);
  if (!languageChanged) await carryOverUnchangedFields(tx, entryId, before.sourceHash, hash, { title: before.title === after.title, body: bodyUnchanged });
  // The title was taken off: the open reports on its translation are closed (a topic without a title has no title translation to report or to correct).
  if (before.title !== null && after.title === null) await resolveTitleReports(tx, entryId, now);
  if (!bodyUnchanged) {
    await tx.delete(divergences).where(eq(divergences.entryId, entryId));
    // A stale human text remains tied to its own source revision's saved mention bindings.
    await tx.update(translations).set({ html: null, cardHtml: null, htmlVersion: 0 }).where(and(
      eq(translations.entryId, entryId), eq(translations.kind, "human"), eq(translations.field, "body"),
    ));
  }
  await markHumanTranslationsStale(tx, entryId, hash, now);
  // Do not translate or embed hidden entries; requeue when unhidden.
  if (!before.hiddenAt) {
    await enqueueTranslations(tx, { id: entryId, lang, sourceHash: hash });
    await enqueueEmbedding(tx, { id: entryId, sourceHash: hash });
  }
  // An alternative framing's title change alters the original's Markdown list. Hidden alternatives are absent from that list, so they do not change the original.
  if ((before.title !== after.title || languageChanged) && !before.hiddenAt) await touchAltOriginal(tx, entryId, now);
  return { revisionId: revision?.id ?? null, sourceHash: hash, mentions };
}

// Validate title/body for moderator fixes (fixEntry), using editEntry topic rules: lengths, single-line title, no NUL. Callers check renderability after locking the row.
// The title may come back null (a blank title): the caller decides whether that is allowed (a fix is only for a question, which keeps its title).
export function parseTopicText(input: { title: unknown; body: unknown }): { ok: true; title: string | null; body: string } | { ok: false; error: EntryError } {
  const parsed = z.object({ title: titleSchema, body: common.body }).safeParse(input);
  if (!parsed.success) return { ok: false, error: fieldError(parsed.error.issues) };
  return { ok: true, title: parsed.data.title, body: parsed.data.body };
}

// The source render (including restoration after an appeal). An unrenderable body still has a plain fallback; topics get a card version, replies never do.
export async function renderEntryHtml(kind: "topic" | "reply", id: number, body: string, lang: string, mentions: MentionTargets): Promise<RenderedEntry> {
  const opts = { idPrefix: entryIdPrefix(kind, id), lang, mentions };
  return kind === "topic" ? (await renderEntryOrPlain(body, { ...opts, mentions })) : (await renderMarkdownResult(body, { ...opts, mentions }));
}

// The saved render of the translation of a body (a topic body also gets the card version; a reply's translation has none). The id prefix is the one of the translation (p-<id>-<lang>-).
export async function renderTranslationHtml(kind: "topic" | "reply", id: number, lang: string, text: string, mentions: MentionTargets, machine = false): Promise<RenderedEntry> {
  const opts = { idPrefix: entryIdPrefix(kind, id, lang), headingIdPrefix: entryIdPrefix(kind, id), lang, mentions, translation: machine };
  return kind === "topic" ? (await renderEntryOrPlain(text, { ...opts, mentions })) : (await renderMarkdownResult(text, { ...opts, mentions }));
}

// The same, but null when the translation cannot be rendered (a human fix refuses it).
export async function tryRenderTranslationHtml(kind: "topic" | "reply", id: number, lang: string, text: string, mentions: MentionTargets, machine = false): Promise<RenderedEntry | null> {
  const opts = { idPrefix: entryIdPrefix(kind, id, lang), headingIdPrefix: entryIdPrefix(kind, id), lang, mentions, translation: machine };
  if (kind === "topic") return (await tryRenderEntry(text, { ...opts, mentions }));
  const html = (await tryRenderMarkdown(text, { ...opts, mentions }));
  return html === null ? null : { html, cardHtml: null, cardTruncated: false };
}

// Only authors edit their own topics (title/body/language) and replies (body/language/label). Use creation-time validation.
// The title is optional: a title can be added to a topic without one, or taken off (a question cannot lose its title: invalid_title).
// On change, preserve the replaced revision in entry_revisions and update edited_at, source_hash, and render cache.
// Record nothing for unchanged submissions (changed: false).
// Recheck authorship under the entry-row lock to prevent validation/update races. FOR NO KEY UPDATE matches stance registration's lock on this row,
// serializing edits and stance registration. If the first stance arrives between the initial read and lock, reject the author edit as locked. Foreign-key FOR KEY SHARE checks for concurrent replies/stances do not conflict.
// For pinned questions, attempted title/body/language changes yield locked; unchanged submissions return changed: false.
// Label-only reply changes update only stance_tag/meta_changed_at, leaving entry_revisions/edited_at unchanged. Return changed: true; emit an edited reply in the changes feed.
// Advance the original's meta_changed_at when an alternative framing's title changes. Body-only changes do not advance it, since Markdown lists only the title.
async function editEntryImplementation(
  db: Db,
  editorId: string,
  entryId: number,
  input: unknown,
  opts: { kind?: "topic" | "reply"; now?: Date; expectedVersion?: string } = {},
): Promise<
  { ok: true; id: number; threadId: number; changed: boolean } | { ok: false; error: EditError }
> {
  const found = await getEditableEntry(db, editorId, entryId, { kind: opts.kind });
  if (!found.ok) return found;
  const { kind } = found.entry;
  let title: string | null = null;
  let body: string;
  let attributes: { lang?: SourceLang; asksStance?: boolean; altOf?: number | null; stanceTag?: StanceTag | null };
  if (kind === "topic") {
    const parsed = topicEditSchema.safeParse(input);
    if (!parsed.success) return { ok: false, error: fieldError(parsed.error.issues) };
    ({ title, body, ...attributes } = parsed.data);
  } else {
    const parsed = replyEditSchema.safeParse(input);
    if (!parsed.success) return { ok: false, error: fieldError(parsed.error.issues) };
    ({ body, ...attributes } = parsed.data);
  }
  const language = attributes.lang && attributes.lang !== found.entry.lang ? await resolvePostLanguage(body, attributes.lang, found.entry.lang) : null;
  if (language) attributes.lang = language.lang as SourceLang;
  const bodyError = await checkBodyBudget(body, editorId);
  if (bodyError) return { ok: false, error: bodyError };
  const now = opts.now ?? new Date();

  const [source] = await db.select({ revision: entries.mentionRevision }).from(entries).where(eq(entries.id, entryId));
  const previous = source ? await readMentionBindings(db, entryId, source.revision) : [];
  const renderInput = { kind, id: entryId, body, lang: attributes.lang ?? found.entry.lang, previous };
  const preparedRender = activeEntryRender(renderInput) ?? await prepareEntryRender(db, renderInput);

  return db.transaction(async (tx) => {
    await lockAbuseWriter(tx, editorId);
    await lockReferenceTopics(tx, { entryId, body });
    const [current] = await tx
      .select({
        title: entries.title,
        body: entries.body,
        sourceHash: entries.sourceHash,
        lang: entries.lang,
        langCode: entries.langCode,
        threadId: entries.threadId,
        authorId: entries.authorId,
        deletedAt: entries.deletedAt,
        hiddenAt: entries.hiddenAt,
        asksStance: entries.asksStance,
        altOf: entries.altOf,
        stanceTag: entries.stanceTag,
        stanceLockedAt: entries.stanceLockedAt,
      })
      .from(entries)
      .where(eq(entries.id, entryId))
      .for("no key update");
    if (!current || current.deletedAt) return { ok: false as const, error: "not_found" as const };
    if (current.authorId !== editorId) return { ok: false as const, error: "forbidden" as const };
    // Only versioned form submissions opt in. Compare after locking, before any update,
    // including no-op and label-only edits. Direct callers retain their existing behavior.
    if (opts.expectedVersion !== undefined && opts.expectedVersion !== entryEditVersion(current)) {
      return { ok: false as const, error: "edit_conflict" as const };
    }
    const threadId = current.threadId ?? entryId;
    const currentTag = current.stanceTag as StanceTag | null;
    // Attribute combinations: question attributes are immutable; labels require replies to questions. undefined leaves the label unchanged; null removes it.
    const nextTag = attributes.stanceTag === undefined ? currentTag : attributes.stanceTag;
    const facts = await loadStanceAttrFacts(tx, { kind, threadId: current.threadId });
    const attrError = checkStanceAttributes({
      kind,
      mode: "edit",
      asksStance: attributes.asksStance ?? current.asksStance,
      altOf: attributes.altOf === undefined ? current.altOf : attributes.altOf,
      stanceTag: nextTag,
      threadAsksStance: facts.threadAsksStance,
      current: { asksStance: current.asksStance, altOf: current.altOf },
    });
    if (attrError) return { ok: false as const, error: attrError };
    // A question keeps its title (the proposition): the edit cannot empty it. The input has no asksStance, so this is checked on the stored row (before the lock check).
    if (kind === "topic" && current.asksStance && title === null) return { ok: false as const, error: "invalid_title" as const };
    const lang = attributes.lang ?? current.lang;
    const textChanged = current.title !== title || current.body !== body || current.lang !== lang;
    const tagChanged = nextTag !== currentTag;
    // Authors cannot edit the title/body/language of a question pinned by a stance.
    if (textChanged && current.stanceLockedAt !== null) return { ok: false as const, error: "locked" as const };
    if (!textChanged && !tagChanged) {
      return { ok: true as const, id: entryId, threadId, changed: false };
    }
    if (!textChanged) {
      // Label-only changes leave history, edited_at, and source_hash unchanged. Advance the change timestamp with nondecreasing meta_changed_at.
      await tx
        .update(entries)
        .set({ stanceTag: nextTag, metaChangedAt: sql`greatest(coalesce(${entries.metaChangedAt}, ${now.toISOString()}::timestamptz), ${now.toISOString()}::timestamptz)` })
        .where(eq(entries.id, entryId));
      return { ok: true as const, id: entryId, threadId, changed: true };
    }
    const { mentions } = await applyEntryEdit(tx, {
      entryId,
      editorId,
      now,
      before: { title: current.title, body: current.body, sourceHash: current.sourceHash, lang: current.lang, hiddenAt: current.hiddenAt },
      after: { title, body, lang, ...(language && lang !== current.lang ? { langCode: language.langCode, langSource: "explicit" as const } : {}), html: "", preparedRender },
      tagChange: tagChanged ? { to: nextTag } : undefined,
      coalesceHistory: await withinEditGrace(tx, entryId, now),
    });
    const spamHidden = await inspectEntrySpam(tx, { id: entryId, authorId: editorId, body, sourceHash: sourceHash(title, body, lang) }, now);
    // The author's edit of the body: a member who is named now and was not told before is told (a member told before is not told again, even if the mention was removed
    // and written again). A moderator's fix of a typo (fixEntry) does not come here: it is not the author's call.
    if (current.body !== body) {
      await notifyMentions(tx, {
        entry: { id: entryId, kind, threadId, authorId: editorId, hidden: current.hiddenAt !== null || spamHidden },
        mentioned: (await notifiable(body, mentions)),
        subsumed: new Set(),
        now,
      });
    }
    return { ok: true as const, id: entryId, threadId, changed: true };
  });
}

const viewColumns = {
  id: entries.id,
  kind: entries.kind,
  lang: entries.lang,
  langCode: entries.langCode,
  title: entries.title,
  body: entries.body,
  html: entries.html,
  htmlVersion: entries.htmlVersion,
  authorId: entries.authorId,
  authorHandle: retainedAuthorColumn(entries.authorId),
  parentId: entries.parentId,
  aiAssistance: entries.aiAssistance,
  createdAt: entries.createdAt,
  editedAt: entries.editedAt,
  sourceHash: entries.sourceHash,
  mentionRevision: entries.mentionRevision,
  hiddenAt: entries.hiddenAt,
  deletedAt: entries.deletedAt,
  asksStance: entries.asksStance,
  altOf: entries.altOf,
  stanceTag: entries.stanceTag,
  stanceLockedAt: entries.stanceLockedAt,
};

type ViewRow = {
  id: number;
  kind: string;
  lang: string;
  langCode?: string | null;
  title: string | null;
  body: string;
  html: string | null;
  htmlVersion: number;
  mentionRevision: number;
  authorId: string;
  authorHandle: string | null;
  parentId: number | null;
  aiAssistance: string | null;
  createdAt: Date;
  editedAt: Date | null;
  sourceHash: string | null;
  hiddenAt: Date | null;
  deletedAt: Date | null;
  asksStance: boolean;
  altOf: number | null;
  stanceTag: string | null;
  stanceLockedAt: Date | null;
};

function visibilityOf(row: Pick<ViewRow, "authorId" | "lang" | "hiddenAt" | "deletedAt">, viewer: Viewer | undefined): EntryVisibility {
  if (row.deletedAt) return "deleted";
  if (!row.hiddenAt) return "visible";
  return canSeeHidden(viewer, row) ? "hidden" : "hidden-redacted";
}

// Content-redacted entry (deleted reply or hidden entry unreadable by this viewer). Retain position/kind only; clear title, body, author, etc.
function redactedView(row: ViewRow, visibility: "deleted" | "hidden-redacted"): EntryView {
  return {
    id: row.id,
    visibility,
    kind: row.kind as EntryView["kind"],
    lang: "en",
    title: null,
    body: "",
    html: "",
    authorId: "",
    authorHandle: "",
    parentId: row.parentId,
    aiAssistance: null,
    createdAt: row.createdAt,
    editedAt: null,
    sourceHash: null,
    // Also omit reply labels and question attributes from redacted entries, so hidden-reply labels cannot reveal the direction of their content.
    asksStance: false,
    altOf: null,
    stanceTag: null,
    stanceLocked: false,
  };
}

// Use the cache if its version matches current RENDER_VERSION. Otherwise, or if absent, re-render and save.
// `mentions`: the members that the bodies of the rows that are rendered again can name (viewsWithHtml looks them up once for all the rows).
async function viewWithHtml(db: Db, row: ViewRow, viewer: Viewer | undefined, mentions: MentionTargets): Promise<EntryView> {
  const visibility = visibilityOf(row, viewer);
  if (visibility === "deleted" || visibility === "hidden-redacted") return redactedView(row, visibility);
  const { html: cached, htmlVersion, hiddenAt: _hiddenAt, deletedAt: _deletedAt, stanceLockedAt, mentionRevision: _mentionRevision, ...rest } = row;
  let html = cached;
  if (html === null || htmlVersion !== RENDER_VERSION) {
    const kind = row.kind as EntryView["kind"];
    const rendered = await withMarkdownRead(() => renderEntryHtml(kind, row.id, row.body, row.lang, mentions));
    html = rendered.html;
    try {
      // If edited during rendering, do not overwrite with HTML from the old body. Update only rows whose body still matches the read value.
      if (rendered.cacheable !== false) await db
        .update(entries)
        .set({ html, cardHtml: rendered.cardHtml, htmlVersion: RENDER_VERSION })
        .where(and(eq(entries.id, row.id), eq(entries.body, row.body), eq(entries.mentionRevision, row.mentionRevision), isNull(entries.deletedAt)));
    } catch (error) {
      // A save failure does not prevent display.
      console.warn(`[entries] could not cache rendered html for entry ${row.id}:`, safeErrorText(error));
    }
  }
  // Expose pinned status only to the author and authorized typo editors (assigned source-language moderators/operators). Boolean only; never expose the timestamp.
  const canSeeLock = viewer !== undefined && (viewer.userId === row.authorId || (row.kind === "topic" && inScope(viewer.scope, row.lang)));
  return toView({ ...rest, html }, visibility, stanceLockedAt !== null && canSeeLock);
}

// The views of several rows. The rows whose stored rendering is missing or old are rendered again; the members they can mention are looked up in one query for all of them.
async function viewsWithHtml(db: Db, rows: readonly ViewRow[], viewer: Viewer | undefined): Promise<EntryView[]> {
  const stale = rows.filter((r) => {
    const v = visibilityOf(r, viewer);
    return (v === "visible" || v === "hidden") && (r.html === null || r.htmlVersion !== RENDER_VERSION);
  });
  const snapshots = await resolveSavedMentionsFor(db, stale);
  return Promise.all(rows.map(r => viewWithHtml(db, r, viewer, snapshots.get(r.id) ?? new Map())));
}

function toView(
  row: Omit<ViewRow, "html" | "htmlVersion" | "hiddenAt" | "deletedAt" | "stanceLockedAt" | "mentionRevision"> & { html: string },
  visibility: EntryVisibility,
  stanceLocked: boolean,
): EntryView {
  return {
    ...row,
    visibility,
    kind: row.kind as EntryView["kind"],
    lang: row.lang as SourceLang, langCode: row.langCode,
    aiAssistance: row.aiAssistance as AiAssistance | null,
    authorHandle: row.authorHandle ?? "?",
    stanceTag: row.stanceTag as StanceTag | null,
    stanceLocked,
  };
}

// Whether an undeleted entry belongs to an existing, undeleted thread.
export async function isEntryInThread(db: Db, entryId: number, threadId: number): Promise<boolean> {
  const [row] = await db
    .select({ id: entries.id, threadId: entries.threadId })
    .from(entries)
    .innerJoin(rootTopic, rootTopicOn())
    .where(and(eq(entries.id, entryId), isNull(entries.deletedAt), undeletedTopic(rootTopic)));
  return row !== undefined && (row.id === threadId || row.threadId === threadId);
}

// Thread replies paginate in groups of REPLIES_PER_PAGE (100); page starts at 1. Invalid page/limit throws RangeError.
// Count all deleted replies in pagination, matching Markdown order and boundaries. After paging, keep only placeholders referenced by undeleted replies.
// Hidden content is visible only to authorized viewer scope (author, assigned moderators/operators). Return empty content to other viewers (hidden-redacted).
// Beyond the last page, replies is empty; callers use pageCount to decide. Deleted topics return null.
// stanceTag filters replies by label, returning only undeleted, unhidden matches in creation order, 100 per page.
// Pagination counts the filtered sequence; replyTotal is the filtered reply count.
export async function getThread(
  db: Db,
  threadId: number,
  opts: { page?: number; limit?: number; viewer?: Viewer; stanceTag?: StanceTag } = {},
): Promise<Thread | null> {
  const { page, limit, offset } = checkPagination(opts, REPLIES_PER_PAGE);
  const [topic] = await db
    .select({ ...viewColumns, replyCount: entries.replyCount })
    .from(entries)
    .leftJoin(profiles, eq(profiles.userId, entries.authorId))
    .where(and(eq(entries.id, threadId), undeletedTopic(), publicTopicPlace()));
  if (!topic) return null;
  const { replyCount, ...topicRow } = topic;
  const replyFilter = opts.stanceTag
    ? and(eq(entries.threadId, threadId), eq(entries.kind, "reply"), eq(entries.stanceTag, opts.stanceTag), isNull(entries.deletedAt), isNull(entries.hiddenAt))
    : and(eq(entries.threadId, threadId), eq(entries.kind, "reply"));
  const boundary = offset ? db.select({ createdAt: entries.createdAt, id: entries.id }).from(entries)
    .where(replyFilter).orderBy(asc(entries.createdAt), asc(entries.id)).limit(1).offset(offset - 1) : undefined;
  const [[total], replies] = await Promise.all([
    db.select({ n: count() }).from(entries).where(replyFilter),
    db
      .select({ ...viewColumns, hasUndeletedChild: hasUndeletedReply() })
      .from(entries)
      .leftJoin(profiles, eq(profiles.userId, entries.authorId))
      .where(and(replyFilter, afterPageBoundary([entries.createdAt, entries.id], boundary)))
      .orderBy(asc(entries.createdAt), asc(entries.id))
      .limit(limit),
  ]);
  const replyTotal = Number(total.n);
  const keptReplies = replies.filter(row => row.deletedAt === null || row.hasUndeletedChild)
    .map(({ hasUndeletedChild: _hasChild, ...row }) => row);
  const [topicView, ...replyViews] = await viewsWithHtml(db, [topicRow, ...keptReplies], opts.viewer);
  return {
    topic: topicView,
    replies: replyViews,
    page,
    pageSize: limit,
    pageCount: pageCount(replyTotal, limit),
    replyCount,
    replyTotal,
  };
}

// Read a list of topic/reply ids using thread rules for render caching and hidden content. Only authorized viewers see hidden content; deleted entries retain position only.
// Used by screens displaying entries outside a thread, such as replies in the reasons section. Omit absent ids from the returned Map.
export async function getEntryViews(db: Db, ids: readonly number[], viewer?: Viewer): Promise<Map<number, EntryView>> {
  const out = new Map<number, EntryView>();
  if (ids.length === 0) return out;
  const rows = await db
    .select(viewColumns)
    .from(entries)
    .leftJoin(profiles, eq(profiles.userId, entries.authorId))
    .where(inArray(entries.id, [...ids]));
  for (const view of await viewsWithHtml(db, rows, viewer)) out.set(view.id, view);
  return out;
}

// Find the reply's pagination page in createdAt/id order. Return 1 if not found.
// Deleted replies retain positions and count toward each group of 100. UI and Markdown pagination match.
export async function replyPage(db: Db, threadId: number, replyId: number, pageSize: number = REPLIES_PER_PAGE): Promise<number> {
  const [target] = await db
    .select({ createdAt: entries.createdAt })
    .from(entries)
    .where(
      and(eq(entries.id, replyId), eq(entries.threadId, threadId), eq(entries.kind, "reply")),
    );
  if (!target) return 1;
  const [before] = await db
    .select({ n: count() })
    .from(entries)
    .where(
      and(
        eq(entries.threadId, threadId),
        eq(entries.kind, "reply"),
        or(lt(entries.createdAt, target.createdAt), and(eq(entries.createdAt, target.createdAt), lte(entries.id, replyId))),
      ),
    );
  return pageCount(Number(before.n), pageSize);
}

// Reply position in the thread: page and reply anchor. Used as the destination after reply creation/editing.
// Passing lang preserves ?lang=, the page-specific display language, so readers continue in the same translation language after replying.
export async function replyLocation(db: Db, threadId: number, replyId: number, opts: { lang?: string | null } = {}): Promise<string> {
  return replyLocationAt(threadId, replyId, await replyPage(db, threadId, replyId), opts);
}

// Reply position when its page is already known: the query-free portion of replyLocation. Batch-computed pages (objections.server.ts) use the same destination shape.
// opts.lang is a carried language ("fr" or "fr&rl=1", see carriedLang in app/lib/reading-lang.ts).
export function replyLocationAt(threadId: number, replyId: number, page: number, opts: { lang?: string | null } = {}): string {
  const params = new URLSearchParams();
  if (page > 1) params.set("page", String(page));
  setCarriedLang(params, opts.lang);
  const query = params.toString();
  return `/t/${threadId}${query ? `?${query}` : ""}#c-${replyId}`;
}

// Listing scope. all: everything; langs: source in these languages; not-langs: source in none of these languages.
// followed: the topics the member follows now (state `following`; the ones taken off are not listed). The order is the same as the other lists (latest activity first).
export type TopicScope =
  | { kind: "all" }
  | { kind: "langs"; langs: readonly Lang[] }
  | { kind: "not-langs"; langs: readonly Lang[] }
  | { kind: "followed"; userId: string; unreadOnly?: boolean }
  | { kind: "village"; villageId: string }
  // The villages the member follows or has joined (public and not ended): the home's "Joined & followed villages" filter.
  | { kind: "my-villages"; userId: string };
export type TopicPage = { topics: TopicSummary[]; page: number; limit: number; hasNext: boolean };
// List ordering is independent of the reader. Insightful counts only the topic post,
// excluding moderated reactions; ties use newest creation and then newest id.
export type TopicOrder = "created" | "activity" | "insightful";

// Topic visibility: not hidden, or viewer is its author, assigned source-language moderator, or operator.
// Without viewer (such as Markdown), omit hidden topics.
export function visibleTo(viewer: Viewer | undefined): SQL | undefined {
  if (!viewer) return isNull(entries.hiddenAt);
  if (viewer.scope.operator) return undefined;
  const clauses = [isNull(entries.hiddenAt), eq(entries.authorId, viewer.userId)];
  if (viewer.scope.langs.length > 0) clauses.push(or(inArray(entries.lang, [...viewer.scope.langs]), notInArray(entries.lang, [...enabledLangs()]))!);
  return or(...clauses);
}

// Return topic listings one page at a time (default 30), ordered by newest activity and then newest id. order: "created" uses newest creation for home 「新しい投稿」 (entries_topic_created_idx, etc.).
// "insightful" uses counted topic reactions, then newest creation/id.
// Read entries.last_activity_at/reply_count aggregates without recounting replies on every call.
// Validate page (starting at 1) and limit (1–100); invalid values throw RangeError. Read one extra row to determine hasNext.
export async function listTopics(
  db: Db,
  scope: TopicScope = { kind: "all" },
  opts: { page?: number; limit?: number; viewer?: Viewer; asksOnly?: boolean; titledOnly?: boolean; order?: TopicOrder } = {},
): Promise<TopicPage> {
  const { page, limit, offset } = checkPagination(opts);
  const created = opts.order === "created";
  const conditions: Array<SQL | undefined> = [eq(entries.kind, "topic"), isNull(entries.deletedAt), visibleTo(opts.viewer), publicTopicPlace()];
  // Questions-only filter (?asks=1).
  if (opts.asksOnly) conditions.push(eq(created ? entries.asksStance : topicListingStats.asksStance, true));
  // Long posts only (a topic with a title; see app/lib/long-post.ts). A topic without a title is a short remark.
  if (opts.titledOnly) conditions.push(isNotNull(entries.title));
  if (scope.kind === "langs") {
    if (scope.langs.length === 0) return { topics: [], page, limit, hasNext: false };
    const lang = opts.order === "created" ? entries.lang : topicListingStats.lang;
    conditions.push(inArray(lang, [...scope.langs]));
  } else if (scope.kind === "not-langs" && scope.langs.length > 0) {
    conditions.push(notInArray(opts.order === "created" ? entries.lang : topicListingStats.lang, [...scope.langs]));
  } else if (scope.kind === "village") {
    conditions.push(eq(opts.order === "created" ? entries.villageId : topicListingStats.villageId, scope.villageId));
  } else if (scope.kind === "my-villages") {
    const column = opts.order === "created" ? entries.villageId : topicListingStats.villageId;
    // One IN over the union of the two small sets, so that the planner can read the village indexes instead of filtering the whole list.
    const followed = db.select({ id: villageFollows.villageId }).from(villageFollows).innerJoin(villages, eq(villages.id, villageFollows.villageId)).where(and(eq(villageFollows.userId, scope.userId), activePublicPostVillageCondition()));
    const joined = db.select({ id: villageMembers.villageId }).from(villageMembers).innerJoin(villages, eq(villages.id, villageMembers.villageId)).where(and(eq(villageMembers.userId, scope.userId), activeSharedVillageCondition()));
    conditions.push(inArray(column, followed.union(joined)));
  } else if (scope.kind === "followed") {
    conditions.push(scope.unreadOnly ? unreadFollowedTopicCondition(db, scope.userId) : inArray(entries.id, db.select({ id: follows.threadId }).from(follows).where(and(eq(follows.userId, scope.userId), eq(follows.state, "following")))));
  }
  const insightful = opts.order === "insightful";
  const time = insightful ? topicListingStats.createdAt : created ? entries.createdAt : topicListingStats.lastActivityAt;
  const idKey = created ? entries.id : topicListingStats.topicId;
  const keys = insightful ? [topicListingStats.insightfulCount, time, idKey] : [time, idKey];
  const order = insightful
    ? [sql`${topicListingStats.insightfulCount} desc nulls last`, sql`${topicListingStats.createdAt} desc nulls last`, sql`${topicListingStats.topicId} desc nulls last`]
    : created ? [desc(entries.createdAt), desc(entries.id)] : [sql`${topicListingStats.lastActivityAt} desc nulls last`, sql`${topicListingStats.topicId} desc nulls last`];
  const boundaryBase = db.select({ ...(insightful ? { count: topicListingStats.insightfulCount } : {}), time, id: entries.id }).from(entries);
  const boundarySource = created ? boundaryBase : boundaryBase.innerJoin(topicListingStats, eq(topicListingStats.topicId, entries.id));
  const boundary = offset ? boundarySource.where(and(...conditions)).orderBy(...order).limit(1).offset(offset - 1) : undefined;
  const listingBase = db
    .select({
      id: entries.id,
      lang: entries.lang,
      langCode: entries.langCode,
      title: entries.title,
      sourceHash: entries.sourceHash,
      authorId: entries.authorId,
      authorHandle: retainedAuthorColumn(entries.authorId),
      replyCount: entries.replyCount,
      createdAt: entries.createdAt,
      lastActivityAt: entries.lastActivityAt,
      hiddenAt: entries.hiddenAt,
      asksStance: entries.asksStance,
    })
    .from(entries)
    .leftJoin(profiles, eq(profiles.userId, entries.authorId));
  const listingSource = created ? listingBase : listingBase.innerJoin(topicListingStats, eq(topicListingStats.topicId, entries.id));
  const rows = await listingSource.where(and(...conditions, afterPageBoundary(keys, boundary, true)))
    .orderBy(...order).limit(limit + 1);
  return {
    topics: rows.slice(0, limit).map((r) => ({
      id: r.id,
      hidden: r.hiddenAt !== null,
      lang: r.lang as SourceLang, langCode: r.langCode,
      title: r.title,
      sourceHash: r.sourceHash,
      authorId: r.authorId,
      authorHandle: r.authorHandle ?? "?",
      replyCount: r.replyCount,
      createdAt: r.createdAt,
      lastActivityAt: r.lastActivityAt,
      asksStance: r.asksStance,
    })),
    page,
    limit,
    hasNext: rows.length > limit,
  };
}

export async function createTopic(...args: Parameters<typeof createTopicImplementation>): Promise<Awaited<ReturnType<typeof createTopicImplementation>>> {
  return withMarkdownScope("write", args[1], async () => {
    try { return await createTopicImplementation(...args); }
    catch (error) { if (error instanceof MarkdownBudgetError) return { ok: false, error: "body_too_complex" }; throw error; }
  });
}

export async function createReply(...args: Parameters<typeof createReplyImplementation>): Promise<Awaited<ReturnType<typeof createReplyImplementation>>> {
  return withMarkdownScope("write", args[1], async () => {
    try { return await createReplyImplementation(...args); }
    catch (error) { if (error instanceof MarkdownBudgetError) return { ok: false, error: "body_too_complex" }; throw error; }
  });
}

// The write phase owns a transaction, or a savepoint when db is already transactional (such as in withSignedWrite).
// MarkdownBudgetError becomes a result: from the write phase only after that boundary rolls back, and from
// rendering before the write phase while nothing has been written yet. Other exceptions propagate.
export async function editEntry(...args: Parameters<typeof editEntryImplementation>): Promise<Awaited<ReturnType<typeof editEntryImplementation>>> {
  return withMarkdownScope("write", args[1], async () => {
    try { return await editEntryImplementation(...args); }
    catch (error) { if (error instanceof MarkdownBudgetError) return { ok: false, error: "body_too_complex" }; throw error; }
  });
}
