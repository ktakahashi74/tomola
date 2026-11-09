import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray, isNotNull, isNull, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "~/lib/db/client.server";
import { entries, glossaryEntries, glossaryRevisions, profiles } from "~/lib/db/schema";
import { siteOrigin } from "~/lib/http/csrf.server";
import { GLOSSARY_PAGE_SIZE, glossaryChangeKind, SINGLE_LINE, type GlossaryChangeKind, type GlossaryContent, type GlossaryVia } from "~/lib/glossary";
import { LANGS, type Lang } from "~/lib/languages";
import { checkPagination } from "~/lib/pagination";
import { inScope, type ModScope, type Viewer } from "~/lib/roles.server";
import type { GlossaryRow } from "~/lib/translations.server";

// Glossary managed by operators and assigned target-language moderators. Entries are translation candidates/notes, not a single correct answer. keep_original permits retaining source wording.
// Supply entries whose terms appear in the source as recommended prompt translations; they need not be used if unsuitable for context.
// Glossary version hashes active, undeleted row contents (glossaryVersionOf in translations.server.ts).
//
// Only createGlossaryEntry, updateGlossaryEntry, deleteGlossaryEntry, and bulk clearNeedsReviewBulk modify the glossary. Check authorization and append glossary_revisions
// while holding the entry-row lock, in the same transaction. UI and pnpm glossary:import both pass through here; source scanning in tests/glossary-revisions.test.ts enforces this.
// Only this file and translations.server.ts read glossary_entries, preventing forgotten conditions excluding deleted entries.
// Glossary changes neither queue translation jobs nor touch existing translations. They affect only subsequent translations and report retries.

export type GlossaryError =
  | "invalid_term"
  | "invalid_lang"
  | "invalid_target"
  | "same_lang"
  | "invalid_candidates"
  | "invalid_note"
  | "duplicate"
  | "not_found"
  | "forbidden"
  | "lang_fixed"
  | "invalid_proposal";

export const MAX_TERM_LENGTH = 200;
export const MAX_CANDIDATES = 20;
export const MAX_NOTE_LENGTH = 500;

// Convert one-candidate-per-line input into an array; trim whitespace and discard empty lines and duplicates.
export function parseCandidates(text: string): string[] {
  return [...new Set(text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean))];
}

export type GlossaryInput = {
  term: unknown;
  lang: unknown;
  targetLang: unknown;
  // One string per line, or an array.
  candidates?: unknown;
  note?: unknown;
  keepOriginal?: unknown;
  // Needs review: not yet verified by speakers of that language.
  needsReview?: unknown;
};

// Update input: source/target languages are immutable after creation. Optional supplied values must match stored values (lang_fixed).
export type GlossaryUpdateInput = Omit<GlossaryInput, "lang" | "targetLang"> & { lang?: unknown; targetLang?: unknown };

const termSchema = z.string().trim().min(1).max(MAX_TERM_LENGTH).regex(SINGLE_LINE);
const candidateSchema = z.string().min(1).max(MAX_TERM_LENGTH).regex(SINGLE_LINE);
const noteSchema = z.string().trim().max(MAX_NOTE_LENGTH);

type Parsed = { term: string; lang: Lang; targetLang: Lang; candidates: string[]; note: string; keepOriginal: boolean; needsReview: boolean };

// Validate term, candidates, note, and the two flags, excluding languages.
function parseContent(input: GlossaryUpdateInput): { ok: true; value: GlossaryContent } | { ok: false; error: GlossaryError } {
  const term = termSchema.safeParse(input.term);
  if (!term.success) return { ok: false, error: "invalid_term" };
  const list = Array.isArray(input.candidates) ? input.candidates.map(String) : parseCandidates(String(input.candidates ?? ""));
  const candidates = z.array(candidateSchema).max(MAX_CANDIDATES).safeParse(list);
  if (!candidates.success) return { ok: false, error: "invalid_candidates" };
  const note = noteSchema.safeParse(String(input.note ?? ""));
  if (!note.success) return { ok: false, error: "invalid_note" };
  const flag = (v: unknown) => v === true || v === "on" || v === "true";
  return { ok: true, value: { term: term.data, candidates: candidates.data, note: note.data, keepOriginal: flag(input.keepOriginal), needsReview: flag(input.needsReview) } };
}

function parse(input: GlossaryInput): { ok: true; value: Parsed } | { ok: false; error: GlossaryError } {
  const content = parseContent(input);
  if (!content.ok) return content;
  const lang = LANGS.find((l) => l === input.lang);
  if (!lang) return { ok: false, error: "invalid_lang" };
  const targetLang = LANGS.find((l) => l === input.targetLang);
  if (!targetLang) return { ok: false, error: "invalid_target" };
  if (lang === targetLang) return { ok: false, error: "same_lang" };
  return { ok: true, value: { ...content.value, lang, targetLang } };
}

export type GlossaryEntry = Parsed & { id: number; updatedAt: Date };
export type GlossaryEntryView = GlossaryEntry & { deletedAt: Date | null; updatedByHandle: string | null };

function toEntry(row: typeof glossaryEntries.$inferSelect): GlossaryEntry {
  return {
    id: row.id,
    term: row.term,
    lang: row.lang as Lang,
    targetLang: row.targetLang as Lang,
    candidates: row.candidates,
    note: row.note,
    keepOriginal: row.keepOriginal,
    needsReview: row.needsReview,
    updatedAt: row.updatedAt,
  };
}

// Contents saved in history from column values; copy arrays.
export const contentOf = (r: Pick<GlossaryContent, "term" | "candidates" | "note" | "keepOriginal" | "needsReview">): GlossaryContent => ({
  term: r.term,
  candidates: [...r.candidates],
  note: r.note,
  keepOriginal: r.keepOriginal,
  needsReview: r.needsReview,
});

export const sameContent = (a: GlossaryContent, b: GlossaryContent): boolean =>
  a.term === b.term &&
  a.note === b.note &&
  a.keepOriginal === b.keepOriginal &&
  a.needsReview === b.needsReview &&
  a.candidates.length === b.candidates.length &&
  a.candidates.every((c, i) => c === b.candidates[i]);

// ---- Authorization ----

// Editor: requireModerator result for UI, --as operator for imports. via identifies the change source, defaulting to admin.
export type GlossaryActor = { userId: string; scope: ModScope; via?: GlossaryVia };

// Shared create/update/delete authorization: operator or moderator assigned to the entry's target_lang. Language tags must match exactly
// so a zh-Hans moderator cannot edit zh-Hant targets (scripts are separate languages). Assignment to source lang grants no authority.
export const canEditGlossary = (scope: ModScope, targetLang: string): boolean => inScope(scope, targetLang);

export type GlossaryWriteOptions = {
  now?: Date;
  // Proposal entry by URL or number; empty means absent.
  proposal?: unknown;
};

// Whether the (term, lang, target_lang) unique constraint was violated. Drizzle wraps driver errors in cause.
function isDuplicate(err: unknown): boolean {
  const field = (e: unknown, key: string) =>
    typeof e === "object" && e !== null && key in e ? (e as Record<string, unknown>)[key] : undefined;
  return [err, field(err, "cause")].some((e) => field(e, "code") === "23505");
}

// Container for returning a result mid-transaction by throwing to roll back.
class Abort<E extends string> extends Error {
  constructor(readonly error: E) {
    super(error);
  }
}

// Run the change inside a transaction. If Abort is thrown, roll back writes and return its error result.
// If db is already transactional (imports wrap the entire operation), this creates a nested transaction/savepoint.
async function atomically<T, E extends string>(db: Db, run: (tx: Db) => Promise<T>): Promise<T | { ok: false; error: E }> {
  try {
    return await db.transaction(async (tx) => run(tx));
  } catch (err) {
    if (err instanceof Abort) return { ok: false, error: err.error as E };
    throw err;
  }
}

// ---- Proposal entry ----

// Parse a reference, empty meaning absent. Accept a number or this site's topic URL (/t/<id>, optionally ?lang= or #); reject external URLs.
// Require an undeleted, unhidden topic (kind = 'topic'). Replies/absent ids yield invalid_proposal. It need not ask for a stance.
export async function resolveProposal(tx: Db, raw: unknown): Promise<{ ok: true; entryId: number | null } | { ok: false; error: "invalid_proposal" }> {
  const text = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw.trim() : raw == null ? "" : null;
  if (text === null) return { ok: false, error: "invalid_proposal" };
  if (text === "") return { ok: true, entryId: null };
  let id: number | null = null;
  if (/^\d{1,15}$/.test(text)) id = Number(text);
  else {
    try {
      // Site-local paths such as 「/t/12」 are also accepted.
      const url = new URL(text, siteOrigin());
      const path = /^\/t\/(\d{1,15})\/?$/.exec(url.pathname);
      if (url.origin === siteOrigin() && path) id = Number(path[1]);
    } catch {
      // Not parseable as a URL.
    }
  }
  if (id === null || id < 1) return { ok: false, error: "invalid_proposal" };
  const [found] = await tx
    .select({ id: entries.id })
    .from(entries)
    .where(and(eq(entries.id, id), eq(entries.kind, "topic"), isNull(entries.deletedAt), isNull(entries.hiddenAt)));
  return found ? { ok: true, entryId: found.id } : { ok: false, error: "invalid_proposal" };
}

// ---- Writes with history ----

async function addRevision(
  tx: Db,
  rev: { entryId: number; before: GlossaryContent | null; after: GlossaryContent | null; actor: GlossaryActor; proposalEntryId: number | null; now: Date },
) {
  await tx.insert(glossaryRevisions).values({
    entryId: rev.entryId,
    before: rev.before,
    after: rev.after,
    editorId: rev.actor.userId,
    via: rev.actor.via ?? "admin",
    proposalEntryId: rev.proposalEntryId,
    createdAt: rev.now,
  });
}

export async function createGlossaryEntry(
  db: Db,
  actor: GlossaryActor,
  input: GlossaryInput,
  opts: GlossaryWriteOptions = {},
): Promise<{ ok: true; id: number; revived: boolean } | { ok: false; error: GlossaryError }> {
  const parsed = parse(input);
  if (!parsed.ok) return parsed;
  const value = parsed.value;
  // Authorize creation against the input target language.
  if (!canEditGlossary(actor.scope, value.targetLang)) return { ok: false, error: "forbidden" };
  const now = opts.now ?? new Date();
  return atomically<{ ok: true; id: number; revived: boolean }, GlossaryError>(db, async (tx) => {
    const proposal = await resolveProposal(tx, opts.proposal);
    if (!proposal.ok) throw new Abort(proposal.error);
    const after = contentOf(value);
    // Read and lock the same combination, including deleted rows. Active means duplicate; deleted means restore the same row, keeping one continuous history.
    const [existing] = await tx
      .select()
      .from(glossaryEntries)
      .where(and(eq(glossaryEntries.term, value.term), eq(glossaryEntries.lang, value.lang), eq(glossaryEntries.targetLang, value.targetLang)))
      .for("update");
    if (existing) {
      if (existing.deletedAt === null) throw new Abort("duplicate");
      await tx
        .update(glossaryEntries)
        .set({ candidates: after.candidates, note: after.note, keepOriginal: after.keepOriginal, needsReview: after.needsReview, deletedAt: null, updatedBy: actor.userId, updatedAt: now })
        .where(eq(glossaryEntries.id, existing.id));
      await addRevision(tx, { entryId: existing.id, before: null, after, actor, proposalEntryId: proposal.entryId, now });
      return { ok: true, id: existing.id, revived: true };
    }
    let id: number;
    try {
      const [row] = await tx
        .insert(glossaryEntries)
        .values({ term: value.term, lang: value.lang, targetLang: value.targetLang, candidates: after.candidates, note: after.note, keepOriginal: after.keepOriginal, needsReview: after.needsReview, updatedBy: actor.userId, updatedAt: now })
        .returning({ id: glossaryEntries.id });
      id = row.id;
    } catch (err) {
      // Concurrent creation: the first commit succeeds; the unique index blocks the later one.
      if (isDuplicate(err)) throw new Abort("duplicate");
      throw err;
    }
    await addRevision(tx, { entryId: id, before: null, after, actor, proposalEntryId: proposal.entryId, now });
    return { ok: true, id, revived: false };
  });
}

export async function updateGlossaryEntry(
  db: Db,
  actor: GlossaryActor,
  id: number,
  input: GlossaryUpdateInput,
  opts: GlossaryWriteOptions = {},
): Promise<{ ok: true; changed: boolean } | { ok: false; error: GlossaryError }> {
  const parsed = parseContent(input);
  if (!parsed.ok) return parsed;
  const after = parsed.value;
  const now = opts.now ?? new Date();
  return atomically<{ ok: true; changed: boolean }, GlossaryError>(db, async (tx) => {
    // Read with a row lock, serializing writes to the same entry so history remains a continuous chain.
    const [row] = await tx
      .select()
      .from(glossaryEntries)
      .where(and(eq(glossaryEntries.id, id), isNull(glossaryEntries.deletedAt)))
      .for("update");
    if (!row) throw new Abort("not_found");
    // Authorize changes against the stored row's target language, not submitted input.
    if (!canEditGlossary(actor.scope, row.targetLang)) throw new Abort("forbidden");
    // Source/target languages are immutable after creation, keeping authorization fixed to the row's target language. Delete and recreate to change the combination.
    const given = (v: unknown) => v !== undefined && v !== null && v !== "";
    if ((given(input.lang) && input.lang !== row.lang) || (given(input.targetLang) && input.targetLang !== row.targetLang)) throw new Abort("lang_fixed");
    const proposal = await resolveProposal(tx, opts.proposal);
    if (!proposal.ok) throw new Abort(proposal.error);
    const before = contentOf(row);
    // For identical contents, write nothing: neither history nor updated_at changes; discard the proposal reference.
    if (sameContent(before, after)) return { ok: true, changed: false };
    try {
      await tx
        .update(glossaryEntries)
        .set({ term: after.term, candidates: after.candidates, note: after.note, keepOriginal: after.keepOriginal, needsReview: after.needsReview, updatedBy: actor.userId, updatedAt: now })
        .where(eq(glossaryEntries.id, id));
    } catch (err) {
      // Changing the term produced a combination matching another row, including deleted rows.
      if (isDuplicate(err)) throw new Abort("duplicate");
      throw err;
    }
    await addRevision(tx, { entryId: id, before, after, actor, proposalEntryId: proposal.entryId, now });
    return { ok: true, changed: true };
  });
}

// Soft-delete by setting deleted_at. History records 「削除」, and readding the same combination restores the same row.
export async function deleteGlossaryEntry(
  db: Db,
  actor: GlossaryActor,
  id: number,
  opts: GlossaryWriteOptions = {},
): Promise<{ ok: true } | { ok: false; error: "not_found" | "forbidden" | "invalid_proposal" }> {
  const now = opts.now ?? new Date();
  return atomically<{ ok: true }, "not_found" | "forbidden" | "invalid_proposal">(db, async (tx) => {
    const [row] = await tx
      .select()
      .from(glossaryEntries)
      .where(and(eq(glossaryEntries.id, id), isNull(glossaryEntries.deletedAt)))
      .for("update");
    if (!row) throw new Abort("not_found");
    if (!canEditGlossary(actor.scope, row.targetLang)) throw new Abort("forbidden");
    const proposal = await resolveProposal(tx, opts.proposal);
    if (!proposal.ok) throw new Abort(proposal.error);
    await tx.update(glossaryEntries).set({ deletedAt: now, updatedBy: actor.userId, updatedAt: now }).where(eq(glossaryEntries.id, id));
    await addRevision(tx, { entryId: id, before: contentOf(row), after: null, actor, proposalEntryId: proposal.entryId, now });
    return { ok: true };
  });
}

// ---- Clearing needs_review in bulk ----

// The most entries one bulk request may name (a page has GLOSSARY_PAGE_SIZE; "all of a language" names none). Keeps the bind parameters of the queries bounded.
export const MAX_BULK_IDS = 1000;
// Rows per UPDATE and per INSERT of revisions: "all of a language" may touch thousands of rows, and one statement may bind only 65535 parameters.
export const BULK_WRITE_CHUNK = 500;

export type ClearNeedsReviewInput = { targetLang: unknown; now?: Date } & (
  // The entries the person selected, each with the updated_at (ms since the epoch) it had when the screen showed it. A row that was changed since is not marked: the person
  // would be marking content they never saw (stale).
  | { entries: ReadonlyArray<{ id: number; updatedAt: number }> }
  // Every active entry of the target language that needs review, as fingerprinted (needsReviewSummary) when the person was asked. If the rows are not the same now
  // (a row was added, changed, cleared or deleted), nothing is written (rows_changed): the person confirms what is there now.
  | { all: { fingerprint: string } }
);

export type ClearNeedsReviewResult =
  | { ok: true; changed: number; skipped: number; forbidden: number; stale: number }
  | { ok: false; error: "invalid_target" | "invalid_ids" }
  | { ok: false; error: "rows_changed"; actual: number };

// A fingerprint over (id, updated_at) of the rows, in id order: it differs when a row of the set is added, removed or changed.
function fingerprintOf(rows: ReadonlyArray<{ id: number; updatedAt: Date }>): string {
  return createHash("sha256").update(rows.map((r) => `${r.id}@${r.updatedAt.getTime()}`).join("\n")).digest("hex").slice(0, 16);
}

// What "mark all entries of this language as reviewed" would touch: the number of active entries of the target language that need review, the time of the latest change among
// them, and the fingerprint that clearNeedsReviewBulk checks when the person has confirmed.
export async function needsReviewSummary(db: Db, targetLang: Lang): Promise<{ count: number; latest: Date | null; fingerprint: string }> {
  const rows = await db
    .select({ id: glossaryEntries.id, updatedAt: glossaryEntries.updatedAt })
    .from(glossaryEntries)
    .where(and(eq(glossaryEntries.targetLang, targetLang), isNull(glossaryEntries.deletedAt), eq(glossaryEntries.needsReview, true)))
    .orderBy(asc(glossaryEntries.id));
  const latest = rows.reduce<Date | null>((max, r) => (max === null || r.updatedAt > max ? r.updatedAt : max), null);
  return { count: rows.length, latest, fingerprint: fingerprintOf(rows) };
}

// Clears needs_review ("the target language's speakers have checked the candidates") of many entries at once, for the people who may edit them (canEditGlossary on each entry's
// own saved target language: an operator, or a moderator of that target language; zh-Hans and zh-Hant are different languages). One transaction: the rows are locked first
// (in id order, so two bulk requests cannot wait for each other) and every decision is made on the locked rows, so a concurrent single edit is either before (its result is
// then seen as a change: stale, or rows_changed) or after (it sees the cleared row). One revision per entry that changed (via actor.via, admin by default; before and after
// include needsReview; no proposal post), and updated_by and updated_at are written like any other change, so the list and /glossary show the reviewer and the time.
//
// Per entry: missing or soft-deleted -> skipped; not editable by the actor -> forbidden (nothing is written for it); another target language than targetLang -> skipped;
// already cleared -> skipped; changed since the person was shown it -> stale (not cleared); otherwise changed. Nothing else is touched: needs_review is not in the glossary
// version (glossaryVersionOf) and is not passed to the translator, so the version stays the same, and no translation job is enqueued and no existing translation is touched
// (like every glossary change).
export async function clearNeedsReviewBulk(db: Db, actor: GlossaryActor, input: ClearNeedsReviewInput): Promise<ClearNeedsReviewResult> {
  const targetLang = LANGS.find((l) => l === input.targetLang);
  if (!targetLang) return { ok: false, error: "invalid_target" };
  // id -> the updated_at (ms) the person saw; null means "all of the language".
  let seen: Map<number, number> | null = null;
  if ("entries" in input) {
    if (input.entries.length > MAX_BULK_IDS || input.entries.some((e) => !Number.isSafeInteger(e.id) || e.id < 1 || !Number.isSafeInteger(e.updatedAt) || e.updatedAt < 0)) {
      return { ok: false, error: "invalid_ids" };
    }
    seen = new Map();
    for (const e of input.entries) if (!seen.has(e.id)) seen.set(e.id, e.updatedAt);
  }
  const now = input.now ?? new Date();
  return atomically<ClearNeedsReviewResult, never>(db, async (tx) => {
    let rows: Array<typeof glossaryEntries.$inferSelect> = [];
    let missing = 0;
    let forbidden = 0;
    if (seen === null) {
      if (canEditGlossary(actor.scope, targetLang)) {
        // Rows that are cleared or deleted by a concurrent write while this waits for the lock drop out of the result (the condition is checked again on the new row).
        rows = await tx
          .select()
          .from(glossaryEntries)
          .where(and(eq(glossaryEntries.targetLang, targetLang), isNull(glossaryEntries.deletedAt), eq(glossaryEntries.needsReview, true)))
          .orderBy(asc(glossaryEntries.id))
          .for("update");
      } else {
        // Not this person's language: nothing to lock or write; just say how many rows they were refused.
        forbidden = await countNeedsReview(tx, targetLang);
      }
    } else if (seen.size > 0) {
      rows = await tx.select().from(glossaryEntries).where(inArray(glossaryEntries.id, [...seen.keys()])).orderBy(asc(glossaryEntries.id)).for("update");
      missing = seen.size - rows.length;
    }
    let skipped = missing;
    let stale = 0;
    const toClear: Array<typeof glossaryEntries.$inferSelect> = [];
    for (const row of rows) {
      if (row.deletedAt !== null) skipped++;
      else if (!canEditGlossary(actor.scope, row.targetLang)) forbidden++;
      else if (row.targetLang !== targetLang || !row.needsReview) skipped++;
      else if (seen !== null && row.updatedAt.getTime() !== seen.get(row.id)) stale++;
      else toClear.push(row);
    }
    if ("all" in input && canEditGlossary(actor.scope, targetLang) && fingerprintOf(toClear) !== input.all.fingerprint) {
      return { ok: false, error: "rows_changed", actual: toClear.length };
    }
    for (let i = 0; i < toClear.length; i += BULK_WRITE_CHUNK) {
      const chunk = toClear.slice(i, i + BULK_WRITE_CHUNK);
      await tx
        .update(glossaryEntries)
        .set({ needsReview: false, updatedBy: actor.userId, updatedAt: now })
        .where(inArray(glossaryEntries.id, chunk.map((r) => r.id)));
      await tx.insert(glossaryRevisions).values(
        chunk.map((row) => ({
          entryId: row.id,
          before: contentOf(row),
          after: { ...contentOf(row), needsReview: false },
          editorId: actor.userId,
          via: actor.via ?? "admin",
          proposalEntryId: null,
          createdAt: now,
        })),
      );
    }
    return { ok: true, changed: toClear.length, skipped, forbidden, stale };
  });
}

// How many active entries of a target language still need review (the N of "mark all N entries of this language as reviewed", and what pnpm langs:open checks).
export async function countNeedsReview(db: Db, targetLang: Lang): Promise<number> {
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(glossaryEntries)
    .where(and(eq(glossaryEntries.targetLang, targetLang), isNull(glossaryEntries.deletedAt), eq(glossaryEntries.needsReview, true)));
  return n;
}

// ---- Reads ----

export type GlossaryListOptions = {
  from?: Lang;
  to?: Lang;
  // If true, deleted entries only.
  deleted?: boolean;
  // Only entries editable in this scope (/admin/glossary; all for operators).
  editableBy?: ModScope;
  // true: only the entries that still need review (the "needs review only" filter of /admin/glossary).
  needsReview?: boolean;
  page?: number;
  limit?: number;
};

// Listing in term/source-language/target-language order. hasNext indicates a subsequent page.
export async function listGlossary(db: Db, opts: GlossaryListOptions = {}): Promise<{ entries: GlossaryEntryView[]; hasNext: boolean }> {
  const { limit, offset } = checkPagination({ page: opts.page, limit: opts.limit }, GLOSSARY_PAGE_SIZE);
  const where: SQL[] = [opts.deleted ? isNotNull(glossaryEntries.deletedAt) : isNull(glossaryEntries.deletedAt)];
  if (opts.from) where.push(eq(glossaryEntries.lang, opts.from));
  if (opts.to) where.push(eq(glossaryEntries.targetLang, opts.to));
  if (opts.needsReview) where.push(eq(glossaryEntries.needsReview, true));
  if (opts.editableBy && !opts.editableBy.operator) {
    where.push(opts.editableBy.langs.length > 0 ? inArray(glossaryEntries.targetLang, [...opts.editableBy.langs]) : sql`false`);
  }
  const rows = await db
    .select({ entry: glossaryEntries, handle: profiles.handle })
    .from(glossaryEntries)
    .leftJoin(profiles, eq(profiles.userId, glossaryEntries.updatedBy))
    .where(and(...where))
    .orderBy(asc(glossaryEntries.term), asc(glossaryEntries.lang), asc(glossaryEntries.targetLang), asc(glossaryEntries.id))
    .limit(limit + 1)
    .offset(offset);
  return {
    entries: rows.slice(0, limit).map((r) => ({ ...toEntry(r.entry), deletedAt: r.entry.deletedAt, updatedByHandle: r.handle })),
    hasNext: rows.length > limit,
  };
}

export type GlossaryRevisionView = {
  id: number;
  kind: GlossaryChangeKind;
  before: GlossaryContent | null;
  after: GlossaryContent | null;
  editorHandle: string | null;
  proposalEntryId: number | null;
  createdAt: Date;
};

// Per-entry history, newest first. Fetch history for displayed entries in one query; empty arrays for entries without history.
// limit caps each entry's history from the newest end, using a window function to enforce per-entry limits in one query.
export async function listGlossaryRevisions(db: Db, entryIds: readonly number[], opts: { limit?: number } = {}): Promise<Map<number, GlossaryRevisionView[]>> {
  const out = new Map<number, GlossaryRevisionView[]>(entryIds.map((id) => [id, []]));
  if (entryIds.length === 0) return out;
  const where: SQL[] = [inArray(glossaryRevisions.entryId, [...entryIds])];
  if (opts.limit !== undefined) {
    const ids = sql.join(entryIds.map((id) => sql`${id}`), sql`, `);
    where.push(
      sql`${glossaryRevisions.id} in (select id from (select id, row_number() over (partition by entry_id order by id desc) as rn from glossary_revisions where entry_id in (${ids})) ranked where rn <= ${opts.limit})`,
    );
  }
  const rows = await db
    .select({ rev: glossaryRevisions, handle: profiles.handle })
    .from(glossaryRevisions)
    .leftJoin(profiles, eq(profiles.userId, glossaryRevisions.editorId))
    .where(and(...where))
    .orderBy(desc(glossaryRevisions.id));
  for (const { rev, handle } of rows) {
    out.get(rev.entryId)?.push({
      id: rev.id,
      kind: glossaryChangeKind(rev),
      before: rev.before,
      after: rev.after,
      editorHandle: handle,
      proposalEntryId: rev.proposalEntryId,
      createdAt: rev.createdAt,
    });
  }
  return out;
}

// The number of revisions of each entry (the page shows the newest few and says how many there are).
export async function countGlossaryRevisions(db: Db, entryIds: readonly number[]): Promise<Map<number, number>> {
  const out = new Map<number, number>(entryIds.map((id) => [id, 0]));
  if (entryIds.length === 0) return out;
  const rows = await db
    .select({ entryId: glossaryRevisions.entryId, n: sql<number>`count(*)::int` })
    .from(glossaryRevisions)
    .where(inArray(glossaryRevisions.entryId, [...entryIds]))
    .groupBy(glossaryRevisions.entryId);
  for (const r of rows) out.set(r.entryId, r.n);
  return out;
}

// Takes the lock that serializes an import against every other glossary write. The import decides what to skip ("a person edited this row") from the rows it reads
// first, so a screen edit that commits after that read would be overwritten without --overwrite-edited. EXCLUSIVE conflicts with the ROW SHARE lock that
// SELECT ... FOR UPDATE takes, so a screen edit waits on the table before it takes a row lock (a weaker mode would let the two wait for each other).
// Call it first in the import transaction, before reading anything.
export async function lockGlossaryForImport(tx: Db): Promise<void> {
  await tx.execute(sql`lock table glossary_entries in exclusive mode`);
}

// One active, undeleted entry, used by the translation-proposal template (glossary-proposal.server.ts).
export async function getActiveGlossaryEntry(db: Db, id: number): Promise<GlossaryEntry | null> {
  const [row] = await db
    .select()
    .from(glossaryEntries)
    .where(and(eq(glossaryEntries.id, id), isNull(glossaryEntries.deletedAt)));
  return row ? toEntry(row) : null;
}

// All active entries for export; callers choose ordering.
export async function loadAllGlossary(db: Db): Promise<GlossaryRow[]> {
  return db.select().from(glossaryEntries).where(isNull(glossaryEntries.deletedAt)).orderBy(asc(glossaryEntries.id));
}

// Editor display for listing 「最後に変えた人」 and history 「変えた人」. UI/Markdown show only the strings returned here.
// Show handles to all members. Change only this function to change visibility; viewer supports that. Null for absent handles, unrecorded editors, or deleted members.
export function editorLabel(_viewer: Viewer | null, who: { editorHandle: string | null }): string | null {
  return who.editorHandle === null ? null : `@${who.editorHandle}`;
}

// All rows, including deleted ones, and their latest history source, read by pnpm glossary:import.
export type GlossaryImportRow = GlossaryRow & { lastVia: GlossaryVia | null };

export async function loadGlossaryForImport(db: Db): Promise<GlossaryImportRow[]> {
  const rows = await db.select().from(glossaryEntries).orderBy(asc(glossaryEntries.id));
  if (rows.length === 0) return [];
  // Source of each row's latest history, with the greatest id.
  const last = await db
    .selectDistinctOn([glossaryRevisions.entryId], { entryId: glossaryRevisions.entryId, via: glossaryRevisions.via })
    .from(glossaryRevisions)
    .orderBy(glossaryRevisions.entryId, desc(glossaryRevisions.id));
  const via = new Map(last.map((r) => [r.entryId, r.via as GlossaryVia]));
  return rows.map((r) => ({ ...r, lastVia: via.get(r.id) ?? null }));
}
