import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createAppeal, decideAppeal, getAppealableAction, listOpenAppeals } from "~/lib/appeals.server";
import { entries, moderationActions, notifications, profiles, stanceChanges } from "~/lib/db/schema";
import { readDistributions } from "~/lib/distribution.server";
import { createReply, createTopic } from "~/lib/entries.server";
import { buildObservationExport } from "~/lib/exports.server";
import {
  crossAreaDirectionMatrix,
  crossAreaInsightfulRate,
  crossAreaUpdateRate,
  firstParticipation,
  firstStancesByArea,
  fourWeekRetention,
  stanceDistanceByAreaPair,
  weeklyActiveMembers,
} from "~/lib/metrics.server";
import { excludeReactions, includeReactions, listPublicLog, type Actor } from "~/lib/moderation.server";
import { listNotifications } from "~/lib/notifications.server";
import { listObjections, loadObjectionPanel } from "~/lib/objections.server";
import { searchMembers } from "~/lib/roles.server";
import { loadReasonCandidates, loadReasonsPanel } from "~/lib/reasons.server";
import { setStance } from "~/lib/stances.server";
import { loadReactions, setVote } from "~/lib/votes.server";
import { addMember, createTestDb } from "./helpers/db";

// Stance and "なるほど" exclusion (operator exclude_reactions and its reversal): operators only, explanation required, personal notification, public record and appeal.
// Covers Insightful, the reasons panel, operator metrics and observation exports.
const t = (minutes: number) => new Date(Date.UTC(2026, 9, 5, 0, minutes));
const OP: Actor = { id: "op", scope: { operator: true, langs: [] } };
const MOD: Actor = { id: "mod", scope: { operator: false, langs: ["ja"] } };

async function world() {
  const db = await createTestDb();
  await addMember(db, "author", "hana", { homeArea: "ja" });
  await addMember(db, "ann", "ann", { homeArea: "ja" });
  await addMember(db, "bob", "bob", { homeArea: "en", readLangs: ["en"] });
  await addMember(db, "op", "opr", { homeArea: "ja", email: "operator@example.com" });
  await addMember(db, "mod", "moriko", { homeArea: "ja" });
  await addMember(db, "reviewer", "rev", { homeArea: "ja" });
  const q = await createTopic(db, "author", { lang: "ja", title: "問い", body: "命題です。", asksStance: true }, { now: t(0) });
  if (!q.ok) throw new Error("question failed");
  return { db, q: q.id };
}
const choose = async (db: Awaited<ReturnType<typeof world>>["db"], userId: string, q: number, position: "agree" | "disagree" | "neither", minute = 1) => {
  const res = await setStance(db, userId, { questionId: q, position, expectedVersion: 0 }, { now: t(minute) });
  if (!res.ok) throw new Error(`stance failed: ${res.error}`);
};
const profileOf = async (db: Awaited<ReturnType<typeof world>>["db"], id: string) => (await db.select().from(profiles).where(eq(profiles.userId, id)))[0];
const totals = async (db: Awaited<ReturnType<typeof world>>["db"], q: number) => (await readDistributions(db, [q], { kind: "observation" })).get(q)!;

describe("excludeReactions and includeReactions", () => {
  it("only an operator can exclude, with an explanation; not oneself, not an operator", async () => {
    const saved = process.env.OPERATOR_EMAILS;
    process.env.OPERATOR_EMAILS = "operator@example.com";
    try {
      const { db } = await world();
      const input = { userId: "bob", reason: "spam", note: "a ring of fake accounts" };
      // A scoped moderator or ordinary member cannot act without operator authority.
      expect(await excludeReactions(db, MOD, input, { now: t(5) })).toEqual({ ok: false, error: "forbidden" });
      expect(await excludeReactions(db, { id: "ann", scope: { operator: false, langs: [] } }, input, { now: t(5) })).toEqual({ ok: false, error: "forbidden" });
      // Explanation required; use existing reason categories spam, harassment, infohazard and other.
      expect(await excludeReactions(db, OP, { userId: "bob", reason: "spam" }, { now: t(5) })).toEqual({ ok: false, error: "note_required" });
      expect(await excludeReactions(db, OP, { userId: "bob", reason: "spam", note: "   " }, { now: t(5) })).toEqual({ ok: false, error: "note_required" });
      expect(await excludeReactions(db, OP, { userId: "bob", reason: "fake", note: "n" }, { now: t(5) })).toEqual({ ok: false, error: "invalid_reason" });
      expect(await excludeReactions(db, OP, { userId: "bob", reason: "spam", note: "x".repeat(501) }, { now: t(5) })).toEqual({ ok: false, error: "invalid_note" });
      // Cannot target oneself or an operator; missing members yield not_found.
      expect(await excludeReactions(db, OP, { userId: "op", reason: "spam", note: "n" }, { now: t(5) })).toEqual({ ok: false, error: "own_entry" });
      expect(await excludeReactions(db, { id: "someone", scope: OP.scope }, { userId: "op", reason: "spam", note: "n" }, { now: t(5) })).toEqual({ ok: false, error: "target_is_operator" });
      expect(await excludeReactions(db, OP, { userId: "nobody", reason: "spam", note: "n" }, { now: t(5) })).toEqual({ ok: false, error: "not_found" });
      expect((await profileOf(db, "bob")).reactionsExcludedAt).toBeNull();
      // Succeeds once; cannot exclude an already-excluded member. Reversal applies only to excluded members.
      const done = await excludeReactions(db, OP, input, { now: t(5) });
      expect(done).toMatchObject({ ok: true });
      expect(await excludeReactions(db, OP, input, { now: t(6) })).toEqual({ ok: false, error: "invalid_state" });
      expect(await includeReactions(db, OP, { userId: "ann", reason: "other" }, { now: t(7) })).toEqual({ ok: false, error: "invalid_state" });
      expect(await includeReactions(db, MOD, { userId: "bob", reason: "other" }, { now: t(7) })).toEqual({ ok: false, error: "forbidden" });
      expect(await includeReactions(db, OP, { userId: "bob", reason: "other" }, { now: t(7) })).toMatchObject({ ok: true });
      expect(await includeReactions(db, OP, { userId: "bob", reason: "other" }, { now: t(8) })).toEqual({ ok: false, error: "invalid_state" });
    } finally {
      if (saved === undefined) delete process.env.OPERATOR_EMAILS;
      else process.env.OPERATOR_EMAILS = saved;
    }
  });

  it("takes the member out of the distribution (totals and number of languages) and puts the member back; the member's own record stays", async () => {
    const { db, q } = await world();
    await choose(db, "ann", q, "agree");
    await choose(db, "bob", q, "disagree");
    expect(await totals(db, q)).toMatchObject({ total: 2, counts: { agree: 1, disagree: 1, neither: 0 }, langs: 2 });
    const done = await excludeReactions(db, OP, { userId: "bob", reason: "spam", note: "fake account" }, { now: t(5) });
    if (!done.ok) throw new Error("exclusion failed");
    // Stances predating the action are excluded too, reducing language participation.
    expect(await totals(db, q)).toMatchObject({ total: 1, counts: { agree: 1, disagree: 0, neither: 0 }, langs: 1 });
    expect(await profileOf(db, "bob")).toMatchObject({ reactionsExcludedAt: t(5), reactionsExcludedActionId: done.actionId });
    // Stances chosen while excluded also do not count. Preserve the member's stance rows, "押した" UI state, and personal export.
    const second = await createTopic(db, "author", { lang: "ja", title: "二つ目", body: "命題です。", asksStance: true });
    if (!second.ok) throw new Error("question failed");
    await choose(db, "bob", second.id, "agree", 6);
    expect(await totals(db, second.id)).toMatchObject({ total: 0, langs: 0 });
    // Reversing restores all of them.
    expect(await includeReactions(db, OP, { userId: "bob", reason: "other" }, { now: t(7) })).toMatchObject({ ok: true });
    expect(await totals(db, q)).toMatchObject({ total: 2, langs: 2 });
    expect(await totals(db, second.id)).toMatchObject({ total: 1, langs: 1 });
    expect(await profileOf(db, "bob")).toMatchObject({ reactionsExcludedAt: null, reactionsExcludedActionId: null });
  });

  it("is recorded, told to the member as a moderation notification, and listed in the public log (no explanation, no actor, no name)", async () => {
    const { db } = await world();
    const done = await excludeReactions(db, OP, { userId: "bob", reason: "harassment", note: "brigading" }, { now: t(5) });
    if (!done.ok) throw new Error("exclusion failed");
    expect((await db.select().from(moderationActions).where(eq(moderationActions.id, done.actionId)))[0]).toMatchObject({
      action: "exclude_reactions",
      targetUserId: "bob",
      targetEntryId: null,
      reason: "harassment",
      note: "brigading",
      actorId: "op",
      revisionId: null,
    });
    // Notify the member through the existing moderation kind, with no new kind and no actor identity.
    const list = await listNotifications(db, "bob");
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({ kind: "moderation", action: "exclude_reactions", reason: "harassment", note: "brigading", actionId: done.actionId, actorHandle: null, entryId: null });
    expect((await db.select().from(notifications).where(eq(notifications.userId, "bob")))[0]).toMatchObject({ actorId: null, entryId: null });
    // Notify the member of reversal too.
    const back = await includeReactions(db, OP, { userId: "bob", reason: "other", note: "my mistake" }, { now: t(6) });
    if (!back.ok) throw new Error("inclusion failed");
    expect((await listNotifications(db, "bob")).items.map((n) => n.action)).toEqual(["include_reactions", "exclude_reactions"]);
    // Public record: action type, reason category, source language (null for member actions) and date only.
    expect((await listPublicLog(db)).entries).toEqual([
      { action: "include_reactions", reason: "other", lang: null, date: "2026-10-05" },
      { action: "exclude_reactions", reason: "harassment", lang: null, date: "2026-10-05" },
    ]);
    // Mail bodies are checked in tests/notification-email.test.ts, which adds exclusion and reversal to moderation mail checks.
  });

  it("is on the member search of the operator screen", async () => {
    const { db } = await world();
    expect((await searchMembers(db, "bob")).map((h) => [h.handle, h.reactionsExcluded])).toEqual([["bob", false]]);
    await excludeReactions(db, OP, { userId: "bob", reason: "spam", note: "n" }, { now: t(5) });
    expect((await searchMembers(db, "bob")).map((h) => [h.handle, h.reactionsExcluded])).toEqual([["bob", true]]);
  });
});

describe("an appeal against an exclusion", () => {
  it("can be made by the member, reviewed by someone else, and an overturned one puts the member back (include_reactions) only while that exclusion still stands", async () => {
    const { db, q } = await world();
    await choose(db, "bob", q, "disagree");
    const done = await excludeReactions(db, OP, { userId: "bob", reason: "spam", note: "fake" }, { now: t(5) });
    if (!done.ok) throw new Error("exclusion failed");
    expect(await totals(db, q)).toMatchObject({ total: 0 });
    // Only the affected member sees the action; hide its existence from others.
    expect(await getAppealableAction(db, "ann", done.actionId)).toBeNull();
    expect(await getAppealableAction(db, "bob", done.actionId)).toMatchObject({ action: "exclude_reactions", reason: "spam", note: "fake", entry: null, appeal: null });
    expect(await createAppeal(db, "ann", done.actionId, "not mine")).toEqual({ ok: false, error: "not_found" });
    const appeal = await createAppeal(db, "bob", done.actionId, "I am a real person", { now: t(6) });
    if (!appeal.ok) throw new Error("appeal failed");
    expect(await createAppeal(db, "bob", done.actionId, "again")).toEqual({ ok: false, error: "duplicate" });
    // A different moderator or operator reviews; the original operator does not see this appeal.
    expect((await listOpenAppeals(db, { id: "op", scope: OP.scope })).cards).toEqual([]);
    const reviewer = { id: "reviewer", scope: OP.scope };
    const open = await listOpenAppeals(db, reviewer);
    expect(open.cards).toHaveLength(1);
    expect(open.cards[0]).toMatchObject({ action: "exclude_reactions", reason: "spam", note: "fake", entry: null, appellantHandle: "bob" });
    expect(await decideAppeal(db, { id: "op", scope: OP.scope }, appeal.id, { decision: "overturned", note: "ok" })).toEqual({ ok: false, error: "own_action" });
    expect(await decideAppeal(db, reviewer, appeal.id, { decision: "overturned", note: "a real member" }, { now: t(7) })).toEqual({ ok: true, status: "overturned", reversed: true });
    expect(await profileOf(db, "bob")).toMatchObject({ reactionsExcludedAt: null, reactionsExcludedActionId: null });
    expect(await totals(db, q)).toMatchObject({ total: 1, counts: { agree: 0, disagree: 1, neither: 0 } });
    // Record the opposite action under the reviewer, category other and explanation "異議が通った". Notify the member of the appeal result.
    const actions = await db.select().from(moderationActions).orderBy(moderationActions.id);
    expect(actions.map((a) => [a.action, a.actorId, a.targetUserId, a.reason])).toEqual([["exclude_reactions", "op", "bob", "spam"], ["include_reactions", "reviewer", "bob", "other"]]);
    expect(actions[1].note).toBe(`Appeal #${appeal.id} overturned`);
    expect((await listNotifications(db, "bob")).items.map((n) => [n.kind, n.appealStatus, n.appealReversed])).toEqual([["appeal_decided", "overturned", true], ["moderation", null, null]]);
  });

  it("does not put the member back when the exclusion was already undone or replaced by a later one; upholding changes nothing", async () => {
    const { db, q } = await world();
    await choose(db, "bob", q, "agree");
    const reviewer = { id: "reviewer", scope: OP.scope };
    const first = await excludeReactions(db, OP, { userId: "bob", reason: "spam", note: "first" }, { now: t(5) });
    if (!first.ok) throw new Error("exclusion failed");
    const a1 = await createAppeal(db, "bob", first.actionId, "x");
    if (!a1.ok) throw new Error("appeal failed");
    // An operator reversed and then re-excluded the member with a new action; overturning the old action leaves the new exclusion.
    await includeReactions(db, OP, { userId: "bob", reason: "other" }, { now: t(6) });
    const second = await excludeReactions(db, OP, { userId: "bob", reason: "spam", note: "second" }, { now: t(7) });
    if (!second.ok) throw new Error("exclusion failed");
    expect(await decideAppeal(db, reviewer, a1.id, { decision: "overturned", note: "old one" })).toEqual({ ok: true, status: "overturned", reversed: false });
    expect((await profileOf(db, "bob")).reactionsExcludedActionId).toBe(second.actionId);
    expect(await totals(db, q)).toMatchObject({ total: 0 });
    // Upholding changes nothing.
    const a2 = await createAppeal(db, "bob", second.actionId, "y");
    if (!a2.ok) throw new Error("appeal failed");
    expect(await decideAppeal(db, reviewer, a2.id, { decision: "upheld", note: "it stands" })).toEqual({ ok: true, status: "upheld", reversed: false });
    expect((await profileOf(db, "bob")).reactionsExcludedActionId).toBe(second.actionId);
    expect((await db.select().from(moderationActions)).map((a) => a.action)).toEqual(["exclude_reactions", "include_reactions", "exclude_reactions"]);
  });
});

describe("the objection panel leaves out members under exclusion", () => {
  it("hides the other ways of asking and the objection replies of an excluded writer from the panel and from 'see all', and shows them again after the exclusion is undone", async () => {
    const { db, q } = await world();
    await addMember(db, "cid", "cid", { homeArea: "en", readLangs: ["en"] });
    const alt = await createTopic(db, "bob", { lang: "en", title: "Another way", body: "x", asksStance: true, altOf: q }, { now: t(1) });
    const objection = await createReply(db, "bob", q, { lang: "en", body: "I object.", stanceTag: "objection" }, { now: t(2) });
    const keptAlt = await createTopic(db, "cid", { lang: "en", title: "Third way", body: "x", asksStance: true, altOf: q }, { now: t(3) });
    const keptObjection = await createReply(db, "cid", q, { lang: "en", body: "Me too.", stanceTag: "objection" }, { now: t(4) });
    if (!alt.ok || !objection.ok || !keptAlt.ok || !keptObjection.ok) throw new Error("setup failed");
    const langs = { readLangs: ["ja", "en"] as const, displayLang: "en" as const };
    const ids = async () => {
      const panel = await loadObjectionPanel(db, q, langs);
      const all = await listObjections(db, q, { ...langs, page: 1 });
      return { panel: [panel.alternatives.map((a) => a.id), panel.objections.map((o) => o.id)], all: [all.alternatives.map((a) => a.id), all.objections.map((o) => o.id)] };
    };
    expect(await ids()).toEqual({ panel: [[keptAlt.id, alt.id], [keptObjection.id, objection.id]], all: [[keptAlt.id, alt.id], [keptObjection.id, objection.id]] });
    await excludeReactions(db, OP, { userId: "bob", reason: "spam", note: "fake" }, { now: t(5) });
    expect(await ids()).toEqual({ panel: [[keptAlt.id], [keptObjection.id]], all: [[keptAlt.id], [keptObjection.id]] });
    await includeReactions(db, OP, { userId: "bob", reason: "other" }, { now: t(6) });
    expect((await ids()).panel).toEqual([[keptAlt.id, alt.id], [keptObjection.id, objection.id]]);
  });
});

describe("Insightful and the reasons panel leave out members under exclusion", () => {
  const viewer = { userId: "reviewer", scope: { operator: false, langs: [] as never[] } };

  it("does not count an excluded member's Insightful in the total or in the number of languages, and counts it again after the exclusion is undone; the member's own press stays on their screen", async () => {
    const { db, q } = await world();
    for (const who of ["ann", "bob", "reviewer"]) expect((await setVote(db, who, q, true, { now: t(1) })).ok).toBe(true);
    const insightful = async (as: string | null) => (await loadReactions(db, [{ id: q }], as)).get(q)!;
    expect((await insightful("ann")).insightful).toEqual({ total: 3, langs: 2 });
    await excludeReactions(db, OP, { userId: "bob", reason: "spam", note: "fake account" }, { now: t(5) });
    // bob was the only member from English: the number of languages falls with the total
    expect((await insightful("ann")).insightful).toEqual({ total: 2, langs: 1 });
    expect(await insightful("bob")).toEqual({ insightful: { total: 2, langs: 1 }, mine: true });
    // a press given while excluded is not counted either
    await addMember(db, "late", "late", { homeArea: "fr", readLangs: ["fr"] });
    await setVote(db, "late", q, true, { now: t(6) });
    expect((await insightful(null)).insightful).toEqual({ total: 3, langs: 2 });
    await excludeReactions(db, OP, { userId: "late", reason: "spam", note: "fake account" }, { now: t(7) });
    expect((await insightful(null)).insightful).toEqual({ total: 2, langs: 1 });
    await includeReactions(db, OP, { userId: "bob", reason: "other" }, { now: t(8) });
    await includeReactions(db, OP, { userId: "late", reason: "other" }, { now: t(9) });
    expect((await insightful(null)).insightful).toEqual({ total: 4, langs: 3 });
  });

  it("leaves an excluded writer's tagged replies out of the reasons panel and its candidates, and brings them back after the exclusion is undone", async () => {
    const { db, q } = await world();
    const bobs = await createReply(db, "bob", q, { lang: "en", body: "my reason", stanceTag: "agree" }, { now: t(1) });
    const anns = await createReply(db, "ann", q, { lang: "ja", body: "私の理由", stanceTag: "agree" }, { now: t(2) });
    if (!bobs.ok || !anns.ok) throw new Error("reply failed");
    const drawn = async () => {
      const panel = await loadReasonsPanel(db, q, { viewer, now: t(10) });
      return [...panel.pick.agree].sort((a, b) => a - b);
    };
    expect(await drawn()).toEqual([anns.id, bobs.id].sort((a, b) => a - b));
    await excludeReactions(db, OP, { userId: "bob", reason: "spam", note: "fake account" }, { now: t(5) });
    expect(await drawn()).toEqual([anns.id]);
    expect((await loadReasonCandidates(db, q)).map((c) => c.authorId)).toEqual(["ann"]);
    // the reply is still in the thread (the exclusion is about counts and panels, not about the post)
    expect((await db.select().from(entries).where(eq(entries.id, bobs.id)))[0].deletedAt).toBeNull();
    await includeReactions(db, OP, { userId: "bob", reason: "other" }, { now: t(6) });
    expect(await drawn()).toEqual([anns.id, bobs.id].sort((a, b) => a - b));
  });
});

// The operator metrics and the observation export leave out a member under exclusion, and take the member back when the exclusion is undone: the stances
// and the Insightful of the member, and nothing else of the member's activity (here: the member has no post). The rows stay in the database all the time (the exclusion works backwards).
describe("the operator metrics and the observation export", () => {
  it("leave out the Insightful, the stances and the activity of a member under exclusion, and bring them back when it is undone", async () => {
    const { db, q } = await world();
    const now = t(100);
    const reply = await createReply(db, "author", q, { lang: "ja", body: "補足です。" }, { now: t(2) });
    if (!reply.ok) throw new Error("reply failed");
    // ann (ja) and bob (en) press Insightful on the reply of the author (ja); ann chooses agree, bob chooses disagree and then changes to neither, prompted by the reply
    expect((await setVote(db, "ann", reply.id, true, { now: t(5) })).ok).toBe(true);
    expect((await setVote(db, "bob", reply.id, true, { now: t(6) })).ok).toBe(true);
    expect((await setStance(db, "ann", { questionId: q, position: "agree", expectedVersion: 0 }, { now: t(10) })).ok).toBe(true);
    expect((await setStance(db, "bob", { questionId: q, position: "disagree", expectedVersion: 0 }, { now: t(11) })).ok).toBe(true);
    expect((await setStance(db, "bob", { questionId: q, position: "neither", expectedVersion: 1, triggerEntryId: reply.id }, { now: t(12) })).ok).toBe(true);
    await db.update(profiles).set({ createdAt: new Date("2026-08-17T06:00:00Z") }).where(eq(profiles.userId, "bob"));

    const snapshot = async () => {
      const exported = await buildObservationExport(db, { model: null, now, salt: Buffer.alloc(32, 5) });
      const replyRow = exported.entries.find((e) => e.id === reply.id) as { insightful: number; insightful_langs: number };
      return {
        insightful: (await crossAreaInsightfulRate(db, now)).at(-1),
        update: (await crossAreaUpdateRate(db, now)).at(-1),
        active: (await weeklyActiveMembers(db, now)).at(-1)!.members,
        matrix: await crossAreaDirectionMatrix(db, now),
        distance: (await stanceDistanceByAreaPair(db, now)).at(-1),
        firstStances: await firstStancesByArea(db, now),
        cohort: (await firstParticipation(db, now))[0],
        retention: (await fourWeekRetention(db, now))[0],
        distribution: exported.questions[0].distribution,
        reply: { insightful: replyRow.insightful, langs: replyRow.insightful_langs },
      };
    };

    const before = await snapshot();
    // the numbers by hand: Insightful 1 of 2 across languages (bob), 2 people; the one change was prompted by a post from another area (1 of 1); the author, ann and bob are active;
    // the matrix row ja: (ja, ja) 1 and (ja, en) 1 of 2; ja agree against en neither: distance 1; first stances ja agree 1, en disagree 1; two stances (agree, neither) from 2 languages
    expect(before.insightful).toMatchObject({ observed: true, numerator: 1, denominator: 2, people: 2 });
    expect(before.update).toMatchObject({ changes: 1, observed: true, numerator: 1, denominator: 1, people: 1 });
    expect(before.active).toBe(3);
    expect(before.matrix.insightful).toEqual([
      { authorArea: "ja", reactorArea: "ja", numerator: 1, denominator: 2, people: 1 },
      { authorArea: "ja", reactorArea: "en", numerator: 1, denominator: 2, people: 1 },
    ]);
    expect(before.distance).toMatchObject({ a: "ja", b: "en", questions: 1, people: 2, mean: 1 });
    expect(before.firstStances.map((r) => [r.area, r.people])).toEqual([["ja", 1], ["en", 1]]);
    expect(before.distribution).toMatchObject({ total: 2, counts: { agree: 1, disagree: 0, neither: 1 }, langs: 2 });
    expect(before.reply).toEqual({ insightful: 2, langs: 2 });
    // bob started on 2026-08-17: the member is in the first cohort of eight weeks (and his first stance is there); the member under exclusion leaves the cohort
    expect(before.cohort.stance).toMatchObject({ observed: true });

    await excludeReactions(db, OP, { userId: "bob", reason: "spam", note: "a fake account" }, { now: t(50) });
    const during = await snapshot();
    expect(during.insightful).toMatchObject({ observed: true, numerator: 0, denominator: 1, people: 1 });
    expect(during.update).toMatchObject({ changes: 0, observed: false });
    expect(during.active).toBe(2);
    expect(during.matrix.insightful).toEqual([{ authorArea: "ja", reactorArea: "ja", numerator: 1, denominator: 1, people: 1 }]);
    expect(during.distance).toBeUndefined();
    expect(during.firstStances.map((r) => r.area)).toEqual(["ja"]);
    expect(during.distribution).toMatchObject({ total: 1, counts: { agree: 1, disagree: 0, neither: 0 }, langs: 1 });
    expect(during.reply).toEqual({ insightful: 1, langs: 1 });
    // the member leaves the denominators of the cohorts too
    expect(during.cohort.stance).toMatchObject({ observed: false });
    // the rows are all still there
    expect((await db.select().from(stanceChanges)).length).toBe(3);

    await includeReactions(db, OP, { userId: "bob", reason: "other" }, { now: t(60) });
    expect(await snapshot()).toEqual(before);
  }, 60_000);
});
