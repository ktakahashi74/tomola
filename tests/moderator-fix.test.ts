import { markdownFixture, SLOW_MARKDOWN } from "./helpers/markdown-fixture";
import { and, asc, eq } from "drizzle-orm";
import { createElement } from "react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createAppeal, decideAppeal, getAppealableAction, listOpenAppeals } from "~/lib/appeals.server";
import { entries, entryRevisions, jobs, moderationActions, notifications, profiles, segments, stances } from "~/lib/db/schema";
import { readDistributions } from "~/lib/distribution.server";
import { createReply, createTopic, getEditableEntry, getThread, softDeleteEntry } from "~/lib/entries.server";
import { EMBED_JOB } from "~/lib/embeddings.server";
import { deleteEntry, fixEntry, hideEntry, listPublicLog, type Actor } from "~/lib/moderation.server";
import { listNotifications } from "~/lib/notifications.server";
import { getViewer, grantModerator } from "~/lib/roles.server";
import { setStance } from "~/lib/stances.server";
import { TRANSLATE_JOB } from "~/lib/translations.server";
import { renderInRouter } from "./helpers/render-in-router";
import { createMarkdownExecutor, setMarkdownExecutorForTests, withMarkdownScope } from "~/lib/markdown-budget.server";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";

// Correcting a typo in a locked question (moderation action fix_entry): assigned moderators and operators only, with a required explanation. Covers revisions, notifications, public records, and appeals restoring the preceding version.
const t = (minutes: number) => new Date(Date.UTC(2026, 9, 5, 0, minutes));
const OP: Actor = { id: "", scope: { operator: true, langs: [] } };
const JA_MOD: Actor = { id: "", scope: { operator: false, langs: ["ja"] } };
const EN_MOD: Actor = { id: "", scope: { operator: false, langs: ["en"] } };

let h: RouteHarness;
let author: string;
let bob: string;
let ann: string;
let jamod: string;
let enmod: string;
let operator: string;
let reviewer: string;
let seq = 0;

beforeAll(async () => {
  h = await setupRouteHarness();
  author = await h.signIn("hana", { homeArea: "ja", readLangs: ["ja", "en"] });
  bob = await h.signIn("bob", { homeArea: "en", readLangs: ["en", "ja"] });
  ann = await h.signIn("ann", { homeArea: "ja", readLangs: ["ja"] });
  jamod = await h.signIn("jamod", { homeArea: "ja", readLangs: ["ja"] });
  enmod = await h.signIn("enmod", { homeArea: "en", readLangs: ["en"] });
  operator = await h.signIn("opal", { homeArea: "ja", readLangs: ["ja"] });
  reviewer = await h.signIn("rina", { homeArea: "ja", readLangs: ["ja"] });
  JA_MOD.id = jamod;
  EN_MOD.id = enmod;
  OP.id = operator;
  expect((await grantModerator(h.db, operator, jamod, "ja")).ok).toBe(true);
  expect((await grantModerator(h.db, operator, enmod, "en")).ok).toBe(true);
});
afterAll(() => h.restore());

// Create hana's question and lock it with bob's stance; setStance locks on the first stance from someone other than the author.
async function lockedQuestion(over: { title?: string; body?: string; altOf?: number | null } = {}) {
  const res = await createTopic(h.db, author, { lang: "ja", title: over.title ?? `共生は制御の代理になりうる${++seq}`, body: over.body ?? "ここでの共生とは、にらみ合いのない状態を指す。二文目です。", asksStance: true, altOf: over.altOf ?? null }, { now: t(0) });
  if (!res.ok) throw new Error(`question failed: ${res.error}`);
  const stance = await setStance(h.db, bob, { questionId: res.id, position: "agree", expectedVersion: 0 }, { now: t(1) });
  if (!stance.ok) throw new Error(`stance failed: ${stance.error}`);
  return res.id;
}
const row = async (id: number) => (await h.db.select().from(entries).where(eq(entries.id, id)))[0];
const revisions = (id: number) => h.db.select().from(entryRevisions).where(eq(entryRevisions.entryId, id)).orderBy(asc(entryRevisions.id));
const actionsOf = (id: number) => h.db.select().from(moderationActions).where(eq(moderationActions.targetEntryId, id)).orderBy(asc(moderationActions.id));
// The base of the edit form: the source hash of the text as it is now (a form opened just before the fix).
const hashOf = async (id: number) => (await row(id))?.sourceHash ?? "";
const fix = async (actor: Actor, entryId: number, over: { title?: string; body?: string; note?: unknown; sourceHash?: unknown } = {}, now = t(10)) =>
  fixEntry(
    h.db,
    actor,
    {
      entryId,
      title: over.title ?? "共生は制御の代替になりうる",
      body: over.body ?? "ここでの共生とは、にらみ合いのない状態を指す。二文目です。",
      note: "note" in over ? over.note : "代理を代替に直した",
      sourceHash: "sourceHash" in over ? over.sourceHash : await hashOf(entryId),
    },
    { now },
  );

describe("who can fix what", () => {
  it("only a moderator of the question's language and an operator, and only a locked question; the author's own screen stays the author's", async () => {
    const q = await lockedQuestion();
    const before = await row(q);
    // A moderator of an unrelated language and an ordinary member receive forbidden.
    expect(await fix(EN_MOD, q)).toEqual({ ok: false, error: "forbidden" });
    expect(await fix({ id: ann, scope: { operator: false, langs: [] } }, q)).toEqual({ ok: false, error: "forbidden" });
    // A moderator cannot correct a question they authored.
    expect(await fix({ id: author, scope: { operator: false, langs: ["ja"] } }, q)).toEqual({ ok: false, error: "own_entry" });
    expect(await fix({ id: author, scope: OP.scope }, q)).toEqual({ ok: false, error: "own_entry" });
    expect(await row(q)).toEqual(before);
    expect(await revisions(q)).toEqual([]);
    // The assigned language moderator and an operator can correct it.
    expect(await fix(JA_MOD, q, { title: "共生は制御の代替になりうる" })).toMatchObject({ ok: true });
    expect(await fix(OP, q, { title: "共生は制御の代替になりうる。" }, t(11))).toMatchObject({ ok: true });
  });

  it("is only for a locked question: before the lock the author edits (invalid_state); a reply and a topic that is not a question are invalid_state; a deleted question is not_found", async () => {
    const unlocked = await createTopic(h.db, author, { lang: "ja", title: "固定前", body: "本文", asksStance: true });
    const plain = await createTopic(h.db, author, { lang: "ja", title: "ふつうの話題", body: "本文" });
    const q = await lockedQuestion();
    const reply = await createReply(h.db, bob, q, { lang: "ja", body: "返信です。" });
    if (!unlocked.ok || !plain.ok || !reply.ok) throw new Error("setup failed");
    for (const id of [unlocked.id, plain.id, reply.id]) expect(await fix(JA_MOD, id), String(id)).toEqual({ ok: false, error: "invalid_state" });
    expect(await fix(JA_MOD, 987_654)).toEqual({ ok: false, error: "not_found" });
    const gone = await lockedQuestion();
    await softDeleteEntry(h.db, gone, { now: t(5) });
    expect(await fix(JA_MOD, gone)).toEqual({ ok: false, error: "not_found" });
    // getEditableEntry uses the same gate: moderator-fix for a locked question is available only to an assigned moderator passed as viewer.
    const viewer = await getViewer(h.db, { id: jamod, email: "jamod@example.com" });
    expect(await getEditableEntry(h.db, jamod, unlocked.id, { kind: "topic", viewer })).toEqual({ ok: false, error: "forbidden" });
    expect(await getEditableEntry(h.db, jamod, q, { kind: "topic", viewer })).toMatchObject({ ok: true, entry: { mode: "moderator-fix", locked: true } });
    expect(await getEditableEntry(h.db, jamod, reply.id, { kind: "reply", viewer })).toEqual({ ok: false, error: "forbidden" });
  });

  it("needs an explanation (the reason class is fixed to other), checks the content like the author's edit, and sees no_change", async () => {
    const q = await lockedQuestion();
    expect(await fix(JA_MOD, q, { note: undefined })).toEqual({ ok: false, error: "note_required" });
    expect(await fix(JA_MOD, q, { note: "   " })).toEqual({ ok: false, error: "note_required" });
    expect(await fix(JA_MOD, q, { note: "x".padEnd(501, "x") })).toEqual({ ok: false, error: "invalid_note" });
    expect(await fix(JA_MOD, q, { note: 5 })).toEqual({ ok: false, error: "invalid_note" });
    expect(await fix(JA_MOD, q, { title: "" })).toEqual({ ok: false, error: "invalid_title" });
    expect(await fix(JA_MOD, q, { title: "a\nb" })).toEqual({ ok: false, error: "invalid_title" });
    expect(await fix(JA_MOD, q, { body: "   " })).toEqual({ ok: false, error: "body_required" });
    expect(await fix(JA_MOD, q, { body: "x".padEnd(50_001, "x") })).toEqual({ ok: false, error: "body_too_long" });
    // A submission with no changes.
    const same = await row(q);
    expect(await fix(JA_MOD, q, { title: same.title!, body: same.body })).toEqual({ ok: false, error: "no_change" });
    expect(await revisions(q)).toEqual([]);
    expect(await actionsOf(q)).toEqual([]);
    // Title-only and body-only changes also pass.
    expect(await fix(JA_MOD, q, { title: "共生は制御の代替になりうる", body: same.body })).toMatchObject({ ok: true });
    expect(await fix(JA_MOD, q, { title: "共生は制御の代替になりうる", body: "ここでの共生とは、にらみ合いのない状態を指す。二文目です！" }, t(11))).toMatchObject({ ok: true });
    // Record the explanation with the reason category fixed to other.
    expect((await actionsOf(q)).map((a) => [a.action, a.reason, a.note])).toEqual([["fix_entry", "other", "代理を代替に直した"], ["fix_entry", "other", "代理を代替に直した"]]);
  });
});

describe("a stale form", () => {
  it("is refused when the text changed after the form was opened (another moderator's fix, or an appeal that put the earlier text back): invalid_state, nothing is written", async () => {
    const q = await lockedQuestion({ title: "元の題", body: "元の本文です。" });
    const opened = await hashOf(q);
    // two moderators open the form on the same text; the first one fixes
    expect(await fix(JA_MOD, q, { title: "一人目の題", body: "元の本文です。", sourceHash: opened }, t(10))).toMatchObject({ ok: true });
    const afterFirst = await row(q);
    expect(await fix(OP, q, { title: "二人目の題", body: "二人目の本文です。", sourceHash: opened }, t(11))).toEqual({ ok: false, error: "invalid_state" });
    expect(await row(q)).toEqual(afterFirst);
    expect(await revisions(q)).toHaveLength(1);
    expect(await actionsOf(q)).toHaveLength(1);
    // a stale form is refused even when it holds the same text as the current one (it says nothing about what the moderator saw)
    expect(await fix(OP, q, { title: afterFirst.title!, body: afterFirst.body, sourceHash: opened }, t(12))).toEqual({ ok: false, error: "invalid_state" });
    // no base, an empty one or one that is not the current text: the same
    for (const bad of [undefined, null, "", 5, "0000000000000000"]) expect(await fix(OP, q, { title: "二人目の題", sourceHash: bad }, t(13)), String(bad)).toEqual({ ok: false, error: "invalid_state" });
    expect(await actionsOf(q)).toHaveLength(1);
    // a form opened after the first fix works on the new text
    expect(await fix(OP, q, { title: "二人目の題", body: "元の本文です。", sourceHash: await hashOf(q) }, t(14))).toMatchObject({ ok: true });
    // an appeal that put the earlier text back also makes a form that was opened before it stale
    const formBeforeAppeal = await hashOf(q);
    const appeal = await createAppeal(h.db, author, (await actionsOf(q))[1].id, "no", { now: t(15) });
    if (!appeal.ok) throw new Error("appeal failed");
    expect(await decideAppeal(h.db, { id: reviewer, scope: OP.scope }, appeal.id, { decision: "overturned", note: "n" }, { now: t(16) })).toMatchObject({ ok: true, reversed: true });
    expect(await fix(JA_MOD, q, { title: "三人目の題", sourceHash: formBeforeAppeal }, t(17))).toEqual({ ok: false, error: "invalid_state" });
  });
});

describe("what a fix does", () => {
  it("keeps the earlier version in the history, changes the text, rebuilds the derived data and leaves the lock and the stances alone", async () => {
    const q = await lockedQuestion({ title: "共生は制御の代理になりうる", body: "ここでの共生とは、にらみ合いのない状態を指す。二文目です。" });
    const before = await row(q);
    const stanceRowsBefore = await h.db.select().from(stances).where(eq(stances.questionId, q));
    const totalsBefore = (await readDistributions(h.db, [q], { kind: "observation" })).get(q);
    await h.db.delete(jobs);
    const result = await fix(JA_MOD, q, { title: "共生は制御の代替になりうる", body: "ここでの共生とは、にらみ合いのない状態を指す。三文目も足した。二文目です。" }, t(20));
    if (!result.ok) throw new Error(`fix failed: ${result.error}`);
    const after = await row(q);
    // Title, body, edit time, source version, and render cache.
    expect(after).toMatchObject({ title: "共生は制御の代替になりうる", body: "ここでの共生とは、にらみ合いのない状態を指す。三文目も足した。二文目です。", editedAt: t(20), updatedAt: t(20) });
    expect(after.sourceHash).not.toBe(before.sourceHash);
    expect(after.html).toContain("三文目も足した");
    // The previous revision contains the title and body immediately before correction; editor_id is the moderator who corrected it.
    const revs = await revisions(q);
    expect(revs).toHaveLength(1);
    expect(revs[0]).toMatchObject({ id: result.revisionId, entryId: q, title: "共生は制御の代理になりうる", body: "ここでの共生とは、にらみ合いのない状態を指す。二文目です。", editorId: jamod, editedAt: t(20) });
    // Rebuild sentence segmentation and enqueue translation and embedding jobs.
    expect((await h.db.select().from(segments).where(eq(segments.entryId, q))).length).toBe(3);
    const queued = await h.db.select().from(jobs);
    expect(queued.filter((j) => j.kind === TRANSLATE_JOB).length).toBeGreaterThan(0);
    expect(queued.filter((j) => j.kind === EMBED_JOB).length).toBe(1);
    // Keep the lock time, stance rows, and distribution unchanged.
    expect(after.stanceLockedAt).toEqual(before.stanceLockedAt);
    expect(await h.db.select().from(stances).where(eq(stances.questionId, q))).toEqual(stanceRowsBefore);
    expect((await readDistributions(h.db, [q], { kind: "observation" })).get(q)).toEqual({ ...totalsBefore!, asOf: expect.any(Date) });
    // The author still cannot edit; the lock remains.
    expect(await getEditableEntry(h.db, author, q, { kind: "topic" })).toMatchObject({ ok: true, entry: { mode: "author-locked" } });
  });

  it("makes the original question appear in the change feed when the fixed question is another way of asking (its title is on the original's Markdown)", async () => {
    const original = await lockedQuestion();
    const alt = await lockedQuestion({ altOf: original, title: "別の立て方の問い" });
    const before = await row(original);
    expect(before.metaChangedAt).not.toBeNull();
    // A body-only correction does not affect the original question; a title correction does.
    const bodyOnly = await fixEntry(h.db, JA_MOD, { entryId: alt, sourceHash: await hashOf(alt), title: "別の立て方の問い", body: "直した本文です。", note: "n" }, { now: t(30) });
    expect(bodyOnly.ok).toBe(true);
    expect((await row(original)).metaChangedAt).toEqual(before.metaChangedAt);
    const titleToo = await fixEntry(h.db, JA_MOD, { entryId: alt, sourceHash: await hashOf(alt), title: "別の立て方の問い（直し）", body: "直した本文です。", note: "n" }, { now: t(31) });
    expect(titleToo.ok).toBe(true);
    expect((await row(original)).metaChangedAt).toEqual(t(31));
    expect((await row(original)).changedAt).toEqual(t(31));
  });
});

describe("the title of a fixed question", () => {
  it("cannot be emptied by a fix: a question keeps its title (invalid_title), and nothing is written", async () => {
    const q = await lockedQuestion({ title: "元の題", body: "元の本文です。" });
    const before = await row(q);
    for (const title of [undefined, null, "", "   "]) {
      const res = await fixEntry(h.db, JA_MOD, { entryId: q, sourceHash: await hashOf(q), title, body: "直した本文です。", note: "題を消す" }, { now: t(90) });
      expect(res, JSON.stringify(title)).toEqual({ ok: false, error: "invalid_title" });
    }
    const after = await row(q);
    expect(after.title).toBe("元の題");
    expect(after.sourceHash).toBe(before.sourceHash);
  });
});

describe("the edit form of a fix", () => {
  const titleTag = (html: string) => html.match(/<input\b[^>]*\bname="title"[^>]*>/)?.[0] ?? "";
  const drawn = async (id: number, as: string) => {
    const mod = await import("~/routes/topic-edit");
    const loaderData = await mod.loader(await h.signedArgs(h.request(`/t/${id}/edit`, { as }), { id: String(id) }));
    return { loaderData, html: await renderInRouter(() => createElement(mod.default as never, { loaderData, actionData: undefined, params: {}, matches: [] } as never), `/t/${id}/edit`) };
  };

  it("names the actual personal destination when a moderator corrects another member's question", async () => {
    const prior = process.env.VILLAGES;
    vi.stubEnv("VILLAGES", "1");
    try {
      const owner = await h.signIn("zedit_owner", { homeArea: "ja", readLangs: ["ja"] });
      await h.db.update(profiles).set({ displayName: "投稿先の持ち主", displayNameLatin: "Destination owner" }).where(eq(profiles.userId, owner));
      const topic = await createTopic(h.db, owner, { title: "A question to correct", body: "Owned writing.", lang: "ja", asksStance: true });
      if (!topic.ok) throw new Error(topic.error);
      expect(await setStance(h.db, bob, { questionId: topic.id, position: "agree", expectedVersion: 0 })).toMatchObject({ ok: true });
      const { loaderData, html } = await drawn(topic.id, "jamod");
      expect(loaderData).toMatchObject({ fix: true, destination: "Destination owner" });
      expect(html.indexOf('data-village-target')).toBeLessThan(html.indexOf('name="title"'));
      expect(html).not.toContain('name="village"');
    } finally { vi.stubEnv("VILLAGES", prior); }
  });

  it("keeps the title field required in fix mode (a question always has its title)", async () => {
    const q = await lockedQuestion({ title: "元の題", body: "元の本文です。" });
    const { loaderData, html } = await drawn(q, "jamod");
    expect(loaderData).toMatchObject({ fix: true, locked: false });
    expect(titleTag(html)).toContain('required=""');
    expect(titleTag(html)).toContain('value="元の題"');
  });

  it("is required for the author of a question that is not locked yet, and optional for a topic without a title", async () => {
    const open = await createTopic(h.db, author, { lang: "ja", title: "まだ固定されない問い", body: "本文。", asksStance: true }, { now: t(91) });
    const bare = await createTopic(h.db, author, { lang: "ja", body: "題のない短い発言。" }, { now: t(92) });
    if (!open.ok || !bare.ok) throw new Error("topic failed");
    expect(titleTag((await drawn(open.id, "hana")).html)).toContain('required=""');
    expect(titleTag((await drawn(bare.id, "hana")).html)).not.toContain("required");
  });
});

describe("the record, the notice and the public log", () => {
  it("records fix_entry with the revision, tells the author with a moderation notification (no new kind, no mention) and lists it in the public log without the text", async () => {
    const q = await lockedQuestion({ title: "元の題ABC", body: "元の本文XYZ。" });
    await h.db.delete(notifications);
    const done = await fixEntry(h.db, JA_MOD, { entryId: q, sourceHash: await hashOf(q), title: "直した題DEF", body: "直した本文UVW。", note: "題と本文の誤字" }, { now: t(40) });
    if (!done.ok) throw new Error(`fix failed: ${done.error}`);
    const [action] = await actionsOf(q);
    expect(action).toMatchObject({ id: done.actionId, action: "fix_entry", targetEntryId: q, targetUserId: null, reason: "other", note: "題と本文の誤字", actorId: jamod, revisionId: done.revisionId });
    // Send the author the existing moderation notification without the actor. Do not send mention notifications.
    const mine = await listNotifications(h.db, author);
    expect(mine.items).toHaveLength(1);
    expect(mine.items[0]).toMatchObject({ kind: "moderation", action: "fix_entry", reason: "other", note: "題と本文の誤字", actionId: done.actionId, actorHandle: null });
    expect((await h.db.select().from(notifications)).map((n) => [n.userId, n.kind, n.actorId])).toEqual([[author, "moderation", null]]);
    // Public records contain only action type, reason category, source language, and date; omit before/after bodies, explanation, and actor.
    const log = await listPublicLog(h.db);
    expect(log.entries[0]).toEqual({ action: "fix_entry", reason: "other", lang: "ja", date: "2026-10-05" });
    for (const secret of ["元の題ABC", "元の本文XYZ", "直した題DEF", "直した本文UVW", "題と本文の誤字", "jamod"]) expect(JSON.stringify(log), secret).not.toContain(secret);
    // The author can see it as an appealable action; others must not even learn it exists.
    expect(await getAppealableAction(h.db, author, done.actionId)).toMatchObject({ action: "fix_entry", reason: "other", note: "題と本文の誤字", entry: { id: q } });
    expect(await getAppealableAction(h.db, bob, done.actionId)).toBeNull();
  });
});

describe("an appeal against a fix", () => {
  it("restores a previously saved costly revision as plain text during a write request", async () => {
    const q = await lockedQuestion({ title: "Original", body: "Original text." });
    const done = await fixEntry(h.db, JA_MOD, { entryId: q, sourceHash: await hashOf(q), title: "Corrected", body: "Corrected text.", note: "Correction" });
    if (!done.ok) throw new Error("fix failed");
    const source = SLOW_MARKDOWN;
    const fixture = markdownFixture();
    await h.db.update(entryRevisions).set({ body: source }).where(eq(entryRevisions.id, done.revisionId));
    const appeal = await createAppeal(h.db, author, done.actionId, "Restore original");
    if (!appeal.ok) throw new Error("appeal failed");
    await setMarkdownExecutorForTests(fixture.executor({ cpuMs: 250 }));
    try {
      expect(await withMarkdownScope("write", reviewer, () => decideAppeal(h.db, { id: reviewer, scope: OP.scope }, appeal.id, { decision: "overturned", note: "Restore" }))).toMatchObject({ ok: true, reversed: true });
      const restored = await row(q);
      expect(restored.body).toBe(source);
      expect(restored.html).toBe(`<pre class="whitespace-pre-wrap">${source}</pre>`);
    } finally { await setMarkdownExecutorForTests(createMarkdownExecutor({ cpuMs: 1000 })); fixture.remove(); }
  });
  it("overturned: the text before the fix comes back (a new revision keeps the fixed text), unfix_entry is recorded by the reviewer, the lock stays, the author is told", async () => {
    const q = await lockedQuestion({ title: "元の題", body: "元の本文です。" });
    const done = await fixEntry(h.db, JA_MOD, { entryId: q, sourceHash: await hashOf(q), title: "直した題", body: "直した本文です。", note: "直した" }, { now: t(50) });
    if (!done.ok) throw new Error("fix failed");
    const lockedAt = (await row(q)).stanceLockedAt;
    const appeal = await createAppeal(h.db, author, done.actionId, "I did not want this changed", { now: t(51) });
    if (!appeal.ok) throw new Error("appeal failed");
    await h.db.delete(jobs);
    // The actor cannot review the appeal.
    expect(await decideAppeal(h.db, { id: jamod, scope: JA_MOD.scope }, appeal.id, { decision: "overturned", note: "x" })).toEqual({ ok: false, error: "own_action" });
    expect(await decideAppeal(h.db, { id: reviewer, scope: OP.scope }, appeal.id, { decision: "overturned", note: "the original was right" }, { now: t(52) })).toEqual({ ok: true, status: "overturned", reversed: true });
    const after = await row(q);
    expect(after).toMatchObject({ title: "元の題", body: "元の本文です。", editedAt: t(52) });
    expect(after.html).toContain("元の本文です");
    expect(after.stanceLockedAt).toEqual(lockedAt);
    // Revisions: the version immediately before correction (original) and the current version before restoration (corrected).
    expect((await revisions(q)).map((r) => [r.title, r.body, r.editorId])).toEqual([["元の題", "元の本文です。", jamod], ["直した題", "直した本文です。", reviewer]]);
    const actions = await actionsOf(q);
    expect(actions.map((a) => [a.action, a.actorId, a.reason, a.note])).toEqual([["fix_entry", jamod, "other", "直した"], ["unfix_entry", reviewer, "other", `Appeal #${appeal.id} overturned`]]);
    expect(actions[1].revisionId).toBe((await revisions(q))[1].id);
    // Requeue translation and embedding for the restored version. Notify the author of the appeal result without a new moderation notification.
    expect((await h.db.select().from(jobs)).filter((j) => j.kind === TRANSLATE_JOB).length).toBeGreaterThan(0);
    expect((await listNotifications(h.db, author)).items[0]).toMatchObject({ kind: "appeal_decided", appealStatus: "overturned", appealReversed: true });
    expect((await listPublicLog(h.db)).entries.slice(0, 2).map((e) => e.action)).toEqual(["unfix_entry", "fix_entry"]);
  });

  it("shows the text before the fix to the author and to the reviewer; a third party sees nothing; hide and delete have no before", async () => {
    const q = await lockedQuestion({ title: "元の題", body: "元の本文です。" });
    const done = await fixEntry(h.db, JA_MOD, { entryId: q, sourceHash: await hashOf(q), title: "直した題", body: "直した本文です。", note: "直した" }, { now: t(80) });
    if (!done.ok) throw new Error("fix failed");
    const appeal = await createAppeal(h.db, author, done.actionId, "I wrote it that way", { now: t(81) });
    if (!appeal.ok) throw new Error("appeal failed");
    // the author: the text before the fix, and the text now (the entry)
    const own = await getAppealableAction(h.db, author, done.actionId);
    expect(own?.before).toEqual({ title: "元の題", body: "元の本文です。" });
    expect(own?.entry).toMatchObject({ id: q, title: "直した題", body: "直した本文です。" });
    // a third party gets nothing (the existence of the action is not shown)
    expect(await getAppealableAction(h.db, bob, done.actionId)).toBeNull();
    expect(await getAppealableAction(h.db, ann, done.actionId)).toBeNull();
    // the reviewer's card carries the same text before; someone who cannot review gets no card
    const cards = (await listOpenAppeals(h.db, { id: reviewer, scope: OP.scope })).cards;
    const card = cards.find((c) => c.id === appeal.id);
    expect(card?.before).toEqual({ title: "元の題", body: "元の本文です。" });
    expect(card?.entry).toMatchObject({ title: "直した題", body: "直した本文です。" });
    expect((await listOpenAppeals(h.db, { id: bob, scope: { operator: false, langs: [] } })).cards).toEqual([]);
    // the pages carry it too
    const appealRoute = await import("~/routes/appeal");
    const page = (await (appealRoute.loader as (a: never) => unknown)(await h.signedArgs(h.request(`/appeal/${done.actionId}`, { as: "hana" }), { actionId: String(done.actionId) }))) as { before: unknown };
    expect(page.before).toEqual({ title: "元の題", body: "元の本文です。" });
    const modRoute = await import("~/routes/mod-appeals");
    const modPage = (await (modRoute.loader as (a: never) => unknown)(await h.signedArgs(h.request("/mod/appeals", { as: "enmod" })))) as { cards: Array<{ id: number; before: unknown }> };
    expect(modPage.cards.find((c) => c.id === appeal.id)?.before).toEqual({ title: "元の題", body: "元の本文です。" });
    // hide and delete: no before (neither on the author's side nor on the card)
    const hidden = await createReply(h.db, bob, q, { lang: "en", body: "A reply that gets hidden." }, { now: t(82) });
    const removed = await createReply(h.db, bob, q, { lang: "en", body: "A reply that gets deleted." }, { now: t(83) });
    if (!hidden.ok || !removed.ok) throw new Error("reply failed");
    const hide = await hideEntry(h.db, OP, { entryId: hidden.id, reason: "spam", note: "ad" }, { now: t(84) });
    const del = await deleteEntry(h.db, OP, { entryId: removed.id, reason: "spam", note: "ad" }, { now: t(85) });
    if (!hide.ok || !del.ok) throw new Error("action failed");
    const appealHide = await createAppeal(h.db, bob, hide.actionId, "not spam", { now: t(86) });
    const appealDel = await createAppeal(h.db, bob, del.actionId, "not spam", { now: t(87) });
    if (!appealHide.ok || !appealDel.ok) throw new Error("appeal failed");
    expect((await getAppealableAction(h.db, bob, hide.actionId))?.before).toBeNull();
    expect((await getAppealableAction(h.db, bob, del.actionId))?.before).toBeNull();
    const after = (await listOpenAppeals(h.db, { id: reviewer, scope: OP.scope })).cards;
    expect(after.find((c) => c.id === appealHide.id)).toMatchObject({ action: "hide", before: null });
    expect(after.find((c) => c.id === appealDel.id)).toMatchObject({ action: "delete", before: null });
  });

  it("does not turn back a fix that a later fix replaced (reversed: false), and upholding changes nothing", async () => {
    const q = await lockedQuestion({ title: "元の題", body: "元の本文です。" });
    const first = await fixEntry(h.db, JA_MOD, { entryId: q, sourceHash: await hashOf(q), title: "一回目の題", body: "元の本文です。", note: "一回目" }, { now: t(60) });
    const second = await fixEntry(h.db, OP, { entryId: q, sourceHash: await hashOf(q), title: "二回目の題", body: "元の本文です。", note: "二回目" }, { now: t(61) });
    if (!first.ok || !second.ok) throw new Error("fix failed");
    const a1 = await createAppeal(h.db, author, first.actionId, "no");
    const a2 = await createAppeal(h.db, author, second.actionId, "no");
    if (!a1.ok || !a2.ok) throw new Error("appeal failed");
    const rev = { id: reviewer, scope: OP.scope };
    expect(await decideAppeal(h.db, rev, a1.id, { decision: "overturned", note: "old one" }, { now: t(62) })).toEqual({ ok: true, status: "overturned", reversed: false });
    expect((await row(q)).title).toBe("二回目の題");
    // Upholding the action changes nothing.
    expect(await decideAppeal(h.db, rev, a2.id, { decision: "upheld", note: "it stands" }, { now: t(63) })).toEqual({ ok: true, status: "upheld", reversed: false });
    expect((await row(q)).title).toBe("二回目の題");
    expect((await actionsOf(q)).map((a) => a.action)).toEqual(["fix_entry", "fix_entry"]);
    const a3 = await createAppeal(h.db, author, second.actionId, "again");
    expect(a3).toEqual({ ok: false, error: "duplicate" });
  });

  it("a chain of fixes A then B: B can be overturned and then A (after B is put back, the text is A's again); each puts back what that fix replaced", async () => {
    const q = await lockedQuestion({ title: "元の題", body: "元の本文です。" });
    const a = await fixEntry(h.db, JA_MOD, { entryId: q, sourceHash: await hashOf(q), title: "Aの題", body: "Aの本文です。", note: "A" }, { now: t(100) });
    const b = await fixEntry(h.db, OP, { entryId: q, sourceHash: await hashOf(q), title: "Bの題", body: "Bの本文です。", note: "B" }, { now: t(101) });
    if (!a.ok || !b.ok) throw new Error("fix failed");
    const appealA = await createAppeal(h.db, author, a.actionId, "A is wrong", { now: t(102) });
    const appealB = await createAppeal(h.db, author, b.actionId, "B is wrong", { now: t(103) });
    if (!appealA.ok || !appealB.ok) throw new Error("appeal failed");
    const rev = { id: reviewer, scope: OP.scope };
    // B first: the latest fix goes back to A's text
    expect(await decideAppeal(h.db, rev, appealB.id, { decision: "overturned", note: "B was wrong" }, { now: t(104) })).toEqual({ ok: true, status: "overturned", reversed: true });
    expect(await row(q)).toMatchObject({ title: "Aの題", body: "Aの本文です。" });
    // then A: the text is A's again (what A produced), so A's earlier text comes back, although an unfix_entry now follows A in the record
    expect(await decideAppeal(h.db, rev, appealA.id, { decision: "overturned", note: "A was wrong" }, { now: t(105) })).toEqual({ ok: true, status: "overturned", reversed: true });
    expect(await row(q)).toMatchObject({ title: "元の題", body: "元の本文です。", editedAt: t(105) });
    // history: the text before each fix, then the text that each put-back replaced
    expect((await revisions(q)).map((r) => [r.title, r.editorId])).toEqual([["元の題", jamod], ["Aの題", operator], ["Bの題", reviewer], ["Aの題", reviewer]]);
    const actions = await actionsOf(q);
    expect(actions.map((x) => [x.action, x.actorId])).toEqual([["fix_entry", jamod], ["fix_entry", operator], ["unfix_entry", reviewer], ["unfix_entry", reviewer]]);
    expect(actions[3].revisionId).toBe((await revisions(q))[3].id);
    expect((await listNotifications(h.db, author)).items.slice(0, 2).map((n) => [n.kind, n.appealStatus, n.appealReversed])).toEqual([["appeal_decided", "overturned", true], ["appeal_decided", "overturned", true]]);
  });

  it("A cannot be put back while B's text stands: reversed is false, recorded, shown to the reviewer and in the appellant's notification, and the text and the record are left alone", async () => {
    const q = await lockedQuestion({ title: "元の題", body: "元の本文です。" });
    const a = await fixEntry(h.db, JA_MOD, { entryId: q, sourceHash: await hashOf(q), title: "Aの題", body: "元の本文です。", note: "A" }, { now: t(110) });
    const b = await fixEntry(h.db, OP, { entryId: q, sourceHash: await hashOf(q), title: "Bの題", body: "元の本文です。", note: "B" }, { now: t(111) });
    if (!a.ok || !b.ok) throw new Error("fix failed");
    const appealA = await createAppeal(h.db, author, a.actionId, "A is wrong", { now: t(112) });
    if (!appealA.ok) throw new Error("appeal failed");
    const before = await row(q);
    const revisionsBefore = await revisions(q);
    expect(await decideAppeal(h.db, { id: reviewer, scope: OP.scope }, appealA.id, { decision: "overturned", note: "A was wrong" }, { now: t(113) })).toEqual({ ok: true, status: "overturned", reversed: false });
    expect(await row(q)).toEqual(before);
    expect(await revisions(q)).toEqual(revisionsBefore);
    expect((await actionsOf(q)).map((x) => x.action)).toEqual(["fix_entry", "fix_entry"]);
    // recorded on the appeal, shown to the appellant (the page and the notification) and to the reviewer (the redirect of the review page)
    expect((await getAppealableAction(h.db, author, a.actionId))?.appeal).toMatchObject({ status: "overturned", reversed: false });
    expect((await listNotifications(h.db, author)).items[0]).toMatchObject({ kind: "appeal_decided", appealStatus: "overturned", appealReversed: false });
    const modRoute = await import("~/routes/mod-appeals");
    const second = await createAppeal(h.db, author, b.actionId, "B is wrong", { now: t(114) });
    if (!second.ok) throw new Error("appeal failed");
    const decided = await h.outcome(async () => (modRoute.action as (a: never) => unknown)(await h.signedArgs(h.request("/mod/appeals", { as: "enmod", form: { appealId: String(second.id), intent: "overturn", note: "B was wrong" } }))));
    expect(decided).toMatchObject({ status: 302, location: "/mod/appeals?done=overturned" });
    // B's put-back works (it is the newest), and puts back what B replaced: A's text (A itself stays unreversed)
    expect(await row(q)).toMatchObject({ title: "Aの題" });
  });

  it("the same for a longer chain: only a fix whose own text still stands is put back (A, B, C: B is not put back while C stands; C is)", async () => {
    const q = await lockedQuestion({ title: "元の題", body: "元の本文です。" });
    const a = await fixEntry(h.db, JA_MOD, { entryId: q, sourceHash: await hashOf(q), title: "Aの題", body: "元の本文です。", note: "A" }, { now: t(120) });
    const b = await fixEntry(h.db, OP, { entryId: q, sourceHash: await hashOf(q), title: "Bの題", body: "元の本文です。", note: "B" }, { now: t(121) });
    const c = await fixEntry(h.db, JA_MOD, { entryId: q, sourceHash: await hashOf(q), title: "Cの題", body: "元の本文です。", note: "C" }, { now: t(122) });
    if (!a.ok || !b.ok || !c.ok) throw new Error("fix failed");
    const [appealB, appealC] = await Promise.all([createAppeal(h.db, author, b.actionId, "x", { now: t(123) }), createAppeal(h.db, author, c.actionId, "x", { now: t(124) })]);
    if (!appealB.ok || !appealC.ok) throw new Error("appeal failed");
    const rev = { id: reviewer, scope: OP.scope };
    expect(await decideAppeal(h.db, rev, appealB.id, { decision: "overturned", note: "n" }, { now: t(125) })).toMatchObject({ ok: true, reversed: false });
    expect((await row(q)).title).toBe("Cの題");
    expect(await decideAppeal(h.db, rev, appealC.id, { decision: "overturned", note: "n" }, { now: t(126) })).toMatchObject({ ok: true, reversed: true });
    expect((await row(q)).title).toBe("Bの題");
  });

  it("puts the earlier text back on a question that was deleted in the meantime, without rebuilding what the deletion removed", async () => {
    const q = await lockedQuestion({ title: "元の題", body: "元の本文です。" });
    const done = await fixEntry(h.db, JA_MOD, { entryId: q, sourceHash: await hashOf(q), title: "直した題", body: "直した本文です。", note: "直した" }, { now: t(70) });
    if (!done.ok) throw new Error("fix failed");
    await softDeleteEntry(h.db, q, { now: t(71) });
    const appeal = await createAppeal(h.db, author, done.actionId, "x");
    if (!appeal.ok) throw new Error("appeal failed");
    await h.db.delete(jobs);
    expect(await decideAppeal(h.db, { id: reviewer, scope: OP.scope }, appeal.id, { decision: "overturned", note: "n" }, { now: t(72) })).toMatchObject({ ok: true, reversed: true });
    expect(await row(q)).toMatchObject({ title: "元の題", body: "元の本文です。" });
    // Do not recreate derived data removed by deletion, such as sentence segments and jobs; recreate them on restoration.
    expect(await h.db.select().from(segments).where(eq(segments.entryId, q))).toEqual([]);
    expect((await h.db.select().from(jobs)).filter((j) => j.kind === TRANSLATE_JOB || j.kind === EMBED_JOB)).toEqual([]);
  });
});

describe("who sees that a question is locked", () => {
  it("the author and those who can fix it (a moderator of its language, an operator); nobody else, and never the time", async () => {
    const q = await lockedQuestion();
    const stanceTimeIso = (await row(q)).stanceLockedAt!.toISOString();
    const seen = async (who: string, email: string | null) => {
      const thread = await getThread(h.db, q, { viewer: email ? await getViewer(h.db, { id: who, email }) : undefined });
      return thread!.topic.stanceLocked;
    };
    expect(await seen(author, "hana@example.com")).toBe(true);
    expect(await seen(jamod, "jamod@example.com")).toBe(true);
    expect(await seen(enmod, "enmod@example.com")).toBe(false);
    expect(await seen(bob, "bob@example.com")).toBe(false);
    expect(await seen(ann, "ann@example.com")).toBe(false);
    expect(await seen("", null)).toBe(false);
    // UI: eligible correctors receive canFix, the locked-question entry point; the author receives locked. Others receive neither. No data includes the timestamp.
    const topicRoute = await import("~/routes/topic");
    type Page = { question: { locked: boolean; canFix: boolean } };
    const load = async (as: string) => (await (topicRoute.loader as (a: never) => unknown)(await h.signedArgs(h.request(`/t/${q}`, { as }), { id: String(q) }))) as Page;
    const pages = { hana: await load("hana"), jamod: await load("jamod"), enmod: await load("enmod"), bob: await load("bob") };
    expect(pages.hana.question).toMatchObject({ locked: true, canFix: false });
    expect(pages.jamod.question).toMatchObject({ locked: false, canFix: true });
    expect(pages.enmod.question).toMatchObject({ locked: false, canFix: false });
    expect(pages.bob.question).toMatchObject({ locked: false, canFix: false });
    for (const page of Object.values(pages)) expect(JSON.stringify(page)).not.toContain(stanceTimeIso.slice(0, 19));
    // Form: the assigned moderator can submit with an explanation and return to the question page; a missing explanation returns 400.
    const editRoute = await import("~/routes/topic-edit");
    const send = (form: Record<string, string>) => h.outcome(async () => (editRoute.action as (a: never) => unknown)(await h.signedArgs(h.request(`/t/${q}/edit`, { as: "jamod", form }), { id: String(q) })));
    // the form carries the base: the loader hands the moderator the hash of the text the form was opened on (and the author's locked page none)
    const editLoad = async (as: string) => (await (editRoute.loader as (a: never) => unknown)(await h.signedArgs(h.request(`/t/${q}/edit`, { as }), { id: String(q) }))) as { sourceHash: string | null; fix: boolean; locked: boolean };
    const opened = await editLoad("jamod");
    expect(opened).toMatchObject({ fix: true, sourceHash: (await row(q)).sourceHash });
    expect(await editLoad("hana")).toMatchObject({ locked: true, sourceHash: null });
    expect((await send({ title: "画面から直した題", body: "画面から直した本文。", sourceHash: opened.sourceHash! })).status).toBe(400);
    expect(await send({ title: "画面から直した題", body: "画面から直した本文。", note: "画面で直した", sourceHash: opened.sourceHash! })).toMatchObject({ status: 302, location: `/t/${q}` });
    expect(await row(q)).toMatchObject({ title: "画面から直した題", body: "画面から直した本文。" });
    expect((await actionsOf(q)).at(-1)).toMatchObject({ action: "fix_entry", note: "画面で直した", actorId: jamod });
    // the same form again (opened before the fix above): stale. 409, nothing is written, and no input is echoed back (the page shows the current text)
    const stale = await send({ title: "古い画面から直した題", body: "古い画面から直した本文。", note: "古い画面で直した", sourceHash: opened.sourceHash! });
    expect(stale).toMatchObject({ status: 409 });
    expect((stale.value as { data: Record<string, unknown> }).data).toEqual({ error: "invalid_state", fix: true, values: undefined });
    expect(await row(q)).toMatchObject({ title: "画面から直した題", body: "画面から直した本文。" });
    // An ordinary member receives 403.
    const asBob = await h.outcome(async () => (editRoute.action as (a: never) => unknown)(await h.signedArgs(h.request(`/t/${q}/edit`, { as: "bob", form: { title: "x", body: "y", note: "n", sourceHash: opened.sourceHash! } }), { id: String(q) })));
    expect(asBob.status).toBe(403);
    expect((await h.db.select().from(entries).where(and(eq(entries.id, q))))[0].title).toBe("画面から直した題");
  });
});
