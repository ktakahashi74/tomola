import { getTableColumns, eq, sql } from "drizzle-orm";
import { expect, it, vi } from "vitest";
import { addMember, createTestDb } from "./helpers/db";
import { createTopic } from "~/lib/entries.server";
import { entries, profiles, readingCounts, villages } from "~/lib/db/schema";
import { countReading, weeklyReadings } from "~/lib/reading-counts.server";

it("atomically increments only anonymous UTC buckets and never stores identifying fields", async () => {
  const db = await createTestDb();
  await addMember(db, "reading_source", "reading_source");
  const topic = await createTopic(db, "reading_source", { lang: "ja", title: "Reading fixture", body: "本文。" });
  if (!topic.ok) throw new Error(topic.error);
  const opts = { method: "browser" as const, lang: "en" as const, source: "ai" as const, now: new Date("2026-11-12T23:30:00Z") };
  await Promise.all([countReading(db, topic.id, opts), countReading(db, topic.id, opts)]);
  const rows = await db.select().from(readingCounts).where(eq(readingCounts.source, "ai"));
  expect(rows).toEqual([{ day: "2026-11-12", method: "browser", sourceLang: "ja", readLang: "en", source: "ai", count: 2 }]);
  expect(Object.keys(getTableColumns(readingCounts)).sort()).toEqual(["count", "day", "method", "readLang", "source", "sourceLang"]);
  const weekly = await weeklyReadings(db, new Date("2026-11-13T00:00:00Z"));
  expect(weekly.since).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(weekly.weeks.at(-1)).toMatchObject({ observed: true, total: 2, translated: 2, pairs: [{ sourceLang: "ja", readLang: "en", count: 2 }] });
  expect(weekly.weeks[0].observed).toBe(false);
});
it("excludes authors, excluded members, hidden/deleted posts and closed villages", async () => {
  const db = await createTestDb();
  await addMember(db, "reading_author", "reading_author");
  await addMember(db, "reading_excluded", "reading_excluded");
  await db.update(profiles).set({ reactionsExcludedAt: new Date() }).where(eq(profiles.userId, "reading_excluded"));
  const topic = await createTopic(db, "reading_author", { lang: "ja", title: "Private fixture", body: "本文。" });
  if (!topic.ok) throw new Error(topic.error);
  const opts = { method: "browser" as const, lang: "ja" as const };
  await countReading(db, topic.id, { ...opts, readerId: "reading_author" });
  await countReading(db, topic.id, { ...opts, readerId: "reading_excluded" });
  await db.update(entries).set({ hiddenAt: new Date() }).where(eq(entries.id, topic.id));
  await countReading(db, topic.id, opts);
  await db.update(entries).set({ hiddenAt: null, deletedAt: new Date() }).where(eq(entries.id, topic.id));
  await countReading(db, topic.id, opts);
  const villageId = "1234567890abcdef1234567890abcdef";
  await db.insert(villages).values({ id: villageId, kind: "closed", name: "Closed", sourceLang: "ja" });
  await db.update(entries).set({ deletedAt: null, villageId }).where(eq(entries.id, topic.id));
  await countReading(db, topic.id, opts);
  expect((await db.select({ total: sql<number>`sum(${readingCounts.count})::int` }).from(readingCounts))[0].total).toBe(0);
});
it("keeps machine methods separate and aggregates them without creating event records", async () => {
  const db = await createTestDb();
  await addMember(db, "reading_tools", "reading_tools");
  const topic = await createTopic(db, "reading_tools", { lang: "ja", title: "Tools", body: "本文。" });
  if (!topic.ok) throw new Error(topic.error);
  for (const method of ["markdown", "api", "mcp", "ai_crawler"] as const) await countReading(db, topic.id, { method, lang: "en", source: "ai" });
  const rows = await db.select().from(readingCounts);
  expect(rows.filter(row => row.count > 0).map(row => [row.method, row.source, row.count]).sort()).toEqual([
    ["ai_crawler", "none", 1], ["api", "none", 1], ["markdown", "none", 1], ["mcp", "none", 1],
  ]);
});

it("contains failures in count-only language resolution without logging their details", async () => {
  const db = await createTestDb();
  await addMember(db, "reading_failure", "reading_failure");
  const topic = await createTopic(db, "reading_failure", { lang: "ja", title: "Failure", body: "本文。" });
  if (!topic.ok) throw new Error(topic.error);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    await expect(countReading(db, topic.id, { method: "ai_crawler", lang: async () => { throw new Error("private IP and user agent"); } })).resolves.toBeUndefined();
    expect(warn.mock.calls).toEqual([["[reading-counts] Could not count read"]]);
    expect((await db.select().from(readingCounts)).every(row => row.count === 0)).toBe(true);
  } finally { warn.mockRestore(); }
});
