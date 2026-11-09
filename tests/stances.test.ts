import { and, asc, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { Db } from "~/lib/db/client.server";
import { entries, profiles, rateLimits, stanceChanges, stances } from "~/lib/db/schema";
import { readDistributions } from "~/lib/distribution.server";
import { createReply, createTopic, getEditableEntry, softDeleteEntry } from "~/lib/entries.server";
import { hideEntry, unhideEntry, type Actor } from "~/lib/moderation.server";
import { changeHomeArea } from "~/lib/profiles.server";
import { addressHasher } from "~/lib/auth/magic-link.server";
import { authSecret } from "~/lib/auth/secret.server";
import { hitMemberLimit, hitStanceQuestionLimit, MEMBER_RATE_LIMITS, STANCE_PER_QUESTION_LIMIT, stanceQuestionLimitKey } from "~/lib/rate-limit.server";
import { deleteAllStanceRecords, deleteStanceRecord, listOwnStanceRecords, loadOwnStances, rewriteStanceAreas, setStance } from "~/lib/stances.server";
import { setVote } from "~/lib/votes.server";
import { addMember, createTestDb } from "./helpers/db";

// Stance registration, changes, withdrawal, history, stale-page detection, locking, area rewriting, and deletion. Distribution counting is in tests/distribution.test.ts; concurrent submissions in tests/pg-concurrency.test.ts.
const t = (minutes: number) => new Date(Date.UTC(2026, 9, 5, 0, minutes));
const OP: Actor = { id: "op", scope: { operator: true, langs: [] } };

// Japanese author author; stance voters ann (ja), bob (en), cid (fr); and operator op.
async function world() {
  const db = await createTestDb();
  await addMember(db, "author", "hana", { homeArea: "ja" });
  await addMember(db, "ann", "ann", { homeArea: "ja" });
  await addMember(db, "bob", "bob", { homeArea: "en", readLangs: ["en"] });
  await addMember(db, "cid", "cid", { homeArea: "fr", readLangs: ["fr"] });
  await addMember(db, "op", "opr", { homeArea: "ja" });
  const q = await createTopic(db, "author", { lang: "ja", title: "問い", body: "命題です。", asksStance: true }, { now: t(0) });
  if (!q.ok) throw new Error("question failed");
  return { db, q: q.id };
}

const stanceRows = (db: Db, userId?: string) =>
  db
    .select()
    .from(stances)
    .where(userId ? eq(stances.userId, userId) : undefined)
    .orderBy(asc(stances.userId));
const changeRows = (db: Db, userId: string, questionId?: number) =>
  db
    .select()
    .from(stanceChanges)
    .where(questionId ? and(eq(stanceChanges.userId, userId), eq(stanceChanges.questionId, questionId)) : eq(stanceChanges.userId, userId))
    .orderBy(asc(stanceChanges.id));
const questionRow = async (db: Db, id: number) => (await db.select().from(entries).where(eq(entries.id, id)))[0];

describe("setStance: one tap, with a history that is never overwritten", () => {
  it("registers, changes and withdraws a stance, and appends one change per move", async () => {
    const { db, q } = await world();
    expect(await setStance(db, "ann", { questionId: q, position: "agree", expectedVersion: 0 }, { now: t(1) })).toEqual({ ok: true, changed: true, position: "agree", version: 1 });
    expect(await setStance(db, "ann", { questionId: q, position: "disagree", expectedVersion: 1 }, { now: t(2) })).toEqual({ ok: true, changed: true, position: "disagree", version: 2 });
    expect(await setStance(db, "ann", { questionId: q, position: null, expectedVersion: 2 }, { now: t(3) })).toEqual({ ok: true, changed: true, position: null, version: 3 });
    // Withdrawal deletes the current stance row and records a history change with to=null.
    expect(await stanceRows(db, "ann")).toEqual([]);
    expect((await changeRows(db, "ann")).map((c) => [c.fromPosition, c.toPosition, c.area, c.createdAt.toISOString()])).toEqual([
      [null, "agree", "ja", t(1).toISOString()],
      ["agree", "disagree", "ja", t(2).toISOString()],
      ["disagree", null, "ja", t(3).toISOString()],
    ]);
    // Reselecting after withdrawal continues version numbering rather than resetting it.
    expect(await setStance(db, "ann", { questionId: q, position: "neither", expectedVersion: 3 }, { now: t(4) })).toEqual({ ok: true, changed: true, position: "neither", version: 4 });
    expect(await stanceRows(db, "ann")).toMatchObject([{ questionId: q, userId: "ann", position: "neither", area: "ja", version: 4 }]);
    expect(await changeRows(db, "ann")).toHaveLength(4);
    expect(await loadOwnStances(db, "ann", [q])).toEqual(new Map([[q, { position: "neither", version: 4 }]]));
  });

  it("does not record a resend of the same value, and a double tap shows no conflict", async () => {
    const { db, q } = await world();
    await setStance(db, "ann", { questionId: q, position: "agree", expectedVersion: 0 }, { now: t(1) });
    // Resubmitting the same value records nothing and is not a conflict even with an old version, covering double clicks.
    expect(await setStance(db, "ann", { questionId: q, position: "agree", expectedVersion: 0 }, { now: t(2) })).toEqual({ ok: true, changed: false, position: "agree", version: 1 });
    expect(await changeRows(db, "ann")).toHaveLength(1);
    expect((await stanceRows(db, "ann"))[0].updatedAt.toISOString()).toBe(t(1).toISOString());
    // Withdrawal with no current selection is also a no-op.
    expect(await setStance(db, "bob", { questionId: q, position: null, expectedVersion: 0 })).toEqual({ ok: true, changed: false, position: null, version: 0 });
    expect(await changeRows(db, "bob")).toEqual([]);
  });

  it("detects a stale screen: the current stance and version come back, and nothing is written", async () => {
    const { db, q } = await world();
    await setStance(db, "ann", { questionId: q, position: "agree", expectedVersion: 0 }, { now: t(1) });
    await setStance(db, "ann", { questionId: q, position: "disagree", expectedVersion: 1 }, { now: t(2) });
    // Submit from an old version-1 page after another tab advances to version 2.
    expect(await setStance(db, "ann", { questionId: q, position: "neither", expectedVersion: 1 }, { now: t(3) })).toEqual({ ok: false, error: "conflict", position: "disagree", version: 2 });
    expect(await changeRows(db, "ann")).toHaveLength(2);
    // After withdrawal and reselection, a pre-withdrawal page still has a mismatched version and is detected. Versions count history rows, so they never go backward.
    await setStance(db, "ann", { questionId: q, position: null, expectedVersion: 2 }, { now: t(4) });
    await setStance(db, "ann", { questionId: q, position: "agree", expectedVersion: 3 }, { now: t(5) });
    expect(await setStance(db, "ann", { questionId: q, position: "neither", expectedVersion: 1 }, { now: t(6) })).toEqual({ ok: false, error: "conflict", position: "agree", version: 4 });
    // While withdrawn, a non-withdrawal submission from a stale page returns the current version, the count at withdrawal.
    await setStance(db, "bob", { questionId: q, position: "agree", expectedVersion: 0 }, { now: t(7) });
    await setStance(db, "bob", { questionId: q, position: null, expectedVersion: 1 }, { now: t(8) });
    expect(await setStance(db, "bob", { questionId: q, position: "disagree", expectedVersion: 1 }, { now: t(9) })).toEqual({ ok: false, error: "conflict", position: null, version: 2 });
  });

  it("answers not_found, not_a_question, hidden and no_profile; a hidden question can be withdrawn from but not chosen", async () => {
    const { db, q } = await world();
    const plain = await createTopic(db, "author", { lang: "ja", title: "ふつう", body: "本文" });
    if (!plain.ok) throw new Error("topic failed");
    const reply = await createReply(db, "bob", q, { lang: "en", body: "reply" });
    if (!reply.ok) throw new Error("reply failed");
    expect(await setStance(db, "ann", { questionId: 999_999, position: "agree", expectedVersion: 0 })).toEqual({ ok: false, error: "not_found" });
    expect(await setStance(db, "ann", { questionId: plain.id, position: "agree", expectedVersion: 0 })).toEqual({ ok: false, error: "not_a_question" });
    expect(await setStance(db, "ann", { questionId: reply.id, position: "agree", expectedVersion: 0 })).toEqual({ ok: false, error: "not_a_question" });
    expect(await setStance(db, "nobody", { questionId: q, position: "agree", expectedVersion: 0 })).toEqual({ ok: false, error: "no_profile" });
    expect(await stanceRows(db)).toEqual([]);
    // A hidden question permits withdrawal but not registration or changes.
    await setStance(db, "ann", { questionId: q, position: "agree", expectedVersion: 0 }, { now: t(1) });
    expect((await hideEntry(db, OP, { entryId: q, reason: "spam", note: "hidden" }, { now: t(2) })).ok).toBe(true);
    expect(await setStance(db, "bob", { questionId: q, position: "agree", expectedVersion: 0 })).toEqual({ ok: false, error: "hidden" });
    expect(await setStance(db, "ann", { questionId: q, position: "disagree", expectedVersion: 1 })).toEqual({ ok: false, error: "hidden" });
    expect(await setStance(db, "ann", { questionId: q, position: null, expectedVersion: 1 }, { now: t(3) })).toEqual({ ok: true, changed: true, position: null, version: 2 });
    // Unhiding permits selection again.
    expect((await unhideEntry(db, OP, { entryId: q, reason: "other" }, { now: t(4) })).ok).toBe(true);
    expect((await setStance(db, "ann", { questionId: q, position: "agree", expectedVersion: 2 })).ok).toBe(true);
    // A deleted question returns not_found.
    expect((await softDeleteEntry(db, q)).ok).toBe(true);
    expect(await setStance(db, "bob", { questionId: q, position: "agree", expectedVersion: 0 })).toEqual({ ok: false, error: "not_found" });
  });
});

describe("the lock: the first stance of a member other than the author", () => {
  it("is set by the first stance of someone else, and not by the author's own stance, change or withdrawal", async () => {
    const { db, q } = await world();
    await setStance(db, "author", { questionId: q, position: "agree", expectedVersion: 0 }, { now: t(1) });
    await setStance(db, "author", { questionId: q, position: "disagree", expectedVersion: 1 }, { now: t(2) });
    await setStance(db, "author", { questionId: q, position: null, expectedVersion: 2 }, { now: t(3) });
    expect((await questionRow(db, q)).stanceLockedAt).toBeNull();
    // The author can edit.
    expect((await getEditableEntry(db, "author", q, { kind: "topic" }))).toMatchObject({ ok: true, entry: { locked: false, mode: "author" } });
    // Even if the author selected first, the first non-author stance starts locking.
    await setStance(db, "author", { questionId: q, position: "agree", expectedVersion: 3 }, { now: t(4) });
    expect((await questionRow(db, q)).stanceLockedAt).toBeNull();
    await setStance(db, "ann", { questionId: q, position: "neither", expectedVersion: 0 }, { now: t(5) });
    expect((await questionRow(db, q)).stanceLockedAt?.toISOString()).toBe(t(5).toISOString());
    expect(await getEditableEntry(db, "author", q, { kind: "topic" })).toMatchObject({ ok: true, entry: { locked: true, mode: "author-locked" } });
    // The second and subsequent voters do not rewrite the timestamp.
    await setStance(db, "bob", { questionId: q, position: "agree", expectedVersion: 0 }, { now: t(6) });
    expect((await questionRow(db, q)).stanceLockedAt?.toISOString()).toBe(t(5).toISOString());
  });

  it("stays after the last stance of others is withdrawn or deleted, after a hide, a deletion and a restoration, and a member under exclusion also locks", async () => {
    const { db, q } = await world();
    await setStance(db, "ann", { questionId: q, position: "agree", expectedVersion: 0 }, { now: t(1) });
    await setStance(db, "ann", { questionId: q, position: null, expectedVersion: 1 }, { now: t(2) });
    expect((await questionRow(db, q)).stanceLockedAt?.toISOString()).toBe(t(1).toISOString());
    await deleteStanceRecord(db, "ann", q);
    expect((await questionRow(db, q)).stanceLockedAt?.toISOString()).toBe(t(1).toISOString());
    expect(await stanceRows(db)).toEqual([]);
    // Locking persists through moderation hiding and unhiding.
    await hideEntry(db, OP, { entryId: q, reason: "spam", note: "hidden" }, { now: t(3) });
    await unhideEntry(db, OP, { entryId: q, reason: "other" }, { now: t(4) });
    expect((await questionRow(db, q)).stanceLockedAt?.toISOString()).toBe(t(1).toISOString());
    // An excluded member's stance also starts locking because exclusion can be overturned on appeal.
    const fresh = await createTopic(db, "author", { lang: "ja", title: "もう一つの問い", body: "命題です。", asksStance: true });
    if (!fresh.ok) throw new Error("question failed");
    await db.update(profiles).set({ reactionsExcludedAt: t(5) }).where(eq(profiles.userId, "bob"));
    await setStance(db, "bob", { questionId: fresh.id, position: "agree", expectedVersion: 0 }, { now: t(6) });
    expect((await questionRow(db, fresh.id)).stanceLockedAt?.toISOString()).toBe(t(6).toISOString());
  });

  it("does not move the question's own times: updated_at, last_activity_at and changed_at stay (a stance leaves no trace in the times)", async () => {
    const { db, q } = await world();
    const vote = await createReply(db, "bob", q, { lang: "en", body: "I like this." }, { now: t(1) });
    if (!vote.ok) throw new Error("reply failed");
    const watched = async () => {
      const [question, thread] = await Promise.all([questionRow(db, q), questionRow(db, vote.id)]);
      return [question.updatedAt, question.lastActivityAt, question.changedAt, thread.updatedAt, thread.changedAt].map((d) => d.toISOString());
    };
    const before = await watched();
    // Initial stance, stance change, withdrawal, and adding/removing "なるほど".
    await setStance(db, "ann", { questionId: q, position: "agree", expectedVersion: 0 }, { now: t(30) });
    expect(await watched()).toEqual(before);
    await setStance(db, "ann", { questionId: q, position: "disagree", expectedVersion: 1 }, { now: t(31) });
    await setStance(db, "ann", { questionId: q, position: null, expectedVersion: 2 }, { now: t(32) });
    await setVote(db, "ann", vote.id, true, { now: t(33) });
    await setVote(db, "ann", vote.id, false, { now: t(34) });
    await setVote(db, "ann", q, true, { now: t(35) });
    expect(await watched()).toEqual(before);
    expect((await questionRow(db, q)).stanceLockedAt).not.toBeNull();
  });
});

describe("the trigger of a change (the entry that made the member rethink)", () => {
  it("is recorded only for an entry of the question's thread that the member gave Insightful, and a made-up trigger is ignored", async () => {
    const { db, q } = await world();
    const mine = await createReply(db, "bob", q, { lang: "en", body: "A point." }, { now: t(1) });
    const other = await createReply(db, "cid", q, { lang: "fr", body: "Un autre point." }, { now: t(2) });
    const elsewhere = await createTopic(db, "bob", { lang: "en", title: "elsewhere", body: "x" });
    if (!mine.ok || !other.ok || !elsewhere.ok) throw new Error("setup failed");
    await setStance(db, "ann", { questionId: q, position: "agree", expectedVersion: 0 }, { now: t(3) });
    await setVote(db, "ann", mine.id, true, { now: t(4) });
    await setVote(db, "ann", elsewhere.id, true, { now: t(4) });
    // A voted post is recorded with a snapshot of its author's area at posting time, en for bob.
    await setStance(db, "ann", { questionId: q, position: "disagree", expectedVersion: 1, triggerEntryId: mine.id }, { now: t(5) });
    // An unvoted post, a post in another thread, or a nonexistent post records no trigger rather than raising an error.
    await setStance(db, "ann", { questionId: q, position: "neither", expectedVersion: 2, triggerEntryId: other.id }, { now: t(6) });
    await setStance(db, "ann", { questionId: q, position: "agree", expectedVersion: 3, triggerEntryId: elsewhere.id }, { now: t(7) });
    await setStance(db, "ann", { questionId: q, position: "disagree", expectedVersion: 4, triggerEntryId: 987_654 }, { now: t(8) });
    const rows = await changeRows(db, "ann");
    expect(rows.map((c) => [c.toPosition, c.triggerEntryId, c.triggerArea])).toEqual([
      ["agree", null, null],
      ["disagree", mine.id, "en"],
      ["neither", null, null],
      ["agree", null, null],
      ["disagree", null, null],
    ]);
    // A hidden post cannot be a trigger.
    await setVote(db, "ann", other.id, true, { now: t(9) });
    await hideEntry(db, OP, { entryId: other.id, reason: "spam", note: "x" }, { now: t(10) });
    await setStance(db, "ann", { questionId: q, position: "agree", expectedVersion: 5, triggerEntryId: other.id }, { now: t(11) });
    expect((await changeRows(db, "ann")).at(-1)).toMatchObject({ toPosition: "agree", triggerEntryId: null, triggerArea: null });
  });
});

describe("the area of a stance", () => {
  it("is written from home_area, and a change of the home area rewrites stances.area only (no change record, no version, no updated_at)", async () => {
    const { db, q } = await world();
    const second = await createTopic(db, "author", { lang: "ja", title: "二つ目", body: "命題です。", asksStance: true });
    if (!second.ok) throw new Error("question failed");
    await setStance(db, "ann", { questionId: q, position: "agree", expectedVersion: 0 }, { now: t(1) });
    await setStance(db, "ann", { questionId: second.id, position: "disagree", expectedVersion: 0 }, { now: t(2) });
    await setStance(db, "bob", { questionId: q, position: "agree", expectedVersion: 0 }, { now: t(3) });
    expect(await changeHomeArea(db, "ann", "th", { now: t(10) })).toEqual({ ok: true, changed: true });
    // Rewrite this member's stances on all questions to the new area; other members remain unchanged.
    expect((await stanceRows(db, "ann")).map((s) => [s.area, s.version, s.updatedAt.toISOString()])).toEqual([
      ["th", 1, t(1).toISOString()],
      ["th", 1, t(2).toISOString()],
    ]);
    expect((await stanceRows(db, "bob"))[0].area).toBe("en");
    // History area remains the snapshot from the change time; no new history is created.
    expect((await changeRows(db, "ann")).map((c) => c.area)).toEqual(["ja", "ja"]);
    // Subsequent registrations and changes use the new area.
    await setStance(db, "ann", { questionId: q, position: "neither", expectedVersion: 1 }, { now: t(11) });
    expect((await stanceRows(db, "ann")).find((s) => s.questionId === q)?.area).toBe("th");
    expect((await changeRows(db, "ann", q)).map((c) => c.area)).toEqual(["ja", "th"]);
    // Selecting the same area is a no-op; rewriteStanceAreas also avoids writing unchanged rows.
    expect(await rewriteStanceAreas(db, "ann", "th")).toBe(0);
    expect(await rewriteStanceAreas(db, "ann", "fr")).toBe(2);
    expect((await stanceRows(db, "ann")).map((s) => s.area)).toEqual(["fr", "fr"]);
  });
});

describe("deleting one's own records (the right to delete comes before append-only)", () => {
  it("removes the stance and its history for one question, takes the member out of the distribution at once, and works on hidden and deleted questions", async () => {
    const { db, q } = await world();
    const second = await createTopic(db, "author", { lang: "ja", title: "二つ目", body: "命題です。", asksStance: true });
    const third = await createTopic(db, "author", { lang: "ja", title: "三つ目", body: "命題です。", asksStance: true });
    if (!second.ok || !third.ok) throw new Error("question failed");
    for (const [id, position] of [[q, "agree"], [second.id, "disagree"], [third.id, "neither"]] as const) await setStance(db, "ann", { questionId: id, position, expectedVersion: 0 }, { now: t(1) });
    await setStance(db, "bob", { questionId: q, position: "agree", expectedVersion: 0 }, { now: t(2) });
    expect((await readDistributions(db, [q], { kind: "observation" })).get(q)).toMatchObject({ total: 2, counts: { agree: 2, disagree: 0, neither: 0 }, langs: 2 });
    expect(await deleteStanceRecord(db, "ann", q)).toEqual({ stances: 1, changes: 1 });
    expect((await readDistributions(db, [q], { kind: "observation" })).get(q)).toMatchObject({ total: 1, langs: 1 });
    expect(await loadOwnStances(db, "ann", [q, second.id])).toEqual(
      new Map([
        [q, { position: null, version: 0 }],
        [second.id, { position: "disagree", version: 1 }],
      ]),
    );
    // History for hidden and deleted questions can also be deleted without a rate limit.
    await hideEntry(db, OP, { entryId: second.id, reason: "spam", note: "hidden" }, { now: t(3) });
    await softDeleteEntry(db, third.id, { now: t(4) });
    expect(await deleteStanceRecord(db, "ann", second.id)).toEqual({ stances: 1, changes: 1 });
    expect(await deleteStanceRecord(db, "ann", third.id)).toEqual({ stances: 1, changes: 1 });
    expect(await deleteStanceRecord(db, "ann", third.id)).toEqual({ stances: 0, changes: 0 });
    expect(await changeRows(db, "ann")).toEqual([]);
    // bob's history remains.
    expect(await stanceRows(db, "bob")).toHaveLength(1);
    // Deletion resets the version to 0. A pre-deletion page can coincidentally match a later version; allow this because the owner explicitly deleted the history.
    expect(await setStance(db, "ann", { questionId: q, position: "agree", expectedVersion: 0 }, { now: t(5) })).toMatchObject({ ok: true, version: 1 });
  });

  it("deleteAllStanceRecords removes every stance and change of the member and nobody else's", async () => {
    const { db, q } = await world();
    const second = await createTopic(db, "author", { lang: "ja", title: "二つ目", body: "命題です。", asksStance: true });
    if (!second.ok) throw new Error("question failed");
    for (const id of [q, second.id]) {
      await setStance(db, "ann", { questionId: id, position: "agree", expectedVersion: 0 });
      await setStance(db, "bob", { questionId: id, position: "disagree", expectedVersion: 0 });
    }
    expect(await deleteAllStanceRecords(db, "ann")).toEqual({ stances: 2, changes: 2 });
    expect(await stanceRows(db)).toHaveLength(2);
    expect(await changeRows(db, "bob")).toHaveLength(2);
    expect(await deleteAllStanceRecords(db, "ghost")).toEqual({ stances: 0, changes: 0 });
  });

  it("a suspended member's stance counts, and the member can still delete the record", async () => {
    const { db, q } = await world();
    await setStance(db, "ann", { questionId: q, position: "agree", expectedVersion: 0 }, { now: t(1) });
    await db.update(profiles).set({ suspendedUntil: new Date(Date.UTC(2031, 0, 1)), suspendedReason: "spam" }).where(eq(profiles.userId, "ann"));
    expect((await readDistributions(db, [q], { kind: "observation" })).get(q)).toMatchObject({ total: 1 });
    expect(await deleteStanceRecord(db, "ann", q)).toEqual({ stances: 1, changes: 1 });
  });
});

describe("the member's own list (/settings/stances)", () => {
  it("lists the questions with a stance or a history, newest change first, with the history in time order and readable triggers only", async () => {
    const { db, q } = await world();
    const second = await createTopic(db, "author", { lang: "ja", title: "二つ目の問い", body: "命題です。", asksStance: true });
    const gone = await createTopic(db, "author", { lang: "ja", title: "消える問い", body: "命題です。", asksStance: true });
    if (!second.ok || !gone.ok) throw new Error("question failed");
    const reply = await createReply(db, "bob", q, { lang: "en", body: "A point." }, { now: t(1) });
    if (!reply.ok) throw new Error("reply failed");
    await setStance(db, "ann", { questionId: q, position: "agree", expectedVersion: 0 }, { now: t(2) });
    await setVote(db, "ann", reply.id, true, { now: t(3) });
    await setStance(db, "ann", { questionId: q, position: "disagree", expectedVersion: 1, triggerEntryId: reply.id }, { now: t(4) });
    await setStance(db, "ann", { questionId: second.id, position: "neither", expectedVersion: 0 }, { now: t(5) });
    await setStance(db, "ann", { questionId: gone.id, position: "agree", expectedVersion: 0 }, { now: t(6) });
    await softDeleteEntry(db, gone.id, { now: t(7) });
    await setStance(db, "bob", { questionId: q, position: "agree", expectedVersion: 0 }, { now: t(8) });
    const viewer = { userId: "ann", scope: { operator: false, langs: [] } };
    const list = await listOwnStanceRecords(db, "ann", { readLangs: ["ja"], displayLang: "ja", viewer });
    // Order by newest last change; exclude bob's stances.
    expect(list.map((r) => r.questionId)).toEqual([gone.id, second.id, q]);
    expect(list.map((r) => [r.question.state, r.question.title?.text ?? null, r.position])).toEqual([
      ["deleted", null, "agree"],
      ["visible", "二つ目の問い", "neither"],
      ["visible", "問い", "disagree"],
    ]);
    expect(list[2].changes).toEqual([
      { from: null, to: "agree", at: t(2), trigger: null },
      { from: "agree", to: "disagree", at: t(4), trigger: { entryId: reply.id, href: `/t/${q}#c-${reply.id}` } },
    ]);
    // Do not link a trigger post that has become unreadable.
    await hideEntry(db, OP, { entryId: reply.id, reason: "spam", note: "hidden" }, { now: t(9) });
    const after = await listOwnStanceRecords(db, "ann", { readLangs: ["ja"], displayLang: "ja", viewer });
    expect(after.find((r) => r.questionId === q)?.changes[1].trigger).toEqual({ entryId: reply.id, href: null });
    // A hidden question's title appears only for an authorized viewer, the operator.
    await hideEntry(db, OP, { entryId: second.id, reason: "spam", note: "hidden" }, { now: t(10) });
    const hiddenForMember = (await listOwnStanceRecords(db, "ann", { readLangs: ["ja"], displayLang: "ja", viewer })).find((r) => r.questionId === second.id);
    expect(hiddenForMember?.question).toEqual({ state: "hidden", title: null });
    const hiddenForOperator = (await listOwnStanceRecords(db, "ann", { readLangs: ["ja"], displayLang: "ja", viewer: { userId: "op", scope: OP.scope } })).find((r) => r.questionId === second.id);
    expect(hiddenForOperator?.question).toMatchObject({ state: "hidden", title: { text: "二つ目の問い" } });
    expect(await listOwnStanceRecords(db, "cid", { readLangs: ["fr"], displayLang: "fr", viewer: { userId: "cid", scope: { operator: false, langs: [] } } })).toEqual([]);
  });
});

describe("the limits on sending a stance", () => {
  it("allows 30 sends an hour per member and 10 a day per question (a fixed window cut at 00:00 UTC), and counts refused sends and resends too", async () => {
    const { db } = await world();
    expect(MEMBER_RATE_LIMITS.stance).toEqual({ limit: 30, windowSeconds: 3600 });
    expect(STANCE_PER_QUESTION_LIMIT).toEqual({ limit: 10, windowSeconds: 86400 });
    const noon = new Date(Date.UTC(2026, 9, 5, 12, 0));
    for (let i = 1; i <= 30; i++) expect((await hitMemberLimit(db, "stance", "ann", noon)).allowed, `send ${i}`).toBe(true);
    expect((await hitMemberLimit(db, "stance", "ann", noon)).allowed).toBe(false);
    // Other members have separate counters. A new window, the next hour, allows use again.
    expect((await hitMemberLimit(db, "stance", "bob", noon)).allowed).toBe(true);
    expect((await hitMemberLimit(db, "stance", "ann", new Date(noon.getTime() + 3600_000))).allowed).toBe(true);
    for (let i = 1; i <= 10; i++) expect((await hitStanceQuestionLimit(db, "ann", 7, noon)).allowed, `question send ${i}`).toBe(true);
    const refused = await hitStanceQuestionLimit(db, "ann", 7, noon);
    expect(refused).toMatchObject({ allowed: false, limit: 10, retryAfterSeconds: 12 * 3600 });
    // Different questions have separate counters even for the same member. The window changes at 00:00 UTC the next day.
    expect((await hitStanceQuestionLimit(db, "ann", 8, noon)).allowed).toBe(true);
    expect((await hitStanceQuestionLimit(db, "ann", 7, new Date(Date.UTC(2026, 9, 6, 0, 0)))).allowed).toBe(true);
    const keys = (await db.select({ key: rateLimits.key }).from(rateLimits)).map((r) => r.key);
    expect(keys).toContain(stanceQuestionLimitKey("ann", 7));
    expect(keys).toContain(stanceQuestionLimitKey("ann", 8));
  });

  it("keys the per-question count with an HMAC, so that rate_limits does not keep that a member took part in a question once the member deletes the record", async () => {
    const { db, q } = await world();
    const key = stanceQuestionLimitKey("ann", q);
    // a keyed digest of the member and the question; stable, different per member, per question and per secret, and not the magic-link address key
    expect(key).toMatch(/^member:stance-question:[0-9a-f]{64}$/);
    expect(stanceQuestionLimitKey("ann", q)).toBe(key);
    expect(stanceQuestionLimitKey("bob", q)).not.toBe(key);
    expect(stanceQuestionLimitKey("ann", q + 1)).not.toBe(key);
    expect(stanceQuestionLimitKey("ann", q, "another-secret-000000000000000000000000")).not.toBe(key);
    expect(key).not.toContain(addressHasher(authSecret())(`ann:${q}`));
    // a send, then the member deletes the whole record: nothing in rate_limits names the member or the question
    expect((await setStance(db, "ann", { questionId: q, position: "agree", expectedVersion: 0 })).ok).toBe(true);
    expect((await hitStanceQuestionLimit(db, "ann", q)).allowed).toBe(true);
    expect(await deleteStanceRecord(db, "ann", q)).toMatchObject({ stances: 1 });
    const rows = (await db.select({ key: rateLimits.key }).from(rateLimits)).map((r) => r.key).filter((k) => k.startsWith("member:stance-question:"));
    expect(rows).toEqual([key]);
    expect(rows[0]).not.toContain("ann");
  });
});
