import { expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "~/lib/db/client.server";
import { addMember, createTestDb } from "./helpers/db";
import { chatMessages, entries, jobs, villages } from "~/lib/db/schema";
import { softDeleteEntry } from "~/lib/entries.server";
import { deleteChatRows } from "~/lib/village-chat-delete.server";
import { enqueue, runDueJobs, STUCK_AFTER_MS } from "~/lib/jobs/queue.server";
import { paidTranslationCall } from "~/lib/jobs/paid-translation.server";
import { MarkdownBusyError } from "~/lib/markdown-budget.server";

const call = { result: { text: "private paid translation", model: "fixture", promptVersion: "v1", inputTokens: 1, outputTokens: 1 }, costUsdMicro: 1 };
const saved = { paidTranslationCalls: { ["a".repeat(64)]: call } };
const quiet = { warn() {}, error() {} };

async function sourceToDelete(db: Db, source: string) {
  await addMember(db, "author", "author");
  let payload: object, kind: string, remove: () => Promise<unknown>;
  if (source === "entry") {
    const [entry] = await db.insert(entries).values({ kind: "topic", authorId: "author", lang: "ja", body: "source", sourceHash: "h" }).returning();
    payload = { entryId: entry.id }; kind = "translate_entry";
    remove = () => softDeleteEntry(db, entry.id);
  } else {
    const [village] = await db.insert(villages).values({ kind: "open", slug: "cleanup" }).returning();
    const [message] = await db.insert(chatMessages).values({ villageId: village.id, authorId: "author", lang: "ja", body: "source", createdSeq: 1, changedSeq: 1 }).returning();
    payload = { messageId: message.id }; kind = "translate_chat";
    remove = () => db.transaction(tx => deleteChatRows(tx, village.id, "author", message.id));
  }
  return { payload, kind, remove };
}

it.each(["entry", "chat"])("erases %s translation checkpoints in unfinished and failed jobs when its source is deleted", async source => {
  const db = await createTestDb();
  const { payload, kind, remove } = await sourceToDelete(db, source);
  await db.insert(jobs).values(["queued", "running", "done", "failed"].map(status => ({ kind, status, payload: { ...payload, ...(status === "done" ? {} : saved) } })));
  await remove();
  const remaining = await db.select().from(jobs);
  expect(remaining).toHaveLength(3);
  expect(JSON.stringify(remaining)).not.toContain(call.result.text);
  for (const job of remaining) expect(job.payload).not.toHaveProperty("paidTranslationCalls");
});

it("clears paid text on completion and refuses to put it back in a completed job", async () => {
  const db = await createTestDb();
  await enqueue(db, "translate_entry", saved);
  await runDueJobs(db, { translate_entry: async () => {} }, { logger: quiet });
  const [job] = await db.select().from(jobs);
  expect(job.status).toBe("done");
  expect(job.payload).not.toHaveProperty("paidTranslationCalls");
  await expect(db.update(jobs).set({ payload: saved }).where(eq(jobs.id, job.id))).rejects.toThrow();
});

it.each([
  ["translate_entry", "transient", 0, true],
  ["translate_title", "transient", 2, true],
  ["translate_entry", "transient", 3, false],
  ["translate_chat", "transient", 0, false],
  ["retranslate_after_report", "transient", 0, false],
  ["translate_entry", "permanent", 0, false],
] as const)("retains failed %s checkpoints only for daily recovery (%s, count %i)", async (kind, failure, automaticRetryCount, retain) => {
  const db = await createTestDb();
  await enqueue(db, kind, { ...saved, automaticRetryCount }, { maxAttempts: 1 });
  await runDueJobs(db, { [kind]: async () => { throw failure === "transient" ? new MarkdownBusyError() : Object.assign(new Error("refusal"), { retryable: false }); } }, { now: new Date(Date.now() + 1000), logger: quiet });
  const [job] = await db.select().from(jobs);
  expect(job.status).toBe("failed");
  expect(Object.hasOwn(job.payload as object, "paidTranslationCalls")).toBe(retain);
});

it("clears an exhausted abandoned worker's checkpoint", async () => {
  const db = await createTestDb(), now = new Date();
  await db.insert(jobs).values({ kind: "translate_entry", status: "running", attempts: 1, maxAttempts: 1, lockedAt: new Date(now.getTime() - STUCK_AFTER_MS - 1), payload: saved });
  await runDueJobs(db, {}, { now });
  expect((await db.select().from(jobs))[0].payload).not.toHaveProperty("paidTranslationCalls");
});

it.each(["entry", "chat"])("cannot restore deleted %s text when an in-flight paid call later fails inspection", async source => {
  const db = await createTestDb();
  const { payload, kind, remove } = await sourceToDelete(db, source);
  let started!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  await enqueue(db, kind, payload);
  const running = runDueJobs(db, { [kind]: async () => {
    await paidTranslationCall("a".repeat(64), async () => { started(); await gate; return call; });
    throw new MarkdownBusyError();
  } }, { now: new Date(Date.now() + 1000), logger: quiet, limit: 1 });
  await ready;
  try { await remove(); }
  finally { release(); }
  await running;
  expect(JSON.stringify(await db.select().from(jobs))).not.toContain(call.result.text);
  expect((await db.select().from(jobs))[0].payload).not.toHaveProperty("paidTranslationCalls");
});

it("checkpoints a new paid result after a deleted source is restored", async () => {
  const db = await createTestDb();
  const { payload, kind, remove } = await sourceToDelete(db, "entry");
  const now = new Date(Date.now() + 1000);
  const { id } = await enqueue(db, kind, payload, { runAt: now });
  await db.update(jobs).set({ status: "running" }).where(eq(jobs.id, id));
  await remove();
  // Simulate the interrupted execution returning to queued, then source restore.
  await db.update(jobs).set({ status: "queued" }).where(eq(jobs.id, id));
  await db.update(entries).set({ deletedAt: null }).where(eq(entries.id, (payload as { entryId: number }).entryId));
  let calls = 0, inspected = false;
  const handlers = { [kind]: async () => {
    await paidTranslationCall("a".repeat(64), async () => { calls++; return call; });
    if (!inspected) { inspected = true; throw new MarkdownBusyError(); }
  } };
  expect(await runDueJobs(db, handlers, { now, logger: quiet })).toMatchObject({ retried: 1 });
  expect((await db.select().from(jobs))[0].payload).toHaveProperty("paidTranslationCalls");
  expect(await runDueJobs(db, handlers, { now: new Date(now.getTime() + 31_000), logger: quiet })).toMatchObject({ done: 1 });
  expect(calls).toBe(1);
});
