import { createElement } from "react";
import { and, eq } from "drizzle-orm";
import { afterEach, expect, it, vi } from "vitest";
import { addMember, createTestDb } from "./helpers/db";
import { renderInRouter } from "./helpers/render-in-router";
import { parseThreadBlocks } from "./helpers/md";
import { entries, jobs, llmUsage } from "~/lib/db/schema";
import { createReply, createTopic } from "~/lib/entries.server";
import { loadEntryDisplays, loadTitleDisplays, type DisplayInput } from "~/lib/entry-display.server";
import { loadReasonExcerpts } from "~/lib/reasons.server";
import { buildThreadMarkdown } from "~/lib/md/thread.server";
import { getBudgetStatus, releaseReservation, reserveUsage } from "~/lib/llm/usage.server";
import { enqueue, runDueJobs } from "~/lib/jobs/queue.server";
import { createTranslationHandlers } from "~/lib/jobs/translation-jobs.server";
import { TRANSLATE_JOB, translateDedupeKey } from "~/lib/translations.server";
import { requestBodyTranslations } from "~/lib/translation-on-read.server";
import { resetTranslationWaitCache } from "~/lib/translation-wait.server";
import { TranslatedEntry } from "~/components/translated-entry";
import { m } from "~/paraglide/messages.js";

vi.mock("~/paraglide/messages.js", async () => ({ m: (await import("./helpers/messages-json")).jsonMessages() }));
afterEach(() => { vi.unstubAllEnvs(); resetTranslationWaitCache(); });
const logger = { warn() {}, error() {} };

it("shows reservation waits per post and language, then displays the admitted translation", async () => {
  vi.stubEnv("LLM_MONTHLY_BUDGET_USD", "1");
  const db = await createTestDb();
  await addMember(db, "budget_writer", "budget_writer");
  const made = await createTopic(db, "budget_writer", { lang: "ja", title: "原題", body: "元の本文。" });
  if (!made.ok) throw new Error(made.error);
  const reply = await createReply(db, "budget_writer", made.id, { lang: "ja", body: "返信の本文。" });
  if (!reply.ok) throw new Error(reply.error);
  const rows = await db.select().from(entries);
  const inputs = rows.map(row => ({ ...row, kind: row.kind as DisplayInput["kind"], lang: "ja" as const }));
  await db.delete(jobs);
  const now = new Date();
  await db.insert(llmUsage).values({ engine: "fake", model: "fake", purpose: "translate", costUsdMicro: 850_000, createdAt: now });
  for (const input of inputs) {
    const payload = { entryId: input.id, lang: "en" as const, sourceHash: input.sourceHash! };
    await enqueue(db, TRANSLATE_JOB, payload, { dedupeKey: translateDedupeKey(payload, "ja"), runAt: now });
  }
  const defer = async () => {
    await reserveUsage(db, { engine: "fake", model: "fake", purpose: "translate", role: "primary", estimateMicro: 200_000, now });
  };
  expect(await runDueJobs(db, { [TRANSLATE_JOB]: defer }, { now, logger })).toMatchObject({ deferred: 2, failed: 0 });
  expect((await getBudgetStatus(db)).state).toBe("degraded");
  const options = { displayLang: "en" as const, readLangs: [], browser: new Set(inputs.map(row => row.id)) };
  const paused = await loadEntryDisplays(db, inputs, options);
  for (const input of inputs) {
    const display = paused.get(input.id)!;
    expect(display).toMatchObject({ wait: { kind: "stopped" }, needsCurrent: true, pending: true });
    const html = await renderInRouter(() => createElement(TranslatedEntry, { ...input, html: input.html!, display, meta: null }));
    expect(html).toContain(m.label_no_translation());
    expect(html).not.toContain(m.translation_working());
  }
  expect((await loadTitleDisplays(db, inputs.filter(row => row.kind === "topic"), options)).get(made.id)?.wait).toEqual({ kind: "stopped" });
  expect((await loadEntryDisplays(db, inputs, { ...options, displayLang: "fr" })).get(made.id)?.wait).toBeUndefined();
  const reasons = await loadReasonExcerpts(db, inputs, options);
  for (const input of inputs) expect(reasons.get(input.id)?.wait).toEqual({ kind: "stopped" });
  const originalWork = await db.select().from(jobs);
  for (const request of [false, true]) expect(await requestBodyTranslations(db, inputs, "en", request)).toMatchObject({ paused: inputs.map(row => row.id), stopped: false, ready: [] });
  expect(await db.select().from(jobs)).toEqual(originalWork);
  const blocks = parseThreadBlocks((await buildThreadMarkdown(db, made.id, { page: 1, lang: "all", sentences: false, k: null, readerId: "budget_writer" }))!);
  for (const block of blocks.filter(block => ["post", "comment"].includes(String(block.fm.type)))) {
    expect(block.fm).toMatchObject({ translations_pending_reason: "unavailable" });
    expect(block.fm.translations_pending).toContain("en");
    expect(block.fm).not.toHaveProperty("translations_resume");
  }
  // A different revision, title job, or running admission does not pause this body.
  const input = inputs[0];
  const [job] = originalWork.filter(job => (job.payload as { entryId: number }).entryId === input.id);
  for (const update of [{ payload: { ...(job.payload as object), sourceHash: "old" } }, { kind: "translate_title" }, { status: "running" }]) {
    await db.update(jobs).set(update).where(eq(jobs.id, job.id));
    expect((await loadEntryDisplays(db, [input], options)).get(input.id)?.wait).toBeUndefined();
    if (update.status === "running") expect(await requestBodyTranslations(db, inputs, "en", false)).toMatchObject({ paused: [inputs[1].id], stopped: false });
    await db.update(jobs).set({ payload: job.payload, kind: job.kind, status: job.status }).where(eq(jobs.id, job.id));
  }
  vi.stubEnv("LLM_MONTHLY_BUDGET_USD", "2");
  const reservation = await reserveUsage(db, { engine: "fake", model: "fake", purpose: "translate", role: "primary", estimateMicro: 200_000, now });
  await releaseReservation(db, reservation);
  await db.update(jobs).set({ runAt: now }).where(and(eq(jobs.kind, TRANSLATE_JOB), eq(jobs.status, "queued")));
  expect(await runDueJobs(db, createTranslationHandlers(), { now, logger })).toMatchObject({ done: 2, deferred: 0 });
  const ready = await loadEntryDisplays(db, inputs, options);
  for (const input of inputs) {
    expect(ready.get(input.id)).toMatchObject({ shown: "translation", pending: false });
    expect(ready.get(input.id)?.needsCurrent).toBeUndefined();
    expect(ready.get(input.id)?.translation?.html).toContain("[en]");
  }
});
