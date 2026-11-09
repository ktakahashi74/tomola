import { afterEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, addMember } from "./helpers/db";
import { createTopic } from "~/lib/entries.server";
import { entries, jobs, translations, villages } from "~/lib/db/schema";
import { reconcileMissingTranslations } from "~/lib/jobs/translation-backfill.server";
afterEach(() => vi.unstubAllEnvs());
it("defaults closed, respects stopped budgets and bounds missing-translation work", async () => {
  vi.stubEnv("ENABLED_LANGS", "ja,en");
  const db = await createTestDb(); await addMember(db, "qbf_author", "qbf_author");
  for (let n = 0; n < 3; n++) expect((await createTopic(db, "qbf_author", { title: `題${n}`, body: "日本語の本文。", lang: "ja" })).ok).toBe(true);
  await db.delete(jobs);
  expect(await reconcileMissingTranslations(db)).toBe(0);
  expect(await reconcileMissingTranslations(db, { env: { TRANSLATION_BACKFILL_ENABLED: "1", ENABLED_LANGS: "ja,en", LLM_MONTHLY_BUDGET_USD: "0" } })).toBe(0);
  const opts = { env: { TRANSLATION_BACKFILL_ENABLED: "1", ENABLED_LANGS: "ja,en" }, limit: 1 };
  expect(await reconcileMissingTranslations(db, opts)).toBe(1);
  expect((await db.select().from(jobs).where(eq(jobs.kind, "translate_entry")))).toHaveLength(1);
  expect(await reconcileMissingTranslations(db, opts)).toBe(1);
  expect(await reconcileMissingTranslations(db, opts)).toBe(1);
  expect(await reconcileMissingTranslations(db, opts)).toBe(0);
});
it("leaves closed, hidden, deleted, completed and already-jobbed targets alone, regardless of prompt version", async () => {
  vi.stubEnv("ENABLED_LANGS", "ja,en");
  const db = await createTestDb(); await addMember(db, "qbf_scoped", "qbf_scoped");
  const ids: number[] = [];
  for (let n = 0; n < 7; n++) {
    const post = await createTopic(db, "qbf_scoped", { title: `題${n}`, body: `日本語の本文${n}。`, lang: "ja" });
    if (!post.ok) throw new Error("Post failed"); ids.push(post.id);
  }
  await db.delete(jobs);
  const [closed] = await db.insert(villages).values({ kind: "closed" }).returning();
  await db.update(entries).set({ villageId: closed.id }).where(eq(entries.id, ids[0]));
  await db.update(entries).set({ hiddenAt: new Date() }).where(eq(entries.id, ids[1]));
  await db.update(entries).set({ deletedAt: new Date() }).where(eq(entries.id, ids[2]));
  const [complete] = await db.select().from(entries).where(eq(entries.id, ids[3]));
  await db.insert(translations).values(["title", "body"].map(field => ({ entryId: complete.id, field, lang: "en", kind: "primary", text: "Existing translation", sourceHash: complete.sourceHash, promptVersion: "translate-v1" })));
  for (const [index, status] of [[4, "failed"], [5, "done"]] as const) {
    const [entry] = await db.select().from(entries).where(eq(entries.id, ids[index]));
    await db.insert(jobs).values({ kind: "translate_entry", payload: { entryId: entry.id, sourceHash: entry.sourceHash, lang: "en" }, status });
  }
  const opts = { env: { TRANSLATION_BACKFILL_ENABLED: "1", ENABLED_LANGS: "ja,en" } };
  expect(await reconcileMissingTranslations(db, opts)).toBe(1);
  const queued = await db.select().from(jobs).where(eq(jobs.status, "queued"));
  expect(queued.map(row => row.payload)).toEqual(expect.arrayContaining([{ entryId: ids[6], sourceHash: expect.any(String), lang: "en" }]));
  expect(queued.every(row => (row.payload as { entryId: number }).entryId === ids[6])).toBe(true);
  expect(await reconcileMissingTranslations(db, opts)).toBe(0);
});
