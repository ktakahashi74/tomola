import { expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { entries, profiles, topicListingStats, votes } from "~/lib/db/schema";
import { setVote } from "~/lib/votes.server";
import { addMember, createTestDb } from "./helpers/db";

it("previews and repairs missing, stale and unexpected derived rows without changing posts or votes", async () => {
  const { rebuildTopicListingStats } = await import("~/lib/topic-listing-stats.server");
  const db = await createTestDb();
  for (const id of ["rebuild_writer", "rebuild_voter", "rebuild_excluded"]) await addMember(db, id, id);
  const topics = await db.insert(entries).values([0, 1].map(n => ({ kind: "topic", authorId: "rebuild_writer", lang: "en", title: `Topic ${n}`, body: `Body ${n}`, asksStance: n === 0 }))).returning();
  const [reply] = await db.insert(entries).values({ kind: "reply", threadId: topics[0].id, authorId: "rebuild_writer", lang: "en", body: "Reply" }).returning();
  await db.update(profiles).set({ reactionsExcludedAt: new Date() }).where(eq(profiles.userId, "rebuild_excluded"));
  for (const id of ["rebuild_voter", "rebuild_excluded"]) await setVote(db, id, topics[0].id, true);
  await db.update(topicListingStats).set({ insightfulCount: 99, lang: "ja" }).where(eq(topicListingStats.topicId, topics[0].id));
  await db.delete(topicListingStats).where(eq(topicListingStats.topicId, topics[1].id));
  await db.insert(topicListingStats).values({ topicId: reply.id, lang: "en", createdAt: reply.createdAt, lastActivityAt: reply.lastActivityAt });
  const before = await db.select().from(topicListingStats);
  const posts = await db.select().from(entries);
  const originalVotes = await db.select().from(votes);
  expect(await rebuildTopicListingStats(db)).toMatchObject({ mode: "dry-run", topics: 2, missing: 1, different: 1, unexpected: 1 });
  expect(await db.select().from(topicListingStats)).toEqual(before);
  expect(await rebuildTopicListingStats(db, { write: true })).toMatchObject({ mode: "write", topics: 2, missing: 1, different: 1, unexpected: 1 });
  expect(await db.select().from(entries)).toEqual(posts);
  expect(await db.select().from(votes)).toEqual(originalVotes);
  expect(await rebuildTopicListingStats(db)).toMatchObject({ missing: 0, different: 0, unexpected: 0 });
  expect((await db.select().from(topicListingStats).where(eq(topicListingStats.topicId, topics[0].id)))[0]).toMatchObject({ insightfulCount: 1, lang: "en", asksStance: true });
  await setVote(db, "rebuild_voter", topics[0].id, false);
  expect((await db.select().from(topicListingStats).where(eq(topicListingStats.topicId, topics[0].id)))[0].insightfulCount).toBe(0);
});

it("runs the operator command in preview mode unless --write is explicitly given", async () => {
  const { runTopicListingRebuild } = await import("../scripts/rebuild-topic-listing-stats");
  const db = await createTestDb(); await addMember(db, "cli_writer", "cli_writer");
  await db.insert(entries).values({ kind: "topic", authorId: "cli_writer", lang: "en", body: "Topic" });
  await db.delete(topicListingStats);
  const lines: string[] = [];
  let closed = 0;
  const deps = { open: async () => db, close: async () => { closed++; }, output: { log: (line: string) => { lines.push(line); } } };
  await runTopicListingRebuild([], deps);
  expect(await db.select().from(topicListingStats)).toEqual([]);
  await runTopicListingRebuild(["--write"], deps);
  expect(await db.select().from(topicListingStats)).toHaveLength(1);
  expect(lines.map(line => JSON.parse(line).mode)).toEqual(["dry-run", "write"]);
  expect(closed).toBe(2);
});

it("rejects unknown or repeated flags before opening the operator database", async () => {
  const { runTopicListingRebuild } = await import("../scripts/rebuild-topic-listing-stats");
  for (const args of [["--force"], ["--write", "--write"], ["--write", "extra"]]) {
    let opened = false;
    await expect(runTopicListingRebuild(args, { open: async () => { opened = true; throw new Error("must not open"); } })).rejects.toThrow(/usage/i);
    expect(opened).toBe(false);
  }
});
