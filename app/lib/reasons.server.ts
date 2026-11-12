import { availabilityKey, loadTranslationAvailability } from "~/lib/translation-availability.server";
import { FLAG_STRUCTURE_MISMATCH } from "~/lib/llm/flags";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "~/lib/db/client.server";
import { entries, profiles, reasonSelections, votes } from "~/lib/db/schema";
import { isStale, wantsTranslation, type ShownKind } from "~/lib/display";
import { loadPickedTranslations } from "~/lib/entry-display.server";
import { getEntryViews, replyLocationAt, type EntryView } from "~/lib/entries.server";
import type { Lang, SourceLang } from "~/lib/languages";
import { replyPagesOf } from "~/lib/objections.server";
import { markdownToPlainText, MAX_SOURCE_CHARS, plainExcerpt } from "~/lib/plain-text.server";
import { pickReasons, reasonsSeed, seededRandom, type ReasonCandidate, type ReasonPick } from "~/lib/reasons";
import type { Viewer } from "~/lib/roles.server";
import { isPosition, POSITIONS, type Position } from "~/lib/stances";

// The reasons panel of a question: the database side. The selection itself is pure (reasons.ts); this file reads the candidates and the picked replies.

// The replies of the question's thread that carry the mark agree, disagree or neither and may be shown: not deleted, not hidden, and not written by a member under the operator action
// exclude_reactions (a panel is a limited place of exposure, so it is not given to a member judged to be manipulating). Replies marked objection are not here (they have their own panel).
// Empty when the question is not a visible question (not a question, deleted or hidden). `lang` is the original language of the reply row; the writer's profile is read for the
// exclusion only (the writer's home area is not read at all). Each candidate carries only whether at least one non-excluded member pressed Insightful.
// The correlated EXISTS keeps the query count independent of the number of replies and uses the same voter eligibility as the displayed total.
export async function loadReasonCandidates(db: Db, questionId: number): Promise<ReasonCandidate[]> {
  const [question] = await db
    .select({ kind: entries.kind, asksStance: entries.asksStance, deletedAt: entries.deletedAt, hiddenAt: entries.hiddenAt })
    .from(entries)
    .where(eq(entries.id, questionId));
  if (!question || question.kind !== "topic" || !question.asksStance || question.deletedAt || question.hiddenAt) return [];
  const rows = await db
    .select({
      entryId: entries.id, authorId: entries.authorId, lang: entries.lang, stanceTag: entries.stanceTag,
      insightful: sql<boolean>`exists (${db.select({ entryId: votes.entryId }).from(votes)
        .innerJoin(profiles, and(eq(profiles.userId, votes.voterId), isNull(profiles.reactionsExcludedAt)))
        .where(eq(votes.entryId, entries.id))})`,
    })
    .from(entries)
    .leftJoin(profiles, eq(profiles.userId, entries.authorId))
    .where(
      and(
        eq(entries.threadId, questionId),
        eq(entries.kind, "reply"),
        inArray(entries.stanceTag, [...POSITIONS]),
        isNull(entries.deletedAt),
        isNull(entries.hiddenAt),
        isNull(profiles.reactionsExcludedAt),
      ),
    );
  const out: ReasonCandidate[] = [];
  for (const r of rows) if (isPosition(r.stanceTag)) out.push({ entryId: r.entryId, authorId: r.authorId, lang: r.lang as Lang, position: r.stanceTag, insightful: r.insightful });
  return out;
}

export type ReasonsPanel = {
  pick: ReasonPick;
  // The picked replies, as a thread would show them (the rendered HTML, the author's handle, the original language, ...). Keyed by reply id.
  views: Map<number, EntryView>;
  // Where each picked reply is in the thread (the page and the anchor), for "read in context".
  locations: Map<number, string>;
};

// One stored draw per question and UTC day, shared by Web and MCP. A conflict
// chooses the row already stored by the other reader, even across processes.
// Eligibility is checked on each read: removal, exclusion and a changed position
// empty a slot rather than causing another draw. New replies and changes to
// counted Insightful (presses, undoing or voter exclusion) wait until tomorrow;
// Insightful is not an eligibility condition for a stored pick.
// Explicit seeds draw from the current signals as a test-only override and do not modify the daily snapshot.
export async function loadReasonsPanel(db: Db, questionId: number, opts: { viewer?: Viewer; now?: Date; seed?: number; lang?: string | null }): Promise<ReasonsPanel> {
  const now = opts.now ?? new Date();
  let pick: ReasonPick;
  if (opts.seed !== undefined) {
    pick = pickReasons(await loadReasonCandidates(db, questionId), { rng: seededRandom(opts.seed) });
  } else {
    const [question] = await db.select({ id: entries.id }).from(entries).where(and(eq(entries.id, questionId), eq(entries.kind, "topic"), eq(entries.asksStance, true), isNull(entries.deletedAt), isNull(entries.hiddenAt)));
    if (!question) {
      pick = { agree: [], disagree: [], neither: [] };
    } else {
      const day = now.toISOString().slice(0, 10);
      const where = and(eq(reasonSelections.questionId, questionId), eq(reasonSelections.day, day));
      let [selected] = await db.select({ pick: reasonSelections.pick }).from(reasonSelections).where(where);
      if (!selected) {
        const candidates = await loadReasonCandidates(db, questionId);
        await db.insert(reasonSelections).values({ questionId, day, pick: pickReasons(candidates, { rng: seededRandom(reasonsSeed(questionId, now)) }) }).onConflictDoNothing({ target: [reasonSelections.questionId, reasonSelections.day] });
        [selected] = await db.select({ pick: reasonSelections.pick }).from(reasonSelections).where(where);
      }
      // A competing reader may have drawn after a new reply arrived. Refresh
      // eligibility after selecting the winner, rather than using our old draw.
      const candidates = await loadReasonCandidates(db, questionId);
      const eligible = new Map(candidates.map((c) => [c.entryId, c.position]));
      pick = Object.fromEntries(POSITIONS.map((p) => [p, selected.pick[p].filter((id) => eligible.get(id) === p)])) as ReasonPick;
    }
  }
  const ids = POSITIONS.flatMap((p: Position) => pick[p]);
  const [views, pages] = await Promise.all([getEntryViews(db, ids, opts.viewer), replyPagesOf(db, questionId, ids)]);
  const locations = new Map<number, string>();
  for (const id of ids) locations.set(id, replyLocationAt(questionId, id, pages.get(id) ?? 1, { lang: opts.lang ?? null }));
  return { pick, views, locations };
}

// The text of a picked reply as the panel shows it: a plain-text excerpt (no Markdown, no HTML), not the clipped HTML of the reply. The same reply is also in the thread's list, and
// two copies of its HTML on one page would repeat footnote ids and let the keyboard focus enter clipped content; a text excerpt has neither problem.
export const REASON_EXCERPT_CHARS = 240;

export type ReasonExcerpt = {
  text: string;
  // The language of `text`: the display language when it is the translation, otherwise the original language of the reply.
  lang: SourceLang;
  // Whether the excerpt is shorter than the reply (the panel then offers "Read more", which opens the reply in the thread).
  truncated: boolean;
  // The kind of the translation when the excerpt is the translation (the small label next to it), otherwise null.
  translation: { kind: ShownKind; engine: string | null; model: string | null; fallback: boolean; stale: boolean; structureMismatch?: boolean } | null;
  // The reader would read a translation, which does not exist yet: the original is shown.
  pending: boolean;
  unavailable?: boolean;
};

// The excerpts of the picked replies, by the rule of the other lists (the objections panel, search results): the display language's translation when the reader would read one
// (the original language is not among their reading languages) and it exists, otherwise the original.
export async function loadReasonExcerpts(db: Db, views: readonly Pick<EntryView, "id" | "lang" | "sourceHash" | "body">[], opts: { readLangs: readonly Lang[]; displayLang: Lang }): Promise<Map<number, ReasonExcerpt>> {
  const picked = await loadPickedTranslations(
    db,
    views.map((v) => ({ id: v.id, kind: "reply" as const, lang: v.lang, sourceHash: v.sourceHash })),
    opts.displayLang,
    ["body"],
  );
  const out = new Map<number, ReasonExcerpt>();
  const availability = await loadTranslationAvailability(db, views.filter(e => !picked.get(e.id)?.body && wantsTranslation(e.lang, opts.readLangs, opts.displayLang)), [opts.displayLang]);
  for (const v of views) {
    const wants = wantsTranslation(v.lang, opts.readLangs, opts.displayLang);
    const body = wants ? (picked.get(v.id)?.body ?? null) : null;
    const source = body ? body.text : v.body;
    const text = (await plainExcerpt(source, REASON_EXCERPT_CHARS));
    // The text is cut by plainExcerpt (graphemes) or, for a very long post, by the parser's limit before that.
    const truncated = text !== (await markdownToPlainText(source)) || source.length > MAX_SOURCE_CHARS;
    out.set(v.id, {
      text,
      lang: body ? opts.displayLang : v.lang,
      truncated,
      translation: body ? { kind: body.kind, engine: body.engine, model: body.model, fallback: body.fallback, stale: isStale(body.flags), ...(body.flags.includes(FLAG_STRUCTURE_MISMATCH) ? { structureMismatch: true } : {}) } : null,
      pending: wants && body === null && availability.get(availabilityKey(v.id, opts.displayLang)) !== "unavailable",
      ...(wants && body === null && availability.get(availabilityKey(v.id, opts.displayLang)) === "unavailable" ? { unavailable: true } : {}),
    });
  }
  return out;
}
