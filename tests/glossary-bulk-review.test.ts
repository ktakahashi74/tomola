import { and, asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { glossaryEntries, glossaryRevisions, jobs, profiles, translations } from "~/lib/db/schema";
import { createTopic } from "~/lib/entries.server";
import { glossaryChangeKind, isReviewMark } from "~/lib/glossary";
import {
  BULK_WRITE_CHUNK,
  clearNeedsReviewBulk,
  countNeedsReview,
  createGlossaryEntry,
  deleteGlossaryEntry,
  listGlossary,
  listGlossaryRevisions,
  MAX_BULK_IDS,
  needsReviewSummary,
  updateGlossaryEntry,
  type GlossaryActor,
} from "~/lib/glossary.server";
import type { Lang } from "~/lib/languages";
import { grantModerator, type ModScope } from "~/lib/roles.server";
import { getGlossaryVersion, loadGlossary, matchGlossary } from "~/lib/translations.server";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";

// Clearing needs_review in bulk: the function (permissions per entry, one revision per changed entry, the skips, the counts, no job and no version change)
// and the action of /admin/glossary (origin first, the moderator gate, the confirmation step, filters kept). A few tests add many rows through a harness, so give them room.
vi.setConfig({ testTimeout: 30_000 });

const OPERATOR: ModScope = { operator: true, langs: [] };
const mod = (...langs: Array<"ja" | "en" | "fr" | "zh-Hans" | "zh-Hant">): ModScope => ({ operator: false, langs });
const NONE: ModScope = { operator: false, langs: [] };
const T0 = new Date(Date.UTC(2026, 9, 5, 0, 0));
const T3 = new Date(Date.UTC(2026, 9, 5, 0, 3));
const T5 = new Date(Date.UTC(2026, 9, 5, 0, 5));

let h: RouteHarness;
let ids: Record<string, string>;
let op: GlossaryActor;
const saved = process.env.OPERATOR_EMAILS;
const actor = (userId: string, scope: ModScope): GlossaryActor => ({ userId, scope });
let seq = 0;

beforeAll(async () => {
  process.env.OPERATOR_EMAILS = "boss@example.com";
  h = await setupRouteHarness();
  for (const handle of ["boss", "frmod", "jamod", "hansmod", "hantmod", "bothmod", "susmod", "plain"]) await h.signIn(handle);
  ids = h.ids;
  for (const [handle, lang] of [["frmod", "fr"], ["jamod", "ja"], ["hansmod", "zh-Hans"], ["hantmod", "zh-Hant"], ["bothmod", "zh-Hans"], ["bothmod", "zh-Hant"], ["susmod", "fr"]] as const) {
    const res = await grantModerator(h.db, ids.boss, ids[handle], lang);
    if (!res.ok) throw new Error("grant failed");
  }
  await h.db.update(profiles).set({ suspendedUntil: new Date(Date.now() + 86_400_000), suspendedReason: "spam" }).where(eq(profiles.userId, ids.susmod));
  op = actor(ids.boss, OPERATOR);
});
afterAll(() => {
  h.restore();
  if (saved === undefined) delete process.env.OPERATOR_EMAILS;
  else process.env.OPERATOR_EMAILS = saved;
});

// Entries with their own terms (the database is shared by the tests of this file). Each needs review unless said otherwise.
async function make(targetLang: string, over: { lang?: string; needsReview?: boolean; candidates?: string; note?: string; keepOriginal?: boolean } = {}): Promise<number> {
  const n = ++seq;
  const res = await createGlossaryEntry(
    h.db,
    op,
    { term: `bulk-${n}`, lang: over.lang ?? "en", targetLang, candidates: over.candidates ?? `cand-${n}`, note: over.note ?? "", keepOriginal: over.keepOriginal ?? false, needsReview: over.needsReview ?? true },
    { now: T0 },
  );
  if (!res.ok) throw new Error(`create failed: ${res.error}`);
  return res.id;
}
const rowOf = async (id: number) => (await h.db.select().from(glossaryEntries).where(eq(glossaryEntries.id, id)))[0];
const revsOf = (id: number) => h.db.select().from(glossaryRevisions).where(eq(glossaryRevisions.entryId, id)).orderBy(asc(glossaryRevisions.id));
// The entries as a screen shows them: each with the updated_at (ms) it has now.
const pick = async (...entryIds: number[]) => Promise.all(entryIds.map(async (id) => ({ id, updatedAt: (await rowOf(id))?.updatedAt.getTime() ?? 0 })));
// "All of a language" as the confirmation fixes it: the fingerprint of the rows that need review now.
const allOf = async (lang: Lang) => ({ all: { fingerprint: (await needsReviewSummary(h.db, lang)).fingerprint } });
const state = async (...entryIds: number[]) => JSON.stringify([await Promise.all(entryIds.map(rowOf)), await Promise.all(entryIds.map(revsOf))]);

describe("clearNeedsReviewBulk", () => {
  it("clears the named entries and writes one revision for each: via admin, the editor, before and after with needsReview, the reviewer and the time on the row", async () => {
    const a = await make("fr", { note: "n", keepOriginal: true });
    const b = await make("fr", { lang: "ja", candidates: "x\ny" });
    const c = await make("fr");
    const res = await clearNeedsReviewBulk(h.db, op, { targetLang: "fr", entries: await pick(a, b), now: T5 });
    expect(res).toEqual({ ok: true, changed: 2, skipped: 0, forbidden: 0, stale: 0 });
    for (const id of [a, b]) {
      const revs = await revsOf(id);
      expect(revs).toHaveLength(2);
      const last = revs[1];
      expect(last).toMatchObject({ entryId: id, editorId: ids.boss, via: "admin", proposalEntryId: null });
      expect(last.createdAt).toEqual(T5);
      expect(last.before).toEqual({ ...revs[0].after, needsReview: true });
      expect(last.after).toEqual({ ...last.before, needsReview: false });
      expect(glossaryChangeKind(last)).toBe("updated");
      expect(isReviewMark(last.before, last.after)).toBe(true);
      // Nothing but the flag, the reviewer and the time changed on the row
      const row = await rowOf(id);
      expect(row).toMatchObject({ needsReview: false, updatedBy: ids.boss, deletedAt: null });
      expect(row.updatedAt).toEqual(T5);
      expect(row.candidates).toEqual((last.after as { candidates: string[] }).candidates);
    }
    expect((await rowOf(a)).note).toBe("n");
    expect((await rowOf(a)).keepOriginal).toBe(true);
    // The entry that was not named is as it was
    expect((await rowOf(c)).needsReview).toBe(true);
    expect(await revsOf(c)).toHaveLength(1);
    // The history the page reads shows the reviewer's handle
    const history = (await listGlossaryRevisions(h.db, [a])).get(a)!;
    expect(history[0]).toMatchObject({ kind: "updated", editorHandle: "boss" });
  });

  it("skips entries that are already cleared, deleted, missing or of another target language, writes nothing for them, and counts them", async () => {
    const need = await make("fr");
    const cleared = await make("fr", { needsReview: false });
    const deleted = await make("fr");
    expect(await deleteGlossaryEntry(h.db, op, deleted, { now: T0 })).toEqual({ ok: true });
    const other = await make("zh-Hans");
    const before = await state(cleared, deleted, other);
    const res = await clearNeedsReviewBulk(h.db, op, { targetLang: "fr", entries: await pick(need, cleared, deleted, other, 9_999_999), now: T5 });
    expect(res).toEqual({ ok: true, changed: 1, skipped: 4, forbidden: 0, stale: 0 });
    expect(await state(cleared, deleted, other)).toBe(before);
    expect((await rowOf(deleted)).needsReview).toBe(true);
    // A second run changes nothing and writes no revision
    const revs = (await revsOf(need)).length;
    expect(await clearNeedsReviewBulk(h.db, op, { targetLang: "fr", entries: await pick(need), now: T5 })).toEqual({ ok: true, changed: 0, skipped: 1, forbidden: 0, stale: 0 });
    expect(await revsOf(need)).toHaveLength(revs);
  });

  it("clears every active entry of the target language that needs review, whatever the language of the term, and leaves the other languages, the cleared and the deleted alone", async () => {
    // A language of its own for this test: the database is shared, so use a target language that no other test fills with entries that need review
    const rows = [await make("de"), await make("de", { lang: "ja" }), await make("de", { lang: "fr" })];
    const cleared = await make("de", { needsReview: false });
    const deleted = await make("de");
    await deleteGlossaryEntry(h.db, op, deleted, { now: T0 });
    const otherLang = await make("ja");
    const before = await state(cleared, deleted, otherLang);
    expect(await countNeedsReview(h.db, "de")).toBe(3);
    expect(await clearNeedsReviewBulk(h.db, op, { targetLang: "de", ...(await allOf("de")), now: T5 })).toEqual({ ok: true, changed: 3, skipped: 0, forbidden: 0, stale: 0 });
    expect(await countNeedsReview(h.db, "de")).toBe(0);
    for (const id of rows) expect(await revsOf(id)).toHaveLength(2);
    expect(await state(cleared, deleted, otherLang)).toBe(before);
    expect((await listGlossary(h.db, { to: "de", needsReview: true })).entries).toEqual([]);
    expect(await clearNeedsReviewBulk(h.db, op, { targetLang: "de", ...(await allOf("de")), now: T5 })).toEqual({ ok: true, changed: 0, skipped: 0, forbidden: 0, stale: 0 });
  });

  it("marks only what the person was shown: a row whose candidates changed after the page was loaded is stale, keeps needs_review and gets no revision", async () => {
    const changedLater = await make("fr");
    const untouched = await make("fr");
    const shown = await pick(changedLater, untouched);
    // Someone else (an editor, an operator, an import) changes the candidates after the page was loaded
    expect(await updateGlossaryEntry(h.db, op, changedLater, { term: (await rowOf(changedLater)).term, candidates: "new candidate", needsReview: true }, { now: T3 })).toEqual({ ok: true, changed: true });
    const revs = (await revsOf(changedLater)).length;
    const res = await clearNeedsReviewBulk(h.db, op, { targetLang: "fr", entries: shown, now: T5 });
    expect(res).toEqual({ ok: true, changed: 1, skipped: 0, forbidden: 0, stale: 1 });
    expect(await rowOf(changedLater)).toMatchObject({ needsReview: true, candidates: ["new candidate"] });
    expect(await revsOf(changedLater)).toHaveLength(revs);
    expect((await rowOf(untouched)).needsReview).toBe(false);
    // The person looks again (the page shows the new time): now it is marked
    expect(await clearNeedsReviewBulk(h.db, op, { targetLang: "fr", entries: await pick(changedLater), now: T5 })).toEqual({ ok: true, changed: 1, skipped: 0, forbidden: 0, stale: 0 });
    // A row that was changed and also marked by someone else is "already reviewed", not stale
    const other = await make("fr");
    const seenOther = await pick(other);
    await clearNeedsReviewBulk(h.db, op, { targetLang: "fr", entries: seenOther, now: T3 });
    expect(await clearNeedsReviewBulk(h.db, op, { targetLang: "fr", entries: seenOther, now: T5 })).toEqual({ ok: true, changed: 0, skipped: 1, forbidden: 0, stale: 0 });
  });

  it("all of a language: writes nothing when the rows are not the ones that were confirmed (a candidate changed, a row added, marked or deleted), and says how many there are now", async () => {
    // A target language of its own in this test (vi): the fingerprint covers the whole language
    const rows = [await make("vi"), await make("vi"), await make("vi")];
    const before0 = await state(rows[0]);
    const confirmed = await needsReviewSummary(h.db, "vi");
    expect(confirmed.count).toBe(3);
    expect(confirmed.latest).toEqual(T0);
    const asked = { targetLang: "vi", all: { fingerprint: confirmed.fingerprint }, now: T5 };
    // Nothing changed since: the same fingerprint (it does not depend on the time of asking)
    expect((await needsReviewSummary(h.db, "vi")).fingerprint).toBe(confirmed.fingerprint);
    // A candidate changed (the row still needs review): not the same rows
    await updateGlossaryEntry(h.db, op, rows[1], { term: (await rowOf(rows[1])).term, candidates: "edited", needsReview: true }, { now: T3 });
    expect(await clearNeedsReviewBulk(h.db, op, asked)).toEqual({ ok: false, error: "rows_changed", actual: 3 });
    expect((await needsReviewSummary(h.db, "vi")).latest).toEqual(T3);
    // A row is added, marked, deleted
    const fresh = await needsReviewSummary(h.db, "vi");
    const added = await make("vi");
    expect(await clearNeedsReviewBulk(h.db, op, { ...asked, all: { fingerprint: fresh.fingerprint } })).toEqual({ ok: false, error: "rows_changed", actual: 4 });
    const withAdded = await needsReviewSummary(h.db, "vi");
    await clearNeedsReviewBulk(h.db, op, { targetLang: "vi", entries: await pick(added), now: T3 });
    expect(await clearNeedsReviewBulk(h.db, op, { ...asked, all: { fingerprint: withAdded.fingerprint } })).toEqual({ ok: false, error: "rows_changed", actual: 3 });
    const withThree = await needsReviewSummary(h.db, "vi");
    await deleteGlossaryEntry(h.db, op, rows[2], { now: T3 });
    expect(await clearNeedsReviewBulk(h.db, op, { ...asked, all: { fingerprint: withThree.fingerprint } })).toEqual({ ok: false, error: "rows_changed", actual: 2 });
    // The refused calls wrote nothing: the untouched row has its one revision and still needs review
    expect(await revsOf(rows[0])).toHaveLength(1);
    expect((await rowOf(rows[0])).needsReview).toBe(true);
    expect(await state(rows[0])).toBe(before0);
    // With the fingerprint of what is there, it goes through
    const current = await needsReviewSummary(h.db, "vi");
    expect(await clearNeedsReviewBulk(h.db, op, { ...asked, all: { fingerprint: current.fingerprint } })).toEqual({ ok: true, changed: 2, skipped: 0, forbidden: 0, stale: 0 });
    expect((await needsReviewSummary(h.db, "vi")).count).toBe(0);
  });

  it("writes a large language in chunks: every row is cleared and has its revision", async () => {
    // Direct inserts: creating over a thousand rows through the entry function would only make the test slow
    const total = BULK_WRITE_CHUNK * 2 + 100;
    await h.db.insert(glossaryEntries).values(
      Array.from({ length: total }, (_, i) => ({ term: `chunk-${i}`, lang: "en", targetLang: "th", candidates: [`c${i}`], note: "", keepOriginal: false, needsReview: true, updatedBy: ids.boss, updatedAt: T0 })),
    );
    const summary = await needsReviewSummary(h.db, "th");
    expect(summary.count).toBe(total);
    expect(await clearNeedsReviewBulk(h.db, op, { targetLang: "th", all: { fingerprint: summary.fingerprint }, now: T5 })).toEqual({ ok: true, changed: total, skipped: 0, forbidden: 0, stale: 0 });
    expect((await needsReviewSummary(h.db, "th")).count).toBe(0);
    const revs = await h.db.select().from(glossaryRevisions).where(and(eq(glossaryRevisions.editorId, ids.boss), eq(glossaryRevisions.createdAt, T5)));
    expect(revs.filter((r) => r.after && (r.after as { term: string }).term.startsWith("chunk-"))).toHaveLength(total);
  });

  it("refuses an unknown target language and unusable ids and bases; no entries is a no-op", async () => {
    expect(await clearNeedsReviewBulk(h.db, op, { targetLang: "xx", entries: [{ id: 1, updatedAt: 0 }] })).toEqual({ ok: false, error: "invalid_target" });
    expect(await clearNeedsReviewBulk(h.db, op, { targetLang: undefined, entries: [] })).toEqual({ ok: false, error: "invalid_target" });
    for (const bad of [{ id: 0, updatedAt: 1 }, { id: -1, updatedAt: 1 }, { id: 1.5, updatedAt: 1 }, { id: Number.NaN, updatedAt: 1 }, { id: Number.MAX_SAFE_INTEGER + 1, updatedAt: 1 }, { id: 1, updatedAt: -1 }, { id: 1, updatedAt: 1.5 }, { id: 1, updatedAt: Number.NaN }]) {
      expect(await clearNeedsReviewBulk(h.db, op, { targetLang: "fr", entries: [bad] })).toEqual({ ok: false, error: "invalid_ids" });
    }
    expect(await clearNeedsReviewBulk(h.db, op, { targetLang: "fr", entries: Array.from({ length: MAX_BULK_IDS + 1 }, (_, i) => ({ id: i + 1, updatedAt: 0 })) })).toEqual({ ok: false, error: "invalid_ids" });
    expect(await clearNeedsReviewBulk(h.db, op, { targetLang: "fr", entries: [] })).toEqual({ ok: true, changed: 0, skipped: 0, forbidden: 0, stale: 0 });
    // The same id twice counts once
    const a = await make("fr");
    expect(await clearNeedsReviewBulk(h.db, op, { targetLang: "fr", entries: await pick(a, a), now: T5 })).toEqual({ ok: true, changed: 1, skipped: 0, forbidden: 0, stale: 0 });
    expect(await revsOf(a)).toHaveLength(2);
  });

  it("does not change the glossary version or what the translator is given, and enqueues no job and touches no translation", async () => {
    const entry = await make("fr", { candidates: "alignement" });
    const topic = await createTopic(h.db, ids.plain, { lang: "en", title: "A post", body: `${(await rowOf(entry)).term} appears here.` });
    if (!topic.ok) throw new Error("topic failed");
    const world = async () => JSON.stringify([await h.db.select().from(jobs).orderBy(asc(jobs.id)), await h.db.select().from(translations).orderBy(asc(translations.id))]);
    const hint = async () => matchGlossary(await loadGlossary(h.db, "en", "fr"), `${(await rowOf(entry)).term} appears here.`);
    const [version, jobsAndTranslations, hints] = [await getGlossaryVersion(h.db), await world(), await hint()];
    expect(hints).toHaveLength(1);
    expect((await clearNeedsReviewBulk(h.db, op, { targetLang: "fr", entries: await pick(entry), now: T5 })).ok).toBe(true);
    expect((await rowOf(entry)).needsReview).toBe(false);
    // needs_review is not part of the version (translations.server.ts glossaryVersionOf) and is not given to the translator
    expect(await getGlossaryVersion(h.db)).toBe(version);
    expect(await hint()).toEqual(hints);
    expect(await world()).toBe(jobsAndTranslations);
  });
});

describe("the permission of the bulk clear is checked on every entry, by its own saved target language", () => {
  // One entry for each of the target languages fr, zh-Hans, zh-Hant and ja, all needing review.
  async function four() {
    return { fr: await make("fr"), hans: await make("zh-Hans"), hant: await make("zh-Hant"), ja: await make("ja") };
  }
  const needs = async (...entryIds: number[]) => Promise.all(entryIds.map(async (id) => (await rowOf(id)).needsReview));

  it("an operator clears the entries of the language that is named, and skips (not refuses) the entries of other languages", async () => {
    const e = await four();
    expect(await clearNeedsReviewBulk(h.db, op, { targetLang: "zh-Hant", entries: await pick(...Object.values(e)), now: T5 })).toEqual({ ok: true, changed: 1, skipped: 3, forbidden: 0, stale: 0 });
    expect(await needs(e.fr, e.hans, e.hant, e.ja)).toEqual([true, true, false, true]);
  });

  it("a moderator of the target language clears its entries and is refused (forbidden) for the others; nothing is written for the refused", async () => {
    const e = await four();
    const before = await state(e.hans, e.hant, e.ja);
    expect(await clearNeedsReviewBulk(h.db, actor(ids.frmod, mod("fr")), { targetLang: "fr", entries: await pick(...Object.values(e)), now: T5 })).toEqual({ ok: true, changed: 1, skipped: 0, forbidden: 3, stale: 0 });
    expect(await needs(e.fr)).toEqual([false]);
    expect(await state(e.hans, e.hant, e.ja)).toBe(before);
    expect((await revsOf(e.fr))[1]).toMatchObject({ editorId: ids.frmod, via: "admin" });
  });

  it("a moderator of another language, and a member who is not a moderator, are refused for every entry and for the whole language, and nothing changes", async () => {
    const e = await four();
    const before = await state(...Object.values(e));
    const rows = (await countNeedsReview(h.db, "fr")) as number;
    for (const who of [actor(ids.jamod, mod("ja")), actor(ids.plain, NONE)]) {
      expect(await clearNeedsReviewBulk(h.db, who, { targetLang: "fr", entries: await pick(e.fr), now: T5 })).toEqual({ ok: true, changed: 0, skipped: 0, forbidden: 1, stale: 0 });
      // The whole language: the number refused is the number of entries that need review, and no row is locked or written
      expect(await clearNeedsReviewBulk(h.db, who, { targetLang: "fr", ...(await allOf("fr")), now: T5 })).toEqual({ ok: true, changed: 0, skipped: 0, forbidden: rows, stale: 0 });
    }
    expect(await state(...Object.values(e))).toBe(before);
  });

  it("zh-Hans and zh-Hant are different languages: neither moderator clears the other's entries, by ids or by language; one who holds both clears both", async () => {
    const e = await four();
    const hans = actor(ids.hansmod, mod("zh-Hans"));
    const hant = actor(ids.hantmod, mod("zh-Hant"));
    const before = await state(e.hans, e.hant);
    // The language named does not decide: the entry's own target language does
    expect(await clearNeedsReviewBulk(h.db, hans, { targetLang: "zh-Hans", entries: await pick(e.hant), now: T5 })).toEqual({ ok: true, changed: 0, skipped: 0, forbidden: 1, stale: 0 });
    expect(await clearNeedsReviewBulk(h.db, hans, { targetLang: "zh-Hant", entries: await pick(e.hant), now: T5 })).toEqual({ ok: true, changed: 0, skipped: 0, forbidden: 1, stale: 0 });
    expect(await clearNeedsReviewBulk(h.db, hant, { targetLang: "zh-Hans", entries: await pick(e.hans), now: T5 })).toEqual({ ok: true, changed: 0, skipped: 0, forbidden: 1, stale: 0 });
    expect(await state(e.hans, e.hant)).toBe(before);
    const forbiddenAll = await clearNeedsReviewBulk(h.db, hans, { targetLang: "zh-Hant", ...(await allOf("zh-Hant")), now: T5 });
    expect(forbiddenAll).toMatchObject({ ok: true, changed: 0, skipped: 0 });
    expect((forbiddenAll as { forbidden: number }).forbidden).toBeGreaterThanOrEqual(1);
    expect(await state(e.hans, e.hant)).toBe(before);
    // Each clears its own
    expect(await clearNeedsReviewBulk(h.db, hans, { targetLang: "zh-Hans", entries: await pick(e.hans, e.hant), now: T5 })).toEqual({ ok: true, changed: 1, skipped: 0, forbidden: 1, stale: 0 });
    expect(await needs(e.hans, e.hant)).toEqual([false, true]);
    expect(await clearNeedsReviewBulk(h.db, actor(ids.bothmod, mod("zh-Hans", "zh-Hant")), { targetLang: "zh-Hant", entries: await pick(e.hans, e.hant), now: T5 })).toEqual({ ok: true, changed: 1, skipped: 1, forbidden: 0, stale: 0 });
    expect(await needs(e.hans, e.hant)).toEqual([false, false]);
  });
});

describe("isReviewMark", () => {
  const content = { term: "t", candidates: ["a", "b"], note: "", keepOriginal: false, needsReview: true };
  it("is a change whose only difference is needsReview going from true to false", () => {
    expect(isReviewMark(content, { ...content, needsReview: false })).toBe(true);
    expect(isReviewMark(content, { ...content, needsReview: false, candidates: ["a"] })).toBe(false);
    expect(isReviewMark(content, { ...content, needsReview: false, note: "n" })).toBe(false);
    expect(isReviewMark(content, { ...content, needsReview: false, term: "u" })).toBe(false);
    expect(isReviewMark(content, { ...content, needsReview: false, keepOriginal: true })).toBe(false);
    expect(isReviewMark({ ...content, needsReview: false }, content)).toBe(false);
    expect(isReviewMark(content, content)).toBe(false);
    expect(isReviewMark(null, content)).toBe(false);
    expect(isReviewMark(content, null)).toBe(false);
  });
});

// ---- /admin/glossary ----

const route = () => import("~/routes/admin-glossary");
const load = async (as: string, query = "") => h.outcome(async () => (await (await route()).loader(h.args(h.request(`/admin/glossary${query}`, { as })))));
const post = async (as: string | undefined, form: Record<string, string | string[]>, headers?: Record<string, string>) =>
  h.outcome(async () => (await route()).action(h.args(h.request("/admin/glossary", { as, form, headers }))));
type Bulk = {
  step: string;
  kind?: string;
  lang?: string;
  entries?: Array<{ id: number; updatedAt: number }>;
  count?: number;
  latest?: string | null;
  fingerprint?: string;
  changed?: number | boolean;
  skipped?: number;
  forbidden?: number;
  stale?: number;
};
const bulkOf = (out: { value?: unknown }): Bulk => (out.value as { data: { bulk: Bulk } }).data.bulk;
const loaded = (out: { value?: unknown }) =>
  out.value as { query: { to: string | null; from: string | null; page: number; review: boolean }; bulk: { lang: string; needReview: number } | null; selectAll: boolean; entries: Array<{ id: number; needsReview: boolean; updatedAt: string }> };
// The values of the checkboxes as the page renders them: "<id>@<updated_at in ms>".
const sel = async (...entryIds: number[]) => (await pick(...entryIds)).map((e) => `${e.id}@${e.updatedAt}`);

describe("the list of /admin/glossary: the bulk review is offered for a target language the person may edit", () => {
  it("shows the number that needs review for the filtered language, only to a person who may edit that language; the review filter and select=all are read", async () => {
    const a = await make("th");
    await make("th");
    await make("th", { needsReview: false });
    const operator = loaded(await load("boss", "?to=th"));
    expect(operator.bulk).toEqual({ lang: "th", needReview: 2 });
    expect(operator.selectAll).toBe(false);
    expect(operator.entries.length).toBeGreaterThanOrEqual(3);
    // The loader gives the page the time that each checkbox carries
    expect(Date.parse(operator.entries.find((e) => e.id === a)!.updatedAt)).toBe((await rowOf(a)).updatedAt.getTime());
    // Without a target language there is nothing to say "all N of": no bulk review
    expect(loaded(await load("boss")).bulk).toBeNull();
    // A moderator of another language sees nothing of it (the list is limited to their languages) and has no bulk review
    const ja = loaded(await load("jamod", "?to=th"));
    expect(ja.bulk).toBeNull();
    expect(ja.entries).toEqual([]);
    // The needs-review-only filter and the term language filter keep working with the target language
    const only = loaded(await load("boss", "?to=th&review=1"));
    expect(only.query.review).toBe(true);
    expect(only.entries.every((e) => e.needsReview)).toBe(true);
    expect(only.entries.map((e) => e.id)).toContain(a);
    expect(loaded(await load("boss", "?to=th&from=ja&review=1")).entries).toEqual([]);
    expect(loaded(await load("boss", "?to=th&select=all")).selectAll).toBe(true);
    // select=all means nothing without the bulk review
    expect(loaded(await load("boss", "?select=all")).selectAll).toBe(false);
    // The number is the target language's: it does not depend on the term-language filter or the page
    expect(loaded(await load("boss", "?to=th&from=ja")).bulk).toEqual({ lang: "th", needReview: 2 });
  });
});

describe("the action: mark the selected entries as reviewed", () => {
  it("asks first (no write), then writes on the confirmation; the entries that need review are cleared with one revision each", async () => {
    const a = await make("fr");
    const b = await make("fr");
    const c = await make("fr");
    const before = await state(a, b, c);
    const asked = await post("frmod", { intent: "review_selected", targetLang: "fr", ids: await sel(a, b) });
    expect(asked.status).toBe(200);
    expect(bulkOf(asked)).toEqual({ step: "confirm", kind: "selected", lang: "fr", entries: await pick(a, b) });
    expect(await state(a, b, c)).toBe(before);
    const done = await post("frmod", { intent: "review_selected", targetLang: "fr", ids: await sel(a, b), confirm: "1" });
    expect(done.status).toBe(200);
    expect(bulkOf(done)).toEqual({ step: "done", lang: "fr", changed: 2, skipped: 0, forbidden: 0, stale: 0 });
    expect(await Promise.all([a, b, c].map(async (id) => (await rowOf(id)).needsReview))).toEqual([false, false, true]);
    for (const id of [a, b]) expect((await revsOf(id))[1]).toMatchObject({ editorId: ids.frmod, via: "admin" });
    expect(await revsOf(c)).toHaveLength(1);
    // The same form again: nothing left to change, and it says so (skipped)
    expect(bulkOf(await post("frmod", { intent: "review_selected", targetLang: "fr", ids: await sel(a, b), confirm: "1" }))).toEqual({ step: "done", lang: "fr", changed: 0, skipped: 2, forbidden: 0, stale: 0 });
  });

  it("a post that carries the time of an older version of a row marks nothing of that row, and the result page says how many changed after they were shown", async () => {
    const a = await make("fr");
    const b = await make("fr");
    const shown = await sel(a, b);
    // The page was loaded; then another editor changed the candidates of a
    expect(await updateGlossaryEntry(h.db, op, a, { term: (await rowOf(a)).term, candidates: "changed after the page was loaded", needsReview: true }, { now: T3 })).toEqual({ ok: true, changed: true });
    const revs = (await revsOf(a)).length;
    // Asking already carries the old time through to the confirmation
    expect(bulkOf(await post("frmod", { intent: "review_selected", targetLang: "fr", ids: shown })).entries).toEqual((await pick(a, b)).map((e) => ({ ...e, updatedAt: Number(shown[e.id === a ? 0 : 1].split("@")[1]) })));
    const done = await post("frmod", { intent: "review_selected", targetLang: "fr", ids: shown, confirm: "1" });
    expect(done.status).toBe(200);
    expect(bulkOf(done)).toEqual({ step: "done", lang: "fr", changed: 1, skipped: 0, forbidden: 0, stale: 1 });
    expect(await rowOf(a)).toMatchObject({ needsReview: true, candidates: ["changed after the page was loaded"] });
    expect(await revsOf(a)).toHaveLength(revs);
    expect((await rowOf(b)).needsReview).toBe(false);
    // Only stale rows are named: the page says so and nothing is refused (not a crafted form)
    const only = await post("frmod", { intent: "review_selected", targetLang: "fr", ids: shown.slice(0, 1), confirm: "1" });
    expect(only.status).toBe(200);
    expect(bulkOf(only)).toEqual({ step: "done", lang: "fr", changed: 0, skipped: 0, forbidden: 0, stale: 1 });
    // After a reload the page carries the new time and the row is marked
    expect(bulkOf(await post("frmod", { intent: "review_selected", targetLang: "fr", ids: await sel(a), confirm: "1" }))).toMatchObject({ step: "done", changed: 1, stale: 0 });
  });

  it("refuses a post with nothing selected, with a bad language, and with ids that are not rows (400), and writes nothing", async () => {
    const a = await make("fr");
    const before = await state(a);
    const none = await post("frmod", { intent: "review_selected", targetLang: "fr", confirm: "1" });
    expect(none.status).toBe(400);
    expect(bulkOf(none)).toEqual({ step: "none_selected" });
    // A bare id (no time) is not a row of the page
    const bare = await post("frmod", { intent: "review_selected", targetLang: "fr", ids: [String(a)], confirm: "1" });
    expect(bare.status).toBe(400);
    expect(bulkOf(bare)).toEqual({ step: "invalid" });
    expect((await post("frmod", { intent: "review_selected", targetLang: "fr", ids: ["0@1", "-1@1", "1.5@1", "abc", "", `${a}@`, `${a}@x`, `@1`], confirm: "1" })).status).toBe(400);
    expect(bulkOf(await post("frmod", { intent: "review_selected", targetLang: "xx", ids: await sel(a), confirm: "1" }))).toEqual({ step: "invalid" });
    expect((await post("frmod", { intent: "review_selected", ids: await sel(a), confirm: "1" })).status).toBe(400);
    expect((await post("frmod", { intent: "review_selected", targetLang: "fr", ids: Array.from({ length: MAX_BULK_IDS + 1 }, (_, i) => `${i + 1}@0`), confirm: "1" })).status).toBe(400);
    expect(await state(a)).toBe(before);
  });

  it("enforces the permission on every entry: a crafted form with entries of another language is 403 and writes nothing, whatever language it names", async () => {
    const hant = await make("zh-Hant");
    const hans = await make("zh-Hans");
    const fr = await make("fr");
    const before = await state(hant, hans, fr);
    // A Simplified Chinese moderator names zh-Hant (403 at once: not their language), or names zh-Hans with a zh-Hant entry (403: nothing to change, an entry refused)
    expect((await post("hansmod", { intent: "review_selected", targetLang: "zh-Hant", ids: await sel(hant), confirm: "1" })).status).toBe(403);
    expect((await post("hansmod", { intent: "review_selected", targetLang: "zh-Hant", ids: await sel(hant) })).status).toBe(403);
    expect((await post("hansmod", { intent: "review_selected", targetLang: "zh-Hans", ids: await sel(hant, fr), confirm: "1" })).status).toBe(403);
    expect((await post("hantmod", { intent: "review_all", targetLang: "zh-Hans", confirm: "1", fingerprint: "0123456789abcdef" })).status).toBe(403);
    expect((await post("jamod", { intent: "review_all", targetLang: "fr" })).status).toBe(403);
    expect(await state(hant, hans, fr)).toBe(before);
    // Mixed: the entry that the person may edit is cleared, the other is counted as refused
    const hantBefore = await state(hant);
    const mixed = await post("hansmod", { intent: "review_selected", targetLang: "zh-Hans", ids: await sel(hant, hans), confirm: "1" });
    expect(bulkOf(mixed)).toEqual({ step: "done", lang: "zh-Hans", changed: 1, skipped: 0, forbidden: 1, stale: 0 });
    expect(await state(hant)).toBe(hantBefore);
    expect((await rowOf(hant)).needsReview).toBe(true);
    expect((await rowOf(hans)).needsReview).toBe(false);
  });

  it("is hidden from a member who is not a moderator (404), sends a suspended moderator to the suspension page and a visitor to the login, for the question and for the confirmation", async () => {
    const a = await make("fr");
    const before = await state(a);
    const forms: Array<Record<string, string | string[]>> = [
      { intent: "review_selected", targetLang: "fr", ids: await sel(a) },
      { intent: "review_selected", targetLang: "fr", ids: await sel(a), confirm: "1" },
      { intent: "review_all", targetLang: "fr" },
      { intent: "review_all", targetLang: "fr", confirm: "1", fingerprint: "0123456789abcdef" },
    ];
    for (const form of forms) {
      expect(await post("plain", form)).toMatchObject({ status: 404 });
      expect(await post("susmod", form)).toMatchObject({ status: 302, location: "/suspended" });
      expect(await post(undefined, form)).toMatchObject({ status: 302, location: "/login" });
    }
    expect(await state(a)).toBe(before);
  });

  it("refuses a post from another origin (403) before it looks at who sends it, for every step, and writes nothing", async () => {
    const a = await make("fr");
    const before = await state(a);
    const foreign = { origin: "https://evil.example" };
    const forms: Array<Record<string, string | string[]>> = [
      { intent: "review_selected", targetLang: "fr", ids: await sel(a) },
      { intent: "review_selected", targetLang: "fr", ids: await sel(a), confirm: "1" },
      { intent: "review_all", targetLang: "fr" },
      { intent: "review_all", targetLang: "fr", confirm: "1", fingerprint: "0123456789abcdef" },
    ];
    for (const form of forms) {
      // Signed in, and not signed in at all (the origin check comes before the login check)
      expect(await post("frmod", form, foreign)).toMatchObject({ status: 403 });
      expect(await post("boss", form, foreign)).toMatchObject({ status: 403 });
      expect(await post(undefined, form, foreign)).toMatchObject({ status: 403 });
    }
    expect(await state(a)).toBe(before);
  });
});

describe("the action: mark all the entries of the target language that need review as reviewed", () => {
  it("first states the number, the latest change and the language and writes nothing; the confirmation carries the fingerprint; other rows than the confirmed ones are not written but asked again", async () => {
    // A target language of its own in this test (ko): the set is the whole language's
    const rows = [await make("ko"), await make("ko", { lang: "ja" }), await make("ko")];
    await make("ko", { needsReview: false });
    const other = await make("ja");
    const before = await state(...rows, other);
    const asked = await post("boss", { intent: "review_all", targetLang: "ko" });
    const question = bulkOf(asked);
    expect(question).toMatchObject({ step: "confirm", kind: "all", lang: "ko", count: 3, latest: T0.toISOString(), changed: false });
    expect(question.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(await state(...rows, other)).toBe(before);
    // Someone changes the candidates of one of the rows (same number of rows) while the person is reading the question
    await updateGlossaryEntry(h.db, op, rows[1], { term: (await rowOf(rows[1])).term, candidates: "changed meanwhile", needsReview: true }, { now: T3 });
    const snapshot = await state(...rows, other);
    const again = await post("boss", { intent: "review_all", targetLang: "ko", confirm: "1", fingerprint: question.fingerprint! });
    expect(again.status).toBe(200);
    const second = bulkOf(again);
    expect(second).toMatchObject({ step: "confirm", kind: "all", lang: "ko", count: 3, latest: T3.toISOString(), changed: true });
    expect(second.fingerprint).not.toBe(question.fingerprint);
    expect(await state(...rows, other)).toBe(snapshot);
    // Someone adds a row while the person is reading the second question
    const late = await make("ko");
    expect(bulkOf(await post("boss", { intent: "review_all", targetLang: "ko", confirm: "1", fingerprint: second.fingerprint! }))).toMatchObject({ step: "confirm", count: 4, changed: true });
    expect((await rowOf(late)).needsReview).toBe(true);
    // A post that is confirmed without a fingerprint is not a confirmation
    expect((await post("boss", { intent: "review_all", targetLang: "ko", confirm: "1" })).status).toBe(400);
    expect((await post("boss", { intent: "review_all", targetLang: "ko", confirm: "1", fingerprint: "many" })).status).toBe(400);
    const third = bulkOf(await post("boss", { intent: "review_all", targetLang: "ko" }));
    const done = await post("boss", { intent: "review_all", targetLang: "ko", confirm: "1", fingerprint: third.fingerprint! });
    expect(bulkOf(done)).toEqual({ step: "done", lang: "ko", changed: 4, skipped: 0, forbidden: 0, stale: 0 });
    expect(await countNeedsReview(h.db, "ko")).toBe(0);
    expect((await rowOf(other)).needsReview).toBe(true);
    for (const id of [...rows, late]) expect(await revsOf(id)).toHaveLength(id === rows[1] ? 3 : 2);
    // Nothing left: there is nothing to confirm
    expect(bulkOf(await post("boss", { intent: "review_all", targetLang: "ko" }))).toEqual({ step: "done", lang: "ko", changed: 0, skipped: 0, forbidden: 0, stale: 0 });
  });

  it("a moderator of the language does it for their own language only, and the history shows their handle", async () => {
    const rows = [await make("zh-Hans"), await make("zh-Hans", { lang: "ja" })];
    const hantOne = await make("zh-Hant");
    const asked = bulkOf(await post("hansmod", { intent: "review_all", targetLang: "zh-Hans" }));
    expect(asked).toMatchObject({ step: "confirm", kind: "all", lang: "zh-Hans" });
    expect(await post("hansmod", { intent: "review_all", targetLang: "zh-Hans", confirm: "1", fingerprint: asked.fingerprint! })).toMatchObject({ status: 200 });
    expect(await countNeedsReview(h.db, "zh-Hans")).toBe(0);
    expect((await rowOf(hantOne)).needsReview).toBe(true);
    const history = (await listGlossaryRevisions(h.db, rows)).get(rows[0])!;
    expect(history[0]).toMatchObject({ kind: "updated", editorHandle: "hansmod" });
  });
});
