import { quietLogger as quiet } from "./helpers/logger";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "~/lib/db/client.server";
import { entries, jobs, moderationActions, notifications, reports, translations } from "~/lib/db/schema";
import { createReply, createTopic, editEntry, getThread, listTopics, softDeleteEntry } from "~/lib/entries.server";
import { createTranslationHandlers } from "~/lib/jobs/translation-jobs.server";
import { runDueJobs } from "~/lib/jobs/queue.server";
import { createFakeEngine } from "~/lib/llm/engines/fake.server";
import { createReport, dismissReports, hideEntry, listReportCards, unhideEntry, type Actor } from "~/lib/moderation.server";
import { grantModerator, getViewer, type ModScope } from "~/lib/roles.server";
import { createTranslationReport } from "~/lib/translation-reports.server";
import { requeueTranslations } from "~/lib/translations-requeue.server";
import { setVote } from "~/lib/votes.server";
import { addMember, createTestDb } from "./helpers/db";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";

// Reports and actions: hide/unhide/dismiss, scope, and hidden-content visibility rules.

const JA_MOD: ModScope = { operator: false, langs: ["ja"] };
const EN_MOD: ModScope = { operator: false, langs: ["en"] };
const OPERATOR: ModScope = { operator: true, langs: [] };
const actor = (id: string, scope: ModScope): Actor => ({ id, scope });

async function setup() {
  const db = await createTestDb();
  await addMember(db, "author", "hana", { readLangs: ["ja", "en"] });
  await addMember(db, "other", "taro", { readLangs: ["ja", "en"] });
  await addMember(db, "jamod", "moriko", { readLangs: ["ja"] });
  await addMember(db, "enmod", "mary", { readLangs: ["en"] });
  await addMember(db, "op", "opal", { readLangs: ["ja", "en"] });
  const ja = await createTopic(db, "author", { lang: "ja", title: "日本語の話題", body: "本文です。" });
  const en = await createTopic(db, "author", { lang: "en", title: "An English topic", body: "Body." });
  if (!ja.ok || !en.ok) throw new Error("topic failed");
  const reply = await createReply(db, "other", ja.id, { lang: "ja", body: "返信です。" });
  if (!reply.ok) throw new Error("reply failed");
  return { db, ja: ja.id, en: en.id, reply: reply.id };
}

const reportRows = (db: Db, entryId: number) => db.select().from(reports).where(eq(reports.entryId, entryId));
const actionRows = (db: Db) => db.select().from(moderationActions).orderBy(moderationActions.id);

describe("reports", () => {
  it("records a report with a reason and a note; one reporter reports one post once", async () => {
    const { db, ja, en } = await setup();
    const first = await createReport(db, "other", { entryId: ja, reason: "spam", note: "  looks like an advertisement  " });
    expect(first.ok).toBe(true);
    expect(await reportRows(db, ja)).toMatchObject([{ reporterId: "other", reason: "spam", note: "looks like an advertisement", status: "open", handledBy: null }]);
    // The same person cannot report the same post twice, even with a different reason.
    expect(await createReport(db, "other", { entryId: ja, reason: "harassment" })).toEqual({ ok: false, error: "duplicate" });
    expect(await reportRows(db, ja)).toHaveLength(1);
    // Another person may report the same post, and the same person may report another post.
    expect((await createReport(db, "jamod", { entryId: ja, reason: "other" })).ok).toBe(true);
    expect((await createReport(db, "other", { entryId: en, reason: "spam" })).ok).toBe(true);
  });

  it("refuses a report on your own post, on a deleted post, on a hidden post, and on a post in a deleted topic", async () => {
    const { db, ja, en, reply } = await setup();
    expect(await createReport(db, "author", { entryId: ja, reason: "spam" })).toEqual({ ok: false, error: "own_entry" });
    expect(await createReport(db, "other", { entryId: 424242, reason: "spam" })).toEqual({ ok: false, error: "not_found" });
    await db.update(entries).set({ deletedAt: new Date() }).where(eq(entries.id, en));
    expect(await createReport(db, "other", { entryId: en, reason: "spam" })).toEqual({ ok: false, error: "not_found" });
    await db.update(entries).set({ hiddenAt: new Date() }).where(eq(entries.id, reply));
    expect(await createReport(db, "author", { entryId: reply, reason: "spam" })).toEqual({ ok: false, error: "not_found" });
    await db.update(entries).set({ hiddenAt: null }).where(eq(entries.id, reply));
    await db.update(entries).set({ deletedAt: new Date() }).where(eq(entries.id, ja));
    expect(await createReport(db, "author", { entryId: reply, reason: "spam" })).toEqual({ ok: false, error: "not_found" });
    expect(await db.select().from(reports)).toEqual([]);
  });

  it("checks the reason and the length of the note", async () => {
    const { db, ja } = await setup();
    for (const reason of ["", "bad", undefined, 1, "SPAM"]) expect(await createReport(db, "other", { entryId: ja, reason })).toEqual({ ok: false, error: "invalid_reason" });
    expect(await createReport(db, "other", { entryId: ja, reason: "spam", note: "x".repeat(1001) })).toEqual({ ok: false, error: "invalid_note" });
    expect(await createReport(db, "other", { entryId: ja, reason: "spam", note: "a\u0000b" })).toEqual({ ok: false, error: "invalid_note" });
    expect((await createReport(db, "other", { entryId: ja, reason: "spam", note: "x".repeat(1000) })).ok).toBe(true);
  });
});

describe("the scope of a moderator", () => {
  it("a moderator of ja acts on Japanese posts but not on English ones; an operator acts on all", async () => {
    const { db, ja, en } = await setup();
    const input = { reason: "spam", note: "spam" };
    expect(await hideEntry(db, actor("jamod", JA_MOD), { entryId: en, ...input })).toEqual({ ok: false, error: "forbidden" });
    expect(await unhideEntry(db, actor("jamod", JA_MOD), { entryId: en, ...input })).toEqual({ ok: false, error: "forbidden" });
    expect(await dismissReports(db, actor("jamod", JA_MOD), { entryId: en, ...input })).toEqual({ ok: false, error: "forbidden" });
    expect((await db.select().from(entries).where(eq(entries.id, en)))[0].hiddenAt).toBeNull();
    expect((await hideEntry(db, actor("jamod", JA_MOD), { entryId: ja, ...input })).ok).toBe(true);
    // An English moderator cannot handle Japanese posts; an operator can handle both.
    expect(await unhideEntry(db, actor("enmod", EN_MOD), { entryId: ja, ...input })).toEqual({ ok: false, error: "forbidden" });
    expect((await hideEntry(db, actor("op", OPERATOR), { entryId: en, ...input })).ok).toBe(true);
    expect((await unhideEntry(db, actor("op", OPERATOR), { entryId: ja, ...input })).ok).toBe(true);
    // Someone without a moderation assignment cannot act.
    expect(await hideEntry(db, actor("other", { operator: false, langs: [] }), { entryId: ja, ...input })).toEqual({ ok: false, error: "forbidden" });
  });

  it("nobody, not even an operator, acts on their own post", async () => {
    const { db, ja } = await setup();
    await addMember(db, "moderator-author", "mona", { readLangs: ["ja"] });
    const mine = await createTopic(db, "moderator-author", { lang: "ja", title: "t", body: "b" });
    if (!mine.ok) throw new Error("topic failed");
    for (const who of [actor("moderator-author", JA_MOD), actor("moderator-author", OPERATOR)]) {
      expect(await hideEntry(db, who, { entryId: mine.id, reason: "spam", note: "n" })).toEqual({ ok: false, error: "own_entry" });
      expect(await dismissReports(db, who, { entryId: mine.id, reason: "spam" })).toEqual({ ok: false, error: "own_entry" });
    }
    expect((await db.select().from(moderationActions))).toEqual([]);
    expect((await hideEntry(db, actor("moderator-author", JA_MOD), { entryId: ja, reason: "spam", note: "n" })).ok).toBe(true);
  });
});

describe("hide, unhide and dismiss", () => {
  it("hide records the action, hides the post, and resolves every open report on it with who handled it", async () => {
    const { db, ja, en } = await setup();
    await createReport(db, "other", { entryId: ja, reason: "spam" });
    await createReport(db, "jamod", { entryId: ja, reason: "harassment" });
    await createReport(db, "other", { entryId: en, reason: "spam" });
    const now = new Date("2026-10-02T03:04:05Z");
    const res = await hideEntry(db, actor("jamod", JA_MOD), { entryId: ja, reason: "spam", note: "  advertisement  " }, { now });
    if (!res.ok) throw new Error("hide failed");
    const [row] = await db.select().from(entries).where(eq(entries.id, ja));
    expect(row).toMatchObject({ hiddenAt: now, moderatedAt: now, moderationActionId: res.actionId, deletedAt: null });
    expect(await actionRows(db)).toMatchObject([{ id: res.actionId, action: "hide", targetEntryId: ja, targetUserId: null, reason: "spam", note: "advertisement", actorId: "jamod", createdAt: now }]);
    expect(await reportRows(db, ja)).toMatchObject([
      { status: "resolved", handledBy: "jamod", handledAt: now },
      { status: "resolved", handledBy: "jamod", handledAt: now },
    ]);
    // Reports on other posts remain unchanged.
    expect(await reportRows(db, en)).toMatchObject([{ status: "open", handledBy: null }]);
  });

  it("hide needs an explanation and valid input, and cannot hide twice or a deleted post", async () => {
    const { db, ja, reply } = await setup();
    const a = actor("jamod", JA_MOD);
    expect(await hideEntry(db, a, { entryId: ja, reason: "spam", note: "  " })).toEqual({ ok: false, error: "note_required" });
    expect(await hideEntry(db, a, { entryId: ja, reason: "nope", note: "n" })).toEqual({ ok: false, error: "invalid_reason" });
    expect(await hideEntry(db, a, { entryId: ja, reason: "spam", note: "x".repeat(501) })).toEqual({ ok: false, error: "invalid_note" });
    expect(await hideEntry(db, a, { entryId: 424242, reason: "spam", note: "n" })).toEqual({ ok: false, error: "not_found" });
    expect((await hideEntry(db, a, { entryId: ja, reason: "spam", note: "n" })).ok).toBe(true);
    expect(await hideEntry(db, a, { entryId: ja, reason: "spam", note: "n" })).toEqual({ ok: false, error: "invalid_state" });
    await db.update(entries).set({ deletedAt: new Date() }).where(eq(entries.id, reply));
    expect(await hideEntry(db, a, { entryId: reply, reason: "spam", note: "n" })).toEqual({ ok: false, error: "not_found" });
    expect(await actionRows(db)).toHaveLength(1);
  });

  it("unhide shows the post again and queues its translations; it needs a hidden post", async () => {
    const { db, ja } = await setup();
    const a = actor("jamod", JA_MOD);
    expect(await unhideEntry(db, a, { entryId: ja, reason: "other" })).toEqual({ ok: false, error: "invalid_state" });
    await hideEntry(db, a, { entryId: ja, reason: "spam", note: "n" });
    // Simulate the worker completing the queued translation job without work while the post is hidden.
    await db.delete(jobs);
    const res = await unhideEntry(db, a, { entryId: ja, reason: "other", note: "mistake" });
    if (!res.ok) throw new Error("unhide failed");
    expect((await db.select().from(entries).where(eq(entries.id, ja)))[0]).toMatchObject({ hiddenAt: null, moderationActionId: res.actionId });
    expect((await db.select().from(jobs).where(eq(jobs.kind, "translate_entry"))).length).toBe(8);
    expect((await actionRows(db)).map((r) => r.action)).toEqual(["hide", "unhide"]);
  });

  it("dismiss closes all open reports on the post without touching it; nothing to dismiss is refused", async () => {
    const { db, ja } = await setup();
    const a = actor("jamod", JA_MOD);
    expect(await dismissReports(db, a, { entryId: ja, reason: "other" })).toEqual({ ok: false, error: "invalid_state" });
    await createReport(db, "other", { entryId: ja, reason: "spam" });
    await createReport(db, "enmod", { entryId: ja, reason: "other" });
    const res = await dismissReports(db, a, { entryId: ja, reason: "other", note: "fine" });
    if (!res.ok) throw new Error("dismiss failed");
    expect(await reportRows(db, ja)).toMatchObject([{ status: "dismissed", handledBy: "jamod" }, { status: "dismissed", handledBy: "jamod" }]);
    expect((await db.select().from(entries).where(eq(entries.id, ja)))[0].hiddenAt).toBeNull();
    expect((await actionRows(db)).map((r) => r.action)).toEqual(["dismiss_report"]);
  });
});

describe("who may show a hidden post again", () => {
  it("a moderator cannot undo an operator's hide (an infohazard hide stays until an operator lifts it), but can undo another moderator's; an operator can undo any", async () => {
    const saved = process.env.OPERATOR_EMAILS;
    process.env.OPERATOR_EMAILS = "op@example.com";
    try {
      const { db, ja, en } = await setup();
      await addMember(db, "jamod2", "mori2", { readLangs: ["ja"] });
      const jaMod = actor("jamod", JA_MOD);
      const jaMod2 = actor("jamod2", JA_MOD);
      const op = actor("op", OPERATOR);
      // A moderator cannot unhide a post hidden by an operator.
      expect((await hideEntry(db, op, { entryId: ja, reason: "infohazard", note: "operator's hide" })).ok).toBe(true);
      expect(await unhideEntry(db, jaMod, { entryId: ja, reason: "other" })).toEqual({ ok: false, error: "forbidden" });
      expect((await db.select().from(entries).where(eq(entries.id, ja)))[0].hiddenAt).not.toBeNull();
      expect((await unhideEntry(db, op, { entryId: ja, reason: "other" })).ok).toBe(true);
      // Another moderator may unhide a post hidden by a moderator.
      expect((await hideEntry(db, jaMod, { entryId: ja, reason: "spam", note: "moderator's hide" })).ok).toBe(true);
      expect((await unhideEntry(db, jaMod2, { entryId: ja, reason: "other" })).ok).toBe(true);
      // An operator hides it again afterward; the latest hide action belongs to the operator.
      expect((await hideEntry(db, op, { entryId: ja, reason: "infohazard", note: "again" })).ok).toBe(true);
      expect(await unhideEntry(db, jaMod, { entryId: ja, reason: "other" })).toEqual({ ok: false, error: "forbidden" });
      expect(en).toBeDefined();
    } finally {
      if (saved === undefined) delete process.env.OPERATOR_EMAILS;
      else process.env.OPERATOR_EMAILS = saved;
    }
  });
});

describe("the report queue (/mod)", () => {
  it("lists open reports for the moderator's languages only, grouped by post, without the reporter", async () => {
    const { db, ja, en } = await setup();
    await createReport(db, "other", { entryId: ja, reason: "spam", note: "first" }, { now: new Date("2026-10-01T00:00:00Z") });
    await createReport(db, "enmod", { entryId: ja, reason: "other" }, { now: new Date("2026-10-01T01:00:00Z") });
    await createReport(db, "other", { entryId: en, reason: "infohazard" }, { now: new Date("2026-09-30T00:00:00Z") });
    const jaQueue = await listReportCards(db, JA_MOD);
    expect(jaQueue.cards.map((c) => [c.entryId, c.reports.map((r) => r.reason)])).toEqual([[ja, ["spam", "other"]]]);
    expect(JSON.stringify(jaQueue)).not.toMatch(/reporter|"other"[^,]*taro/);
    expect(Object.keys(jaQueue.cards[0].reports[0]).sort()).toEqual(["aiAssessment", "aiPriority", "automaticallyResolved", "createdAt", "id", "note", "reason"]);
    expect(jaQueue.cards[0].reports[0].automaticallyResolved).toBe(false);
    expect((await listReportCards(db, EN_MOD)).cards.map((c) => c.entryId)).toEqual([en]);
    // Operators see all reports, ordered by the oldest initial report.
    expect((await listReportCards(db, OPERATOR)).cards.map((c) => c.entryId)).toEqual([en, ja]);
    expect((await listReportCards(db, { operator: false, langs: [] })).cards).toEqual([]);
    // After an action, the report leaves the pending list and appears in the handled list.
    await hideEntry(db, actor("jamod", JA_MOD), { entryId: ja, reason: "spam", note: "n" });
    expect((await listReportCards(db, JA_MOD)).cards).toEqual([]);
    expect((await listReportCards(db, JA_MOD, { handled: true })).cards.map((c) => [c.entryId, c.hidden])).toEqual([[ja, true]]);
  });

  it("leaves out reports on the viewer's own posts (they cannot act on them, and a note can reveal the reporter) and on posts in a deleted topic", async () => {
    const { db, ja, reply } = await setup();
    await addMember(db, "modauthor", "mona", { readLangs: ["ja"] });
    const mine = await createTopic(db, "modauthor", { lang: "ja", title: "moderator's own", body: "b" });
    if (!mine.ok) throw new Error("topic failed");
    await createReport(db, "other", { entryId: mine.id, reason: "harassment", note: "I am other and I say so" });
    await createReport(db, "other", { entryId: ja, reason: "spam" });
    const ids = async (scope: ModScope, viewerId?: string) => (await listReportCards(db, scope, { viewerId })).cards.map((c) => c.entryId).sort();
    expect(await ids(JA_MOD)).toEqual([ja, mine.id].sort());
    expect(await ids(JA_MOD, "modauthor")).toEqual([ja]);
    expect(await ids(OPERATOR, "op")).toEqual([ja, mine.id].sort());
    // Omit reports on replies in deleted topics because the thread cannot be opened.
    await createReport(db, "jamod", { entryId: reply, reason: "other" });
    expect(await ids(JA_MOD, "modauthor")).toEqual([ja, reply].sort());
    await softDeleteEntry(db, ja);
    expect(await ids(JA_MOD, "modauthor")).toEqual([]);
  });

  it("pages the queue", async () => {
    const { db } = await setup();
    for (let i = 0; i < 5; i++) {
      const t = await createTopic(db, "author", { lang: "ja", title: `t${i}`, body: "b" });
      if (!t.ok) throw new Error("topic failed");
      await createReport(db, "other", { entryId: t.id, reason: "spam" }, { now: new Date(Date.UTC(2026, 9, 1, i)) });
    }
    const p1 = await listReportCards(db, JA_MOD, { limit: 2 });
    const p2 = await listReportCards(db, JA_MOD, { limit: 2, page: 2 });
    const p3 = await listReportCards(db, JA_MOD, { limit: 2, page: 3 });
    expect([p1.cards.length, p1.hasNext, p2.cards.length, p2.hasNext, p3.cards.length, p3.hasNext]).toEqual([2, true, 2, true, 1, false]);
    expect(new Set([...p1.cards, ...p2.cards, ...p3.cards].map((c) => c.entryId)).size).toBe(5);
  });
});

describe("what each viewer sees of a hidden post", () => {
  it("the author, a moderator of its language and an operator see the content with the hidden state; everyone else sees a redacted place", async () => {
    const { db, ja, reply } = await setup();
    await hideEntry(db, actor("jamod", JA_MOD), { entryId: ja, reason: "spam", note: "n" });
    await hideEntry(db, actor("jamod", JA_MOD), { entryId: reply, reason: "spam", note: "n" });
    const view = async (userId: string, scope: ModScope, email = `${userId}@example.com`) => {
      const viewer = await getViewer(db, { id: userId, email });
      return getThread(db, ja, { viewer: { userId, scope: scope.operator ? scope : viewer.scope.langs.length ? viewer.scope : scope } });
    };
    await grantModerator(db, "op", "jamod", "ja");
    const asAuthor = (await view("author", { operator: false, langs: [] }))!;
    expect(asAuthor.topic).toMatchObject({ visibility: "hidden", title: "日本語の話題", body: "本文です。", authorHandle: "hana" });
    // The reply author can see their own reply content, but not the topic.
    const asReplier = (await view("other", { operator: false, langs: [] }))!;
    expect(asReplier.topic).toMatchObject({ visibility: "hidden-redacted", title: null, body: "", html: "", authorId: "", authorHandle: "" });
    expect(asReplier.replies[0]).toMatchObject({ visibility: "hidden", body: "返信です。" });
    const asJaMod = (await view("jamod", JA_MOD))!;
    expect(asJaMod.topic.visibility).toBe("hidden");
    expect(asJaMod.replies[0].visibility).toBe("hidden");
    const asOperator = (await view("op", OPERATOR))!;
    expect(asOperator.topic.visibility).toBe("hidden");
    // Do not expose content to moderators of another language, ordinary members, or absent viewers.
    for (const thread of [(await view("enmod", EN_MOD))!, (await view("taro2", { operator: false, langs: [] }))!, (await getThread(db, ja))!]) {
      expect(thread.topic).toMatchObject({ visibility: "hidden-redacted", title: null, body: "", html: "", authorId: "", authorHandle: "", sourceHash: null });
      // Someone who is not the reply author cannot see its content either ("hidden" is the state that exposes content).
      expect(thread.replies[0].visibility).toBe("hidden-redacted");
      expect(thread.replies[0]).toMatchObject({ body: "", html: "", authorId: "", authorHandle: "" });
    }
    const other = (await getThread(db, ja, { viewer: { userId: "enmod", scope: EN_MOD } }))!;
    expect(other.replies[0]).toMatchObject({ visibility: "hidden-redacted", body: "", authorHandle: "" });
    // After unhiding, everyone can see the content.
    await unhideEntry(db, actor("jamod", JA_MOD), { entryId: ja, reason: "other" });
    expect((await getThread(db, ja))!.topic).toMatchObject({ visibility: "visible", title: "日本語の話題" });
  });

  it("a hidden topic leaves the lists for others and stays for the author, the moderator of its language and operators; the feed of other posts is unaffected", async () => {
    const { db, ja, en } = await setup();
    await hideEntry(db, actor("jamod", JA_MOD), { entryId: ja, reason: "spam", note: "n" });
    const ids = async (viewer?: { userId: string; scope: ModScope }) => (await listTopics(db, { kind: "all" }, { viewer })).topics.map((t) => t.id).sort();
    expect(await ids()).toEqual([en]);
    expect(await ids({ userId: "other", scope: { operator: false, langs: [] } })).toEqual([en]);
    expect(await ids({ userId: "enmod", scope: EN_MOD })).toEqual([en]);
    expect(await ids({ userId: "author", scope: { operator: false, langs: [] } })).toEqual([ja, en].sort());
    expect(await ids({ userId: "jamod", scope: JA_MOD })).toEqual([ja, en].sort());
    expect(await ids({ userId: "op", scope: OPERATOR })).toEqual([ja, en].sort());
    const hidden = (await listTopics(db, { kind: "all" }, { viewer: { userId: "op", scope: OPERATOR } })).topics.find((t) => t.id === ja);
    expect(hidden?.hidden).toBe(true);
    // The language-scoped list behaves the same way.
    expect((await listTopics(db, { kind: "langs", langs: ["ja"] })).topics).toEqual([]);
    expect((await listTopics(db, { kind: "langs", langs: ["ja"] }, { viewer: { userId: "jamod", scope: JA_MOD } })).topics).toHaveLength(1);
  });
});

describe("a hidden post is left out of votes, translations and their context", () => {
  it("takes no new votes (an existing vote can still be withdrawn)", async () => {
    const { db, ja } = await setup();
    expect((await setVote(db, "other", ja, true)).ok).toBe(true);
    await hideEntry(db, actor("jamod", JA_MOD), { entryId: ja, reason: "spam", note: "n" });
    expect(await setVote(db, "enmod", ja, true)).toEqual({ ok: false, error: "not_found" });
    expect(await setVote(db, "other", ja, false)).toMatchObject({ ok: true, voted: false, changed: true });
    await unhideEntry(db, actor("jamod", JA_MOD), { entryId: ja, reason: "other" });
    expect((await setVote(db, "enmod", ja, true)).ok).toBe(true);
  });

  it("is not translated, and translating stops if it is hidden on the way; unhide queues it again", async () => {
    const db = await createTestDb();
    await addMember(db, "author", "hana");
    await addMember(db, "jamod", "moriko");
    const t = await createTopic(db, "author", { lang: "ja", title: "題", body: "本文。" });
    if (!t.ok) throw new Error("topic failed");
    const handlers = createTranslationHandlers({ llm: { engines: { primary: createFakeEngine(), secondary: null, judge: null }, env: {} } });
    await hideEntry(db, actor("jamod", JA_MOD), { entryId: t.id, reason: "spam", note: "n" });
    // Already queued jobs finish without doing anything or creating translations.
    await runDueJobs(db, handlers, { now: new Date(), logger: quiet, limit: 100 });
    expect(await db.select().from(translations)).toEqual([]);
    // Editing while hidden does not enqueue jobs.
    await db.delete(jobs);
    const edit = await editEntry(db, "author", t.id, { title: "新しい題", body: "新しい本文。" });
    expect(edit).toMatchObject({ ok: true, changed: true });
    expect(await db.select().from(jobs)).toEqual([]);
    // The requeue tool also skips hidden posts.
    expect(await requeueTranslations(db)).toMatchObject({ entries: 0, translate: 0 });
    await unhideEntry(db, actor("jamod", JA_MOD), { entryId: t.id, reason: "other" });
    expect((await db.select().from(jobs).where(eq(jobs.kind, "translate_entry"))).length).toBe(8);
    await runDueJobs(db, handlers, { now: new Date(), logger: quiet, limit: 100 });
    expect((await db.select().from(translations).where(eq(translations.entryId, t.id))).length).toBeGreaterThan(0);
  });

  it("does not save a translation that was already running when the post was hidden", async () => {
    const db = await createTestDb();
    await addMember(db, "author", "hana");
    await addMember(db, "jamod", "moriko");
    const t = await createTopic(db, "author", { lang: "ja", title: "題", body: "本文。" });
    if (!t.ok) throw new Error("topic failed");
    const { currentSourceHash } = await import("~/lib/translations.server");
    expect(await currentSourceHash(db, t.id)).not.toBeNull();
    const engine = createFakeEngine();
    let hiddenOnTheWay = false;
    const hidingEngine = {
      ...engine,
      translate: async (req: Parameters<typeof engine.translate>[0]) => {
        // The post becomes hidden during translation.
        if (!hiddenOnTheWay) {
          hiddenOnTheWay = true;
          await hideEntry(db, actor("jamod", JA_MOD), { entryId: t.id, reason: "spam", note: "n" });
        }
        return engine.translate(req);
      },
    };
    const handlers = createTranslationHandlers({ llm: { engines: { primary: hidingEngine, secondary: null, judge: null }, env: {} } });
    await runDueJobs(db, handlers, { now: new Date(), logger: quiet, limit: 100 });
    expect(hiddenOnTheWay).toBe(true);
    expect(await db.select().from(translations).where(eq(translations.entryId, t.id))).toEqual([]);
    expect(await currentSourceHash(db, t.id)).toBeNull();
  });

  it("does not show a hidden post to a moderator of another language even when a translation into that language exists", async () => {
    const { db, ja } = await setup();
    const [row] = await db.select({ hash: entries.sourceHash }).from(entries).where(eq(entries.id, ja));
    await db.insert(translations).values({ entryId: ja, field: "body", lang: "en", kind: "primary", text: "English translation", engine: "fake", model: "m", sourceHash: row.hash });
    await hideEntry(db, actor("jamod", JA_MOD), { entryId: ja, reason: "spam", note: "n" });
    // An English moderator is not responsible for a Japanese source, even with an English translation, and can neither see its content nor act on it.
    const enViewer = { userId: "enmod", scope: EN_MOD };
    expect((await getThread(db, ja, { viewer: enViewer }))!.topic).toMatchObject({ visibility: "hidden-redacted", body: "" });
    expect(await unhideEntry(db, actor("enmod", EN_MOD), { entryId: ja, reason: "other" })).toEqual({ ok: false, error: "forbidden" });
    expect((await listTopics(db, { kind: "all" }, { viewer: enViewer })).topics.map((t) => t.id)).not.toContain(ja);
  });

  it("is not used as context for translating its replies", async () => {
    const db = await createTestDb();
    await addMember(db, "author", "hana");
    await addMember(db, "other", "taro");
    await addMember(db, "jamod", "moriko");
    const t = await createTopic(db, "author", { lang: "ja", title: "秘密の題", body: "秘密の本文。" });
    if (!t.ok) throw new Error("topic failed");
    const r = await createReply(db, "other", t.id, { lang: "ja", body: "返信。" });
    if (!r.ok) throw new Error("reply failed");
    const seen: Array<{ title?: string; context?: string }> = [];
    const engine = createFakeEngine();
    const recording = { ...engine, translate: async (req: Parameters<typeof engine.translate>[0]) => (seen.push({ title: req.title, context: req.context }), engine.translate(req)) };
    const handlers = createTranslationHandlers({ llm: { engines: { primary: recording, secondary: null, judge: null }, env: {} } });
    await runDueJobs(db, handlers, { now: new Date(), logger: quiet, limit: 100 });
    expect(seen.every((s) => s.context === undefined && s.title === undefined)).toBe(true);
    // The same isolation applies after hiding the topic.
    await db.delete(translations).where(eq(translations.entryId, r.id));
    await hideEntry(db, actor("jamod", JA_MOD), { entryId: t.id, reason: "spam", note: "n" });
    seen.length = 0;
    await editEntry(db, "other", r.id, { body: "返信を直した。" });
    await runDueJobs(db, handlers, { now: new Date(), logger: quiet, limit: 100 });
    const ofReply = seen.filter((s) => s.context !== undefined || s.title !== undefined);
    expect(seen.length).toBeGreaterThan(0);
    expect(JSON.stringify(seen)).not.toContain("秘密");
    expect(ofReply).toEqual([]);
  });

  it("takes no mistranslation reports, and the operator's list leaves out reports on hidden posts", async () => {
    const { db, ja } = await setup();
    expect((await createTranslationReport(db, "other", { entryId: ja, lang: "en", field: "body", excerpt: "x", note: "" })).ok).toBe(true);
    await hideEntry(db, actor("jamod", JA_MOD), { entryId: ja, reason: "spam", note: "n" });
    expect(await createTranslationReport(db, "enmod", { entryId: ja, lang: "fr", field: "body", excerpt: "x", note: "" })).toEqual({ ok: false, error: "not_found" });
    const { listOpenReports } = await import("~/lib/translation-reports.server");
    expect(await listOpenReports(db)).toEqual([]);
    await unhideEntry(db, actor("jamod", JA_MOD), { entryId: ja, reason: "other" });
    expect(await listOpenReports(db)).toHaveLength(1);
  });
});

describe("the routes: /mod and the thread page", () => {
  let h: RouteHarness;
  let topicId: number;
  let enTopicId: number;
  const saved = process.env.OPERATOR_EMAILS;
  beforeAll(async () => {
    process.env.OPERATOR_EMAILS = "opal@example.com";
    h = await setupRouteHarness();
    await h.signIn("hana", { homeArea: "ja", readLangs: ["ja", "en"] });
    await h.signIn("taro", { homeArea: "ja", readLangs: ["ja", "en"] });
    await h.signIn("moriko", { homeArea: "ja", readLangs: ["ja"] });
    await h.signIn("mary", { homeArea: "en", readLangs: ["en"] });
    await h.signIn("opal", { homeArea: "ja", readLangs: ["ja", "en"] });
    await grantModerator(h.db, h.ids.opal, h.ids.moriko, "ja");
    await grantModerator(h.db, h.ids.opal, h.ids.mary, "en");
    const a = await createTopic(h.db, h.ids.hana, { lang: "ja", title: "日本語の話題", body: "本文です。" });
    const b = await createTopic(h.db, h.ids.hana, { lang: "en", title: "English topic", body: "Body." });
    if (!a.ok || !b.ok) throw new Error("topic failed");
    topicId = a.id;
    enTopicId = b.id;
  });
  afterAll(() => {
    h.restore();
    if (saved === undefined) delete process.env.OPERATOR_EMAILS;
    else process.env.OPERATOR_EMAILS = saved;
  });

  const thread = async (as: string, id = topicId) => {
    const { loader } = await import("~/routes/topic");
    return (await loader(await h.signedArgs(h.request(`/t/${id}`, { as }), { id: String(id) }))) as unknown as {
      topic: { placeholder: string | null; title?: string; hidden?: boolean; canModerate?: boolean; html?: string };
    };
  };

  it("files a report from the thread page (rate-limited, once per post, not on your own post)", async () => {
    const { action } = await import("~/routes/topic");
    const post = (as: string, form: Record<string, string>, id = topicId) => h.outcome(async () => action(await h.signedArgs(h.request(`/t/${id}`, { as, form: { intent: "flag", ...form } }), { id: String(id) })));
    const ok = await post("taro", { entryId: String(topicId), reason: "spam", note: "ad" });
    expect(ok).toMatchObject({ status: 200, value: { init: null } });
    expect((ok.value as { data: unknown }).data).toMatchObject({ intent: "flag", error: null, reported: true });
    expect((await post("taro", { entryId: String(topicId), reason: "spam" })).status).toBe(409);
    expect((await post("hana", { entryId: String(topicId), reason: "spam" })).status).toBe(400);
    // Reject entries outside this thread.
    expect((await post("taro", { entryId: String(enTopicId), reason: "spam" })).status).toBe(404);
    expect((await post("taro", { entryId: "x", reason: "spam" })).status).toBe(404);
    expect((await post("taro", { entryId: String(topicId), reason: "bad" })).status).toBe(400);
  });

  it("limits reports to 30 an hour per member", async () => {
    const { action } = await import("~/routes/topic");
    const { hitMemberLimit } = await import("~/lib/rate-limit.server");
    for (let i = 0; i < 30; i++) expect((await hitMemberLimit(h.db, "report", h.ids.mary)).allowed).toBe(true);
    const res = await h.outcome(async () => action(await h.signedArgs(h.request(`/t/${topicId}`, { as: "mary", form: { intent: "flag", entryId: String(topicId), reason: "spam" } }), { id: String(topicId) })));
    expect(res.status).toBe(429);
    expect(await h.db.select().from(reports).where(eq(reports.reporterId, h.ids.mary))).toEqual([]);
  });

  it("/mod is for moderators and operators; it lists the reports of the language and nothing else", async () => {
    const { loader } = await import("~/routes/mod");
    const call = (as?: string) => h.outcome(async () => (await loader(await h.signedArgs(h.request("/mod", { as })))));
    expect(await call()).toMatchObject({ status: 302, location: "/login?next=%2Fmod" });
    expect(await call("taro")).toMatchObject({ status: 404 });
    const review = await h.outcome(() => loader(h.args(h.request("/mod?tab=review", { as: "taro" }))));
    expect(review).toMatchObject({ status: 404 });
    expect(JSON.stringify(review.value ?? null)).not.toMatch(/cards|assessment|reviewEntries/);
    await createReport(h.db, h.ids.taro, { entryId: enTopicId, reason: "harassment" });
    const cards = async (as: string) => ((await call(as)).value as { cards: Array<{ entryId: number }> }).cards.map((c) => c.entryId);
    expect(await cards("moriko")).toEqual([topicId]);
    expect(await cards("mary")).toEqual([enTopicId]);
    expect((await cards("opal")).sort()).toEqual([topicId, enTopicId].sort());
  });

  it("the moderator hides the post from /mod; the thread shows the placeholder to members and the content to those who may see it", async () => {
    const { action } = await import("~/routes/mod");
    const post = (as: string, form: Record<string, string>) => h.outcome(async () => action(await h.signedArgs(h.request("/mod", { as, form }))));
    expect(await post("taro", { intent: "hide", entryId: String(topicId), reason: "spam", note: "n" })).toMatchObject({ status: 404 });
    expect(await post("mary", { intent: "hide", entryId: String(topicId), reason: "spam", note: "n" })).toMatchObject({ status: 403 });
    expect(await post("moriko", { intent: "hide", entryId: String(topicId), reason: "spam", note: "" })).toMatchObject({ status: 400 });
    expect(await post("moriko", { intent: "explode", entryId: String(topicId), reason: "spam", note: "n" })).toMatchObject({ status: 400 });
    expect(await post("moriko", { intent: "hide", entryId: String(topicId), reason: "spam", note: "advertisement", returnTo: "https://evil.example/" })).toMatchObject({ status: 302, location: "/mod" });
    // Return destinations must be paths within the same site.
    expect((await h.db.select().from(entries).where(eq(entries.id, topicId)))[0].hiddenAt).not.toBeNull();
    expect((await thread("taro")).topic).toEqual({ id: topicId, placeholder: "hidden" });
    expect((await thread("mary")).topic).toEqual({ id: topicId, placeholder: "hidden" });
    for (const as of ["hana", "moriko", "opal"]) expect((await thread(as)).topic).toMatchObject({ placeholder: null, hidden: true, title: "日本語の話題" });
    expect((await thread("moriko")).topic.canModerate).toBe(true);
    expect((await thread("hana")).topic.canModerate).toBe(false);
    // Lists expose it to the author and assigned moderator, but not other members.
    const { loader: latest } = await import("~/routes/latest");
    const titles = async (as: string) => ((await latest(await h.signedArgs(h.request("/latest", { as })))) as unknown as { topics: Array<{ id: number }> }).topics.map((t) => t.id);
    expect(await titles("taro")).toEqual([enTopicId]);
    expect((await titles("moriko")).sort()).toEqual([topicId, enTopicId].sort());
    expect((await titles("hana")).sort()).toEqual([topicId, enTopicId].sort());
    // Only the post author may vote (the voting route).
    const { action: voteAction } = await import("~/routes/vote");
    expect(await h.outcome(async () => voteAction(await h.signedArgs(h.request("/vote", { as: "moriko", form: { entryId: String(topicId), on: "1" } }))))).toMatchObject({ status: 404 });
  });

  it("a moderator does not see reports on their own posts in /mod, while the operator does", async () => {
    const { loader } = await import("~/routes/mod");
    const own = await createTopic(h.db, h.ids.moriko, { lang: "ja", title: "moriko's own topic", body: "b" });
    if (!own.ok) throw new Error("topic failed");
    await createReport(h.db, h.ids.taro, { entryId: own.id, reason: "harassment", note: "a note that may reveal the reporter" });
    const cards = async (as: string) => ((await h.outcome(async () => (await loader(await h.signedArgs(h.request("/mod", { as })))))).value as { cards: Array<{ entryId: number }> }).cards.map((c) => c.entryId);
    expect(await cards("moriko")).not.toContain(own.id);
    expect(await cards("opal")).toContain(own.id);
  });

  it("the moderator shows it again from the handled tab", async () => {
    const { action, loader } = await import("~/routes/mod");
    const handled = (await h.outcome(async () => (await loader(await h.signedArgs(h.request("/mod?tab=handled", { as: "moriko" })))))).value as { cards: Array<{ entryId: number; hidden: boolean }> };
    expect(handled.cards.map((c) => [c.entryId, c.hidden])).toEqual([[topicId, true]]);
    expect(await h.outcome(async () => action(await h.signedArgs(h.request("/mod", { as: "moriko", form: { intent: "unhide", entryId: String(topicId), reason: "other", returnTo: `/t/${topicId}#p-${topicId}` } }))))).toMatchObject({ status: 302, location: `/t/${topicId}#p-${topicId}` });
    expect((await thread("taro")).topic).toMatchObject({ placeholder: null, hidden: false });
  });
});

describe("a hidden topic's title is not shown in the drafts of a member replying to it", () => {
  it("leaves the thread title out of the draft and the list of drafts", async () => {
    const { db, ja } = await setup();
    const { createDraft, getDraft, listDrafts } = await import("~/lib/drafts.server");
    const draft = await createDraft(db, "other", { kind: "reply", threadId: ja, lang: "ja", body: "下書き" });
    if (!draft.ok) throw new Error("draft failed");
    expect((await getDraft(db, "other", draft.id))?.threadTitle).toBe("日本語の話題");
    expect((await listDrafts(db, "other"))[0].threadTitle).toBe("日本語の話題");
    await hideEntry(db, actor("jamod", JA_MOD), { entryId: ja, reason: "spam", note: "n" });
    expect((await getDraft(db, "other", draft.id))?.threadTitle).toBeNull();
    expect((await listDrafts(db, "other"))[0].threadTitle).toBeNull();
  });
});

describe("no replies to hidden content", () => {
  it("createReply refuses a hidden topic (thread_not_found) and a hidden parent (parent_not_in_thread), with no reply, job or notification made; shown again, it works", async () => {
    const { db, ja, reply } = await setup();
    const jobsBefore = (await db.select().from(jobs)).length;
    const notesBefore = (await db.select().from(notifications)).length;
    await hideEntry(db, actor("jamod", JA_MOD), { entryId: reply, reason: "spam", note: "n" });
    expect(await createReply(db, "author", ja, { lang: "ja", body: "x", parentId: reply })).toEqual({ ok: false, error: "parent_not_in_thread" });
    // A hidden reply does not prevent replies to the topic.
    expect((await createReply(db, "author", ja, { lang: "ja", body: "topic still open" })).ok).toBe(true);
    await hideEntry(db, actor("jamod", JA_MOD), { entryId: ja, reason: "spam", note: "n" });
    const jobsMid = (await db.select().from(jobs)).length;
    const notesMid = (await db.select().from(notifications)).length;
    expect(await createReply(db, "other", ja, { lang: "ja", body: "x" })).toEqual({ ok: false, error: "thread_not_found" });
    // The topic author, assigned moderator, and operator all behave the same way.
    for (const who of ["author", "jamod", "op"]) expect(await createReply(db, who, ja, { lang: "ja", body: "x" }), who).toEqual({ ok: false, error: "thread_not_found" });
    expect((await db.select().from(jobs)).length).toBe(jobsMid);
    expect((await db.select().from(notifications)).length).toBe(notesMid);
    expect(jobsBefore).toBeLessThanOrEqual(jobsMid);
    expect(notesBefore).toBeLessThanOrEqual(notesMid);
    await unhideEntry(db, actor("jamod", JA_MOD), { entryId: ja, reason: "other" });
    expect((await createReply(db, "other", ja, { lang: "ja", body: "open again" })).ok).toBe(true);
  });

  it("drafts: a reply draft cannot be made for a hidden topic or parent, and publishing an existing one is refused and keeps the draft", async () => {
    const { db, ja, reply } = await setup();
    const { createDraft, publishDraft } = await import("~/lib/drafts.server");
    const toTopic = await createDraft(db, "other", { kind: "reply", threadId: ja, lang: "ja", body: "下書き" });
    const toParent = await createDraft(db, "other", { kind: "reply", threadId: ja, parentId: reply, lang: "ja", body: "下書き2" });
    if (!toTopic.ok || !toParent.ok) throw new Error("draft failed");
    await hideEntry(db, actor("jamod", JA_MOD), { entryId: reply, reason: "spam", note: "n" });
    expect(await createDraft(db, "other", { kind: "reply", threadId: ja, parentId: reply, lang: "ja" })).toEqual({ ok: false, error: "parent_not_in_thread" });
    expect(await publishDraft(db, "other", toParent.id)).toEqual({ ok: false, error: "parent_not_in_thread" });
    await hideEntry(db, actor("jamod", JA_MOD), { entryId: ja, reason: "spam", note: "n" });
    expect(await createDraft(db, "other", { kind: "reply", threadId: ja, lang: "ja" })).toEqual({ ok: false, error: "thread_not_found" });
    expect(await publishDraft(db, "other", toTopic.id)).toEqual({ ok: false, error: "thread_not_found" });
    const { drafts } = await import("~/lib/db/schema");
    expect((await db.select().from(drafts)).map((d) => d.id).sort()).toEqual([toTopic.id, toParent.id].sort());
  });

  it("POST /api/drafts answers 400 reply_to_not_found for a hidden topic, a hidden reply or a reply in a hidden topic, as for one that does not exist", async () => {
    const { db, ja, reply } = await setup();
    const { createApiToken } = await import("~/lib/tokens.server");
    const { handleDraftCreate } = await import("~/lib/api/drafts-api.server");
    const token = await createApiToken(db, "other", { name: "d", kind: "draft" });
    if (!token.ok) throw new Error("token failed");
    const post = async (replyTo: string) =>
      handleDraftCreate(
        new Request("http://localhost:5173/api/drafts", {
          method: "POST",
          headers: { authorization: `Bearer ${token.token}`, "content-type": "text/markdown" },
          body: `---\ntype: reply\nreply_to: ${replyTo}\n---\nhello`,
        }),
        { db },
      );
    expect((await post(`p-${ja}`)).status).toBe(201);
    expect((await post(`c-${reply}`)).status).toBe(201);
    await hideEntry(db, actor("jamod", JA_MOD), { entryId: reply, reason: "spam", note: "n" });
    let res = await post(`c-${reply}`);
    expect([res.status, (await res.json()).error]).toEqual([400, "reply_to_not_found"]);
    res = await post("c-424242");
    expect([res.status, (await res.json()).error]).toEqual([400, "reply_to_not_found"]);
    await hideEntry(db, actor("jamod", JA_MOD), { entryId: ja, reason: "spam", note: "n" });
    for (const target of [`p-${ja}`, `c-${reply}`]) {
      res = await post(target);
      expect([res.status, (await res.json()).error], target).toEqual([400, "reply_to_not_found"]);
    }
  });

  it("the thread page takes no reply to a hidden topic: the action refuses it and the page offers no form", async () => {
    const h = await setupRouteHarness();
    try {
      await h.signIn("hana", { homeArea: "ja" });
      await h.signIn("taro", { homeArea: "ja" });
      await h.signIn("moriko", { homeArea: "ja" });
      const { grantModerator } = await import("~/lib/roles.server");
      await h.signIn("opal2", { homeArea: "ja" });
      await grantModerator(h.db, h.ids.hana, h.ids.moriko, "ja");
      const t = await createTopic(h.db, h.ids.hana, { lang: "ja", title: "話題", body: "本文" });
      if (!t.ok) throw new Error("topic failed");
      await hideEntry(h.db, actor(h.ids.moriko, JA_MOD), { entryId: t.id, reason: "spam", note: "n" });
      const { action, loader } = await import("~/routes/topic");
      const params = { id: String(t.id) };
      const posted = await h.outcome(async () => action(await h.signedArgs(h.request(`/t/${t.id}`, { as: "taro", form: { body: "reply to hidden" } }), params)));
      expect(posted.status).toBe(400);
      expect((posted.value as { data: { error: string } }).data.error).toBe("thread_not_found");
      // Drafts cannot be saved either.
      const draft = await h.outcome(async () => action(await h.signedArgs(h.request(`/t/${t.id}`, { as: "taro", form: { body: "x", intent: "draft" } }), params)));
      expect(draft.status).toBe(400);
      expect(await h.db.select().from(entries).where(eq(entries.threadId, t.id))).toEqual([]);
      // UI: the assigned moderator can see the content, but there is no reply field because topic.hidden is true.
      const view = (await h.outcome(async () => (await loader(await h.signedArgs(h.request(`/t/${t.id}`, { as: "moriko" }), params))))).value as { topic: { placeholder: string | null; hidden?: boolean } };
      expect(view.topic).toMatchObject({ placeholder: null, hidden: true });
      const other = (await h.outcome(async () => (await loader(await h.signedArgs(h.request(`/t/${t.id}`, { as: "taro" }), params))))).value as { topic: { placeholder: string | null } };
      expect(other.topic.placeholder).toBe("hidden");
    } finally {
      h.restore();
    }
  });
});
