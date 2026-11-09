import { quietLogger as quiet } from "./helpers/logger";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { Db } from "~/lib/db/client.server";
import { entries, jobs, translations } from "~/lib/db/schema";
import { createReply, createTopic, editEntry } from "~/lib/entries.server";
import { createTranslationHandlers } from "~/lib/jobs/translation-jobs.server";
import { runDueJobs } from "~/lib/jobs/queue.server";
import { createFakeEngine, createFakeJudge } from "~/lib/llm/engines/fake.server";
import type { EngineSet } from "~/lib/llm/config.server";
import { requeueTranslations } from "~/lib/translations-requeue.server";
import { addMember, createTestDb } from "./helpers/db";

const t0 = new Date("2026-10-05T00:00:00Z");

const fakeSet = (): EngineSet => ({ primary: createFakeEngine(), secondary: createFakeEngine(), judge: createFakeJudge() });
const noSecondary = (): EngineSet => ({ primary: createFakeEngine(), secondary: null, judge: null });

async function setup() {
  const db = await createTestDb();
  await addMember(db, "u1", "hana");
  const topic = await createTopic(db, "u1", { lang: "ja", title: "題", body: "本文です。" });
  if (!topic.ok) throw new Error("topic failed");
  const reply = await createReply(db, "u1", topic.id, { lang: "ja", body: "返信です。" });
  if (!reply.ok) throw new Error("reply failed");
  return { db, topicId: topic.id, replyId: reply.id };
}

async function runAll(db: Db, engines: EngineSet, now = t0) {
  return runDueJobs(db, createTranslationHandlers({ llm: { engines, env: { DIVERGENCE_SAMPLE_RATE: "1" } } }), { now, logger: quiet, limit: 1000 });
}
// Measure divergence only for sampled translations (DIVERGENCE_SAMPLE_RATE, default 0); here measure all with 1.
const llm = (engines: EngineSet) => ({ engines, env: { DIVERGENCE_SAMPLE_RATE: "1" } });
const queued = (db: Db, kind: string) => db.select().from(jobs).where(and(eq(jobs.kind, kind), eq(jobs.status, "queued")));

describe("requeueTranslations", () => {
  it("queues translate_entry for entries that have no translations at all, once per entry and language", async () => {
    const { db } = await setup();
    await db.delete(jobs); // Entries without translations have no queued jobs.
    const res = await requeueTranslations(db);
    expect(res).toEqual({ entries: 2, translate: 16, divergence: 0, divergenceSkipped: null });
    const rows = await queued(db, "translate_entry");
    expect(rows).toHaveLength(16);
    expect(rows.every((r) => r.maxAttempts === 10)).toBe(true);
    // Deduplication: rerunning does not enqueue additional jobs.
    expect(await requeueTranslations(db)).toMatchObject({ translate: 0 });
    expect(await queued(db, "translate_entry")).toHaveLength(16);
    // Running queued jobs completes translations and leaves nothing to enqueue.
    expect(await runAll(db, noSecondary())).toMatchObject({ done: 24, failed: 0 });
    expect(await requeueTranslations(db)).toMatchObject({ entries: 2, translate: 0 });
  });

  it("rescues failed jobs: only the (entry, language) pairs without a current primary are queued again", async () => {
    const { db, topicId } = await setup();
    await runAll(db, noSecondary());
    // The French body and Simplified Chinese title are missing after failed jobs. The Korean body translation is flagged not to display.
    await db.delete(translations).where(and(eq(translations.entryId, topicId), eq(translations.lang, "fr"), eq(translations.field, "body")));
    await db.delete(translations).where(and(eq(translations.entryId, topicId), eq(translations.lang, "zh-Hans"), eq(translations.field, "title")));
    await db.update(translations).set({ flags: ["link_mismatch"] }).where(and(eq(translations.entryId, topicId), eq(translations.lang, "ko"), eq(translations.field, "body")));
    await db.update(jobs).set({ status: "failed" }); // It remains failed.
    const res = await requeueTranslations(db);
    expect(res.translate).toBe(3);
    const langs = (await queued(db, "translate_entry")).map((j) => (j.payload as { lang: string }).lang).sort();
    expect(langs).toEqual(["fr", "ko", "zh-Hans"]);
    // Running translates only missing fields without retranslating the rest.
    const calls: string[] = [];
    const base = createFakeEngine();
    const engine = { ...base, translate: async (r: Parameters<typeof base.translate>[0]) => (calls.push(`${r.to}:${r.text}`), base.translate(r)) };
    await runAll(db, { primary: engine, secondary: null, judge: null }, new Date(t0.getTime() + 1000));
    expect(calls.sort()).toEqual(["fr:本文です。", "ko:本文です。", "zh-Hans:題", "zh-Hans:題"]);
    expect(await requeueTranslations(db)).toMatchObject({ translate: 0 });
  });

  it("queues entries whose primary is from an older source (an edit whose jobs failed), skips deleted entries, and ignores replies' missing title", async () => {
    const { db, topicId, replyId } = await setup();
    await runAll(db, noSecondary());
    await editEntry(db, "u1", topicId, { title: "題", body: "直した本文です。" });
    await db.update(jobs).set({ status: "failed" });
    await db.update(entries).set({ deletedAt: t0 }).where(eq(entries.id, replyId));
    const res = await requeueTranslations(db);
    expect(res).toMatchObject({ entries: 1, translate: 8 }); // Only the topic body; its title carried over and the reply was deleted.
    expect((await queued(db, "translate_entry")).every((j) => (j.payload as { entryId: number }).entryId === topicId)).toBe(true);
  });

  it("with --divergence also queues the measurement for topics whose divergence was never measured (not replies)", async () => {
    const { db, topicId } = await setup();
    await runAll(db, noSecondary()); // No measurement occurred because there was no secondary.
    await db.delete(jobs);
    const plain = await requeueTranslations(db, { llm: llm(fakeSet()) });
    expect(plain).toMatchObject({ translate: 0, divergence: 0, divergenceSkipped: null });
    const res = await requeueTranslations(db, { divergence: true, llm: llm(fakeSet()) });
    expect(res).toMatchObject({ translate: 0, divergence: 8, divergenceSkipped: null });
    const jobsQueued = await queued(db, "measure_divergence");
    expect(jobsQueued.every((j) => (j.payload as { entryId: number }).entryId === topicId)).toBe(true);
    // No duplicates; after running completes measurement, nothing remains to enqueue.
    expect(await requeueTranslations(db, { divergence: true, llm: llm(fakeSet()) })).toMatchObject({ divergence: 0 });
    expect(await runAll(db, fakeSet(), new Date(t0.getTime() + 1000))).toMatchObject({ done: 8, failed: 0 });
    expect(await requeueTranslations(db, { divergence: true, llm: llm(fakeSet()) })).toMatchObject({ translate: 0, divergence: 0 });
  });

  it("with --divergence reports why nothing was queued when there is no secondary engine or the budget is degraded", async () => {
    const { db } = await setup();
    await runAll(db, noSecondary());
    await db.delete(jobs);
    const none = await requeueTranslations(db, { divergence: true, llm: llm(noSecondary()) });
    expect(none.divergence).toBe(0);
    expect(none.divergenceSkipped).toMatch(/secondary engine|budget/);
    expect(await queued(db, "measure_divergence")).toHaveLength(0);
  });

  it("also queues missing translations together with the divergence when asked", async () => {
    const { db, topicId } = await setup();
    await runAll(db, fakeSet());
    await db.delete(translations).where(and(eq(translations.entryId, topicId), eq(translations.lang, "de"), eq(translations.kind, "primary")));
    await db.delete(jobs);
    const res = await requeueTranslations(db, { divergence: true, llm: llm(fakeSet()) });
    // A missing German primary requires translate_entry followed by measure_divergence. Other languages are already measured.
    expect(res).toMatchObject({ translate: 1, divergence: 0 });
  });
});
