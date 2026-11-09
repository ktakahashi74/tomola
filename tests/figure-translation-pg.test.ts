import sharp from "sharp";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { figureMedia, figureReadings, figureTranslations, jobs } from "~/lib/db/schema";
import { createTopic } from "~/lib/entries.server";
import { createFigureReader } from "~/lib/figure-reading.server";
import { putMedia, deleteMedia } from "~/lib/media-store.server";
import { createFigureHandlers } from "~/lib/jobs/figure-jobs.server";
import { enqueueEntryFigures } from "~/lib/figure-translation.server";
import { createFakeEngine } from "~/lib/llm/engines/fake.server";
import { runDueJobs } from "~/lib/jobs/queue.server";
import { createTestDb, addMember } from "./helpers/db";
import { PG_MODE } from "./helpers/pg-test";
import { quietLogger } from "./helpers/logger";

// Run after the pinned test clock so every staged job is due without
// rewriting run_at or depending on PostgreSQL's sub-millisecond precision.
const jobNow = new Date("2026-10-01T00:00:00Z");
const env = { FIGURE_TRANSLATION: "1", TRANSLATION_PRIMARY: "fake", ENABLED_LANGS: "ja,en" };
describe.skipIf(!PG_MODE)("concurrent figure ownership and deletion", { tags: ["postgres"] }, () => {
  it("deduplicates two concurrent admissions of the same content", { tags: ["postgres"] }, async () => {
    const db = await createTestDb();
    await addMember(db, "figure-pg-a", "figure_pg_a"); await addMember(db, "figure-pg-b", "figure_pg_b");
    const bytes = await sharp({ create: { width: 320, height: 180, channels: 3, background: "white" } }).webp().toBuffer();
    const images = await Promise.all(["figure-pg-a", "figure-pg-b"].map(id => putMedia(db, id, { bytes, width: 320, height: 180 })));
    const topics = await Promise.all(images.map((image, i) => createTopic(db, i ? "figure-pg-b" : "figure-pg-a", { title: "Concurrent source", body: `![figure](${image.url})`, lang: "en" })));
    // Publication uses the process opt-in; explicitly queue within independent
    // transactions with the feature enabled by this test's scoped environment.
    const { vi } = await import("vitest"); vi.stubEnv("FIGURE_TRANSLATION", "1");
    try {
      await Promise.all(topics.map(topic => { if (!topic.ok) throw new Error(topic.error); return db.transaction(tx => enqueueEntryFigures(tx, topic.id)); }));
      expect(await db.select().from(figureReadings)).toHaveLength(1); expect(await db.select().from(figureMedia)).toHaveLength(2);
      expect(await db.select().from(jobs).where(eq(jobs.kind, "read_figure"))).toHaveLength(1);
      let reads = 0; const reader = createFigureReader(env); const read = reader.read; reader.read = async (...args) => { reads++; return read(...args); };
      await runDueJobs(db, createFigureHandlers({ reader, llm: { env } }), { now: jobNow, logger: quietLogger });
      expect(reads).toBe(1); expect(await db.select().from(figureTranslations)).toHaveLength(2);
    } finally { vi.unstubAllEnvs(); }
  });

  it.each(["reading", "translation"])("cannot recreate data after a concurrent deletion during %s", { tags: ["postgres"] }, async phase => {
    const { vi } = await import("vitest"); vi.stubEnv("FIGURE_TRANSLATION", "1"); vi.stubEnv("ENABLED_LANGS", "ja,en");
    try {
      const db = await createTestDb(); await addMember(db, "figure-pg-race", "figure_pg_race");
      const bytes = await sharp({ create: { width: 320, height: 180, channels: 3, background: "white" } }).webp().toBuffer();
      const image = await putMedia(db, "figure-pg-race", { bytes, width: 320, height: 180 });
      const topic = await createTopic(db, "figure-pg-race", { title: "Withdrawal race", body: `![figure](${image.url})`, lang: "en" }); if (!topic.ok) throw new Error(topic.error);
      let entered!: () => void, release!: () => void;
      const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
      const reader = createFigureReader(env), engine = createFakeEngine();
      const handlers = createFigureHandlers({ reader, llm: { env, engines: { primary: engine, secondary: null, judge: null } } });
      const run = (selected = handlers) => runDueJobs(db, selected, { now: jobNow, logger: quietLogger });
      expect(await run({ prepare_figures: handlers.prepare_figures })).toMatchObject({ done: 1, failed: 0 });
      if (phase === "translation") expect(await run({ read_figure: handlers.read_figure })).toMatchObject({ done: 1, failed: 0 });
      if (phase === "reading") { const read = reader.read; reader.read = async (...args) => { entered(); await gate; return read(...args); }; }
      else { const translate = engine.translate; engine.translate = async request => { entered(); await gate; return translate(request); }; }
      const running = run();
      await Promise.race([started, running.then(() => { throw new Error("Figure job finished before entering the deletion race"); })]);
      try { await deleteMedia(db, image.url.slice(7, 71)); } finally { release(); }
      expect(await running).toMatchObject({ failed: 0 });
      expect(await db.select().from(figureReadings)).toEqual([]); expect(await db.select().from(figureTranslations)).toEqual([]);
      for (const row of await db.select().from(jobs).where(eq(jobs.kind, phase === "reading" ? "read_figure" : "translate_figure"))) expect(JSON.stringify(row.payload)).not.toContain("paidTranslationCalls");
    } finally { vi.unstubAllEnvs(); }
  });
});
