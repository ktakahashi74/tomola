import { eq } from "drizzle-orm";
import { afterEach, expect, it, vi } from "vitest";
import { addMember, createTestDb } from "./helpers/db";
import { chatMessages, chatMessageTranslations, jobs, villages } from "~/lib/db/schema";
import { resumeBudgetWaits } from "~/lib/jobs/budget-wait.server";
import { BUDGET_RESERVATION_WAIT } from "~/lib/jobs/defer-reasons";
import { getWorkerProgress, startWorker, type Worker } from "~/lib/jobs/worker.server";
import { BudgetPausedError } from "~/lib/llm/errors.server";
import { budgetResumeAt } from "~/lib/llm/usage.server";

let worker: Worker | null = null;
afterEach(async () => { await worker?.stop(); worker = null; vi.useRealTimers(); });
const marker = `deferred: [${BUDGET_RESERVATION_WAIT}] waiting`;

it("advances only queued reservation waits and matching paused chat work at startup", async () => {
  const db = await createTestDb();
  await addMember(db, "startup_writer", "startup_writer");
  const [village] = await db.insert(villages).values({ slug: "startup-chat", kind: "open" }).returning();
  const [message] = await db.insert(chatMessages).values({ villageId: village.id, authorId: "startup_writer", lang: "ja", body: "こんにちは。", createdSeq: 1, changedSeq: 1 }).returning();
  const sourceHash = "a".repeat(64);
  await db.insert(chatMessageTranslations).values({ messageId: message.id, lang: "en", sourceHash, state: "paused", errorCode: "budget" });
  const now = new Date();
  const future = new Date(now.getTime() + 900_000);
  const common = { runAt: future, attempts: 2, updatedAt: new Date(now.getTime() - 1000) };
  const rows = await db.insert(jobs).values([
    { ...common, kind: "translate_entry", lastError: marker },
    { ...common, kind: "translate_chat", payload: { messageId: message.id, lang: "en", sourceHash } },
    { ...common, kind: "translate_entry", lastError: "deferred: provider busy" },
    { ...common, kind: "translate_entry", lastError: `unrelated ${marker}` },
    { ...common, kind: "translate_entry", status: "failed", lastError: marker },
    { ...common, kind: "translate_entry", status: "running", lockedAt: now, lastError: marker },
    { ...common, kind: "translate_entry", status: "done", lastError: marker },
    { ...common, kind: "translate_chat", payload: { messageId: message.id, lang: "en", sourceHash: "b".repeat(64) } },
    { ...common, kind: "translate_chat", payload: { messageId: message.id, lang: "fr", sourceHash } },
    { ...common, kind: "translate_chat_report", payload: { messageId: message.id, lang: "en", sourceHash } },
    { ...common, kind: "translate_entry", lastError: marker, runAt: new Date(now.getTime() - 1000) },
  ]).returning();
  await resumeBudgetWaits(db, now);
  for (const [index, row] of rows.entries()) {
    const [after] = await db.select().from(jobs).where(eq(jobs.id, row.id));
    expect(after).toEqual(index < 2 ? { ...row, runAt: now, updatedAt: now } : row);
  }
});

it("wakes waits once per worker start and leaves an unaffordable retry on its fifteen minute schedule", async () => {
  const db = await createTestDb();
  const now = new Date();
  const [row] = await db.insert(jobs).values({ kind: "budget_probe", lastError: marker, runAt: new Date(now.getTime() + 900_000) }).returning();
  const called = vi.fn(async () => { throw new BudgetPausedError("degraded", budgetResumeAt(), "primary", "insufficient"); });
  worker = startWorker({ env: {}, signals: false, intervalMs: 20, getDb: async () => db, handlers: { budget_probe: called } });
  await vi.waitFor(() => expect(called).toHaveBeenCalledTimes(1), { timeout: 10_000 });
  await vi.waitFor(async () => {
    const [after] = await db.select().from(jobs).where(eq(jobs.id, row.id));
    expect(after).toMatchObject({ status: "queued", attempts: 0 });
    expect(after.runAt.getTime()).toBeGreaterThan(Date.now() + 800_000);
  });
  const completed = getWorkerProgress().lastTickCompletedAt;
  await vi.waitFor(() => expect(getWorkerProgress().lastTickCompletedAt).toBeGreaterThan(completed ?? 0));
  await worker!.stop();
  expect(called).toHaveBeenCalledTimes(1);
  const [after] = await db.select().from(jobs).where(eq(jobs.id, row.id));
  expect(after.lastError).toContain(`[${BUDGET_RESERVATION_WAIT}]`);
});
