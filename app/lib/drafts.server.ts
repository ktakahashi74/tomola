import { resolvePostLanguage } from "./lang-detect";
import { recordDraftPublication } from "./eval/signals.server";
import { finishQuestionDraft } from "./ai-question-usage.server";
import { checkBodyBudget } from "~/lib/markdown.server";
import { withEntryRender } from "./entry-render-preparation.server";
import { and, count, desc, eq, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import { AI_ASSISTANCE, type AiAssistance } from "~/lib/ai-assistance";
import type { Db } from "~/lib/db/client.server";
import { apiTokens, drafts, entries, profiles } from "~/lib/db/schema";
import {
  createReply,
  createTopic,
  hasNul,
  MAX_BODY_LENGTH,
  MAX_TITLE_LENGTH,
  TITLE_CONTROL,
  type EntryError,
  type EntryVia,
} from "~/lib/entries.server";
import { headlineFromBody } from "~/lib/headline.server";
import { SOURCE_LANGS, type SourceLang, type Lang } from "~/lib/languages";
import { plainExcerpt } from "~/lib/plain-text.server";
import { loadStanceAttrFacts } from "~/lib/questions.server";
import { checkStanceAttributes, STANCE_TAGS, type StanceAttrError, type StanceTag } from "~/lib/stances";
import { titleOrNull } from "~/lib/text";
import { villagesEnabled } from "~/lib/villages-enabled.server";
import { lockVillageProfile, villageForTopic, villageSlug } from "~/lib/villages.server";

// The excerpt of a draft in the list is plain text (Markdown removed), this many characters.
const DRAFT_EXCERPT_CHARS = 100;

export type Draft = {
  id: number;
  // Present only when villages are enabled; null keeps the publication-time default.
  village?: string | null;
  kind: "topic" | "reply";
  threadId: number | null;
  // For a reply draft: the one line that names the topic being replied to (its title, or the beginning of its body when it has no title; null if the topic was deleted).
  // threadAsksStance: whether that topic is a question (whether to offer the choice of a reply mark).
  threadTitle: string | null;
  threadAsksStance: boolean;
  parentId: number | null;
  responseTo: number | null;
  lang: SourceLang;
  title: string | null;
  body: string;
  version: number;
  // null = not stated. Set by frontmatter or the API; the screens neither show nor change it, and publishing hands it on to the post.
  aiAssistance: AiAssistance | null;
  via: EntryVia;
  // Whether the topic asks for a stance; the original question for an alternative framing (id and title when readable, neither deleted nor hidden); reply label.
  asksStance: boolean;
  altOf: number | null;
  altTitle: string | null;
  stanceTag: StanceTag | null;
  // For via = "api", the creating token's name (null if its row is absent) and frontmatter exactly as received (null if absent).
  tokenName: string | null;
  rawFrontmatter: string | null;
  clientId: string | null;
  clientName: string | null;
  clientUri: string | null;
  clientUpdatedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};
export type DraftSummary = Pick<
  Draft,
  "id" | "kind" | "threadId" | "threadTitle" | "lang" | "title" | "via" | "updatedAt" | "asksStance"
> & {
  excerpt: string;
  // The beginning of the body as one line (headlineFromBody). A topic draft without a title shows it in the list (the "(untitled)" mark is for a draft with no text either).
  headline: string;
};

// The line that names the topic a reply draft answers: its title, or the beginning of its body when it has no title (the body is read only then, and only its start).
const threadBodyStart = sql<string | null>`case when ${entries.title} is null then left(${entries.body}, 4000) end`;
// null: the topic is gone (deleted or hidden). A topic whose body has no text at all (an image without alt text) gets "…" so that it is not taken for a gone one.
const threadLine = async (title: string | null, body: string | null) => title ?? (body === null ? null : (await headlineFromBody(body)) || "…");

// Saving is permissive for incomplete drafts, allowing empty title/body. Check only length limits and valid choices.
// Publishing applies normal entry validation (createTopic/createReply).
export type DraftError =
  | "invalid_draft"
  | "invalid_title"
  | "body_too_long"
  | "body_unrenderable"
  | "body_too_complex"
  | "invalid_lang"
  | "invalid_ai"
  | "thread_not_found"
  | "parent_not_in_thread"
  | "not_found"
  | "draft_conflict"
  | "village_required"
  // Invalid combinations of question/reply-label attributes (checkStanceAttributes in app/lib/stances.ts), at save and publication.
  | StanceAttrError
  // Per-member pending API draft limit reached (maxPendingApiDrafts in createDraft).
  | "too_many_pending_drafts";

// Saving is permissive, but reject values that cannot be stored: NUL in the body (PostgreSQL text cannot store it and would throw on save),
// and title newlines/control characters, using entry rules.
const fields = {
  village: z.unknown().optional(),
  // Original languages are independent of enabled reading languages.
  lang: z.enum(SOURCE_LANGS),
  title: z
    .string()
    .max(MAX_TITLE_LENGTH)
    .refine((s) => !TITLE_CONTROL.test(s))
    .nullish()
    // An empty or whitespace-only title is "no title" (null, as on the API path); a title with text is stored as it was typed.
    .transform(titleOrNull),
  body: z
    .string()
    .max(MAX_BODY_LENGTH)
    .refine((s) => !hasNul(s), { message: "nul" })
    .default(""),
  aiAssistance: z.enum(AI_ASSISTANCE).nullish(),
};
const createSchema = z.object({
  kind: z.enum(["topic", "reply"]),
  threadId: z.number().int().positive().nullish(),
  parentId: z.number().int().positive().nullish(),
  ...fields,
  asksStance: z.boolean().default(false),
  // Original question referenced by an alternative framing, set only at draft creation.
  altOf: z.number().int().positive().nullish(),
  stanceTag: z.enum(STANCE_TAGS).nullish(),
});
// Kind (topic/reply), reply target, and alternative-framing target (altOf) cannot change after creation. asksStance/stanceTag may change; undefined leaves them unchanged, null removes stanceTag.
const updateSchema = z.object({ ...fields, asksStance: z.boolean().optional(), stanceTag: z.enum(STANCE_TAGS).nullish() });

function fieldError(issues: z.core.$ZodIssue[]): DraftError {
  const field = issues[0]?.path[0];
  if (field === "title") return "invalid_title";
  if (field === "lang") return "invalid_lang";
  if (field === "aiAssistance") return "invalid_ai";
  if (field === "asksStance") return "invalid_asks_stance";
  if (field === "altOf") return "invalid_alt_of";
  if (field === "stanceTag") return "invalid_stance_tag";
  if (field === "body") return issues[0]?.code === "custom" ? "body_unrenderable" : "body_too_long";
  return "invalid_draft";
}

type DraftRow = typeof drafts.$inferSelect;

function toDraft(row: DraftRow, threadTitle: string | null = null, tokenName: string | null = null, altTitle: string | null = null, threadAsksStance = false): Draft {
  return {
    id: row.id,
    kind: row.kind as Draft["kind"],
    threadId: row.threadId,
    threadTitle,
    threadAsksStance,
    parentId: row.parentId,
    responseTo: row.responseTo,
    lang: row.lang as SourceLang,
    // A row saved before the title was normalized may hold "" or whitespace: that is "no title" too.
    title: titleOrNull(row.title),
    body: row.body,
    version: row.version,
    aiAssistance: row.aiAssistance as AiAssistance | null,
    via: row.via as EntryVia,
    asksStance: row.asksStance,
    altOf: row.altOf,
    altTitle,
    stanceTag: row.stanceTag as StanceTag | null,
    tokenName,
    rawFrontmatter: row.rawFrontmatter,
    clientId: row.clientId,
    clientName: row.clientName,
    clientUri: row.clientUri,
    clientUpdatedAt: row.clientUpdatedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function createDraftImplementation(
  db: Db,
  authorId: string,
  input: unknown,
  // For via = "api", preserve the token id and frontmatter exactly as received (app/lib/api/drafts-api.server.ts).
  // maxPendingApiDrafts: per-member pending API draft limit when via = "api". Lock the member row and count/insert in one transaction
  // to prevent concurrent requests exceeding the limit.
  opts: { aiSource?: "api" | "mcp"; via?: EntryVia; now?: Date; tokenId?: number | null; rawFrontmatter?: string | null; maxPendingApiDrafts?: number; client?: { key: string; id: string; name: string; uri: string | null }; villageId?: string | null; responseTo?: number | null } = {},
): Promise<{ ok: true; id: number } | { ok: false; error: DraftError }> {
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: fieldError(parsed.error.issues) };
  const d = parsed.data;
  const [responseTarget] = d.kind === "topic" && opts.via !== "api" && opts.responseTo != null
    ? await db.select({ id: entries.id }).from(entries).where(and(eq(entries.id, opts.responseTo), eq(entries.kind, "topic"))) : [];
  let threadId: number | null = null;
  let parentId: number | null = null;
  if (d.kind === "reply") {
    if (!d.threadId) return { ok: false, error: "thread_not_found" };
    const [topic] = await db
      .select({ id: entries.id })
      .from(entries)
      .where(and(eq(entries.id, d.threadId), eq(entries.kind, "topic"), isNull(entries.deletedAt), isNull(entries.hiddenAt)));
    if (!topic) return { ok: false, error: "thread_not_found" };
    threadId = topic.id;
    if (d.parentId) {
      const [parent] = await db
        .select({ id: entries.id })
        .from(entries)
        .where(and(eq(entries.id, d.parentId), eq(entries.threadId, threadId), isNull(entries.deletedAt), isNull(entries.hiddenAt)));
      if (!parent) return { ok: false, error: "parent_not_in_thread" };
      parentId = parent.id;
    }
  }
  // Question/reply-label attribute combinations for draft-save validation. Recheck as entry creation at publication.
  const facts = await loadStanceAttrFacts(db, { kind: d.kind, threadId, altOf: d.altOf });
  const attrError = checkStanceAttributes({ kind: d.kind, mode: "draft", asksStance: d.asksStance, altOf: d.altOf ?? null, stanceTag: d.stanceTag ?? null, ...facts });
  if (attrError) return { ok: false, error: attrError };
  const now = opts.now ?? new Date();
  const values = {
    authorId,
    responseTo: responseTarget?.id ?? null,
    ...(opts.villageId === undefined ? {} : { villageId: opts.villageId }),
    kind: d.kind,
    threadId,
    parentId,
    asksStance: d.asksStance,
    altOf: d.altOf ?? null,
    stanceTag: d.stanceTag ?? null,
    lang: d.lang,
    // Replies have no title.
    title: d.kind === "topic" ? (d.title ?? null) : null,
    body: d.body,
    aiAssistance: d.aiAssistance ?? null,
    via: opts.via ?? "web",
    aiSource: opts.via === "api" ? opts.aiSource ?? "api" : null,
    aiBaseline: opts.via === "api" ? { title: d.kind === "topic" ? d.title ?? null : null, body: d.body } : null,
    tokenId: opts.tokenId ?? null,
    rawFrontmatter: opts.rawFrontmatter ?? null,
    clientKey: opts.client?.key ?? null,
    clientId: opts.client?.id ?? null,
    clientName: opts.client?.name ?? null,
    clientUri: opts.client?.uri ?? null,
    clientUpdatedAt: opts.client ? now : null,
    createdAt: now,
    updatedAt: now,
  };
  const cap = (opts.via ?? "web") === "api" ? opts.maxPendingApiDrafts : undefined;
  if (cap === undefined) {
    const [row] = await db.insert(drafts).values(values).returning({ id: drafts.id });
    return { ok: true, id: row.id };
  }
  return db.transaction(async (tx) => {
    // Lock the member row before counting, serializing concurrent requests from the same member.
    await tx.select({ userId: profiles.userId }).from(profiles).where(eq(profiles.userId, authorId)).for("update");
    if ((await countApiDrafts(tx, authorId)) >= cap) return { ok: false as const, error: "too_many_pending_drafts" as const };
    const [row] = await tx.insert(drafts).values(values).returning({ id: drafts.id });
    return { ok: true as const, id: row.id };
  });
}

export async function createDraft(...args: Parameters<typeof createDraftImplementation>): Promise<Awaited<ReturnType<typeof createDraftImplementation>> & { village?: string | null }> {
  const [db, authorId, input, opts = {}] = args;
  if (!villagesEnabled()) return createDraftImplementation(...args);
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) return createDraftImplementation(...args);
  return db.transaction(async tx => {
    await lockVillageProfile(tx, authorId);
    const d = parsed.data;
    if (d.kind === "reply") {
      if (d.village != null) return { ok: false as const, error: "village_required" as const };
      return createDraftImplementation(tx, authorId, input, opts);
    }
    const village = await villageForTopic(tx, authorId, d.village);
    // Browser drafts may be incomplete. API/MCP preparation requires an available target.
    if (!village && (d.village != null || opts.via === "api")) return { ok: false as const, error: "village_required" as const };
    const result = await createDraftImplementation(tx, authorId, input, { ...opts, villageId: d.village != null ? village?.id ?? null : null });
    return result.ok ? { ...result, village: d.village != null ? village?.slug ?? null : null } : result;
  });
}

// Handle only the member's own drafts. Present others' drafts as nonexistent (not_found).
async function updateDraftImplementation(
  db: Db,
  authorId: string,
  draftId: number,
  input: unknown,
  opts: { now?: Date; expectedVersion?: number; returnVersion?: boolean; villageId?: string | null; skipUnchanged?: boolean } = {},
): Promise<{ ok: true; version?: number } | { ok: false; error: DraftError }> {
  if (opts.expectedVersion !== undefined && (!Number.isSafeInteger(opts.expectedVersion) || opts.expectedVersion < 1)) return { ok: false, error: "draft_conflict" };
  const parsed = updateSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: fieldError(parsed.error.issues) };
  const d = parsed.data;
  const query = db
    .select()
    .from(drafts)
    .where(and(eq(drafts.id, draftId), eq(drafts.authorId, authorId)));
  const [existing] = await (opts.skipUnchanged ? query.for("update") : query);
  if (!existing) return { ok: false, error: "not_found" };
  const kind = existing.kind as "topic" | "reply";
  // Question/reply-label combinations. Since altOf is immutable, do not check whether its target later became hidden/deleted here, which would block saving incomplete drafts.
  // createTopic checks original-question readability at publication. Removing asksStance while retaining altOf yields invalid_alt_of.
  const facts = await loadStanceAttrFacts(db, { kind, threadId: existing.threadId });
  const asksStance = d.asksStance ?? existing.asksStance;
  const stanceTag = d.stanceTag === undefined ? (existing.stanceTag as StanceTag | null) : d.stanceTag;
  const attrError = checkStanceAttributes({
    kind,
    mode: "draft",
    asksStance,
    altOf: existing.altOf,
    stanceTag,
    threadAsksStance: facts.threadAsksStance,
    altTarget: { kind: "topic", asksStance: true, deleted: false, hidden: false },
  });
  if (attrError) return { ok: false, error: attrError };
  // Autosave replays still pass current language, destination and attribute
  // validation. Compare under the same row lock, without advancing its version.
  if (opts.skipUnchanged && existing.lang === d.lang && existing.title === (kind === "topic" ? d.title ?? null : null)
    && existing.body === d.body && existing.asksStance === asksStance && existing.stanceTag === stanceTag
    && (d.aiAssistance === undefined || existing.aiAssistance === d.aiAssistance)
    && (opts.villageId === undefined || existing.villageId === opts.villageId)) return { ok: true, version: existing.version };
  const updated = await db
    .update(drafts)
    .set({
      ...(opts.villageId === undefined ? {} : { villageId: opts.villageId }),
      asksStance,
      stanceTag,
      lang: d.lang,
      // Do not store a title in reply drafts.
      title: existing.kind === "topic" ? (d.title ?? null) : null,
      body: d.body,
      version: sql`${drafts.version} + 1`,
      // undefined: keep what the draft has (the draft screen does not send it); null: clear it.
      ...(d.aiAssistance === undefined ? {} : { aiAssistance: d.aiAssistance }),
      updatedAt: opts.now ?? new Date(),
    })
    .where(and(eq(drafts.id, draftId), eq(drafts.authorId, authorId), opts.expectedVersion === undefined ? undefined : eq(drafts.version, opts.expectedVersion)))
    .returning({ version: drafts.version });
  if (!updated.length) return { ok: false, error: opts.expectedVersion === undefined ? "not_found" : "draft_conflict" };
  return opts.expectedVersion === undefined && !opts.returnVersion ? { ok: true } : { ok: true, version: updated[0].version };
}

export async function updateDraft(...args: Parameters<typeof updateDraftImplementation>): Promise<Awaited<ReturnType<typeof updateDraftImplementation>>> {
  const [db, authorId, draftId, input, opts = {}] = args;
  const parsed = updateSchema.safeParse(input);
  if (!parsed.success) return updateDraftImplementation(...args);
  if (!villagesEnabled()) return opts.skipUnchanged ? db.transaction(tx => updateDraftImplementation(tx, authorId, draftId, input, opts)) : updateDraftImplementation(...args);
  return db.transaction(async tx => {
    await lockVillageProfile(tx, authorId);
    const [existing] = await tx.select({ kind: drafts.kind, villageId: drafts.villageId, via: drafts.via }).from(drafts)
      .where(and(eq(drafts.id, draftId), eq(drafts.authorId, authorId))).for("update");
    if (!existing) return { ok: false as const, error: "not_found" as const };
    const d = parsed.data;
    if (existing.kind === "reply") {
      if (d.village != null) return { ok: false as const, error: "village_required" as const };
      return updateDraftImplementation(tx, authorId, draftId, input, opts);
    }
    const supplied = d.village !== undefined;
    const village = await villageForTopic(tx, authorId, d.village, supplied ? null : existing.villageId);
    if (!village && (d.village != null || existing.villageId !== null || existing.via === "api")) return { ok: false as const, error: "village_required" as const };
    return updateDraftImplementation(tx, authorId, draftId, input, { ...opts, ...(supplied ? { villageId: d.village == null ? null : village?.id ?? null } : {}) });
  });
}

// Remove the original-question link (alt_of) from an alternative-framing draft only when the original becomes unreadable (deleted/hidden):
// while readable, its target is fixed at creation (updateDraft cannot change altOf). Drafts pointing to unreadable originals cannot publish (createTopic rejects with invalid_alt_of)
// and cannot retarget, so removing this link enables publication as an independent question. Leave asks_stance unchanged; it still asks for a stance and may later be unchecked.
// Return invalid_alt_of for non-alternative drafts or readable originals. Others' drafts appear nonexistent (not_found).
export async function removeDraftAltOf(
  db: Db,
  authorId: string,
  draftId: number,
  opts: { now?: Date; expectedVersion?: number; returnVersion?: boolean } = {},
): Promise<{ ok: true; version?: number } | { ok: false; error: "not_found" | "invalid_alt_of" | "draft_conflict" }> {
  const [existing] = await db
    .select({ altOf: drafts.altOf })
    .from(drafts)
    .where(and(eq(drafts.id, draftId), eq(drafts.authorId, authorId)));
  if (!existing) return { ok: false, error: "not_found" };
  if (existing.altOf === null) return { ok: false, error: "invalid_alt_of" };
  const { altTarget } = await loadStanceAttrFacts(db, { kind: "topic", altOf: existing.altOf });
  // Cannot unlink a readable original (neither deleted nor hidden). May unlink if its row is absent.
  if (altTarget && !altTarget.deleted && !altTarget.hidden) return { ok: false, error: "invalid_alt_of" };
  const updated = await db
    .update(drafts)
    .set({ altOf: null, version: sql`${drafts.version} + 1`, updatedAt: opts.now ?? new Date() })
    .where(and(eq(drafts.id, draftId), eq(drafts.authorId, authorId), eq(drafts.altOf, existing.altOf), opts.expectedVersion === undefined ? undefined : eq(drafts.version, opts.expectedVersion)))
    .returning({ version: drafts.version });
  if (!updated.length) return { ok: false, error: opts.expectedVersion === undefined ? "not_found" : "draft_conflict" };
  return opts.expectedVersion === undefined && !opts.returnVersion ? { ok: true } : { ok: true, version: updated[0].version };
}

export async function getDraft(db: Db, authorId: string, draftId: number): Promise<Draft | null> {
  const alt = alias(entries, "alt");
  const [row] = await db
    .select({ draft: drafts, threadTitle: entries.title, threadBody: threadBodyStart, threadAsksStance: entries.asksStance, tokenName: apiTokens.name, altTitle: alt.title })
    .from(drafts)
    // Reply target's topic title: omit deleted/hidden topics, whose content must remain hidden even from the draft owner.
    .leftJoin(entries, and(eq(entries.id, drafts.threadId), isNull(entries.deletedAt), isNull(entries.hiddenAt)))
    // Alternative-framing original's title: likewise only if neither deleted nor hidden.
    .leftJoin(alt, and(eq(alt.id, drafts.altOf), isNull(alt.deletedAt), isNull(alt.hiddenAt)))
    .leftJoin(apiTokens, eq(apiTokens.id, drafts.tokenId))
    .where(and(eq(drafts.id, draftId), eq(drafts.authorId, authorId)));
  if (!row) return null;
  return { ...toDraft(row.draft, (await threadLine(row.threadTitle, row.threadBody)), row.tokenName, row.altTitle, row.threadAsksStance ?? false),
    ...(villagesEnabled() && row.draft.kind === "topic" ? { village: await villageSlug(db, row.draft.villageId) } : {}) };
}

// Count the member's own pending API drafts for the header badge.
export async function countApiDrafts(db: Db, authorId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(drafts)
    .where(and(eq(drafts.authorId, authorId), eq(drafts.via, "api")));
  return Number(row.n);
}

// The member's drafts of topics, for the link to unfinished writing on the new-topic screen.
export async function ownTopicDraftIds(db: Db, authorId: string): Promise<number[]> {
  const rows = await db.select({ id: drafts.id }).from(drafts).where(and(eq(drafts.authorId, authorId), eq(drafts.kind, "topic")));
  return rows.map(row => row.id);
}

export async function listDrafts(db: Db, authorId: string, opts: { limit?: number } = {}): Promise<DraftSummary[]> {
  const rows = await db
    .select({ draft: drafts, threadTitle: entries.title, threadBody: threadBodyStart })
    .from(drafts)
    .leftJoin(entries, and(eq(entries.id, drafts.threadId), isNull(entries.deletedAt), isNull(entries.hiddenAt)))
    .where(eq(drafts.authorId, authorId))
    .orderBy(desc(drafts.updatedAt), desc(drafts.id))
    .limit(opts.limit ?? 200);
  return (await Promise.all(rows.map(async ({ draft, threadTitle, threadBody }) => ({
    id: draft.id,
    kind: draft.kind as Draft["kind"],
    threadId: draft.threadId,
    threadTitle: (await threadLine(threadTitle, threadBody)),
    lang: draft.lang as SourceLang,
    title: titleOrNull(draft.title),
    via: draft.via as EntryVia,
    updatedAt: draft.updatedAt,
    asksStance: draft.asksStance,
    excerpt: (await plainExcerpt(draft.body, DRAFT_EXCERPT_CHARS)),
    headline: (await headlineFromBody(draft.body)),
  }))));
}

// What the form says about the draft that "Write with AI" made from a screen that is not a draft screen: its id (fromDraft) and the version the screen last read (fromDraftVersion).
export function linkedDraftOf(form: FormData): { id: number; version: number } | null {
  const id = String(form.get("fromDraft") ?? ""), version = String(form.get("fromDraftVersion") ?? "");
  if (!/^[1-9]\d{0,15}$/.test(id) || !/^[1-9]\d{0,9}$/.test(version)) return null;
  return { id: Number(id), version: Number(version) };
}

// That draft is removed once what was written from it is posted, and only if it is still at the version the screen saw: an AI may have changed it since, and that version is
// kept. Call it inside the transaction of the post, so that a failure here does not leave a post made and the form still sendable.
export async function deleteLinkedDraft(db: Db, authorId: string, form: FormData, opts: { questionReplyPublished?: boolean } = {}): Promise<boolean> {
  const linked = linkedDraftOf(form);
  if (!linked) return false;
  const deleted = await db
    .delete(drafts)
    .where(and(eq(drafts.id, linked.id), eq(drafts.authorId, authorId), eq(drafts.version, linked.version)))
    .returning({ id: drafts.id });
  if (deleted.length) await finishQuestionDraft(db, linked.id, opts.questionReplyPublished === true);
  return deleted.length > 0;
}

export async function deleteDraft(db: Db, authorId: string, draftId: number): Promise<boolean> {
  return db.transaction(async tx => {
    const deleted = await tx.delete(drafts)
      .where(and(eq(drafts.id, draftId), eq(drafts.authorId, authorId)))
      .returning({ id: drafts.id });
    if (deleted.length) await finishQuestionDraft(tx, draftId, false);
    return deleted.length > 0;
  });
}

class PublishFailed extends Error {
  constructor(readonly error: EntryError, readonly village?: string) {
    super(error);
  }
}

export type PublishResult =
  | { ok: true; kind: "topic"; id: number; threadId: number }
  | { ok: true; kind: "reply"; id: number; threadId: number; followed: boolean }
  | { ok: false; error: EntryError | "not_found"; village?: string };

// Publish a draft by creating an entry and deleting the draft in one transaction.
// Delete and retrieve the draft first after checking its author, so concurrent publication creates an entry only once.
// Entry validation failure rolls back the entire transaction and retains the draft.
// Carry the draft's via into the entry.
async function publishDraftImplementation(
  db: Db,
  authorId: string,
  draftId: number,
  opts: { now?: Date; villageDisplayed?: string } = {},
): Promise<PublishResult> {
  try {
    return await db.transaction(async (tx): Promise<PublishResult> => {
      if (villagesEnabled()) await lockVillageProfile(tx, authorId);
      const [draft] = await tx
        .delete(drafts)
        .where(and(eq(drafts.id, draftId), eq(drafts.authorId, authorId)))
        .returning();
      if (!draft) return { ok: false, error: "not_found" };
      const via = draft.via as EntryVia;
      const resolved = await resolvePostLanguage(draft.body, draft.lang, draft.lang);
      const common = { ...resolved, body: draft.body, aiAssistance: draft.aiAssistance };
      if (draft.kind === "topic") {
        const res = await createTopic(tx, authorId, { ...common, title: draft.title, asksStance: draft.asksStance, altOf: draft.altOf }, { via, now: opts.now, responseTo: draft.responseTo, ...(villagesEnabled() ? { villageId: draft.villageId, villageDisplayed: opts.villageDisplayed } : {}) });
        if (!res.ok) throw new PublishFailed(res.error, res.village);
        await recordDraftPublication(tx, res.id, draft, opts.now ?? new Date());
        return { ok: true, kind: "topic", id: res.id, threadId: res.id };
      }
      const threadId = draft.threadId;
      if (threadId === null) throw new PublishFailed("thread_not_found");
      const res = await createReply(
        tx,
        authorId,
        threadId,
        { ...common, parentId: draft.parentId ?? undefined, stanceTag: draft.stanceTag },
        { via, now: opts.now },
      );
      if (!res.ok) throw new PublishFailed(res.error);
      await recordDraftPublication(tx, res.id, draft, opts.now ?? new Date());
      await finishQuestionDraft(tx, draftId, true, opts.now ?? new Date());
      return { ok: true, kind: "reply", id: res.id, threadId, followed: res.followed };
    });
  } catch (error) {
    if (error instanceof PublishFailed) return { ok: false, error: error.error, ...(error.village === undefined ? {} : { village: error.village }) };
    throw error;
  }
}

export async function publishDraft(...args: Parameters<typeof publishDraftImplementation>): Promise<PublishResult> {
  const [db, authorId, draftId] = args;
  const [draft] = await db.select().from(drafts).where(and(eq(drafts.id, draftId), eq(drafts.authorId, authorId)));
  if (!draft) return { ok: false, error: "not_found" };
  const budgetError = await checkBodyBudget(draft.body, authorId);
  if (budgetError) return { ok: false, error: budgetError };
  return withEntryRender(db, { kind: draft.kind as "topic" | "reply", body: draft.body, lang: draft.lang }, () => publishDraftImplementation(...args), authorId);
}
