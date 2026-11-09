import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { entries, jobs } from "~/lib/db/schema";
import { retryFailedTranslations } from "~/lib/jobs/translation-recovery.server";
import { enqueue } from "~/lib/jobs/queue.server";
import { addMember, createTestDb } from "./helpers/db";

const now = new Date("2026-10-17T03:00:00Z");
it("recovers only transient failures on visible current posts, once daily and at most three times", async () => {
  const db = await createTestDb();
  await addMember(db, "writer", "writer");
  const [post] = await db.insert(entries).values({ kind: "topic", authorId: "writer", lang: "ja", body: "source", sourceHash: "h" }).returning();
  const ids: number[] = [];
  for (const [lang, lastError, sourceHash] of [["en", "APIError: 503 service unavailable", "h"], ["fr", "LlmError: invalid translation structure", "h"], ["de", "Error: network fetch failed", "old"]]) {
    const { id } = await enqueue(db, "translate_entry", { entryId: post.id, lang, sourceHash }, { dedupeKey: `${post.id}:${lang}:${sourceHash}` });
    await db.update(jobs).set({ status: "failed", attempts: 10, lastError }).where(eq(jobs.id, id));
    ids.push(id);
  }
  expect(await retryFailedTranslations(db, now)).toBe(1);
  expect((await db.select().from(jobs).where(eq(jobs.id, ids[0])))[0]).toMatchObject({ status: "queued", attempts: 0 });
  await db.update(jobs).set({ status: "failed" }).where(eq(jobs.id, ids[0]));
  expect(await retryFailedTranslations(db, now)).toBe(0);
  for (const day of [18, 19]) {
    expect(await retryFailedTranslations(db, new Date(`2026-10-${day}T03:00:00Z`))).toBe(1);
    await db.update(jobs).set({ status: "failed" }).where(eq(jobs.id, ids[0]));
  }
  expect(await retryFailedTranslations(db, new Date("2026-10-20T03:00:00Z"))).toBe(0);
});

it("does not recover while the budget is stopped or the source/topic is hidden or deleted", async () => {
  const db = await createTestDb();
  await addMember(db, "writer", "writer");
  const [post] = await db.insert(entries).values({ kind: "topic", authorId: "writer", lang: "ja", body: "source", sourceHash: "h" }).returning();
  const [reply] = await db.insert(entries).values({ kind: "reply", threadId: post.id, authorId: "writer", lang: "ja", body: "reply", sourceHash: "r" }).returning();
  for (const entry of [post, reply]) {
    await db.insert(jobs).values({ kind: "translate_entry", payload: { entryId: entry.id, lang: "en", sourceHash: entry.sourceHash }, status: "failed", attempts: 10, lastError: "TimeoutError: network timeout" });
  }
  expect(await retryFailedTranslations(db, now, { LLM_MONTHLY_BUDGET_USD: "0" })).toBe(0);
  await db.update(entries).set({ hiddenAt: now }).where(eq(entries.id, post.id));
  expect(await retryFailedTranslations(db, now)).toBe(0);
  await db.update(entries).set({ hiddenAt: null, deletedAt: now }).where(eq(entries.id, post.id));
  expect(await retryFailedTranslations(db, now)).toBe(0);
});
