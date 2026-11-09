import { afterEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { addMember, createTestDb } from "./helpers/db";
import { PG_MODE } from "./helpers/pg-test";
import { entries, jobs, translations } from "~/lib/db/schema";
import { createTopic, editEntry } from "~/lib/entries.server";
import { requestBodyTranslations, markTranslationsSeen } from "~/lib/translation-on-read.server";

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
