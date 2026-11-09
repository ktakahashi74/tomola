import { quietLogger as quiet } from "./helpers/logger";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { divergences, entries, translations } from "~/lib/db/schema";
import { createTopic, softDeleteEntry } from "~/lib/entries.server";
import { createTranslationHandlers, entryStillCurrent } from "~/lib/jobs/translation-jobs.server";
import { runDueJobs } from "~/lib/jobs/queue.server";
import { createFakeEngine, createFakeJudge } from "~/lib/llm/engines/fake.server";
import { hideEntry } from "~/lib/moderation.server";
import { addMember, createTestDb } from "./helpers/db";
import { PG_MODE } from "./helpers/pg-test";

// Before saving translations or divergence, lock the entry row and recheck that its version is current and it is neither deleted nor hidden.
// Deletion or hiding during translation must leave no translation or divergence for that entry.

const OP = { id: "op", scope: { operator: true, langs: [] as never[] } };

async function setup() {
  const db = await createTestDb();
  await addMember(db, "author", "hana");
  await addMember(db, "op", "opal");
  const topic = await createTopic(db, "author", { lang: "ja", title: "題", body: "本文。DIVERGE-HIGH の文。" });
  if (!topic.ok) throw new Error("topic failed");
  return { db, topic: topic.id };
}

describe("a translation or a divergence is not saved for a post that was deleted or hidden while the job was running", () => {
  it.skipIf(!PG_MODE)("title locks allow foreign-key inserts while serializing title saves and blocking source edits", { tags: ["postgres"] }, async () => {
    const { db, topic } = await setup();
    const [source] = await db.select().from(entries).where(eq(entries.id, topic));
    let release!: () => void;
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const holding = db.transaction(async tx => {
      expect(await entryStillCurrent(tx, topic, source.sourceHash!, source.mentionRevision, "no key update")).toBe(true);
      started();
      await gate;
    });
    await ready;
    try {
      await db.transaction(async tx => {
        await tx.execute(sql`set local lock_timeout = '500ms'`);
        await tx.insert(entries).values({ kind: "reply", threadId: topic, parentId: topic, authorId: "author", lang: "ja", body: "Reply while the title saves" });
      });
      for (const mode of ["title", "edit"] as const) {
        const blocked = await db.transaction(async tx => {
          await tx.execute(sql`set local lock_timeout = '500ms'`);
          if (mode === "title") await entryStillCurrent(tx, topic, source.sourceHash!, source.mentionRevision, "no key update");
          else await tx.update(entries).set({ body: "Changed" }).where(eq(entries.id, topic));
        }).then(() => null, error => error.cause?.code ?? error.code);
        expect(blocked).toBe("55P03");
      }
    } finally {
      release();
      await holding;
    }
  });

  it("does not save the primary translation after a deletion on the way, and leaves no translation behind", async () => {
    const { db, topic } = await setup();
    const engine = createFakeEngine();
    let done = false;
    const deleting = {
      ...engine,
      translate: async (req: Parameters<typeof engine.translate>[0]) => {
        if (!done) {
          done = true;
          await softDeleteEntry(db, topic);
        }
        return engine.translate(req);
      },
    };
    const handlers = createTranslationHandlers({ llm: { engines: { primary: deleting, secondary: null, judge: null }, env: {} } });
    await runDueJobs(db, handlers, { now: new Date(), logger: quiet, limit: 100 });
    expect(done).toBe(true);
    expect(await db.select().from(translations).where(eq(translations.entryId, topic))).toEqual([]);
  });

  it("does not record divergences or the judged mark when the post is hidden while the judge runs", async () => {
    const { db, topic } = await setup();
    const judge = createFakeJudge();
    let hidden = false;
    const hidingJudge = {
      ...judge,
      judge: async (req: Parameters<typeof judge.judge>[0]) => {
        if (!hidden) {
          hidden = true;
          await hideEntry(db, OP, { entryId: topic, reason: "spam", note: "n" });
        }
        return judge.judge(req);
      },
    };
    const handlers = createTranslationHandlers({ llm: { engines: { primary: createFakeEngine(), secondary: createFakeEngine(), judge: hidingJudge }, env: { DIVERGENCE_SAMPLE_RATE: "1" } } });
    // Divergence-measurement jobs follow the eight-language translation jobs; run them all.
    await runDueJobs(db, handlers, { now: new Date(Date.now() + 3_600_000), logger: quiet, limit: 500 });
    expect(hidden).toBe(true);
    expect(await db.select().from(divergences).where(eq(divergences.entryId, topic))).toEqual([]);
    const secondary = await db.select().from(translations).where(eq(translations.entryId, topic));
    expect(secondary.filter((t) => t.kind === "secondary" && t.flags.includes("judged"))).toEqual([]);
  });

  it("the check made inside the saving transaction refuses a changed, hidden, deleted or missing post, and accepts the current one", async () => {
    const { db, topic } = await setup();
    const { entries } = await import("~/lib/db/schema");
    const [row] = await db.select({ hash: entries.sourceHash }).from(entries).where(eq(entries.id, topic));
    const check = (hash: string, id = topic) => db.transaction((tx) => entryStillCurrent(tx, id, hash));
    expect(await check(row.hash!)).toBe(true);
    expect(await check("another-version")).toBe(false);
    expect(await check(row.hash!, 424242)).toBe(false);
    await hideEntry(db, OP, { entryId: topic, reason: "spam", note: "n" });
    expect(await check(row.hash!)).toBe(false);
    const { unhideEntry } = await import("~/lib/moderation.server");
    await unhideEntry(db, OP, { entryId: topic, reason: "other" });
    expect(await check(row.hash!)).toBe(true);
    await softDeleteEntry(db, topic);
    expect(await check(row.hash!)).toBe(false);
  });

  it("still saves everything for a post that stays visible (the same jobs, without the interruption)", async () => {
    const { db, topic } = await setup();
    const handlers = createTranslationHandlers({ llm: { engines: { primary: createFakeEngine(), secondary: createFakeEngine(), judge: createFakeJudge() }, env: { DIVERGENCE_SAMPLE_RATE: "1" } } });
    await runDueJobs(db, handlers, { now: new Date(Date.now() + 3_600_000), logger: quiet, limit: 500 });
    const rows = await db.select().from(translations).where(eq(translations.entryId, topic));
    expect(rows.filter((t) => t.kind === "primary").length).toBeGreaterThan(0);
    expect((await db.select().from(divergences).where(eq(divergences.entryId, topic))).length).toBeGreaterThan(0);
  });
});
