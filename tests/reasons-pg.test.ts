import { eq } from "drizzle-orm";
import type pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Db } from "~/lib/db/client.server";
import { reasonSelections } from "~/lib/db/schema";
import { createReply, createTopic } from "~/lib/entries.server";
import { loadReasonsPanel } from "~/lib/reasons.server";
import { NO_SCOPE } from "~/lib/roles.server";
import { addMember } from "./helpers/db";
import { holdTx, waitForLockWait } from "./helpers/pg-concurrency";
import { createScratchDb, REAL_PG_URL, type ScratchDb } from "./helpers/pg-real";

const NOW = new Date("2026-10-02T12:00:00Z");

describe.skipIf(!REAL_PG_URL)("persistent reason draws across PostgreSQL connections", { tags: ["postgres"] }, () => {
  let scratch: ScratchDb;
  let seq = 0;
  beforeAll(async () => { scratch = await createScratchDb(); }, 120_000);
  afterEach(async () => { vi.restoreAllMocks(); await scratch?.closeOpened(); });
  afterAll(async () => { await scratch?.drop(); }, 60_000);

  async function world(db: Db) {
    const suffix = ++seq;
    const first = `reason-a-${suffix}`;
    const second = `reason-b-${suffix}`;
    await addMember(db, first, `rea${suffix}`);
    await addMember(db, second, `reb${suffix}`);
    const topic = await createTopic(db, first, { lang: "ja", title: "Question", body: "A question.", asksStance: true });
    if (!topic.ok) throw new Error("topic failed");
    return { first, second, topic: topic.id, viewer: { userId: first, scope: NO_SCOPE } };
  }

  it("refreshes eligibility when another reader saves a draw after a new reply arrives", async () => {
    const [dbA, dbB] = await Promise.all([scratch.open("reason-a"), scratch.open("reason-b")]);
    const w = await world(dbA);
    let reached!: () => void;
    let resume!: () => void;
    const captured = new Promise<void>((resolve) => { reached = resolve; });
    const gate = new Promise<void>((resolve) => { resume = resolve; });
    const pool = (dbA as Db & { $client: pg.Pool }).$client;
    const query = pool.query.bind(pool) as (...args: unknown[]) => Promise<pg.QueryResult>;
    let firstCandidateRead = true;
    const pausedQuery = async (...args: unknown[]) => {
      const config = args[0] as string | pg.QueryConfig;
      const text = typeof config === "string" ? config : config.text;
      const pause = firstCandidateRead && text.includes('left join "profiles"') && text.includes('"entries"."stance_tag"');
      if (pause) firstCandidateRead = false;
      const result = await query(...args);
      if (pause) { reached(); await gate; }
      return result;
    };
    vi.spyOn(pool, "query").mockImplementation(pausedQuery as typeof pool.query);
    const firstRead = loadReasonsPanel(dbA, w.topic, { viewer: w.viewer, now: NOW });
    try {
      await captured;
      const reply = await createReply(dbB, w.second, w.topic, { lang: "en", body: "New reason", stanceTag: "agree" });
      if (!reply.ok) throw new Error("reply failed");
      const secondRead = await loadReasonsPanel(dbB, w.topic, { viewer: w.viewer, now: NOW });
      expect(secondRead.pick.agree).toEqual([reply.id]);
      resume();
      expect((await firstRead).pick).toEqual(secondRead.pick);
      expect(await dbB.select().from(reasonSelections).where(eq(reasonSelections.questionId, w.topic))).toHaveLength(1);
    } finally { resume(); await firstRead.catch(() => {}); }
  }, 30_000);

  it("waits for an uncommitted first draw and uses its winner rather than drawing again", async () => {
    const [dbA, dbB] = await Promise.all([scratch.open("reason-waiter"), scratch.open("reason-winner")]);
    const w = await world(dbA);
    const original = await createReply(dbB, w.first, w.topic, { lang: "ja", body: "Original reason", stanceTag: "agree" });
    if (!original.ok) throw new Error("reply failed");
    const winner = holdTx(dbB, (tx) => loadReasonsPanel(tx, w.topic, { viewer: w.viewer, now: NOW }));
    const selected = await winner.ready;
    const added = await createReply(dbA, w.second, w.topic, { lang: "en", body: "Later reason", stanceTag: "agree" });
    if (!added.ok) throw new Error("reply failed");
    const waiter = loadReasonsPanel(dbA, w.topic, { viewer: w.viewer, now: NOW });
    try {
      await waitForLockWait(await scratch.admin(), "reason-waiter");
      await winner.commit();
      expect((await waiter).pick).toEqual(selected.pick);
      expect((await waiter).pick.agree).toEqual([original.id]);
      expect((await waiter).pick.agree).not.toContain(added.id);
    } finally { await winner.rollback(); await waiter.catch(() => {}); }
  }, 30_000);
});
