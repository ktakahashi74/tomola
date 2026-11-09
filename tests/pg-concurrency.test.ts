import { quietLogger as quiet } from "./helpers/logger";
import { and, count, eq, inArray, isNull, sql } from "drizzle-orm";
import type pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createAppeal, decideAppeal } from "~/lib/appeals.server";
import { closeDb, type Db } from "~/lib/db/client.server";
import { appeals, entries, entryEmbeddings, entryRevisions, follows, glossaryEntries, glossaryRevisions, invitations, jobs, moderationActions, notifications, notifiedMentions, profiles, rateLimits, stanceChanges, stances, translationReports, translations } from "~/lib/db/schema";
import { EMBEDDING_DIM } from "~/lib/db/schema";
import { createReply, createTopic, deleteOwnEntry, editEntry, renderTranslationHtml, softDeleteEntry } from "~/lib/entries.server";
import { importGlossaryRows, type GlossaryRowData } from "~/lib/glossary-io.server";
import { clearNeedsReviewBulk, createGlossaryEntry, deleteGlossaryEntry, needsReviewSummary, updateGlossaryEntry, type GlossaryActor } from "~/lib/glossary.server";
import { markFollowedThreadRead, setFollow } from "~/lib/follows.server";
import { createInvitation, markInvitationUsed } from "~/lib/invitations.server";
import { createEmbeddingHandlers } from "~/lib/jobs/embedding-jobs.server";
import { createNotificationHandlers } from "~/lib/jobs/notification-jobs.server";
import { enqueue, runDueJobs, STUCK_AFTER_MS, type JobHandlers } from "~/lib/jobs/queue.server";
import { createTranslationHandlers, entryStillCurrent } from "~/lib/jobs/translation-jobs.server";
import { loadChanges } from "~/lib/md/changes.server";
import { createMailer } from "~/lib/mail/mail.server";
import { createMemoryMailbox } from "~/lib/mail/transports.server";
import { createFakeEmbeddingEngine } from "~/lib/llm/engines/fake-embedding.server";
import { createFakeEngine } from "~/lib/llm/engines/fake.server";
import type { LlmOptions } from "~/lib/llm/index.server";
import { deleteEntry, excludeReactions, fixEntry, hideEntry, lockMember, suspendMember } from "~/lib/moderation.server";
import { changeHomeArea } from "~/lib/profiles.server";
import { hitRateLimit } from "~/lib/rate-limit.server";
import { rebuildRenderCache, saveRenderedTranslation } from "~/lib/render-cache.server";
import { resolveMentionTargets } from "~/lib/mentions.server";
import { RENDER_VERSION } from "~/lib/markdown.server";
import type { ModScope } from "~/lib/roles.server";
import { findSimilar } from "~/lib/search.server";
import { sourceHash } from "~/lib/source-hash.server";
import { entryEditVersion } from "~/lib/entry-edit-version.server";
import { deleteStanceRecord, setStance } from "~/lib/stances.server";
import { createTranslationReport, resolveReportWithHumanTranslation } from "~/lib/translation-reports.server";
import { SEND_NOTIFICATION_EMAIL_JOB } from "~/lib/notifications.server";
import { RETRANSLATE_REPORT_JOB } from "~/lib/translations.server";
import { addMember } from "./helpers/db";
import { expectPending, expectSettlesWithin, holdTx, waitForLockWait } from "./helpers/pg-concurrency";
import { createScratchDb, REAL_PG_URL, type ScratchDb } from "./helpers/pg-real";

// Real PostgreSQL concurrency tests with two connections; skip without TEST_DATABASE_URL. PGlite has only one connection and cannot verify lock waiting.
// Create races in a deterministic order rather than relying on timing (tests/helpers/pg-concurrency.ts): pause one transaction while it holds a lock, then verify the other
// is blocked waiting for that lock before releasing the first. Waiters acquire the lock in arrival order.
// Do not mix database now() with the JavaScript clock, fixed to 2026-09-30 in these tests; pass timestamps explicitly.

// The real messages (not the empty stubs): the follow tests read the text of the emails that the notification job sends.
vi.mock("~/paraglide/messages.js", async () => ({ m: (await import("./helpers/messages-json")).jsonMessages() }));

const OP: ModScope = { operator: true, langs: [] };
const op = (id: string) => ({ id, scope: OP });
// A time far beyond real time; queued jobs default run_at to the database's real clock.
const LATER = new Date("2031-01-01T00:00:00Z");

describe.skipIf(!REAL_PG_URL)("two connections on PostgreSQL (TEST_DATABASE_URL)", { tags: ["postgres"] }, () => {
  let scratch: ScratchDb;
  let admin: pg.Client;
  let seq = 0;

  beforeAll(async () => {
    scratch = await createScratchDb();
    admin = await scratch.admin();
  }, 120_000);
  afterAll(async () => {
    await scratch?.drop();
  }, 60_000);
  // Close each test's connections at its end. Leaked connections accumulate until file teardown; parallel workers in the all-PostgreSQL pnpm test:pg run can approach the limit of 100.
  afterEach(async () => {
    await scratch?.closeOpened();
  });

  // Topic T authored by a, a's reply R, and member b.
  async function world(db: Db) {
    const n = ++seq;
    const a = `a${n}`;
    const b = `b${n}`;
    await addMember(db, a, `ann${n}`, { readLangs: ["ja"] });
    await addMember(db, b, `bob${n}`, { readLangs: ["ja"] });
    // The operator performs actions; action records have a foreign key to a member.
    await addMember(db, `op${n}`, `opr${n}`, { readLangs: ["ja"] });
    const topic = await createTopic(db, a, { lang: "ja", title: `話題${n}`, body: "本文です。" });
    if (!topic.ok) throw new Error("topic failed");
    const reply = await createReply(db, a, topic.id, { lang: "ja", body: "返信です。" });
    if (!reply.ok) throw new Error("reply failed");
    return { a, b, topic: topic.id, reply: reply.id, n };
  }

  const topicRow = async (db: Db, id: number) => (await db.select({ replyCount: entries.replyCount }).from(entries).where(eq(entries.id, id)))[0];
  const liveReplies = async (db: Db, topic: number) => Number((await db.select({ c: count() }).from(entries).where(and(eq(entries.threadId, topic), eq(entries.kind, "reply"), isNull(entries.deletedAt))))[0].c);

  describe("a reply that is deleted while someone replies to it", () => {
    // Both operations lock the topic before the reply target. The first waiting
    // reply finishes before deletion, including its write to the parent's
    // irreversible edit-history latch.
    it.each([
      ["the author deletes it", "own"],
      ["the operator deletes it", "operator"],
    ] as const)("do not deadlock when %s", async (_name, who) => {
      const [dbBlock, dbReply, dbDelete] = await Promise.all([scratch.open("blocker"), scratch.open("reply"), scratch.open("delete")]);
      const w = await world(dbBlock);
      // Hold the topic row and make both operations wait.
      const blocker = holdTx(dbBlock, (tx) => tx.select().from(entries).where(eq(entries.id, w.topic)).for("no key update"));
      await blocker.ready;
      const replying = createReply(dbReply, w.b, w.topic, { lang: "ja", body: "返信への返信", parentId: w.reply });
      await waitForLockWait(admin, "reply");
      const deleting =
        who === "own"
          ? deleteOwnEntry(dbDelete, w.a, w.reply)
          : deleteEntry(dbDelete, op(`op${w.n}`), { entryId: w.reply, reason: "spam", note: "ad" });
      await waitForLockWait(admin, "delete");
      await blocker.commit();
      const [reply, deleted] = await expectSettlesWithin(Promise.all([replying, deleting]), 15_000, "the reply and the deletion");
      expect(reply.ok).toBe(true);
      expect(deleted.ok).toBe(true);
      // Recount the topic aggregate so it matches nondeleted replies: the one new reply whose parent was deleted.
      expect((await topicRow(dbBlock, w.topic)).replyCount).toBe(await liveReplies(dbBlock, w.topic));
      expect(await liveReplies(dbBlock, w.topic)).toBe(1);
    }, 60_000);
  });

  describe("restoring a deleted reply (an appeal that is overturned) while another reply is posted", () => {
    it.each([["the reply first"], ["the restoration first"]] as const)("keeps the topic's reply count right, %s", async (order) => {
      const [dbBlock, dbReply, dbDecide] = await Promise.all([scratch.open("blocker"), scratch.open("reply"), scratch.open("decide")]);
      const w = await world(dbBlock);
      await addMember(dbBlock, `reviewer${w.n}`, `rev${w.n}`);
      const deleted = await deleteEntry(dbBlock, op(`op${w.n}`), { entryId: w.reply, reason: "spam", note: "ad" });
      if (!deleted.ok) throw new Error("delete failed");
      const appeal = await createAppeal(dbBlock, w.a, deleted.actionId, "it was fine");
      if (!appeal.ok) throw new Error("appeal failed");
      expect((await topicRow(dbBlock, w.topic)).replyCount).toBe(0);

      const blocker = holdTx(dbBlock, (tx) => tx.select().from(entries).where(eq(entries.id, w.topic)).for("no key update"));
      await blocker.ready;
      const start = {
        reply: () => createReply(dbReply, w.b, w.topic, { lang: "ja", body: "もう1つの返信" }),
        restore: () => decideAppeal(dbDecide, { id: `reviewer${w.n}`, scope: OP }, appeal.id, { decision: "overturned", note: "restored" }),
      };
      const first = order === "the reply first" ? "reply" : "restore";
      const second = first === "reply" ? "restore" : "reply";
      const p1 = start[first]();
      await waitForLockWait(admin, first === "reply" ? "reply" : "decide");
      const p2 = start[second]();
      await waitForLockWait(admin, second === "reply" ? "reply" : "decide");
      await blocker.commit();
      const results = await expectSettlesWithin(Promise.all([p1, p2]), 15_000, "the reply and the restoration");
      expect(results.every((r) => r.ok)).toBe(true);
      expect(await liveReplies(dbBlock, w.topic)).toBe(2);
      expect((await topicRow(dbBlock, w.topic)).replyCount).toBe(2);
    }, 60_000);
  });

  describe("an appeal against a suspension that is decided while the suspension is replaced", () => {
    // Overturning a suspension appeal lifts the suspension only if that action still governs it. If an operator concurrently extends it with a new action, do not lift it.
    it.each([["the decision first", "decide"], ["the new suspension first", "suspend"]] as const)("ends in the new suspension either way: %s", async (_name, first) => {
      const [dbBlock, dbDecide, dbSuspend] = await Promise.all([scratch.open("blocker"), scratch.open("decide"), scratch.open("suspend")]);
      const n = ++seq;
      const member = `m${n}`;
      await addMember(dbBlock, member, `mem${n}`);
      await addMember(dbBlock, `reviewer${n}`, `rev${n}`);
      await addMember(dbBlock, `op${n}`, `opr${n}`);
      const now = new Date("2026-10-10T00:00:00Z");
      const first7 = await suspendMember(dbBlock, op(`op${n}`), { userId: member, reason: "spam", note: "7 days", days: 7 }, { now });
      if (!first7.ok) throw new Error("suspend failed");
      const appeal = await createAppeal(dbBlock, member, first7.actionId, "I did not", { now });
      if (!appeal.ok) throw new Error("appeal failed");

      const blocker = holdTx(dbBlock, (tx) => lockMember(tx, member));
      await blocker.ready;
      const decide = () => decideAppeal(dbDecide, { id: `reviewer${n}`, scope: OP }, appeal.id, { decision: "overturned", note: "overturned" }, { now });
      const suspend = () => suspendMember(dbSuspend, op(`op${n}`), { userId: member, reason: "spam", note: "30 days", days: 30 }, { now });
      const p1 = first === "decide" ? decide() : suspend();
      await waitForLockWait(admin, first === "decide" ? "decide" : "suspend");
      const p2 = first === "decide" ? suspend() : decide();
      await waitForLockWait(admin, first === "decide" ? "suspend" : "decide");
      await blocker.commit();
      const [r1, r2] = await expectSettlesWithin(Promise.all([p1, p2]), 15_000, "the decision and the suspension");
      expect(r1.ok && r2.ok).toBe(true);
      const decided = first === "decide" ? (r1 as { reversed: boolean }) : (r2 as { reversed: boolean });
      const second = first === "decide" ? (r2 as { actionId: number }) : (r1 as { actionId: number });
      // The current suspension belongs to the new action.
      const [profile] = await dbBlock.select({ until: profiles.suspendedUntil, actionId: profiles.suspendedActionId }).from(profiles).where(eq(profiles.userId, member));
      expect(profile.actionId).toBe(second.actionId);
      expect(profile.until?.getTime()).toBe(now.getTime() + 30 * 86_400_000);
      // Overturning lifts the suspension only when review happens first. If lifted, there is one unsuspension action; otherwise none.
      expect(decided.reversed).toBe(first === "decide");
      const unsuspends = await dbBlock.select({ id: moderationActions.id }).from(moderationActions).where(and(eq(moderationActions.targetUserId, member), eq(moderationActions.action, "unsuspend")));
      expect(unsuspends).toHaveLength(first === "decide" ? 1 : 0);
      const [row] = await dbBlock.select({ status: appeals.status, reversed: appeals.reversed }).from(appeals).where(eq(appeals.id, appeal.id));
      expect(row).toEqual({ status: "overturned", reversed: first === "decide" });
    }, 60_000);
  });

  describe("saving a translation or an embedding holds the post's row FOR SHARE", () => {
    it("a deletion waits for a translation that is being saved, and then removes it", async () => {
      const [dbSave, dbDelete] = await Promise.all([scratch.open("save"), scratch.open("delete")]);
      const w = await world(dbSave);
      const [topic] = await dbSave.select({ hash: entries.sourceHash }).from(entries).where(eq(entries.id, w.topic));
      // Mid-save: hold the entry row FOR SHARE and pause after writing the translation.
      const saving = holdTx(dbSave, async (tx) => {
        expect(await entryStillCurrent(tx, w.topic, topic.hash!)).toBe(true);
        await tx.insert(translations).values({ entryId: w.topic, field: "body", lang: "en", kind: "primary", text: "[en] 本文です。", engine: "fake", model: "fake-1", sourceHash: topic.hash });
      });
      await saving.ready;
      const deleting = deleteOwnEntry(dbDelete, w.a, w.topic);
      await waitForLockWait(admin, "delete");
      await expectPending(deleting);
      await saving.commit();
      expect((await expectSettlesWithin(deleting, 10_000, "the deletion")).ok).toBe(true);
      // Deletion cleanup runs after the save and leaves no translation.
      expect(await dbSave.select({ id: translations.id }).from(translations).where(eq(translations.entryId, w.topic))).toEqual([]);
    }, 60_000);

    it("a save that starts while the post is being deleted waits, and then sees that the post is gone", async () => {
      const [dbDelete, dbSave] = await Promise.all([scratch.open("delete"), scratch.open("save")]);
      const w = await world(dbDelete);
      const [topic] = await dbDelete.select({ hash: entries.sourceHash }).from(entries).where(eq(entries.id, w.topic));
      const deleting = holdTx(dbDelete, (tx) => tx.update(entries).set({ deletedAt: new Date() }).where(eq(entries.id, w.topic)));
      await deleting.ready;
      const saving = dbSave.transaction((tx) => entryStillCurrent(tx, w.topic, topic.hash!));
      await waitForLockWait(admin, "save");
      await expectPending(saving);
      await deleting.commit();
      expect(await expectSettlesWithin(saving, 10_000, "the check")).toBe(false);
    }, 60_000);

    it("embed_entry: a hide that arrives while the embedding is being written waits for it, and then removes it", async () => {
      const [dbBlock, dbWorker, dbHide] = await Promise.all([scratch.open("blocker"), scratch.open("worker"), scratch.open("hide")]);
      const w = await world(dbBlock);
      const engine = createFakeEmbeddingEngine();
      const handlers = createEmbeddingHandlers({ llm: { embeddingEngine: engine, now: LATER } });
      // Insert the same (entry, model) row first without committing, so the worker blocks on its save INSERT.
      const blocker = holdTx(dbBlock, (tx) =>
        tx.insert(entryEmbeddings).values({ entryId: w.topic, model: engine.model, dim: EMBEDDING_DIM, embedding: Array.from({ length: EMBEDDING_DIM }, (_, i) => (i === 0 ? 1 : 0)), sourceHash: "blocker" }),
      );
      await blocker.ready;
      const running = runDueJobs(dbWorker, handlers, { now: LATER, limit: 20, logger: { error: () => {}, warn: () => {} } });
      await waitForLockWait(admin, "worker");
      const hiding = hideEntry(dbHide, op(`op${w.n}`), { entryId: w.topic, reason: "spam", note: "ad" });
      await waitForLockWait(admin, "hide");
      await expectPending(hiding);
      // Release the blocker: the worker writes its embedding and finishes, then hiding proceeds.
      await blocker.rollback();
      await expectSettlesWithin(running, 15_000, "the worker");
      expect((await expectSettlesWithin(hiding, 10_000, "the hide")).ok).toBe(true);
      expect(await dbBlock.select({ id: entryEmbeddings.entryId }).from(entryEmbeddings).where(eq(entryEmbeddings.entryId, w.topic))).toEqual([]);
    }, 60_000);
  });

  describe("counters and one-time marks", () => {
    it("the rate-limit upsert counts every hit once when 60 requests arrive at once on three connections", async () => {
      const dbs = await Promise.all([scratch.open("r1"), scratch.open("r2"), scratch.open("r3")]);
      const now = new Date("2026-10-10T00:00:30Z");
      const results = await Promise.all(Array.from({ length: 60 }, (_, i) => hitRateLimit(dbs[i % 3], { key: "pg-test:burst", limit: 25, windowSeconds: 60, now })));
      expect(results.filter((r) => r.allowed)).toHaveLength(25);
      expect(results.map((r) => r.count).sort((x, y) => x - y)).toEqual(Array.from({ length: 60 }, (_, i) => i + 1));
      const [row] = await dbs[0].select({ count: rateLimits.count }).from(rateLimits).where(eq(rateLimits.key, "pg-test:burst"));
      // PostgreSQL count returns a number for the typed column via Drizzle mapWith.
      expect(row.count).toBe(60);
      expect(typeof row.count).toBe("number");
    }, 60_000);

    it("an invitation is used by one of several simultaneous sign-ups, never by two", async () => {
      const dbs = await Promise.all([scratch.open("i1"), scratch.open("i2"), scratch.open("i3")]);
      const email = `race${++seq}@example.com`;
      await createInvitation(dbs[0], { email });
      const used = await Promise.all(Array.from({ length: 12 }, (_, i) => markInvitationUsed(dbs[i % 3], email, { usedBy: `user${i}` })));
      expect(used.reduce((sum, n) => sum + n, 0)).toBe(1);
      const rows = await dbs[0].select({ usedBy: invitations.usedBy }).from(invitations).where(eq(invitations.email, email));
      expect(rows).toHaveLength(1);
      expect(rows[0].usedBy).toMatch(/^user\d+$/);
    }, 60_000);
  });

  describe("the job queue with several workers", () => {
    it("two workers claiming from one queue never run a job twice (FOR UPDATE SKIP LOCKED)", async () => {
      const [w1, w2, writer] = await Promise.all([scratch.open("w1"), scratch.open("w2"), scratch.open("writer")]);
      const kind = `pg_claim_${++seq}`;
      const ids: number[] = [];
      for (let i = 0; i < 60; i++) ids.push((await enqueue(writer, kind, { i })).id);
      const ran = new Map<number, number>();
      const byWorker = [0, 0];
      const handlerFor = (worker: number): JobHandlers => ({
        [kind]: async (job) => {
          ran.set(job.id, (ran.get(job.id) ?? 0) + 1);
          byWorker[worker]++;
          await new Promise((r) => setTimeout(r, 15));
        },
      });

      const [s1, s2] = await Promise.all([
        runDueJobs(w1, handlerFor(0), { now: LATER, limit: 100, logger: quiet }),
        runDueJobs(w2, handlerFor(1), { now: LATER, limit: 100, logger: quiet }),
      ]);
      expect(s1.done + s2.done).toBe(60);
      expect([...ran.keys()].sort((x, y) => x - y)).toEqual(ids);
      expect([...ran.values()].every((n) => n === 1)).toBe(true);
      // Both workers performed work while competing for jobs.
      expect(byWorker[0]).toBeGreaterThan(0);
      expect(byWorker[1]).toBeGreaterThan(0);
      const rows = await writer.select({ status: jobs.status, attempts: jobs.attempts }).from(jobs).where(inArray(jobs.id, ids));
      expect(rows.every((r) => r.status === "done" && r.attempts === 1)).toBe(true);
    }, 60_000);

    // A heartbeat prevents another worker from reclaiming a long-running job as stuck. Advance the other worker's clock from claim time, the initial locked_at, by
    // STUCK_AFTER_MS + 1 second. If locked_at has advanced at least one second beyond claim time through a heartbeat, the job is not considered stuck.
    // Without a heartbeat, locked_at stays at claim time, so the job is reclaimed and run again by the other worker.
    it.each([
      ["with a heartbeat the long job keeps its lock and is not run twice", 100, false],
      ["without a heartbeat the same job is taken back and run again", 3_600_000, true],
    ] as const)("%s", async (_name, heartbeatMs, takenBack) => {
      const [w1, w2] = await Promise.all([scratch.open("w1"), scratch.open("w2")]);
      const kind = `pg_long_${++seq}`;
      const { id } = await enqueue(w1, kind, {});
      const claimedAt = new Date("2031-01-01T00:00:00Z");
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let started!: () => void;
      const hasStarted = new Promise<void>((resolve) => (started = resolve));
      const longRuns: number[] = [];
      const otherRuns: number[] = [];

      const first = runDueJobs(
        w1,
        {
          [kind]: async (job) => {
            longRuns.push(job.id);
            started();
            await gate;
          },
        },
        { now: claimedAt, heartbeatMs, logger: quiet },
      );
      await hasStarted;
      const lockedAt = async () => (await w2.select({ lockedAt: jobs.lockedAt }).from(jobs).where(eq(jobs.id, id)))[0].lockedAt!.getTime();
      expect(await lockedAt()).toBe(claimedAt.getTime());
      if (!takenBack) await expect.poll(lockedAt, { timeout: 10_000 }).toBeGreaterThan(claimedAt.getTime() + 1_200);
      else await new Promise((r) => setTimeout(r, 1_500));
      // The other worker's clock: claim time plus STUCK_AFTER_MS + 1 second.
      await runDueJobs(
        w2,
        {
          [kind]: async (job) => {
            otherRuns.push(job.id);
          },
        },
        { now: new Date(claimedAt.getTime() + STUCK_AFTER_MS + 1_000), logger: quiet },
      );
      expect(otherRuns).toEqual(takenBack ? [id] : []);
      release();
      await first;
      const [row] = await w1.select({ status: jobs.status, attempts: jobs.attempts }).from(jobs).where(eq(jobs.id, id));
      // An old worker's completion write after reclamation must not overwrite the new owner's result.
      expect(row).toEqual({ status: "done", attempts: takenBack ? 2 : 1 });
      expect(longRuns).toEqual([id]);
    }, 60_000);

    it("hnsw.iterative_scan keeps a search at 20 results when most of the nearest rows are of an old model or in a hidden topic (pgvector on PostgreSQL)", async () => {
      // Force index scans on this connection only; small tables otherwise choose sequential scans and hide candidate-filtering problems.
      const db = await scratch.open("hnsw", "-c enable_seqscan=off -c enable_bitmapscan=off -c enable_sort=off");
      const n = ++seq;
      await addMember(db, `h${n}`, `hnsw${n}`);
      // Vectors on axis e0 with an e1 component t; smaller t is closer to the query e0. Their continuous ordering lets the HNSW graph reach every row.
      const point = (t: number) => Array.from({ length: EMBEDDING_DIM }, (_, k) => (k === 0 ? 1 : k === 1 ? t : 0));
      const model = `new-model-${n}`;
      const oldModel = `old-model-${n}`;
      const total = 290;
      const rows = await db
        .insert(entries)
        .values(Array.from({ length: total }, (_, i) => ({ kind: "topic", authorId: `h${n}`, lang: "ja", title: `t${i}`, body: "b", sourceHash: `h${i}` })))
        .returning({ id: entries.id });
      // One in seven rows uses the new model, 42 rows total; the rest use the old model. One in three new-model rows belongs to a hidden topic.
      await db.insert(entryEmbeddings).values(rows.map((r, i) => ({ entryId: r.id, model: i % 7 === 0 ? model : oldModel, dim: EMBEDDING_DIM, embedding: point(0.002 * (i + 1)), sourceHash: "x" })));
      const valid = rows.filter((_, i) => i % 7 === 0 && (i / 7) % 3 !== 0);
      await db.update(entries).set({ hiddenAt: new Date() }).where(inArray(entries.id, rows.filter((_, i) => i % 7 === 0 && (i / 7) % 3 === 0).map((r) => r.id)));
      // Precondition: an HNSW scan is used, and without iterative scanning, filtering leaves fewer than 20 results.
      const lit = JSON.stringify(point(0));
      const plain = (await db.execute(sql`select count(*) as c from (select e.entry_id from entry_embeddings e where e.model = ${model} order by e.embedding <=> ${lit}::vector limit 20) t`)) as unknown as { rows: Array<{ c: string }> };
      expect(Number(plain.rows[0].c)).toBeLessThan(20);
      const found = await findSimilar(db, point(0), model, 20);
      expect(found).toHaveLength(20);
      expect(found.every((f) => valid.some((r) => r.id === f.id))).toBe(true);
      expect(found.map((f) => f.distance)).toEqual([...found.map((f) => f.distance)].sort((a, b) => a - b));
      expect(await findSimilar(db, point(0), model, 100)).toHaveLength(valid.length);
    }, 120_000);
  });

  // This adds queued jobs, so place it after the embed_entry test above whose worker processes the first 20 jobs.
  describe("creating another way of asking a question while the question is hidden", () => {
    // Alternative creation reads the original question FOR NO KEY UPDATE via loadStanceAttrFacts; hiding locks the same row in the same mode via lockEntry, serializing the operations.
    // If hiding wins, creation sees a hidden question and returns invalid_alt_of. If creation wins, it succeeds, the original question is marked changed via meta_changed_at, and hiding succeeds afterward.
    it.each([["the hiding first", "hide"], ["the creation first", "create"]] as const)("is serialized on the question's row: %s", async (_name, first) => {
      const [dbBlock, dbCreate, dbHide] = await Promise.all([scratch.open("blocker"), scratch.open("create"), scratch.open("hide")]);
      const w = await world(dbBlock);
      const asked = await createTopic(dbBlock, w.a, { lang: "ja", title: `問い${w.n}`, body: "本文。", asksStance: true });
      if (!asked.ok) throw new Error("question failed");
      const t1 = new Date("2026-10-10T00:00:00Z");
      const t2 = new Date("2026-10-10T00:30:00Z");
      const blocker = holdTx(dbBlock, (tx) => tx.select().from(entries).where(eq(entries.id, asked.id)).for("no key update"));
      await blocker.ready;
      const create = () => createTopic(dbCreate, w.b, { lang: "ja", title: `別の立て方${w.n}`, body: "本文。", asksStance: true, altOf: asked.id }, { now: t1 });
      const hide = () => hideEntry(dbHide, op(`op${w.n}`), { entryId: asked.id, reason: "spam", note: "n" }, { now: t2 });
      const p1 = first === "hide" ? hide() : create();
      await waitForLockWait(admin, first === "hide" ? "hide" : "create");
      const p2 = first === "hide" ? create() : hide();
      await waitForLockWait(admin, first === "hide" ? "create" : "hide");
      await blocker.commit();
      const [r1, r2] = await expectSettlesWithin(Promise.all([p1, p2]), 15_000, "the creation and the hiding");
      const created = (first === "hide" ? r2 : r1) as Awaited<ReturnType<typeof create>>;
      const hidden = (first === "hide" ? r1 : r2) as Awaited<ReturnType<typeof hide>>;
      expect(hidden.ok).toBe(true);
      const [question] = await dbBlock.select({ hiddenAt: entries.hiddenAt, metaChangedAt: entries.metaChangedAt, changedAt: entries.changedAt }).from(entries).where(eq(entries.id, asked.id));
      expect(question.hiddenAt).toEqual(t2);
      const alts = await dbBlock.select({ id: entries.id }).from(entries).where(eq(entries.altOf, asked.id));
      if (first === "hide") {
        expect(created).toEqual({ ok: false, error: "invalid_alt_of" });
        expect(alts).toEqual([]);
        expect(question.metaChangedAt).toBeNull();
      } else {
        expect(created.ok).toBe(true);
        expect(alts).toHaveLength(1);
        expect(question.metaChangedAt).toEqual(t1);
      }
      // The original question appears in the change feed as hidden at hide time; when creation wins, its earlier timestamp is subsumed by the later hide timestamp.
      expect(question.changedAt).toEqual(t2);
      const feed = await loadChanges(dbBlock, { since: t1 });
      expect(feed.changes.find((c) => c.id === asked.id)).toMatchObject({ kind: "hidden", changedAt: t2 });
    }, 60_000);

    it("an edit takes the row FOR NO KEY UPDATE: it does not wait for the key-share lock of a reply being posted, and it does wait for another edit or a stance registration of the same row", async () => {
      const [dbBlock, dbEdit] = await Promise.all([scratch.open("blocker"), scratch.open("edit")]);
      const w = await world(dbBlock);
      // Reply insertion takes KEY SHARE on the topic row for its foreign key; editing does not wait.
      const share = holdTx(dbBlock, (tx) => tx.select().from(entries).where(eq(entries.id, w.topic)).for("key share"));
      await share.ready;
      const free = await expectSettlesWithin(editEntry(dbEdit, w.a, w.topic, { title: "直した題", body: "直した本文" }, { kind: "topic", now: new Date("2026-10-10T00:00:00Z") }), 5_000, "the edit (blocked by a key-share lock?)");
      expect(free).toMatchObject({ ok: true, changed: true });
      await share.commit();
      // FOR NO KEY UPDATE on the same row, from another edit or stance registration, serializes with editing, which waits.
      const exclusive = holdTx(dbBlock, (tx) => tx.select().from(entries).where(eq(entries.id, w.topic)).for("no key update"));
      await exclusive.ready;
      const waiting = editEntry(dbEdit, w.a, w.topic, { title: "さらに直した題", body: "さらに直した本文" }, { kind: "topic", now: new Date("2026-10-10T01:00:00Z") });
      await waitForLockWait(admin, "edit");
      await expectPending(waiting);
      await exclusive.commit();
      expect(await expectSettlesWithin(waiting, 10_000, "the edit after the lock was released")).toMatchObject({ ok: true, changed: true });
    }, 60_000);

    // setStance locks the question FOR NO KEY UPDATE and writes stance_locked_at for the first stance from a non-author. When that transaction overlaps
    // an author title edit, the edit waits for the row lock, then reads the locked question and returns locked without changing the title. To isolate the edit-side lock check,
    // emulate registration manually with the same row lock and column write.
    it("an edit of the title that waits for a stance registration is refused as locked once that commits, and the title stays", async () => {
      const [dbBlock, dbEdit] = await Promise.all([scratch.open("blocker"), scratch.open("edit")]);
      const w = await world(dbBlock);
      const asked = await createTopic(dbBlock, w.a, { lang: "ja", title: `固定される問い${w.n}`, body: "本文。", asksStance: true });
      if (!asked.ok) throw new Error("question failed");
      const lockedAt = new Date("2026-10-10T00:00:00Z");
      const holder = holdTx(dbBlock, async (tx) => {
        await tx.select().from(entries).where(eq(entries.id, asked.id)).for("no key update");
        await tx.update(entries).set({ stanceLockedAt: lockedAt }).where(eq(entries.id, asked.id));
      });
      await holder.ready;
      const editing = editEntry(dbEdit, w.a, asked.id, { title: `直した題${w.n}`, body: "本文。" }, { kind: "topic", now: new Date("2026-10-10T00:10:00Z") });
      await waitForLockWait(admin, "edit");
      await expectPending(editing);
      await holder.commit();
      expect(await expectSettlesWithin(editing, 10_000, "the edit after the stance registration committed")).toEqual({ ok: false, error: "locked" });
      const [row] = await dbBlock.select({ title: entries.title, body: entries.body, stanceLockedAt: entries.stanceLockedAt, editedAt: entries.editedAt }).from(entries).where(eq(entries.id, asked.id));
      expect(row).toEqual({ title: `固定される問い${w.n}`, body: "本文。", stanceLockedAt: lockedAt, editedAt: null });
    }, 60_000);
  });

  // Translation-report flow: the unique database index translation_reports_retry_once_idx atomically determines the first report. Write the retranslation job while holding the entry row FOR SHARE.
  describe("a first mistranslation report and the automatic re-translation", () => {

    // Close connections as soon as they are no longer needed. Parallel workers in pnpm test:pg approach the limit of 100; leaked connections accumulate until teardown.
    const closing = async (...dbs: Db[]) => void (await Promise.all(dbs.map((d) => closeDb(d).catch(() => {}))));
    const llm = (): LlmOptions => ({
      engines: { primary: createFakeEngine(), secondary: null, judge: null, retry: createFakeEngine({ model: "fake-retry" }) },
      env: {},
      now: LATER,
    });

    // Handle only this task's retranslation jobs. This test database contains jobs left by previous tests; claiming other kinds would exhaust the claim limit.
    const retryOnly = () => {
      const all = createTranslationHandlers({ llm: llm() });
      return { [RETRANSLATE_REPORT_JOB]: all[RETRANSLATE_REPORT_JOB] };
    };

    // Topic T is Japanese and has a Thai machine translation of its body.
    async function translatedWorld(db: Db) {
      const w = await world(db);
      const [topic] = await db.select({ hash: entries.sourceHash }).from(entries).where(eq(entries.id, w.topic));
      await db.insert(translations).values({ entryId: w.topic, field: "body", lang: "th", kind: "primary", text: "[th] 本文です。", engine: "fake", model: "fake-1", sourceHash: topic.hash });
      return { ...w, hash: topic.hash! };
    }

    it("a first report that races with another one: the unique index lets exactly one be the retry report, the other waits and becomes a moderator report, and one job is queued", async () => {
      const [dbBlock, dbReport] = await Promise.all([scratch.open("blocker"), scratch.open("report")]);
      try {
        const w = await translatedWorld(dbBlock);
        // Pause the first report after inserting the retry row without committing.
        const first = holdTx(dbBlock, (tx) =>
          tx.insert(translationReports).values({ entryId: w.topic, lang: "th", field: "body", reporterId: w.a, excerpt: "", note: "", sourceHash: w.hash, route: "retry", retrySlot: true }).returning({ id: translationReports.id }),
        );
        await first.ready;
        const second = createTranslationReport(dbReport, w.b, { entryId: w.topic, lang: "th" }, { now: LATER, llm: llm() });
        await waitForLockWait(admin, "report");
        await expectPending(second);
        await first.commit();
        expect(await expectSettlesWithin(second, 10_000, "the second report")).toMatchObject({ ok: true, route: "moderator" });
        const rows = await dbBlock.select({ route: translationReports.route, reporterId: translationReports.reporterId }).from(translationReports).where(eq(translationReports.entryId, w.topic));
        expect(rows.map((r) => r.route).sort()).toEqual(["moderator", "retry"]);
        expect((await dbBlock.select({ payload: jobs.payload }).from(jobs).where(eq(jobs.kind, RETRANSLATE_REPORT_JOB))).filter((j) => (j.payload as { entryId: number }).entryId === w.topic)).toHaveLength(0);
      } finally {
        await closing(dbBlock, dbReport);
      }
    }, 60_000);

    it("six reports from six members on three connections at once: one retry report with one job, five for the moderators", async () => {
      const dbs = await Promise.all([scratch.open("r1"), scratch.open("r2"), scratch.open("r3")]);
      try {
        const w = await translatedWorld(dbs[0]);
        const reporters: string[] = [];
        for (let i = 0; i < 6; i++) {
          const id = `rep${w.n}x${i}`;
          await addMember(dbs[0], id, `rep${w.n}x${i}`, { readLangs: ["th"] });
          reporters.push(id);
        }
        const results = await Promise.all(reporters.map((id, i) => createTranslationReport(dbs[i % 3], id, { entryId: w.topic, lang: "th", note: `n${i}` }, { now: LATER, llm: llm() })));
        expect(results.every((r) => r.ok)).toBe(true);
        expect(results.filter((r) => r.ok && r.route === "retry")).toHaveLength(1);
        expect(results.filter((r) => r.ok && r.route === "moderator")).toHaveLength(5);
        const rows = await dbs[0].select({ route: translationReports.route }).from(translationReports).where(eq(translationReports.entryId, w.topic));
        expect(rows.filter((r) => r.route === "retry")).toHaveLength(1);
        expect(rows).toHaveLength(6);
        const queued = (await dbs[0].select({ payload: jobs.payload }).from(jobs).where(eq(jobs.kind, RETRANSLATE_REPORT_JOB))).filter((j) => (j.payload as { entryId: number }).entryId === w.topic);
        expect(queued).toHaveLength(1);
      } finally {
        await closing(...dbs);
      }
    }, 60_000);

    it("two simultaneous taps of one member on the same translation make one row: the second waits for the first and then makes none (the first report is not used up)", async () => {
      const dbs = await Promise.all([scratch.open("t1"), scratch.open("t2"), scratch.open("t3")]);
      try {
        const w = await translatedWorld(dbs[0]);
        const results = await Promise.all(dbs.map((db) => createTranslationReport(db, w.b, { entryId: w.topic, lang: "th" }, { now: LATER, llm: llm() })));
        expect(results.every((r) => r.ok)).toBe(true);
        expect(results.filter((r) => r.ok && r.id !== null)).toHaveLength(1);
        expect(results.filter((r) => r.ok && r.id === null)).toHaveLength(2);
        const rows = await dbs[0].select({ route: translationReports.route }).from(translationReports).where(eq(translationReports.entryId, w.topic));
        expect(rows).toEqual([{ route: "retry" }]);
      } finally {
        await closing(...dbs);
      }
    }, 60_000);

    it("the site-wide daily cap holds when six members report six different translations at once on three connections: exactly three take the automatic re-translation", async () => {
      const dbs = await Promise.all([scratch.open("c1"), scratch.open("c2"), scratch.open("c3")]);
      try {
        const w = await translatedWorld(dbs[0]);
        const langs = ["fr", "de", "ko", "vi", "zh-Hans", "zh-Hant"] as const;
        await dbs[0].insert(translations).values(langs.map((lang) => ({ entryId: w.topic, field: "body", lang, kind: "primary", text: `[${lang}] 本文です。`, engine: "fake", model: "fake-1", sourceHash: w.hash })));
        const members: string[] = [];
        for (let i = 0; i < 6; i++) {
          const id = `cap${w.n}x${i}`;
          await addMember(dbs[0], id, `cap${w.n}x${i}`, { readLangs: ["th"] });
          members.push(id);
        }
        // The limit counts slots in the preceding 24 hours. This database has earlier tests' reports at LATER, so count two days afterward.
        const now = new Date(LATER.getTime() + 2 * 86_400_000);
        const capped = (): LlmOptions => ({ ...llm(), env: { TRANSLATION_RETRY_DAILY_MAX: "3" } });
        const results = await Promise.all(members.map((id, i) => createTranslationReport(dbs[i % 3], id, { entryId: w.topic, lang: langs[i] }, { now, llm: capped() })));
        expect(results.filter((r) => r.ok && r.route === "retry")).toHaveLength(3);
        expect(results.filter((r) => r.ok && r.route === "moderator")).toHaveLength(3);
        const slots = await dbs[0].select({ id: translationReports.id }).from(translationReports).where(and(eq(translationReports.entryId, w.topic), eq(translationReports.retrySlot, true)));
        expect(slots).toHaveLength(3);
      } finally {
        await closing(...dbs);
      }
    }, 60_000);

    // Always lock entry → report, including deletion cleanup, automatic retranslation saves, and human corrections. Reversing the order deadlocks deletion, which holds the entry and waits for the report, against a retranslation or human correction
    // holding the report and waiting for the entry (40P01). Pause a connection holding the entry, queue all three on that entry, then release it. Any deadlock victim increases the pg_stat_database count.
    const deadlocks = async () => Number((await admin.query<{ n: string }>("SELECT deadlocks::text AS n FROM pg_stat_database WHERE datname = current_database()")).rows[0].n);

    it("a deletion, the retry job's save and a moderator's human fix that all wait for the post's row finish without a deadlock (lock order: post, then report)", async () => {
      const [dbBlock, dbDelete, dbWorker, dbFix] = await Promise.all([scratch.open("blocker"), scratch.open("delete"), scratch.open("worker"), scratch.open("fix")]);
      try {
        const w = await translatedWorld(dbBlock);
        const made = await createTranslationReport(dbBlock, w.b, { entryId: w.topic, lang: "th" }, { now: LATER, llm: llm() });
        if (!made.ok || made.id === null) throw new Error("report failed");
        const before = await deadlocks();
        // Pause while holding the entry row FOR UPDATE.
        const holder = holdTx(dbBlock, (tx) => tx.select({ id: entries.id }).from(entries).where(eq(entries.id, w.topic)).for("update"));
        await holder.ready;
        const deleting = softDeleteEntry(dbDelete, w.topic, { now: LATER });
        await waitForLockWait(admin, "delete");
        const running = runDueJobs(dbWorker, retryOnly(), { now: LATER, limit: 20, logger: quiet });
        await waitForLockWait(admin, "worker");
        const fixing = resolveReportWithHumanTranslation(dbFix, `op${w.n}`, made.id, "人手の訳", { now: LATER });
        await waitForLockWait(admin, "fix");
        await expectPending(deleting);
        await holder.commit();
        expect((await expectSettlesWithin(deleting, 15_000, "the deletion")).ok).toBe(true);
        const stats = await expectSettlesWithin(running, 15_000, "the retry job");
        expect(stats).toMatchObject({ failed: 0, retried: 0 });
        // Deletion has closed the report, so the human correction is not saved.
        expect(await expectSettlesWithin(fixing, 15_000, "the human fix")).toEqual({ ok: false, error: "not_found" });
        expect(await deadlocks()).toBe(before);
        expect((await dbBlock.select({ status: translationReports.status }).from(translationReports).where(eq(translationReports.id, made.id)))[0].status).toBe("resolved");
        expect(await dbBlock.select({ id: translations.id }).from(translations).where(eq(translations.entryId, w.topic))).toEqual([]);
      } finally {
        await closing(dbBlock, dbDelete, dbWorker, dbFix);
      }
    }, 60_000);

    it("a deletion and a human fix that both wait for the post's row: the fix, which comes first, is saved and the deletion then removes it, with no deadlock", async () => {
      const [dbBlock, dbFix, dbDelete] = await Promise.all([scratch.open("blocker"), scratch.open("fix"), scratch.open("delete")]);
      try {
        const w = await translatedWorld(dbBlock);
        const made = await createTranslationReport(dbBlock, w.b, { entryId: w.topic, lang: "th", note: "wrong" }, { now: LATER, llm: llm() });
        if (!made.ok || made.id === null) throw new Error("report failed");
        const before = await deadlocks();
        const holder = holdTx(dbBlock, (tx) => tx.select({ id: entries.id }).from(entries).where(eq(entries.id, w.topic)).for("update"));
        await holder.ready;
        const fixing = resolveReportWithHumanTranslation(dbFix, `op${w.n}`, made.id, "人手の訳", { now: LATER });
        await waitForLockWait(admin, "fix");
        const deleting = softDeleteEntry(dbDelete, w.topic, { now: LATER });
        await waitForLockWait(admin, "delete");
        await holder.commit();
        expect(await expectSettlesWithin(fixing, 15_000, "the human fix")).toEqual({ ok: true, entryId: w.topic });
        expect((await expectSettlesWithin(deleting, 15_000, "the deletion")).ok).toBe(true);
        expect(await deadlocks()).toBe(before);
        expect(await dbBlock.select({ id: translations.id }).from(translations).where(eq(translations.entryId, w.topic))).toEqual([]);
      } finally {
        await closing(dbBlock, dbFix, dbDelete);
      }
    }, 60_000);

    it("the retry job that is writing holds the post's row FOR SHARE: a hide waits for it, and the translation is replaced before the post is hidden", async () => {
      const [dbBlock, dbWorker, dbHide] = await Promise.all([scratch.open("blocker"), scratch.open("worker"), scratch.open("hide")]);
      try {
        const w = await translatedWorld(dbBlock);
        expect((await createTranslationReport(dbBlock, w.b, { entryId: w.topic, lang: "th" }, { now: LATER, llm: llm() })).ok).toBe(true);
        // Update the same translation row without committing so the worker blocks when writing the translation.
        const blocker = holdTx(dbBlock, (tx) => tx.update(translations).set({ updatedAt: LATER }).where(and(eq(translations.entryId, w.topic), eq(translations.field, "body"), eq(translations.lang, "th"))));
        await blocker.ready;
        const running = runDueJobs(dbWorker, retryOnly(), { now: LATER, limit: 20, logger: quiet });
        await waitForLockWait(admin, "worker");
        const hiding = hideEntry(dbHide, op(`op${w.n}`), { entryId: w.topic, reason: "spam", note: "ad" });
        await waitForLockWait(admin, "hide");
        await expectPending(hiding);
        await blocker.rollback();
        await expectSettlesWithin(running, 15_000, "the worker");
        expect((await expectSettlesWithin(hiding, 10_000, "the hide")).ok).toBe(true);
        const [row] = await dbBlock.select({ text: translations.text, model: translations.model, flags: translations.flags }).from(translations).where(and(eq(translations.entryId, w.topic), eq(translations.field, "body"), eq(translations.lang, "th"), eq(translations.kind, "primary")));
        expect(row).toMatchObject({ text: "[th/fake-retry] 本文です。", model: "fake-retry", flags: ["retried_after_report"] });
        expect((await dbBlock.select({ status: translationReports.status }).from(translationReports).where(eq(translationReports.entryId, w.topic)))[0].status).toBe("resolved");
      } finally {
        await closing(dbBlock, dbWorker, dbHide);
      }
    }, 60_000);

    it("a hide that commits while the retry job is about to write wins: the job writes nothing and sends the report to the moderators", async () => {
      const [dbBlock, dbWorker] = await Promise.all([scratch.open("blocker"), scratch.open("worker")]);
      try {
        const w = await translatedWorld(dbBlock);
        expect((await createTranslationReport(dbBlock, w.b, { entryId: w.topic, lang: "th" }, { now: LATER, llm: llm() })).ok).toBe(true);
        // Hold an uncommitted hide update: the worker reads an unhidden entry and translates it, then waits for a shared entry-row lock when saving.
        const hiding = holdTx(dbBlock, (tx) => tx.update(entries).set({ hiddenAt: LATER }).where(eq(entries.id, w.topic)));
        await hiding.ready;
        const running = runDueJobs(dbWorker, retryOnly(), { now: LATER, limit: 20, logger: quiet });
        await waitForLockWait(admin, "worker");
        await expectPending(running);
        await hiding.commit();
        await expectSettlesWithin(running, 15_000, "the worker");
        const [row] = await dbBlock.select({ text: translations.text, model: translations.model }).from(translations).where(and(eq(translations.entryId, w.topic), eq(translations.field, "body"), eq(translations.lang, "th"), eq(translations.kind, "primary")));
        expect(row).toEqual({ text: "[th] 本文です。", model: "fake-1" });
        expect((await dbBlock.select({ route: translationReports.route, status: translationReports.status }).from(translationReports).where(eq(translationReports.entryId, w.topic)))[0]).toEqual({ route: "moderator", status: "open" });
      } finally {
        await closing(dbBlock, dbWorker);
      }
    }, 60_000);

    // Lock order: member profile → question/entry → translation report. Pause a connection holding a locked question, then queue fixEntry (question → translations and reports touched by cleanup),
    // stance registration (profile → question), retranslation-job save (entry → report), human correction (entry → report), and author deletion (question → report) on that question row before releasing it. All complete without increasing the deadlock count.
    it("a typo fix, a stance registration, the retry job's save, a human fix and a deletion that all wait for a locked question's row finish without a deadlock (lock order: profile, post, report)", async () => {
      const [dbBlock, dbFix, dbStance, dbWorker, dbHuman, dbDelete] = await Promise.all([
        scratch.open("blocker"),
        scratch.open("fix"),
        scratch.open("stance"),
        scratch.open("worker"),
        scratch.open("human"),
        scratch.open("delete"),
      ]);
      try {
        const w = await world(dbBlock);
        const asked = await createTopic(dbBlock, w.a, { lang: "ja", title: `固定された問い${w.n}`, body: "本文です。", asksStance: true });
        if (!asked.ok) throw new Error("question failed");
        const [row] = await dbBlock.select({ hash: entries.sourceHash }).from(entries).where(eq(entries.id, asked.id));
        await dbBlock.insert(translations).values({ entryId: asked.id, field: "body", lang: "th", kind: "primary", text: "[th] 本文です。", engine: "fake", model: "fake-1", sourceHash: row.hash });
        await addMember(dbBlock, `giver${w.n}`, `giv${w.n}`);
        await addMember(dbBlock, `second${w.n}`, `snd${w.n}`);
        expect((await setStance(dbBlock, `giver${w.n}`, { questionId: asked.id, position: "agree", expectedVersion: 0 }, { now: LATER })).ok).toBe(true);
        const made = await createTranslationReport(dbBlock, w.b, { entryId: asked.id, lang: "th" }, { now: LATER, llm: llm() });
        if (!made.ok || made.id === null) throw new Error("report failed");
        const before = await deadlocks();
        const holder = holdTx(dbBlock, (tx) => tx.select({ id: entries.id }).from(entries).where(eq(entries.id, asked.id)).for("update"));
        await holder.ready;
        const fixing = fixEntry(dbFix, op(`op${w.n}`), { entryId: asked.id, title: `直した題${w.n}`, body: "直した本文です。", note: "誤字", sourceHash: row.hash }, { now: LATER });
        await waitForLockWait(admin, "fix");
        const registering = setStance(dbStance, `second${w.n}`, { questionId: asked.id, position: "disagree", expectedVersion: 0 }, { now: LATER });
        await waitForLockWait(admin, "stance");
        const running = runDueJobs(dbWorker, retryOnly(), { now: LATER, limit: 20, logger: quiet });
        await waitForLockWait(admin, "worker");
        const humanFix = resolveReportWithHumanTranslation(dbHuman, `op${w.n}`, made.id, "人手の訳", { now: LATER });
        await waitForLockWait(admin, "human");
        const deleting = deleteOwnEntry(dbDelete, w.a, asked.id, { now: LATER });
        await waitForLockWait(admin, "delete");
        await expectPending(fixing);
        await holder.commit();
        const settled = await expectSettlesWithin(Promise.all([fixing, registering, running, humanFix, deleting]), 20_000, "the five that waited for the question's row");
        expect(settled[0]).toMatchObject({ ok: true });
        // Deletion can win the question-row lock before stance registration.
        expect(settled[1]).toMatchObject(settled[1].ok ? { ok: true, changed: true } : { ok: false, error: "not_found" });
        expect(settled[4].ok).toBe(true);
        expect(await dbBlock.select().from(stances).where(and(eq(stances.questionId, asked.id), eq(stances.userId, `second${w.n}`)))).toHaveLength(settled[1].ok ? 1 : 0);
        expect((await dbBlock.select({ deletedAt: entries.deletedAt }).from(entries).where(eq(entries.id, asked.id)))[0].deletedAt).toEqual(LATER);
        expect(await deadlocks()).toBe(before);
        // The correction revision remains, and the question stays locked.
        expect((await dbBlock.select({ n: count() }).from(entryRevisions).where(eq(entryRevisions.entryId, asked.id)))[0].n).toBe(1);
        expect((await dbBlock.select({ lockedAt: entries.stanceLockedAt }).from(entries).where(eq(entries.id, asked.id)))[0].lockedAt).not.toBeNull();
      } finally {
        await closing(dbBlock, dbFix, dbStance, dbWorker, dbHuman, dbDelete);
      }
    }, 90_000);
  });

  // Stances: serialize per member with FOR UPDATE on the profile, acquired first by all stance-changing operations. Serialize per question with FOR NO KEY UPDATE, also used by edits, replies, moderation, and deletion.
  // Create races deterministically: pause one connection holding the row, queue the next two on that row in this order, then release it. Waiters acquire the lock in arrival order.
  describe("stances concurrency", () => {
    const closing = async (...dbs: Db[]) => void (await Promise.all(dbs.map((d) => closeDb(d).catch(() => {}))));
    const at = (minutes: number) => new Date(Date.UTC(2026, 9, 5, 0, minutes));
    const deadlocks = async () => Number((await admin.query<{ n: string }>("SELECT deadlocks::text AS n FROM pg_stat_database WHERE datname = current_database()")).rows[0].n);

    // Question Q authored by a, stance voters m1 (ja) and m2 (en), and operator op.
    async function stanceWorld(db: Db) {
      const w = await world(db);
      await addMember(db, `m1_${w.n}`, `emu${w.n}`, { homeArea: "ja" });
      await addMember(db, `m2_${w.n}`, `fox${w.n}`, { homeArea: "en", readLangs: ["en"] });
      const asked = await createTopic(db, w.a, { lang: "ja", title: `問い${w.n}`, body: "命題です。", asksStance: true }, { now: at(0) });
      if (!asked.ok) throw new Error("question failed");
      return { ...w, q: asked.id, m1: `m1_${w.n}`, m2: `m2_${w.n}` };
    }
    const questionRow = async (db: Db, id: number) => (await db.select().from(entries).where(eq(entries.id, id)))[0];
    const holdProfile = (db: Db, userId: string) => holdTx(db, (tx) => tx.select({ userId: profiles.userId }).from(profiles).where(eq(profiles.userId, userId)).for("update"));
    const holdQuestion = (db: Db, id: number) => holdTx(db, (tx) => tx.select({ id: entries.id }).from(entries).where(eq(entries.id, id)).for("no key update"));

    it("two sends of one member from the same version with different stances: the first goes through, the second is a conflict, and the history does not fork (one row)", async () => {
      const [dbBlock, dbA, dbB] = await Promise.all([scratch.open("blocker"), scratch.open("send-a"), scratch.open("send-b")]);
      try {
        const w = await stanceWorld(dbBlock);
        const holder = holdProfile(dbBlock, w.m1);
        await holder.ready;
        const first = setStance(dbA, w.m1, { questionId: w.q, position: "agree", expectedVersion: 0 }, { now: at(1) });
        await waitForLockWait(admin, "send-a");
        const second = setStance(dbB, w.m1, { questionId: w.q, position: "disagree", expectedVersion: 0 }, { now: at(2) });
        await waitForLockWait(admin, "send-b");
        await expectPending(first);
        await holder.commit();
        expect(await expectSettlesWithin(first, 10_000, "the first send")).toEqual({ ok: true, changed: true, position: "agree", version: 1 });
        expect(await expectSettlesWithin(second, 10_000, "the second send")).toEqual({ ok: false, error: "conflict", position: "agree", version: 1 });
        expect((await dbBlock.select().from(stanceChanges).where(eq(stanceChanges.userId, w.m1))).map((c) => [c.fromPosition, c.toPosition])).toEqual([[null, "agree"]]);
        expect((await dbBlock.select().from(stances).where(eq(stances.userId, w.m1)))[0]).toMatchObject({ position: "agree", version: 1 });
      } finally {
        await closing(dbBlock, dbA, dbB);
      }
    }, 60_000);

    it("two sends of one member with the same stance: one row is added, and the second says it changed nothing", async () => {
      const [dbBlock, dbA, dbB] = await Promise.all([scratch.open("blocker"), scratch.open("send-a"), scratch.open("send-b")]);
      try {
        const w = await stanceWorld(dbBlock);
        const holder = holdProfile(dbBlock, w.m1);
        await holder.ready;
        const first = setStance(dbA, w.m1, { questionId: w.q, position: "neither", expectedVersion: 0 }, { now: at(1) });
        await waitForLockWait(admin, "send-a");
        const second = setStance(dbB, w.m1, { questionId: w.q, position: "neither", expectedVersion: 0 }, { now: at(2) });
        await waitForLockWait(admin, "send-b");
        await holder.commit();
        expect(await expectSettlesWithin(first, 10_000, "the first send")).toMatchObject({ ok: true, changed: true, version: 1 });
        expect(await expectSettlesWithin(second, 10_000, "the second send")).toEqual({ ok: true, changed: false, position: "neither", version: 1 });
        expect(await dbBlock.select().from(stanceChanges).where(eq(stanceChanges.userId, w.m1))).toHaveLength(1);
      } finally {
        await closing(dbBlock, dbA, dbB);
      }
    }, 60_000);

    it.each([["the home area change first"], ["the registration first"]] as const)("a registration and a change of the home area do not cross: every stance ends in the new area, and the record keeps the area of its time (%s)", async (order) => {
      const [dbBlock, dbArea, dbStance] = await Promise.all([scratch.open("blocker"), scratch.open("area"), scratch.open("stance")]);
      try {
        const w = await stanceWorld(dbBlock);
        const holder = holdProfile(dbBlock, w.m1);
        await holder.ready;
        const area = () => changeHomeArea(dbArea, w.m1, "fr", { now: at(5) });
        const register = () => setStance(dbStance, w.m1, { questionId: w.q, position: "agree", expectedVersion: 0 }, { now: at(6) });
        const [firstName, firstRun, secondName, secondRun] = order === "the home area change first" ? (["area", area, "stance", register] as const) : (["stance", register, "area", area] as const);
        const p1 = firstRun();
        await waitForLockWait(admin, firstName);
        const p2 = secondRun();
        await waitForLockWait(admin, secondName);
        await holder.commit();
        await expectSettlesWithin(Promise.all([p1, p2]), 15_000, "the two");
        expect((await dbBlock.select({ area: profiles.homeArea }).from(profiles).where(eq(profiles.userId, w.m1)))[0].area).toBe("fr");
        // In either order, the current stance uses the new language area.
        expect((await dbBlock.select().from(stances).where(eq(stances.userId, w.m1))).map((s) => s.area)).toEqual(["fr"]);
        // History stores the area snapshot at the time: the new area if the area change wins, or the old area if registration wins.
        expect((await dbBlock.select().from(stanceChanges).where(eq(stanceChanges.userId, w.m1))).map((c) => c.area)).toEqual([order === "the home area change first" ? "fr" : "ja"]);
      } finally {
        await closing(dbBlock, dbArea, dbStance);
      }
    }, 60_000);

    it.each([
      ["the edit first", "edit"],
      ["the stance first", "stance"],
    ] as const)("the author's edit and the first stance of another member are serialized on the question's row: %s", async (_name, first) => {
      const [dbBlock, dbEdit, dbStance] = await Promise.all([scratch.open("blocker"), scratch.open("edit"), scratch.open("stance")]);
      try {
        const w = await stanceWorld(dbBlock);
        const holder = holdQuestion(dbBlock, w.q);
        await holder.ready;
        const edit = () => editEntry(dbEdit, w.a, w.q, { title: `直した題${w.n}`, body: "直した本文です。" }, { kind: "topic", now: at(10) });
        const stance = () => setStance(dbStance, w.m1, { questionId: w.q, position: "agree", expectedVersion: 0 }, { now: at(11) });
        const start = { edit, stance };
        const second = first === "edit" ? "stance" : "edit";
        const p1 = start[first]();
        await waitForLockWait(admin, first);
        const p2 = start[second]();
        await waitForLockWait(admin, second);
        await holder.commit();
        const [r1, r2] = await expectSettlesWithin(Promise.all([p1, p2]), 15_000, "the edit and the stance");
        const row = await questionRow(dbBlock, w.q);
        if (first === "edit") {
          // Editing first succeeds; the subsequent stance starts the lock.
          expect(r1).toMatchObject({ ok: true, changed: true });
          expect(r2).toMatchObject({ ok: true, changed: true });
          expect(row.title).toBe(`直した題${w.n}`);
        } else {
          // A stance first starts the lock; editing returns locked and leaves the title unchanged.
          expect(r1).toMatchObject({ ok: true, changed: true });
          expect(r2).toEqual({ ok: false, error: "locked" });
          expect(row.title).toBe(`問い${w.n}`);
        }
        expect(row.stanceLockedAt).toEqual(at(11));
      } finally {
        await closing(dbBlock, dbEdit, dbStance);
      }
    }, 60_000);

    it("the author's own stance does not lock: the edit that is serialized with it goes through, and no lock time is written", async () => {
      const [dbBlock, dbEdit, dbStance] = await Promise.all([scratch.open("blocker"), scratch.open("edit"), scratch.open("stance")]);
      try {
        const w = await stanceWorld(dbBlock);
        const holder = holdQuestion(dbBlock, w.q);
        await holder.ready;
        const stance = setStance(dbStance, w.a, { questionId: w.q, position: "agree", expectedVersion: 0 }, { now: at(11) });
        await waitForLockWait(admin, "stance");
        const edit = editEntry(dbEdit, w.a, w.q, { title: `直した題${w.n}`, body: "直した本文です。" }, { kind: "topic", now: at(12) });
        await waitForLockWait(admin, "edit");
        await holder.commit();
        const [r1, r2] = await expectSettlesWithin(Promise.all([stance, edit]), 15_000, "the stance and the edit");
        expect(r1).toMatchObject({ ok: true, changed: true });
        expect(r2).toMatchObject({ ok: true, changed: true });
        expect((await questionRow(dbBlock, w.q)).stanceLockedAt).toBeNull();
      } finally {
        await closing(dbBlock, dbEdit, dbStance);
      }
    }, 60_000);

    it("the first stances of two other members at the same time both go through, with no deadlock, and the lock time is the time of the one that committed first", async () => {
      const [dbBlock, dbA, dbB] = await Promise.all([scratch.open("blocker"), scratch.open("send-a"), scratch.open("send-b")]);
      try {
        const w = await stanceWorld(dbBlock);
        const before = await deadlocks();
        const holder = holdQuestion(dbBlock, w.q);
        await holder.ready;
        const first = setStance(dbA, w.m1, { questionId: w.q, position: "agree", expectedVersion: 0 }, { now: at(21) });
        await waitForLockWait(admin, "send-a");
        const second = setStance(dbB, w.m2, { questionId: w.q, position: "disagree", expectedVersion: 0 }, { now: at(22) });
        await waitForLockWait(admin, "send-b");
        await holder.commit();
        const [r1, r2] = await expectSettlesWithin(Promise.all([first, second]), 15_000, "the two stances");
        expect(r1).toMatchObject({ ok: true, changed: true });
        expect(r2).toMatchObject({ ok: true, changed: true });
        expect(await deadlocks()).toBe(before);
        expect((await questionRow(dbBlock, w.q)).stanceLockedAt).toEqual(at(21));
      } finally {
        await closing(dbBlock, dbA, dbB);
      }
    }, 60_000);

    it.each([["the registration first"], ["the deletion first"]] as const)("a member's deletion of the record and a registration are serialized: the end state is one of the two orders (%s)", async (order) => {
      const [dbBlock, dbSet, dbDelete] = await Promise.all([scratch.open("blocker"), scratch.open("stance"), scratch.open("delete")]);
      try {
        const w = await stanceWorld(dbBlock);
        const holder = holdProfile(dbBlock, w.m1);
        await holder.ready;
        const register = () => setStance(dbSet, w.m1, { questionId: w.q, position: "agree", expectedVersion: 0 }, { now: at(31) });
        const remove = () => deleteStanceRecord(dbDelete, w.m1, w.q);
        const [firstName, firstRun, secondName, secondRun] = order === "the registration first" ? (["stance", register, "delete", remove] as const) : (["delete", remove, "stance", register] as const);
        const p1 = firstRun();
        await waitForLockWait(admin, firstName);
        const p2 = secondRun();
        await waitForLockWait(admin, secondName);
        await holder.commit();
        await expectSettlesWithin(Promise.all([p1, p2]), 15_000, "the registration and the deletion");
        const rows = await dbBlock.select().from(stances).where(eq(stances.userId, w.m1));
        const changes = await dbBlock.select().from(stanceChanges).where(eq(stanceChanges.userId, w.m1));
        if (order === "the registration first") {
          // Registration → deletion leaves neither a row nor history.
          expect([rows.length, changes.length]).toEqual([0, 0]);
        } else {
          // Deletion with nothing to remove → registration creates a version-1 row.
          expect(rows).toMatchObject([{ position: "agree", version: 1 }]);
          expect(changes).toHaveLength(1);
        }
      } finally {
        await closing(dbBlock, dbSet, dbDelete);
      }
    }, 60_000);

    it("an exclusion and a registration of the same member do not deadlock (both take the profile row first), and the registration is there but not counted", async () => {
      const [dbBlock, dbExclude, dbStance] = await Promise.all([scratch.open("blocker"), scratch.open("exclude"), scratch.open("stance")]);
      try {
        const w = await stanceWorld(dbBlock);
        const before = await deadlocks();
        const holder = holdProfile(dbBlock, w.m1);
        await holder.ready;
        const excluding = excludeReactions(dbExclude, op(`op${w.n}`), { userId: w.m1, reason: "spam", note: "fake" }, { now: at(41) });
        await waitForLockWait(admin, "exclude");
        const registering = setStance(dbStance, w.m1, { questionId: w.q, position: "agree", expectedVersion: 0 }, { now: at(42) });
        await waitForLockWait(admin, "stance");
        await holder.commit();
        const [excluded, registered] = await expectSettlesWithin(Promise.all([excluding, registering]), 15_000, "the exclusion and the registration");
        expect(excluded).toMatchObject({ ok: true });
        expect(registered).toMatchObject({ ok: true, changed: true });
        expect(await deadlocks()).toBe(before);
        expect((await dbBlock.select().from(stances).where(eq(stances.userId, w.m1))).length).toBe(1);
        expect((await dbBlock.select({ at: profiles.reactionsExcludedAt }).from(profiles).where(eq(profiles.userId, w.m1)))[0].at).toEqual(at(41));
      } finally {
        await closing(dbBlock, dbExclude, dbStance);
      }
    }, 60_000);

    it("two moderators' fixes of the same question are serialized on its row: a second form made on the first fix's text works on the new text (a fix with the same content is no_change), and a second form made on the old text is stale", async () => {
      const [dbBlock, dbA, dbB] = await Promise.all([scratch.open("blocker"), scratch.open("fix-a"), scratch.open("fix-b")]);
      try {
        // [same content as the first fix?, the base of the second form: the text after the first fix (a form opened after it) or the old text (opened before it), the second fix's result]
        const cases = [
          [true, "after", { ok: false, error: "no_change" }],
          [false, "after", { ok: true }],
          [false, "before", { ok: false, error: "invalid_state" }],
        ] as const;
        for (const [sameContent, base, expectSecond] of cases) {
          const w = await stanceWorld(dbBlock);
          expect((await setStance(dbBlock, w.m1, { questionId: w.q, position: "agree", expectedVersion: 0 }, { now: at(51) })).ok).toBe(true);
          const holder = holdQuestion(dbBlock, w.q);
          await holder.ready;
          const fixA = fixEntry(dbA, op(`op${w.n}`), { entryId: w.q, title: `直した題${w.n}`, body: "直した本文です。", note: "一人目", sourceHash: sourceHash(`問い${w.n}`, "命題です。", "ja") }, { now: at(52) });
          await waitForLockWait(admin, "fix-a");
          const secondBase = base === "after" ? sourceHash(`直した題${w.n}`, "直した本文です。", "ja") : sourceHash(`問い${w.n}`, "命題です。", "ja");
          const fixB = fixEntry(dbB, op(`op${w.n}`), { entryId: w.q, title: sameContent ? `直した題${w.n}` : `さらに直した題${w.n}`, body: "直した本文です。", note: "二人目", sourceHash: secondBase }, { now: at(53) });
          await waitForLockWait(admin, "fix-b");
          await holder.commit();
          const [a, b] = await expectSettlesWithin(Promise.all([fixA, fixB]), 15_000, "the two fixes");
          expect(a).toMatchObject({ ok: true });
          expect(b).toMatchObject(expectSecond);
          const second = expectSecond.ok === true;
          const revisions = await dbBlock.select().from(entryRevisions).where(eq(entryRevisions.entryId, w.q)).orderBy(entryRevisions.id);
          expect(revisions.map((r) => r.title)).toEqual(second ? [`問い${w.n}`, `直した題${w.n}`] : [`問い${w.n}`]);
          expect((await dbBlock.select().from(moderationActions).where(eq(moderationActions.targetEntryId, w.q))).map((x) => x.note)).toEqual(second ? ["一人目", "二人目"] : ["一人目"]);
          // the stale form wrote nothing: the text is the first fix's
          if (!second) expect((await questionRow(dbBlock, w.q)).title).toBe(`直した題${w.n}`);
        }
      } finally {
        await closing(dbBlock, dbA, dbB);
      }
    }, 90_000);
  });

  // ---- Glossary ----

  describe("the glossary: writes to one entry go through the row lock, so the history stays a chain", () => {
    // The scratch database is shared by the tests of this file: each test uses its own term, so the triples do not collide.
    async function glossaryWorld(db: Db) {
      const n = ++seq;
      await addMember(db, `gop${n}`, `gop${n}`, { readLangs: ["ja"] });
      const actor: GlossaryActor = { userId: `gop${n}`, scope: OP };
      return { actor, term: `alignment-${n}`, input: { term: `alignment-${n}`, lang: "en", targetLang: "ja", candidates: "x", note: "" } as const };
    }
    const revisionsOf = (db: Db, entryId: number) => db.select().from(glossaryRevisions).where(eq(glossaryRevisions.entryId, entryId)).orderBy(glossaryRevisions.id);
    const rowOf = async (db: Db, id: number) => (await db.select().from(glossaryEntries).where(eq(glossaryEntries.id, id)))[0];

    it("two changes to the same entry at once: both are kept, in an unbroken chain, and the entry holds the one that was committed last", async () => {
      const [dbBlock, dbA, dbB] = await Promise.all([scratch.open("blocker"), scratch.open("upd-a"), scratch.open("upd-b")]);
      const { actor, term, input } = await glossaryWorld(dbBlock);
      const made = await createGlossaryEntry(dbBlock, actor, input);
      if (!made.ok) throw new Error("create failed");
      const blocker = holdTx(dbBlock, (tx) => tx.select().from(glossaryEntries).where(eq(glossaryEntries.id, made.id)).for("update"));
      await blocker.ready;
      const first = updateGlossaryEntry(dbA, actor, made.id, { term, candidates: "from a" });
      await waitForLockWait(admin, "upd-a");
      const second = updateGlossaryEntry(dbB, actor, made.id, { term, candidates: "from b" });
      await waitForLockWait(admin, "upd-b");
      await blocker.commit();
      const results = await expectSettlesWithin(Promise.all([first, second]), 15_000, "the two changes");
      expect(results).toEqual([{ ok: true, changed: true }, { ok: true, changed: true }]);
      const revs = await revisionsOf(dbBlock, made.id);
      expect(revs).toHaveLength(3);
      // The chain: each before is the after of the one before; the entry holds the last after
      revs.slice(1).forEach((r, i) => expect(r.before).toEqual(revs[i].after));
      expect(revs.map((r) => r.after?.candidates)).toEqual([["x"], ["from a"], ["from b"]]);
      expect((await rowOf(dbBlock, made.id)).candidates).toEqual(["from b"]);
    }, 60_000);

    it.each([
      ["the deletion first", "delete"],
      ["the change first", "update"],
    ] as const)("a change and a deletion at once: %s", async (_name, firstKind) => {
      const [dbBlock, dbA, dbB] = await Promise.all([scratch.open("blocker"), scratch.open("op-a"), scratch.open("op-b")]);
      const { actor, term, input } = await glossaryWorld(dbBlock);
      const made = await createGlossaryEntry(dbBlock, actor, input);
      if (!made.ok) throw new Error("create failed");
      const blocker = holdTx(dbBlock, (tx) => tx.select().from(glossaryEntries).where(eq(glossaryEntries.id, made.id)).for("update"));
      await blocker.ready;
      const run = {
        delete: (db: Db) => deleteGlossaryEntry(db, actor, made.id),
        update: (db: Db) => updateGlossaryEntry(db, actor, made.id, { term, candidates: "changed" }),
      };
      const secondKind = firstKind === "delete" ? "update" : "delete";
      const p1 = run[firstKind](dbA);
      await waitForLockWait(admin, "op-a");
      const p2 = run[secondKind](dbB);
      await waitForLockWait(admin, "op-b");
      await blocker.commit();
      const [r1, r2] = await expectSettlesWithin(Promise.all([p1, p2]), 15_000, "the change and the deletion");
      const revs = await revisionsOf(dbBlock, made.id);
      if (firstKind === "delete") {
        // The deletion came first: the change finds no entry
        expect(r1).toEqual({ ok: true });
        expect(r2).toEqual({ ok: false, error: "not_found" });
        expect(revs.map((r) => [r.before === null, r.after === null])).toEqual([[true, false], [false, true]]);
        expect((await rowOf(dbBlock, made.id)).deletedAt).not.toBeNull();
        expect((await rowOf(dbBlock, made.id)).candidates).toEqual(["x"]);
      } else {
        // The change came first: the deletion records the content after the change as its before
        expect(r1).toEqual({ ok: true, changed: true });
        expect(r2).toEqual({ ok: true });
        expect(revs).toHaveLength(3);
        expect(revs[2].before).toEqual(revs[1].after);
        expect(revs[2].before?.candidates).toEqual(["changed"]);
        expect(revs[2].after).toBeNull();
        expect((await rowOf(dbBlock, made.id)).deletedAt).not.toBeNull();
      }
    }, 60_000);

    it("two additions of the same (term, term language, target language) at once: one goes through, the other is a duplicate; one row, one revision", async () => {
      const [dbBlock, dbA, dbB] = await Promise.all([scratch.open("blocker"), scratch.open("add-a"), scratch.open("add-b")]);
      const { actor, input } = await glossaryWorld(dbBlock);
      // Both wait for the lock on the table, so that they run together once it is released
      const blocker = holdTx(dbBlock, (tx) => tx.execute(sql`lock table glossary_entries in exclusive mode`));
      await blocker.ready;
      const p1 = createGlossaryEntry(dbA, actor, input);
      await waitForLockWait(admin, "add-a");
      const p2 = createGlossaryEntry(dbB, actor, { ...input, candidates: "y" });
      await waitForLockWait(admin, "add-b");
      await blocker.commit();
      const results = await expectSettlesWithin(Promise.all([p1, p2]), 15_000, "the two additions");
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, error: "duplicate" }]);
      const rows = await dbBlock.select().from(glossaryEntries).where(eq(glossaryEntries.term, input.term));
      expect(rows).toHaveLength(1);
      expect(await revisionsOf(dbBlock, rows[0].id)).toHaveLength(1);
    }, 60_000);

    it("re-adding a deleted entry while another addition of the same triple is made: one row, active, and the history goes on (created, deleted, created)", async () => {
      const [dbBlock, dbA, dbB] = await Promise.all([scratch.open("blocker"), scratch.open("rev-a"), scratch.open("rev-b")]);
      const { actor, term, input } = await glossaryWorld(dbBlock);
      const made = await createGlossaryEntry(dbBlock, actor, input);
      if (!made.ok) throw new Error("create failed");
      expect(await deleteGlossaryEntry(dbBlock, actor, made.id)).toEqual({ ok: true });
      const blocker = holdTx(dbBlock, (tx) => tx.select().from(glossaryEntries).where(eq(glossaryEntries.id, made.id)).for("update"));
      await blocker.ready;
      const p1 = createGlossaryEntry(dbA, actor, input);
      await waitForLockWait(admin, "rev-a");
      const p2 = createGlossaryEntry(dbB, actor, { ...input, candidates: "y" });
      await waitForLockWait(admin, "rev-b");
      await blocker.commit();
      const [r1, r2] = await expectSettlesWithin(Promise.all([p1, p2]), 15_000, "the two additions");
      expect(r1).toEqual({ ok: true, id: made.id, revived: true });
      expect(r2).toEqual({ ok: false, error: "duplicate" });
      const rows = await dbBlock.select().from(glossaryEntries).where(eq(glossaryEntries.term, input.term));
      expect(rows).toHaveLength(1);
      expect(rows[0].deletedAt).toBeNull();
      expect((await revisionsOf(dbBlock, made.id)).map((r) => [r.before === null, r.after === null])).toEqual([[true, false], [false, true], [true, false]]);
    }, 60_000);

    describe("an import and a screen edit of the same row", () => {
      // The import decides what to skip ("a person edited this row") from the rows it reads, so it takes a table lock first (lockGlossaryForImport):
      // a screen edit that commits after the import has read the rows must not be overwritten without --overwrite-edited.
      const seeded = async (db: Db) => {
        const { actor, term, input } = await glossaryWorld(db);
        const n = seq;
        await addMember(db, `gmod${n}`, `gmod${n}`, { readLangs: ["ja"] });
        const mod: GlossaryActor = { userId: `gmod${n}`, scope: { operator: false, langs: ["ja"] } };
        const row = (candidates: string[]): GlossaryRowData => ({ term, lang: "en", targetLang: "ja", candidates, note: "", keepOriginal: false, needsReview: false });
        expect(await importGlossaryRows(db, [row(["x"])], { actor })).toMatchObject({ created: 1 });
        const [entry] = await db.select().from(glossaryEntries).where(eq(glossaryEntries.term, term));
        return { actor, mod, term, row, id: entry.id, input };
      };

      it("a screen edit that is still open when an --update import starts: the import waits, then skips the row as edited and keeps the human value", async () => {
        const [dbBlock, dbImport] = await Promise.all([scratch.open("blocker"), scratch.open("imp")]);
        const w = await seeded(dbBlock);
        const editing = holdTx(dbBlock, (tx) => updateGlossaryEntry(tx, w.mod, w.id, { term: w.term, candidates: "human" }));
        expect(await editing.ready).toEqual({ ok: true, changed: true });
        const importing = importGlossaryRows(dbImport, [w.row(["file"])], { actor: w.actor, update: true });
        await waitForLockWait(admin, "imp");
        await expectPending(importing);
        await editing.commit();
        const summary = await expectSettlesWithin(importing, 15_000, "the import");
        expect(summary).toMatchObject({ created: 0, updated: 0, unchanged: 0, skipped: [{ term: w.term, lang: "en", targetLang: "ja", reason: "edited" }] });
        expect((await rowOf(dbBlock, w.id)).candidates).toEqual(["human"]);
        expect((await revisionsOf(dbBlock, w.id)).map((r) => r.via)).toEqual(["import", "admin"]);
      }, 60_000);

      it("an import that is running when a screen edit is saved: the edit waits for the import, and is applied on top of it", async () => {
        const [dbBlock, dbEdit] = await Promise.all([scratch.open("blocker"), scratch.open("scr")]);
        const w = await seeded(dbBlock);
        const importing = holdTx(dbBlock, (tx) => importGlossaryRows(tx, [w.row(["file"])], { actor: w.actor, update: true }));
        expect(await importing.ready).toMatchObject({ updated: 1, skipped: [] });
        const editing = updateGlossaryEntry(dbEdit, w.mod, w.id, { term: w.term, candidates: "human" });
        await waitForLockWait(admin, "scr");
        await expectPending(editing);
        await importing.commit();
        expect(await expectSettlesWithin(editing, 15_000, "the screen edit")).toEqual({ ok: true, changed: true });
        expect((await rowOf(dbBlock, w.id)).candidates).toEqual(["human"]);
        const revs = await revisionsOf(dbBlock, w.id);
        expect(revs.map((r) => r.via)).toEqual(["import", "import", "admin"]);
        // The chain holds: the edit's before is what the import wrote
        expect(revs[2].before?.candidates).toEqual(["file"]);
      }, 60_000);

      it("a dry run does not take the lock: it reads while a screen edit is open", async () => {
        const [dbBlock, dbImport] = await Promise.all([scratch.open("blocker"), scratch.open("imp-dry")]);
        const w = await seeded(dbBlock);
        const editing = holdTx(dbBlock, (tx) => updateGlossaryEntry(tx, w.mod, w.id, { term: w.term, candidates: "human" }));
        await editing.ready;
        const dry = await expectSettlesWithin(importGlossaryRows(dbImport, [w.row(["file"])], { dryRun: true, update: true }), 10_000, "the dry run");
        expect(dry.total).toBe(1);
        await editing.rollback();
      }, 60_000);
    });

    describe("a bulk clear of needs_review and a single edit of one of its rows", () => {
      // Three entries that need review. The blocker holds the lock on the middle one, so that the bulk clear (which locks its rows in id order) and the edit both wait for it;
      // the one that started waiting first gets it first. The bulk clear marks only what the person was shown: an edit that is committed before it makes the middle row
      // stale (the entries named: the other two are marked) or the set another one (all of the language: nothing is marked). An edit after it is applied on top of the clear.
      // Either way the history of the middle entry is an unbroken chain, and the entry holds the last change.
      // Each case has its own target language, because "all of a language" counts every entry of the language in the shared scratch database.
      const SHOWN = new Date(Date.UTC(2026, 9, 5, 0, 0));
      const EDITED = new Date(Date.UTC(2026, 9, 5, 0, 1));
      const CLEARED = new Date(Date.UTC(2026, 9, 5, 0, 2));
      it.each([
        ["the edit first, the entries named", "edit", "ids", "ko"],
        ["the bulk clear first, the entries named", "bulk", "ids", "vi"],
        ["the edit first, all of the language", "edit", "all", "fr"],
        ["the bulk clear first, all of the language", "bulk", "all", "de"],
      ] as const)("%s", async (_name, firstKind, mode, targetLang) => {
        const [dbBlock, dbEdit, dbBulk] = await Promise.all([scratch.open("blocker"), scratch.open("rev-edit"), scratch.open("rev-bulk")]);
        const { actor } = await glossaryWorld(dbBlock);
        const n = seq;
        const rows: number[] = [];
        for (const i of [1, 2, 3]) {
          const made = await createGlossaryEntry(dbBlock, actor, { term: `review-${n}-${i}`, lang: "en", targetLang, candidates: `c${i}`, note: "", needsReview: true }, { now: SHOWN });
          if (!made.ok) throw new Error("create failed");
          rows.push(made.id);
        }
        const [first, middle, last] = rows;
        const middleTerm = `review-${n}-2`;
        // What the person was shown before either write: the rows with their updated_at, and the fingerprint of "all of the language"
        const shown = await Promise.all(rows.map(async (id) => ({ id, updatedAt: (await rowOf(dbBlock, id)).updatedAt.getTime() })));
        const { fingerprint } = await needsReviewSummary(dbBlock, targetLang);
        const blocker = holdTx(dbBlock, (tx) => tx.select().from(glossaryEntries).where(eq(glossaryEntries.id, middle)).for("update"));
        await blocker.ready;
        const run = {
          // A form that was opened before the bulk clear: it still carries needs_review, so an edit after the clear flags the entry again
          edit: (db: Db) => updateGlossaryEntry(db, actor, middle, { term: middleTerm, candidates: "edited", needsReview: true }, { now: EDITED }),
          bulk: (db: Db) => clearNeedsReviewBulk(db, actor, mode === "ids" ? { targetLang, entries: shown, now: CLEARED } : { targetLang, all: { fingerprint }, now: CLEARED }),
        };
        const secondKind = firstKind === "edit" ? "bulk" : "edit";
        const db = { edit: dbEdit, bulk: dbBulk };
        const p1 = run[firstKind](db[firstKind]);
        await waitForLockWait(admin, firstKind === "edit" ? "rev-edit" : "rev-bulk");
        const p2 = run[secondKind](db[secondKind]);
        await waitForLockWait(admin, secondKind === "edit" ? "rev-edit" : "rev-bulk");
        await blocker.commit();
        const [r1, r2] = await expectSettlesWithin(Promise.all([p1, p2]), 15_000, "the bulk clear and the edit");
        const [editResult, bulkResult] = firstKind === "edit" ? [r1, r2] : [r2, r1];
        expect(editResult).toEqual({ ok: true, changed: true });

        const revs = await revisionsOf(dbBlock, middle);
        // The chain: each before is the after of the one before
        revs.slice(1).forEach((r, i) => expect(r.before).toEqual(revs[i].after));
        const row = await rowOf(dbBlock, middle);
        expect({ term: row.term, candidates: row.candidates, note: row.note, keepOriginal: row.keepOriginal, needsReview: row.needsReview }).toEqual(revs.at(-1)!.after);
        // Whether the two entries that nobody edited were marked (each with one revision for the clear)
        let othersCleared = true;
        if (firstKind === "bulk") {
          // The clear, then the edit from the old form: both changes are in the history; the edit flagged the entry again (the last writer wins, nothing is lost)
          expect(bulkResult).toEqual({ ok: true, changed: 3, skipped: 0, forbidden: 0, stale: 0 });
          expect(revs.map((r) => [r.after?.candidates, r.after?.needsReview])).toEqual([[["c2"], true], [["c2"], false], [["edited"], true]]);
          expect(row.needsReview).toBe(true);
        } else {
          // The edit, then the clear: the person never saw the edited candidates, so the middle entry is not marked and gets no revision for a clear
          expect(revs.map((r) => [r.after?.candidates, r.after?.needsReview])).toEqual([[["c2"], true], [["edited"], true]]);
          expect(row.needsReview).toBe(true);
          if (mode === "ids") {
            expect(bulkResult).toEqual({ ok: true, changed: 2, skipped: 0, forbidden: 0, stale: 1 });
          } else {
            // All of the language: the rows are not the ones that were confirmed, so nothing is written
            expect(bulkResult).toEqual({ ok: false, error: "rows_changed", actual: 3 });
            othersCleared = false;
          }
        }
        for (const id of [first, last]) {
          expect((await rowOf(dbBlock, id)).needsReview).toBe(!othersCleared);
          expect((await revisionsOf(dbBlock, id)).map((r) => r.after?.needsReview)).toEqual(othersCleared ? [true, false] : [true]);
        }
      }, 60_000);
    });
  });
  describe("following: the merged followed_thread notification, the automatic follow and the email jobs", () => {
    const T = (minutes: number) => new Date(Date.UTC(2026, 9, 5, 0, minutes));
    // A topic (written by `a`), two followers f1 and f2 (both with the preference `immediate`, so that every notification queues an email job), and two members who reply.
    async function followWorld(db: Db) {
      const n = ++seq;
      const ids = { a: `fa${n}`, f1: `f1x${n}`, f2: `f2x${n}`, x: `fx${n}`, y: `fy${n}` };
      for (const [key, id] of Object.entries(ids)) await addMember(db, id, `${key}${n}`, { readLangs: ["ja"] });
      await db.update(profiles).set({ emailPref: "immediate" }).where(inArray(profiles.userId, [ids.f1, ids.f2]));
      const topic = await createTopic(db, ids.a, { lang: "ja", title: `話題${n}`, body: "本文です。" }, { now: T(0) });
      if (!topic.ok) throw new Error("topic failed");
      for (const f of [ids.f1, ids.f2]) await setFollow(db, f, topic.id, true, { now: T(0) });
      return { ...ids, topic: topic.id, n };
    }
    const followedRows = (db: Db, userId: string) => db.select().from(notifications).where(and(eq(notifications.userId, userId), eq(notifications.kind, "followed_thread"))).orderBy(notifications.id);
    const emailJobs = (db: Db) => db.select().from(jobs).where(eq(jobs.kind, SEND_NOTIFICATION_EMAIL_JOB));

    it("two replies to the same topic at the same time: one unread row per follower, with the count 2, and no deadlock", async () => {
      const [dbBlock, dbReply] = await Promise.all([scratch.open("blocker"), scratch.open("reply")]);
      const w = await followWorld(dbBlock);
      const first = holdTx(dbBlock, (tx) => createReply(tx, w.x, w.topic, { lang: "ja", body: "一つ目" }, { now: T(1) }));
      expect(await first.ready).toMatchObject({ ok: true });
      // the second reply waits for the topic's row (createReply locks it), then merges into the row the first one made
      const second = createReply(dbReply, w.y, w.topic, { lang: "ja", body: "二つ目" }, { now: T(2) });
      await waitForLockWait(admin, "reply");
      await expectPending(second);
      await first.commit();
      const secondReply = await expectSettlesWithin(second, 15_000, "the second reply");
      if (!secondReply.ok) throw new Error("reply failed");
      for (const f of [w.f1, w.f2]) {
        const rows = await followedRows(dbBlock, f);
        expect(rows, f).toHaveLength(1);
        expect(rows[0]).toMatchObject({ mergedCount: 2, entryId: secondReply.id, actorId: w.y, readAt: null, threadId: w.topic });
      }
      // one email job per merged notification (the second merge kept the same job by its dedupe key)
      expect((await emailJobs(dbBlock)).length).toBeGreaterThanOrEqual(2);
    }, 60_000);

    it.each([["the read first", "read"], ["the merge first", "merge"]] as const)("merging a reply into a followed_thread row while the member reads it: %s", async (_name, first) => {
      const [dbBlock, dbOther] = await Promise.all([scratch.open("blocker"), scratch.open("other")]);
      const w = await followWorld(dbBlock);
      await createReply(dbBlock, w.x, w.topic, { lang: "ja", body: "一つ目" }, { now: T(1) });
      expect(await followedRows(dbBlock, w.f1)).toMatchObject([{ mergedCount: 1, readAt: null }]);
      if (first === "read") {
        // the read is open (the row is locked, not committed); the merge waits for it, and then finds no unread row: it makes a new one
        const reading = holdTx(dbBlock, (tx) => markFollowedThreadRead(tx, w.f1, w.topic, T(5)));
        expect(await reading.ready).toBe(1);
        const merging = createReply(dbOther, w.y, w.topic, { lang: "ja", body: "二つ目" }, { now: T(6) });
        await waitForLockWait(admin, "other");
        await expectPending(merging);
        await reading.commit();
        expect((await expectSettlesWithin(merging, 15_000, "the reply")).ok).toBe(true);
        expect((await followedRows(dbBlock, w.f1)).map((r) => [r.mergedCount, r.readAt !== null])).toEqual([[1, true], [1, false]]);
      } else {
        // the merge is open; the read waits for it, then reads the merged row (the count 2 is read together)
        const merging = holdTx(dbBlock, (tx) => createReply(tx, w.y, w.topic, { lang: "ja", body: "二つ目" }, { now: T(6) }));
        expect(await merging.ready).toMatchObject({ ok: true });
        const reading = markFollowedThreadRead(dbOther, w.f1, w.topic, T(7));
        await waitForLockWait(admin, "other");
        await expectPending(reading);
        await merging.commit();
        expect(await expectSettlesWithin(reading, 15_000, "the read")).toBe(1);
        expect((await followedRows(dbBlock, w.f1)).map((r) => [r.mergedCount, r.readAt !== null])).toEqual([[2, true]]);
      }
      // either way there is never a second unread row for the same member and topic
      const unread = (await followedRows(dbBlock, w.f1)).filter((r) => r.readAt === null);
      expect(unread.length).toBeLessThanOrEqual(1);
    }, 60_000);

    it.each([["the reply's automatic follow commits first", "reply"], ["the unfollow commits first", "unfollow"]] as const)("the automatic follow of a reply and the same member's unfollow at the same time: %s", async (_name, first) => {
      const [dbBlock, dbOther] = await Promise.all([scratch.open("blocker"), scratch.open("other")]);
      const w = await followWorld(dbBlock);
      // y has no follows row for the topic yet
      expect(await dbBlock.select().from(follows).where(and(eq(follows.userId, w.y), eq(follows.threadId, w.topic)))).toEqual([]);
      if (first === "reply") {
        const replying = holdTx(dbBlock, (tx) => createReply(tx, w.y, w.topic, { lang: "ja", body: "返信" }, { now: T(1) }));
        expect(await replying.ready).toMatchObject({ ok: true });
        // the unfollow waits for the row that the automatic follow inserted, and then turns it to `unfollowed`
        const unfollowing = setFollow(dbOther, w.y, w.topic, false, { now: T(2) });
        await waitForLockWait(admin, "other");
        await expectPending(unfollowing);
        await replying.commit();
        expect(await expectSettlesWithin(unfollowing, 15_000, "the unfollow")).toEqual({ ok: true, state: "unfollowed" });
      } else {
        const unfollowing = holdTx(dbBlock, (tx) => setFollow(tx, w.y, w.topic, false, { now: T(2) }));
        expect(await unfollowing.ready).toEqual({ ok: true, state: "unfollowed" });
        // the automatic follow finds the row (not committed yet), waits, and then does nothing: it never overwrites the member's choice
        const replying = createReply(dbOther, w.y, w.topic, { lang: "ja", body: "返信" }, { now: T(1) });
        await waitForLockWait(admin, "other");
        await expectPending(replying);
        await unfollowing.commit();
        expect((await expectSettlesWithin(replying, 15_000, "the reply")).ok).toBe(true);
      }
      expect((await dbBlock.select().from(follows).where(and(eq(follows.userId, w.y), eq(follows.threadId, w.topic))))[0].state).toBe("unfollowed");
    }, 60_000);

    it("replies to two topics at the same time that notify the same two followers and queue their email jobs do not wait for each other (the recipients are handled in ascending order)", async () => {
      const [dbBlock, dbA, dbB] = await Promise.all([scratch.open("blocker"), scratch.open("rep-a"), scratch.open("rep-b")]);
      const w = await followWorld(dbBlock);
      const second = await createTopic(dbBlock, w.a, { lang: "ja", title: `別の話題${w.n}`, body: "本文です。" }, { now: T(0) });
      if (!second.ok) throw new Error("topic failed");
      for (const f of [w.f1, w.f2]) await setFollow(dbBlock, f, second.id, true, { now: T(0) });
      // the first reply is open (its notifications and email jobs are made, not committed); the second must finish while it is open, with no lock to wait for
      const open = holdTx(dbA, (tx) => createReply(tx, w.x, w.topic, { lang: "ja", body: "話題1への返信" }, { now: T(1) }));
      expect(await open.ready).toMatchObject({ ok: true });
      const other = await expectSettlesWithin(createReply(dbB, w.y, second.id, { lang: "ja", body: "話題2への返信" }, { now: T(2) }), 15_000, "the reply to the other topic");
      expect(other.ok).toBe(true);
      await open.commit();
      // and the same with the roles swapped, with both open and then committed in the order that crosses the recipients
      const both = await Promise.all([createReply(dbA, w.x, second.id, { lang: "ja", body: "また2へ" }, { now: T(3) }), createReply(dbB, w.y, w.topic, { lang: "ja", body: "また1へ" }, { now: T(3) })]);
      expect(both.every((r) => r.ok)).toBe(true);
      // every follower has one notification per topic, and one email job per notification
      for (const f of [w.f1, w.f2]) expect((await followedRows(dbBlock, f)).map((r) => r.threadId).sort()).toEqual([w.topic, second.id].sort());
      const jobRows = await emailJobs(dbBlock);
      const keys = jobRows.map((j) => j.dedupeKey);
      expect(new Set(keys).size).toBe(keys.length);
    }, 60_000);

    it("does not claim an opted-in queued email until the producer commits the latest notification", async () => {
      const [dbBlock, dbSend, dbReply] = await Promise.all([scratch.open("blocker"), scratch.open("send"), scratch.open("reply")]);
      await dbBlock.delete(jobs).where(eq(jobs.kind, SEND_NOTIFICATION_EMAIL_JOB));
      const w = await followWorld(dbBlock);
      await dbBlock.update(profiles).set({ emailPref: "none" }).where(inArray(profiles.userId, [w.a, w.f2]));
      await createReply(dbBlock, w.x, w.topic, { lang: "ja", body: "already mailed reply" }, { now: T(1) });
      const [notification] = await followedRows(dbBlock, w.f1);
      // A requeued job may still point to a mailed notification until the next merge commits.
      await dbBlock.update(notifications).set({ emailedAt: T(10) }).where(eq(notifications.id, notification.id));
      const box = createMemoryMailbox();
      const handlers = createNotificationHandlers({ mailer: () => createMailer(box.transport, "a@example.org") });
      const merging = holdTx(dbReply, (tx) => createReply(tx, w.y, w.topic, { lang: "ja", body: "queued boundary reply" }, { now: T(11) }));
      try {
        expect(await merging.ready).toMatchObject({ ok: true });
        // SKIP LOCKED must leave the job alone while its producer holds the queue row.
        expect(await expectSettlesWithin(runDueJobs(dbSend, handlers, { now: T(20), logger: { error() {}, warn() {} } }), 10_000, "the worker")).toMatchObject({ ran: 0 });
      } finally {
        await merging.commit();
      }
      expect(await runDueJobs(dbSend, handlers, { now: T(20), logger: { error() {}, warn() {} } })).toMatchObject({ ran: 1, done: 1 });
      expect(box.sent).toHaveLength(1);
      expect(box.sent[0].text).toContain("queued boundary reply");
      expect((await followedRows(dbBlock, w.f1))[0].emailedAt).toEqual(T(20));
    }, 60_000);

    it.each([["the merge arrives while the email is being sent", "during"], ["the merge comes before the send reads the notification", "before"], ["the merge arrives after the handler's final check", "after"]] as const)("a reply merged into a followed_thread notification whose email job is running: %s", async (_name, when) => {
      const [dbBlock, dbSend, dbReply] = await Promise.all([scratch.open("blocker"), scratch.open("send"), scratch.open("reply")]);
      // the scratch database is shared by the tests of this file: clear the email jobs that earlier tests left, so that only this test's jobs run
      await dbBlock.delete(jobs).where(eq(jobs.kind, SEND_NOTIFICATION_EMAIL_JOB));
      const w = await followWorld(dbBlock);
      await dbBlock.update(profiles).set({ emailPref: "none" }).where(inArray(profiles.userId, [w.a, w.f2]));
      await createReply(dbBlock, w.x, w.topic, { lang: "ja", body: "最初の返信" }, { now: T(1) });
      const box = createMemoryMailbox();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let started!: () => void;
      const sending = new Promise<void>((resolve) => (started = resolve));
      let blocking = when === "during";
      // the mailer's own wait stands for a slow SMTP server: it is not a database lock
      const mailer = createMailer(
        {
          kind: "memory",
          async send(mail) {
            if (blocking) {
              blocking = false;
              started();
              await gate;
            }
            await box.transport.send(mail);
          },
        },
        "a@example.org",
      );
      const handlers = createNotificationHandlers({ mailer: () => mailer });

      if (when === "after") {
        const send = handlers[SEND_NOTIFICATION_EMAIL_JOB];
        let first = true;
        handlers[SEND_NOTIFICATION_EMAIL_JOB] = async (job, ctx) => {
          await send(job, ctx);
          if (first) {
            first = false;
            await createReply(dbReply, w.y, w.topic, { lang: "ja", body: "completion boundary reply" }, { now: T(11) });
          }
        };
        expect(await runDueJobs(dbSend, handlers, { now: T(10), logger: quiet })).toMatchObject({ ran: 1, done: 0, deferred: 1 });
        expect((await followedRows(dbBlock, w.f1))[0].emailedAt).toBeNull();
        expect(await runDueJobs(dbSend, handlers, { now: T(20), logger: quiet })).toMatchObject({ ran: 1, done: 1 });
        expect(box.sent).toHaveLength(2);
        expect(box.sent[1].text).toContain("completion boundary reply");
        return;
      }
      if (when === "before") {
        await createReply(dbReply, w.y, w.topic, { lang: "ja", body: "読まれる前に" }, { now: T(2) });
        expect(await runDueJobs(dbSend, handlers, { now: T(10), logger: quiet })).toMatchObject({ done: 1, deferred: 0 });
        expect(box.sent).toHaveLength(1);
        expect(box.sent[0].text).toContain("読まれる前に");
        expect(await runDueJobs(dbSend, handlers, { now: T(30), logger: quiet })).toMatchObject({ ran: 0 });
        return;
      }
      const running = runDueJobs(dbSend, handlers, { now: T(10), logger: quiet });
      await sending;
      // Another connection merges the notification while the job is running; its next execution is persisted on the queue row.
      const late = await createReply(dbReply, w.y, w.topic, { lang: "ja", body: "送信中に来た返信" }, { now: T(11) });
      if (!late.ok) throw new Error("reply failed");
      expect(await followedRows(dbBlock, w.f1)).toMatchObject([{ mergedCount: 2, entryId: late.id, emailedAt: null }]);
      release();
      expect(await running).toMatchObject({ ran: 1, deferred: 1, done: 0, failed: 0 });
      // the mark did not take: the notification is still to be mailed, and the job waits for the delay
      expect(box.sent).toHaveLength(1);
      expect(box.sent[0].text).toContain("最初の返信");
      expect((await followedRows(dbBlock, w.f1))[0].emailedAt).toBeNull();
      const [job] = await dbBlock.select().from(jobs).where(eq(jobs.kind, SEND_NOTIFICATION_EMAIL_JOB));
      expect(job).toMatchObject({ status: "queued", attempts: 0 });
      expect(await runDueJobs(dbSend, handlers, { now: T(12), logger: quiet })).toMatchObject({ ran: 0 });
      expect(await runDueJobs(dbSend, handlers, { now: T(20), logger: quiet })).toMatchObject({ ran: 1, done: 1 });
      expect(box.sent).toHaveLength(2);
      expect(box.sent[1].text).toContain("送信中に来た返信");
      expect((await followedRows(dbBlock, w.f1))[0].emailedAt).toEqual(T(20));
    }, 60_000);
  });
  // The rebuild of saved renders racing with an edit of the same post.
  describe("the rebuild of the saved renders and an edit of the same post", () => {
    it("the rebuild reads the post before the edit commits and its save waits for the edit's row lock, then writes nothing: the html of the old body never replaces the edit's", async () => {
      const [dbEdit, dbRebuild] = await Promise.all([scratch.open("editor"), scratch.open("rebuilder")]);
      const w = await world(dbEdit);
      // Earlier cases can leave other rows at an old version; this case isolates the one whose save races with an edit.
      await rebuildRenderCache(dbEdit);
      // the post is at an older render version (a deploy raised RENDER_VERSION)
      await dbEdit.update(entries).set({ html: "<p>old</p>", cardHtml: null, htmlVersion: RENDER_VERSION - 1 }).where(eq(entries.id, w.topic));
      // the edit is open: it holds the row (FOR NO KEY UPDATE) and has written the new body, the new html and the current version, uncommitted
      const editing = holdTx(dbEdit, (tx) => editEntry(tx, w.a, w.topic, { title: `話題${w.n}`, body: "編集後の本文。" }));
      expect(await editing.ready).toMatchObject({ ok: true, changed: true });
      // the rebuild sees the committed row (the old body, the old version), draws it and tries its guarded save: UPDATE ... WHERE id = $id AND body = $old body
      const rebuilding = rebuildRenderCache(dbRebuild);
      await waitForLockWait(admin, "rebuilder");
      await expectPending(rebuilding);
      await editing.commit();
      const result = await expectSettlesWithin(rebuilding, 15_000, "the rebuild");
      // after the edit committed, the guard no longer matches (the body changed): nothing was written by the rebuild, and the row is the edit's
      expect(result.entries).toBe(0);
      expect(result.remaining).toBe(0);
      const [row] = await dbEdit.select({ body: entries.body, html: entries.html, htmlVersion: entries.htmlVersion }).from(entries).where(eq(entries.id, w.topic));
      expect(row.body).toBe("編集後の本文。");
      expect(row.html).toContain("編集後の本文。");
      expect(row.html).not.toContain("本文です。");
      expect(row.htmlVersion).toBe(RENDER_VERSION);
    }, 60_000);

    it("a rebuild that finishes first writes its html, and the edit that follows replaces it (the edit stores its own render with the current version)", async () => {
      const [dbEdit, dbRebuild] = await Promise.all([scratch.open("editor2"), scratch.open("rebuilder2")]);
      const w = await world(dbEdit);
      await dbEdit.update(entries).set({ html: "<p>old</p>", cardHtml: null, htmlVersion: RENDER_VERSION - 1 }).where(eq(entries.id, w.topic));
      expect((await rebuildRenderCache(dbRebuild)).entries).toBeGreaterThanOrEqual(1);
      expect((await editEntry(dbEdit, w.a, w.topic, { title: `話題${w.n}`, body: "その後の編集。" })).ok).toBe(true);
      const [row] = await dbEdit.select({ html: entries.html, htmlVersion: entries.htmlVersion }).from(entries).where(eq(entries.id, w.topic));
      expect(row.html).toContain("その後の編集。");
      expect(row.htmlVersion).toBe(RENDER_VERSION);
    }, 60_000);

    it("does not save a human translation rendered from a source snapshot that an overlapping edit replaces", async () => {
      const [dbEdit, dbSave] = await Promise.all([scratch.open("source-editor"), scratch.open("translation-rebuilder")]);
      const w = await world(dbEdit);
      const oldBody = `@bob${w.n} look at this source.`;
      expect((await editEntry(dbEdit, w.a, w.topic, { title: `話題${w.n}`, body: oldBody })).ok).toBe(true);
      const [source] = await dbSave.select().from(entries).where(eq(entries.id, w.topic));
      const text = `@bob${w.n} look at this translation.\n\n${"A long paragraph. ".repeat(100)}`;
      const [tr] = await dbEdit.insert(translations).values({ entryId: w.topic, field: "body", lang: "en", kind: "human", text, sourceHash: source.sourceHash, html: "<p>old cache</p>", cardHtml: null, htmlVersion: RENDER_VERSION - 1 }).returning();
      const mentions = await resolveMentionTargets(dbSave, oldBody);
      const rendered = (await renderTranslationHtml("topic", w.topic, "en", text, mentions));
      expect(rendered.html).toContain('class="mention"');
      const editing = holdTx(dbEdit, tx => editEntry(tx, w.a, w.topic, { title: `話題${w.n}`, body: "The source no longer calls anyone." }));
      expect(await editing.ready).toMatchObject({ ok: true, changed: true });
      const saving = saveRenderedTranslation(dbSave, tr.id, text, rendered, { entryId: w.topic, source: oldBody, sourceHash: source.sourceHash, translationSourceHash: tr.sourceHash });
      await waitForLockWait(admin, "translation-rebuilder");
      await expectPending(saving);
      await editing.commit();
      expect(await expectSettlesWithin(saving, 15_000, "the guarded translation save")).toBe(false);
      const [after] = await dbSave.select().from(translations).where(eq(translations.id, tr.id));
      expect(after.html).toBeNull();
      expect(after.cardHtml).toBeNull();
      expect(after.htmlVersion).toBe(0);
    }, 60_000);
  });
  it("renders an overlapping edit in the source language committed by the first editor", async () => {
    const [dbFirst, dbSecond, dbRead] = await Promise.all([scratch.open("language-first"), scratch.open("language-second"), scratch.open("language-reader")]);
    const w = await world(dbFirst);
    const first = holdTx(dbFirst, tx => editEntry(tx, w.a, w.topic, { title: `話題${w.n}`, body: "First correction", lang: "en" }));
    expect(await first.ready).toMatchObject({ ok: true, changed: true });
    const body = "Later edit[^note]\n\n[^note]: The source language was corrected.";
    const second = editEntry(dbSecond, w.a, w.topic, { title: `話題${w.n}`, body });
    await waitForLockWait(admin, "language-second");
    await expectPending(second);
    await first.commit();
    expect(await expectSettlesWithin(second, 15_000, "the overlapping language edit")).toMatchObject({ ok: true, changed: true });
    const [row] = await dbRead.select().from(entries).where(eq(entries.id, w.topic));
    expect(row).toMatchObject({ body, lang: "en", htmlVersion: RENDER_VERSION });
    expect(row.html).toContain("Later edit");
    expect(row.html).toContain("Footnotes");
    expect(row.html).not.toContain("脚注");
  }, 60_000);

  it.each(["topic", "reply"] as const)("checks a %s form version after waiting for an overlapping edit to commit", async kind => {
    const [firstDb, secondDb] = await Promise.all([scratch.open("version_first"), scratch.open("version_second")]);
    const w = await world(firstDb);
    const id = kind === "topic" ? w.topic : w.reply;
    const [before] = await firstDb.select().from(entries).where(eq(entries.id, id));
    const expectedVersion = entryEditVersion(before);
    const first = holdTx(firstDb, tx => editEntry(tx, w.a, id, { title: before.title, body: "First edit" }, { expectedVersion }));
    expect(await first.ready).toMatchObject({ ok: true });
    const second = editEntry(secondDb, w.a, id, { title: before.title, body: "Old form edit" }, { expectedVersion });
    try { await waitForLockWait(admin, "version_second"); }
    finally { await first.commit(); }
    expect(await expectSettlesWithin(second, 15_000, "the old form edit")).toEqual({ ok: false, error: "edit_conflict" });
    expect((await secondDb.select().from(entries).where(eq(entries.id, id)))[0].body).toBe("First edit");
  }, 60_000);

  describe("two edits of the same post that add the same new mention", () => {
    // Both edits lock the post's row (FOR NO KEY UPDATE), so they run one after the other; the second reads notified_mentions after the first has committed, sees the member as told, and
    // tells nobody. Whatever the order, the member has one notification and one row in notified_mentions.
    it("the second edit waits for the first, and the member gets one notification and one record", async () => {
      const [dbBlock, dbSecond, dbRead] = await Promise.all([scratch.open("blocker"), scratch.open("edit2"), scratch.open("reader")]);
      const w = await world(dbBlock);
      const carol = `c${w.n}`;
      await addMember(dbBlock, carol, `carol${w.n}`, { readLangs: ["ja"] });
      const first = holdTx(dbBlock, (tx) => editEntry(tx, w.a, w.topic, { title: `話題${w.n}`, body: `first edit for @carol${w.n}` }));
      expect(await first.ready).toMatchObject({ ok: true, changed: true });
      const second = editEntry(dbSecond, w.a, w.topic, { title: `話題${w.n}`, body: `second edit for @carol${w.n}, thanks` });
      await waitForLockWait(admin, "edit2");
      await expectPending(second);
      await first.commit();
      expect(await expectSettlesWithin(second, 15_000, "the second edit")).toMatchObject({ ok: true, changed: true });
      const told = await dbRead.select().from(notifications).where(and(eq(notifications.userId, carol), eq(notifications.kind, "mention")));
      expect(told).toHaveLength(1);
      expect(told[0]).toMatchObject({ entryId: w.topic, actorId: w.a });
      expect(await dbRead.select().from(notifiedMentions).where(eq(notifiedMentions.entryId, w.topic))).toHaveLength(1);
      // The text is the second edit's (it ran last), and its rendering has the mention.
      const [row] = await dbRead.select({ body: entries.body, html: entries.html }).from(entries).where(eq(entries.id, w.topic));
      expect(row.body).toBe(`second edit for @carol${w.n}, thanks`);
      expect(row.html).toContain('class="mention"');
    }, 60_000);

    it("two edits that add two different members: each member is told once, and neither edit tells the other's member", async () => {
      const [dbBlock, dbSecond, dbRead] = await Promise.all([scratch.open("blocker"), scratch.open("edit2"), scratch.open("reader")]);
      const w = await world(dbBlock);
      const [c1, c2] = [`c${w.n}`, `d${w.n}`];
      await addMember(dbBlock, c1, `carol${w.n}`, { readLangs: ["ja"] });
      await addMember(dbBlock, c2, `dave${w.n}`, { readLangs: ["ja"] });
      const first = holdTx(dbBlock, (tx) => editEntry(tx, w.a, w.topic, { title: `話題${w.n}`, body: `@carol${w.n}` }));
      await first.ready;
      const second = editEntry(dbSecond, w.a, w.topic, { title: `話題${w.n}`, body: `@carol${w.n} @dave${w.n}` });
      await waitForLockWait(admin, "edit2");
      await first.commit();
      expect(await expectSettlesWithin(second, 15_000, "the second edit")).toMatchObject({ ok: true });
      const kinds = await dbRead.select({ userId: notifications.userId }).from(notifications).where(and(eq(notifications.kind, "mention"), eq(notifications.entryId, w.topic)));
      expect(kinds.map((k) => k.userId).sort()).toEqual([c1, c2]);
      expect(await dbRead.select().from(notifiedMentions).where(eq(notifiedMentions.entryId, w.topic))).toHaveLength(2);
    }, 60_000);
  });
});
