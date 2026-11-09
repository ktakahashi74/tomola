import { quietLogger as quiet } from "./helpers/logger";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handleDraftCreate, MAX_PENDING_API_DRAFTS } from "~/lib/api/drafts-api.server";
import { divergences, drafts, entries, jobs, moderationActions, reports, segments, translations, votes } from "~/lib/db/schema";
import { createDraft, publishDraft } from "~/lib/drafts.server";
import { createReply, createTopic, deleteOwnEntry, getThread, listTopics, softDeleteEntry } from "~/lib/entries.server";
import { createTranslationHandlers } from "~/lib/jobs/translation-jobs.server";
import { runDueJobs } from "~/lib/jobs/queue.server";
import { createFakeEngine } from "~/lib/llm/engines/fake.server";
import { createReport, deleteEntry, listPublicLog } from "~/lib/moderation.server";
import { createApiToken } from "~/lib/tokens.server";
import { currentSourceHash } from "~/lib/translations.server";
import { setVote } from "~/lib/votes.server";
import { grantModerator } from "~/lib/roles.server";
import { getMd, parseBlocks } from "./helpers/md";
import { addMember, createTestDb } from "./helpers/db";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";
import type { Db } from "~/lib/db/client.server";
import { sql } from "drizzle-orm";

// Author deletion and operator delete actions share softDeleteEntry; cleanup runs in the same transaction.

const OP = { operator: true, langs: [] };

async function setup() {
  const db = await createTestDb();
  await addMember(db, "author", "hana", { readLangs: ["ja", "en"] });
  await addMember(db, "other", "taro", { readLangs: ["ja", "en"] });
  await addMember(db, "op", "opal", { readLangs: ["ja"] });
  const topic = await createTopic(db, "author", { lang: "ja", title: "話題", body: "本文です。二文目です。" }, { now: new Date("2026-10-01T00:00:00Z") });
  if (!topic.ok) throw new Error("topic failed");
  const keep = await createReply(db, "other", topic.id, { lang: "ja", body: "残る返信。" }, { now: new Date("2026-10-01T00:05:00Z") });
  const mine = await createReply(db, "author", topic.id, { lang: "ja", body: "消す返信。二文。" }, { now: new Date("2026-10-01T00:10:00Z") });
  if (!keep.ok || !mine.ok) throw new Error("reply failed");
  return { db, topic: topic.id, keep: keep.id, mine: mine.id };
}

// Attach derived data, jobs, reports and votes to the post being deleted.
async function decorate(db: Db, entryId: number, otherEntryId: number) {
  const [row] = await db.select({ hash: entries.sourceHash }).from(entries).where(eq(entries.id, entryId));
  await db.insert(translations).values([
    { entryId, field: "body", lang: "en", kind: "primary", text: "T-primary", engine: "fake", model: "m", sourceHash: row.hash, html: "<p>cached</p>", htmlVersion: 1 },
    { entryId, field: "body", lang: "en", kind: "secondary", text: "T-secondary", engine: "fake", model: "m", sourceHash: row.hash },
    { entryId, field: "body", lang: "fr", kind: "human", text: "T-human-fr", sourceHash: row.hash },
    { entryId, field: "body", lang: "de", kind: "human", text: "T-human", sourceHash: row.hash },
    { entryId: otherEntryId, field: "body", lang: "en", kind: "primary", text: "keep-me", engine: "fake", model: "m", sourceHash: "x" },
  ]);
  await db.insert(divergences).values([
    { entryId, lang: "en", segmentIdx: 0, severity: "low", note: "n" },
    { entryId: otherEntryId, lang: "en", segmentIdx: 0, severity: "low", note: "keep" },
  ]);
  await db.update(entries).set({ html: "<p>cached body</p>", htmlVersion: 1 }).where(eq(entries.id, entryId));
}

describe("softDeleteEntry cleans up in the same transaction", () => {
  it("removes translations of every kind, segments, divergences and the cached html; keeps the votes and other posts' data", async () => {
    const { db, keep, mine } = await setup();
    await decorate(db, mine, keep);
    await setVote(db, "other", mine, true);
    expect((await db.select().from(segments).where(eq(segments.entryId, mine))).length).toBeGreaterThan(0);
    expect(await softDeleteEntry(db, mine)).toMatchObject({ ok: true });
    expect(await db.select().from(translations).where(eq(translations.entryId, mine))).toEqual([]);
    expect(await db.select().from(segments).where(eq(segments.entryId, mine))).toEqual([]);
    expect(await db.select().from(divergences).where(eq(divergences.entryId, mine))).toEqual([]);
    expect((await db.select().from(entries).where(eq(entries.id, mine)))[0]).toMatchObject({ html: null, htmlVersion: 0 });
    // Votes remain but are hidden. Other posts' translations and divergences remain unchanged.
    expect(await db.select().from(votes).where(eq(votes.entryId, mine))).toHaveLength(1);
    expect(await db.select().from(translations).where(eq(translations.entryId, keep))).toHaveLength(1);
    expect(await db.select().from(divergences).where(eq(divergences.entryId, keep))).toHaveLength(1);
    expect((await db.select().from(segments).where(eq(segments.entryId, keep))).length).toBeGreaterThan(0);
  });

  it("cancels the queued translation jobs of the post, leaves running jobs and other posts' jobs, and a running job does not save after the deletion", async () => {
    const { db, topic, keep, mine } = await setup();
    // Posting queued 8 jobs each for mine, keep and topic. Make one appear running.
    const of = (id: number) => db.select().from(jobs).where(and(eq(jobs.kind, "translate_entry"), sql`${jobs.payload}->>'entryId' = ${String(id)}`));
    expect((await of(mine)).length).toBe(8);
    const [running] = await of(mine);
    await db.update(jobs).set({ status: "running", lockedAt: new Date() }).where(eq(jobs.id, running.id));
    await db.insert(jobs).values({ kind: "measure_divergence", payload: { entryId: mine, lang: "en", sourceHash: "h" } });
    await softDeleteEntry(db, mine);
    expect((await of(mine)).map((j) => j.status)).toEqual(["running"]);
    expect(await db.select().from(jobs).where(and(eq(jobs.kind, "measure_divergence"), sql`${jobs.payload}->>'entryId' = ${String(mine)}`))).toEqual([]);
    expect((await of(keep)).length).toBe(8);
    expect((await of(topic)).length).toBe(8);
    // A job already running cannot save a translation after post deletion; translation saves are skipped when currentSourceHash is null.
    expect(await currentSourceHash(db, mine)).toBeNull();
    expect(await currentSourceHash(db, keep)).not.toBeNull();
    // Running remaining worker jobs creates nothing.
    const handlers = createTranslationHandlers({ llm: { engines: { primary: createFakeEngine(), secondary: null, judge: null }, env: {} } });
    await runDueJobs(db, handlers, { now: new Date(Date.now() + 1000), logger: quiet, limit: 500 });
    expect(await db.select().from(translations).where(eq(translations.entryId, mine))).toEqual([]);
  });

  it("closes the open reports on the post: dismissed without a handler for a self-deletion", async () => {
    const { db, mine } = await setup();
    await createReport(db, "other", { entryId: mine, reason: "spam" });
    await createReport(db, "op", { entryId: mine, reason: "other" });
    await db.update(reports).set({ status: "dismissed", handledBy: "op", handledAt: new Date("2026-10-01T00:00:00Z") }).where(eq(reports.reporterId, "op"));
    expect((await deleteOwnEntry(db, "author", mine, { now: new Date("2026-10-02T00:00:00Z") })).ok).toBe(true);
    const rows = await db.select().from(reports).where(eq(reports.entryId, mine)).orderBy(reports.id);
    expect(rows).toMatchObject([
      { status: "dismissed", handledBy: null, handledAt: new Date("2026-10-02T00:00:00Z") },
      // Already-closed reports remain unchanged.
      { status: "dismissed", handledBy: "op", handledAt: new Date("2026-10-01T00:00:00Z") },
    ]);
  });

  it("recomputes topic counters and omits a deleted reply without children while retaining its pagination slot", async () => {
    const { db, topic, keep, mine } = await setup();
    expect((await db.select().from(entries).where(eq(entries.id, topic)))[0]).toMatchObject({ replyCount: 2, lastActivityAt: new Date("2026-10-01T00:10:00Z") });
    const res = await deleteOwnEntry(db, "author", mine);
    expect(res).toEqual({ ok: true, kind: "reply", threadId: topic });
    expect((await db.select().from(entries).where(eq(entries.id, topic)))[0]).toMatchObject({ replyCount: 1, lastActivityAt: new Date("2026-10-01T00:05:00Z") });
    const thread = (await getThread(db, topic))!;
    expect(thread.replies.map((r) => [r.id, r.visibility])).toEqual([[keep, "visible"]]);
    expect(thread).toMatchObject({ replyCount: 1, replyTotal: 2 });
  });

  it("deleting a topic removes it from the lists and the thread (404)", async () => {
    const { db, topic } = await setup();
    expect((await deleteOwnEntry(db, "author", topic, { kind: "topic" }))).toEqual({ ok: true, kind: "topic", threadId: topic });
    expect((await listTopics(db)).topics).toEqual([]);
    expect(await getThread(db, topic)).toBeNull();
    expect(await createReply(db, "other", topic, { lang: "ja", body: "x" })).toEqual({ ok: false, error: "thread_not_found" });
  });

  it("only the author deletes, a post once, and the right kind", async () => {
    const { db, topic, mine } = await setup();
    expect(await deleteOwnEntry(db, "other", mine)).toEqual({ ok: false, error: "forbidden" });
    expect(await deleteOwnEntry(db, "author", mine, { kind: "topic" })).toEqual({ ok: false, error: "not_found" });
    expect(await deleteOwnEntry(db, "author", 424242)).toEqual({ ok: false, error: "not_found" });
    expect((await deleteOwnEntry(db, "author", mine)).ok).toBe(true);
    expect(await deleteOwnEntry(db, "author", mine)).toEqual({ ok: false, error: "not_found" });
    expect((await db.select().from(entries).where(eq(entries.id, topic)))[0].deletedAt).toBeNull();
  });
});

describe("the operator's delete action", () => {
  it("is for operators only, never on your own post, needs a note, records the action, resolves the reports and cleans up", async () => {
    const { db, keep, mine } = await setup();
    await decorate(db, keep, mine);
    await createReport(db, "author", { entryId: keep, reason: "spam" });
    const op = { id: "op", scope: OP };
    const input = { entryId: keep, reason: "spam", note: "advertisement" };
    await grantModerator(db, "op", "other", "ja");
    expect(await deleteEntry(db, { id: "other", scope: { operator: false, langs: ["ja"] } }, { ...input, entryId: mine })).toEqual({ ok: false, error: "forbidden" });
    expect(await deleteEntry(db, { id: "other", scope: OP }, input)).toEqual({ ok: false, error: "own_entry" });
    expect(await deleteEntry(db, op, { ...input, note: "" })).toEqual({ ok: false, error: "note_required" });
    expect(await deleteEntry(db, op, { ...input, entryId: 424242 })).toEqual({ ok: false, error: "not_found" });
    const now = new Date("2026-10-03T00:00:00Z");
    const res = await deleteEntry(db, op, input, { now });
    if (!res.ok) throw new Error("delete failed");
    expect((await db.select().from(entries).where(eq(entries.id, keep)))[0]).toMatchObject({ deletedAt: now, moderatedAt: now, moderationActionId: res.actionId, html: null });
    expect(await db.select().from(translations).where(eq(translations.entryId, keep))).toEqual([]);
    expect((await db.select().from(reports).where(eq(reports.entryId, keep)))[0]).toMatchObject({ status: "resolved", handledBy: "op", handledAt: now });
    expect((await db.select().from(moderationActions))[0]).toMatchObject({ action: "delete", targetEntryId: keep, reason: "spam", note: "advertisement", actorId: "op" });
    expect(await deleteEntry(db, op, input)).toEqual({ ok: false, error: "not_found" });
    // Public record includes only deletion type, reason, original language and date.
    expect((await listPublicLog(db)).entries).toEqual([{ action: "delete", reason: "spam", lang: "ja", date: "2026-10-03" }]);
  });
});

describe("the thread and the twin after a deletion", () => {
  let h: RouteHarness;
  let topic: number;
  let mine: number;
  let keep: number;
  const saved = process.env.OPERATOR_EMAILS;
  beforeAll(async () => {
    process.env.OPERATOR_EMAILS = "opal@example.com";
    h = await setupRouteHarness();
    await h.signIn("hana", { homeArea: "ja", readLangs: ["ja"] });
    await h.signIn("taro", { homeArea: "ja", readLangs: ["ja"] });
    await h.signIn("opal", { homeArea: "ja", readLangs: ["ja"] });
    const t = await createTopic(h.db, h.ids.hana, { lang: "ja", title: "話題", body: "本文" });
    if (!t.ok) throw new Error("topic failed");
    topic = t.id;
    const a = await createReply(h.db, h.ids.taro, topic, { lang: "ja", body: "SECRET-REPLY-BODY" });
    const b = await createReply(h.db, h.ids.hana, topic, { lang: "ja", body: "残る返信", parentId: a.ok ? a.id : undefined });
    if (!a.ok || !b.ok) throw new Error("reply failed");
    mine = a.id;
    keep = b.id;
  });
  afterAll(() => {
    h.restore();
    if (saved === undefined) delete process.env.OPERATOR_EMAILS;
    else process.env.OPERATOR_EMAILS = saved;
  });

  const post = async (as: string, form: Record<string, string>) => {
    const { action } = await import("~/routes/topic");
    return h.outcome(() => action(h.args(h.request(`/t/${topic}`, { as, form }), { id: String(topic) })));
  };

  it("the author deletes only after confirming, and only their own post; the thread shows 'Deleted post' and the twin a deleted: true block", async () => {
    expect((await post("taro", { intent: "delete", entryId: String(mine) })).status).toBe(400);
    expect((await post("hana", { intent: "delete", entryId: String(mine), confirm: "1" })).status).toBe(403);
    expect((await post("taro", { intent: "delete", entryId: "424242", confirm: "1" })).status).toBe(404);
    expect((await h.db.select().from(entries).where(eq(entries.id, mine)))[0].deletedAt).toBeNull();
    const res = await post("taro", { intent: "delete", entryId: String(mine), confirm: "1" });
    expect(res).toMatchObject({ status: 302, location: `/t/${topic}#c-${mine}` });
    const { loader } = await import("~/routes/topic");
    const asAuthor = (await h.outcome(async () => (await loader(h.args(h.request(`/t/${topic}`, { as: "taro" }), { id: String(topic) }))))).value as { replies: Array<{ id: number; placeholder: string | null }> };
    expect(asAuthor.replies.map((r) => [r.id, r.placeholder])).toEqual([[mine, "deleted"], [keep, null]]);
    expect(JSON.stringify(asAuthor)).not.toContain("SECRET-REPLY-BODY");
    const doc = await (await getMd(h, `/t/${topic}.md`, { as: "hana" })).text();
    expect(doc).not.toContain("SECRET-REPLY-BODY");
    expect(parseBlocks(doc).find((b) => b.fm.id === `c-${mine}`)!.fm).toMatchObject({ deleted: true });
  });

  it("an operator deletes from the thread panel only with the confirmation; a topic deleted is a 404", async () => {
    const { action } = await import("~/routes/mod");
    const form = { intent: "delete", entryId: String(keep), reason: "spam", note: "n" };
    expect((await h.outcome(() => action(h.args(h.request("/mod", { as: "opal", form }))))).status).toBe(400);
    expect((await h.db.select().from(entries).where(eq(entries.id, keep)))[0].deletedAt).toBeNull();
    expect(await h.outcome(() => action(h.args(h.request("/mod", { as: "opal", form: { ...form, confirm: "1", returnTo: `/t/${topic}` } }))))).toMatchObject({ status: 302, location: `/t/${topic}` });
    expect((await h.db.select().from(entries).where(eq(entries.id, keep)))[0].deletedAt).not.toBeNull();
    const del = await post("hana", { intent: "delete", entryId: String(topic), confirm: "1" });
    expect(del).toMatchObject({ status: 302, location: "/" });
    const { loader } = await import("~/routes/topic");
    expect((await h.outcome(async () => (await loader(h.args(h.request(`/t/${topic}`, { as: "taro" }), { id: String(topic) }))))).status).toBe(404);
    expect((await getMd(h, `/t/${topic}.md`, { as: "taro" })).status).toBe(404);
  });
});

describe("carry-overs: replying to a deleted post, the pending API draft cap, the votes index", () => {
  it("createReply refuses a deleted parent or topic, also when the draft was made before the deletion", async () => {
    const { db, topic, keep, mine } = await setup();
    const draft = await createDraft(db, "other", { kind: "reply", threadId: topic, parentId: mine, lang: "ja", body: "返信の下書き" });
    if (!draft.ok) throw new Error("draft failed");
    await softDeleteEntry(db, mine);
    expect(await createReply(db, "other", topic, { lang: "ja", body: "x", parentId: mine })).toEqual({ ok: false, error: "parent_not_in_thread" });
    // Publishing also rejects a deleted reply target and preserves the draft.
    expect(await publishDraft(db, "other", draft.id)).toEqual({ ok: false, error: "parent_not_in_thread" });
    expect(await db.select({ id: drafts.id }).from(drafts).where(eq(drafts.id, draft.id))).toHaveLength(1);
    // Draft creation rejects deleted reply targets too.
    expect(await createDraft(db, "other", { kind: "reply", threadId: topic, parentId: mine, lang: "ja" })).toEqual({ ok: false, error: "parent_not_in_thread" });
    // An undeleted reply target is accepted normally.
    expect((await createReply(db, "other", topic, { lang: "ja", body: "y", parentId: keep })).ok).toBe(true);
    await softDeleteEntry(db, topic);
    expect(await publishDraft(db, "other", draft.id)).toEqual({ ok: false, error: "thread_not_found" });
    expect((await db.select().from(entries).where(and(eq(entries.threadId, topic), inArray(entries.kind, ["reply"])))).filter((r) => r.parentId === mine)).toEqual([]);
  });

  it("the pending API draft cap is checked in the same transaction that inserts", async () => {
    const db = await createTestDb();
    await addMember(db, "u1", "hana");
    const make = () => createDraft(db, "u1", { kind: "topic", lang: "ja", title: "t", body: "b" }, { via: "api", maxPendingApiDrafts: 3 });
    const results = await Promise.all([make(), make(), make(), make(), make()]);
    expect(results.filter((r) => r.ok)).toHaveLength(3);
    expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, error: "too_many_pending_drafts" }, { ok: false, error: "too_many_pending_drafts" }]);
    // Drafts created through the UI are exempt from the limit.
    expect((await createDraft(db, "u1", { kind: "topic", lang: "ja", title: "t", body: "b" }, { via: "web", maxPendingApiDrafts: 3 })).ok).toBe(true);
    expect((await db.select().from(drafts)).length).toBe(4);
  });

  it("POST /api/drafts answers 429 too_many_pending_drafts at the cap", async () => {
    const db = await createTestDb();
    await addMember(db, "u1", "hana");
    const token = await createApiToken(db, "u1", { name: "d", kind: "draft" });
    if (!token.ok) throw new Error("token failed");
    await db.insert(drafts).values(Array.from({ length: MAX_PENDING_API_DRAFTS }, () => ({ authorId: "u1", kind: "topic", lang: "ja", title: "t", via: "api" })));
    const res = await handleDraftCreate(new Request("http://localhost:5173/api/drafts", { method: "POST", headers: { authorization: `Bearer ${token.token}`, "content-type": "text/markdown" }, body: "hello" }), { db });
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: "too_many_pending_drafts" });
  });

  it("has an index on votes(voter_id), and deleting an entry row removes its votes (no hard-delete path leaves a foreign key behind)", async () => {
    const { db } = await setup();
    const [raw] = await db.insert(entries).values({ kind: "topic", authorId: "other", lang: "ja", title: "raw", body: "raw" }).returning({ id: entries.id });
    const idx = (await db.execute(sql`select indexdef from pg_indexes where tablename = 'votes' and indexname = 'votes_voter_idx'`)) as unknown as { rows: Array<{ indexdef: string }> };
    expect(idx.rows).toHaveLength(1);
    expect(idx.rows[0].indexdef).toContain("(voter_id)");
    await setVote(db, "author", raw.id, true);
    expect(await db.select().from(votes)).toHaveLength(1);
    await db.delete(entries).where(eq(entries.id, raw.id));
    expect(await db.select().from(votes)).toEqual([]);
  });
});
