import { afterEach, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { addMember, createTestDb } from "./helpers/db";
import { deferred } from "./helpers/deferred";
import { PG_MODE } from "./helpers/pg-test";
import { entries, jobs, llmUsage, translations } from "~/lib/db/schema";
import { createTopic, editEntry } from "~/lib/entries.server";
import { requestBodyTranslations, markTranslationsSeen, translationPageInputs } from "~/lib/translation-on-read.server";
import { primaryModelOf } from "~/lib/llm/config.server";
import { createFakeEngine } from "~/lib/llm/engines/fake.server";
import { translationEstimate } from "~/lib/llm/metering.server";
import { getMonthlyCostMicro, reserveUsage } from "~/lib/llm/usage.server";
import { runDueJobs } from "~/lib/jobs/queue.server";
import { createTranslationHandlers } from "~/lib/jobs/translation-jobs.server";

afterEach(() => vi.unstubAllEnvs());
it.skipIf(!PG_MODE)("concurrent browser requests queue one revision, preserve its priority, and mark one first display", { tags: ["postgres"] }, async () => {
  vi.stubEnv("TRANSLATION_EAGER_SCOPE", "readers");
  const db = await createTestDb(); await addMember(db, "ondemand", "ondemand_author");
  const result = await createTopic(db, "ondemand", { lang: "ja", title: "原題", body: "本文。" });
  if (!result.ok) throw new Error(result.error);
  await db.delete(jobs);
  const [row] = await db.select().from(entries).where(eq(entries.id, result.id));
  const source = { ...row, lang: "ja" as const, kind: "topic" as const };
  await Promise.all(Array.from({ length: 4 }, () => requestBodyTranslations(db, [source], "fr", true)));
  const work = await db.select().from(jobs);
  expect(work).toHaveLength(1); expect(work[0].priority).toBe(1);
  const [translation] = await db.insert(translations).values({ entryId: source.id, field: "body", lang: "fr", kind: "primary", text: "Traduction", sourceHash: source.sourceHash }).returning();
  const marked = await Promise.all(Array.from({ length: 4 }, () => markTranslationsSeen(db, [source], "fr", [translation.id], null)));
  expect(marked.reduce((sum, n) => sum + n, 0)).toBe(1);
  expect((await db.select().from(translations).where(eq(translations.id, translation.id)))[0].everSeen).toBe(true);
  const [authorFirst] = await db.insert(translations).values({ entryId: source.id, field: "body", lang: "en", kind: "primary", text: "Translation", sourceHash: source.sourceHash }).returning();
  const first = new Date();
  expect(await markTranslationsSeen(db, [source], "en", [authorFirst.id], "ondemand", first)).toBe(1);
  expect((await db.select().from(translations).where(eq(translations.id, authorFirst.id)))[0].everSeen).toBe(false);
  const later = await Promise.all(Array.from({ length: 4 }, () => markTranslationsSeen(db, [source], "en", [authorFirst.id], null)));
  expect(later.reduce((sum, n) => sum + n, 0)).toBe(0);
  expect((await db.select().from(translations).where(eq(translations.id, authorFirst.id)))[0]).toMatchObject({ firstSeenAt: first, everSeen: true });
  await db.update(jobs).set({ status: "done" });
  await requestBodyTranslations(db, [source], "fr", true);
  expect(await db.select().from(jobs)).toHaveLength(1);
  expect((await editEntry(db, "ondemand", source.id, { title: "原題", body: "原文を更新。" })).ok).toBe(true);
  await requestBodyTranslations(db, [source], "fr", true); // Stale browser input cannot enqueue the old revision.
  expect((await db.select().from(jobs)).filter(job => job.kind === "translate_entry" && (job.payload as { lang: string }).lang === "fr")).toHaveLength(1);
});

it.skipIf(!PG_MODE)("overlapping page requests defer the larger post and share the worker cap with moderation", { tags: ["postgres"] }, async () => {
  const db = await createTestDb();
  await addMember(db, "page_writer", "page_writer");
  const body = "短い本文。";
  const source = { authorId: "page_writer", lang: "ja", sourceHash: "fixture" };
  const [topic] = await db.insert(entries).values({ ...source, kind: "topic", body }).returning();
  const [long, short] = await db.insert(entries).values(["長い返信。".repeat(400), body].map(text => ({
    ...source, kind: "reply", threadId: topic.id, body: text,
  }))).returning();
  const page = (await translationPageInputs(db, topic.id))!;
  expect(page.map(post => post.id)).toEqual([topic.id, long.id, short.id]);

  vi.stubEnv("TRANSLATION_PRIMARY", "claude");
  const engine = "claude";
  const model = primaryModelOf();
  const now = new Date();
  const estimate = translationEstimate(engine, model, { text: body, from: "ja", to: "en", field: "body" });
  const cap = 6 * estimate;
  vi.stubEnv("LLM_MONTHLY_BUDGET_USD", (cap / 1_000_000).toFixed(6));
  await db.insert(llmUsage).values({ engine, model, purpose: "translate", costUsdMicro: 4 * estimate, createdAt: now });
  const { first, second } = await db.transaction(async tx => {
    await reserveUsage(tx, { engine, model, purpose: "moderation", role: "primary", estimateMicro: estimate, now });
    const first = await requestBodyTranslations(tx, page, "en", true);
    const second = Promise.allSettled([requestBodyTranslations(db, [...page].reverse(), "en", true)]);
    await expect.poll(async () => {
      const { rows: [row] } = await tx.execute(sql`
        select exists (
          select 1 from pg_locks where not granted and pg_backend_pid() = any(pg_blocking_pids(pid))
        ) as waiting
      `) as { rows: { waiting: boolean }[] };
      return row.waiting;
    }).toBe(true);
    return { first, second };
  });
  expect(first).toMatchObject({ paused: [long.id], stopped: false });
  expect(await second).toMatchObject([{ status: "fulfilled", value: { paused: [long.id], stopped: false } }]);
  const work = await db.select().from(jobs).orderBy(jobs.id);
  expect(work.map(job => job.payload)).toEqual([
    expect.objectContaining({ entryId: topic.id }), expect.objectContaining({ entryId: short.id }),
  ]);

  const started = deferred();
  const finish = deferred();
  const fake = createFakeEngine({ model });
  const translate = vi.fn(async (req: Parameters<typeof fake.translate>[0]) => {
    started.resolve();
    await finish.promise;
    return fake.translate(req);
  });
  const handlers = createTranslationHandlers({ llm: { engines: { primary: { id: engine, model, translate }, secondary: null, judge: null } } });
  const due = { now: new Date(), limit: 1, recover: false };
  const running = runDueJobs(db, handlers, due);
  try {
    await Promise.race([started.promise, running.then(stats => { throw new Error(`Expected a provider call, got ${JSON.stringify(stats)}`); })]);
    expect(await getMonthlyCostMicro(db, now)).toBe(cap);
    expect(await runDueJobs(db, handlers, due)).toMatchObject({ deferred: 1, done: 0, failed: 0 });
    expect(translate).toHaveBeenCalledTimes(1);
    expect(await getMonthlyCostMicro(db, now)).toBe(cap);
    const [deferred] = await db.select().from(jobs).where(eq(jobs.id, work[1].id));
    expect(deferred).toMatchObject({ status: "queued", attempts: 0 });
  } finally {
    finish.resolve();
    await running;
  }
  expect(await requestBodyTranslations(db, page, "en", false)).toMatchObject({ ready: [topic.id], paused: [short.id] });
  expect(await getMonthlyCostMicro(db, now)).toBeLessThan(cap);
});
