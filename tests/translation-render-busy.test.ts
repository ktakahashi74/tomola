import { eq } from "drizzle-orm";
import { afterEach, expect, it, vi } from "vitest";
import * as entryService from "~/lib/entries.server";
import { jobs, llmUsage, translations } from "~/lib/db/schema";
import { createTranslationHandlers } from "~/lib/jobs/translation-jobs.server";
import { runDueJobs } from "~/lib/jobs/queue.server";
import { createFakeEngine } from "~/lib/llm/engines/fake.server";
import { MarkdownBusyError } from "~/lib/markdown-budget.server";
import { addMember, createTestDb } from "./helpers/db";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
it("keeps the paid translation when rendering is busy and never translates it again", async () => {
  vi.stubEnv("ENABLED_LANGS", "ja,en");
  const db = await createTestDb();
  await addMember(db, "writer", "writer");
  const topic = await entryService.createTopic(db, "writer", { lang: "ja", body: "本文。" });
  if (!topic.ok) throw new Error(`topic failed: ${JSON.stringify(topic)}`);
  vi.spyOn(entryService, "tryRenderTranslationHtml").mockRejectedValueOnce(new MarkdownBusyError());
  const engine = createFakeEngine();
  const call = vi.spyOn(engine, "translate");
  const handlers = createTranslationHandlers({ llm: { engines: { primary: engine, secondary: null, judge: null } } });
  const now = new Date(Date.now() + 1000);
  expect(await runDueJobs(db, handlers, { now })).toMatchObject({ done: 1, failed: 0, retried: 0 });
  expect((await db.select().from(translations))[0]).toMatchObject({ text: "[en] 本文。", htmlVersion: 0, html: null });
  await db.update(jobs).set({ status: "queued" }).where(eq(jobs.kind, "translate_entry"));
  await runDueJobs(db, handlers, { now });
  expect(call).toHaveBeenCalledTimes(1);
  expect(await db.select().from(llmUsage)).toHaveLength(1);
});
