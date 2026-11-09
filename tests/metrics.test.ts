import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { entries, profiles, translationReports, user } from "~/lib/db/schema";
import { createReply, createTopic } from "~/lib/entries.server";
import { AREAS, type Lang } from "~/lib/languages";
import {
  aiAssistanceByArea,
  crossAreaDirectionMatrix,
  crossAreaInsightfulRate,
  crossAreaReplyRate,
  crossAreaUpdateRate,
  firstParticipation,
  firstStancesByArea,
  fourWeekRetention,
  getMetrics,
  memberStartAt,
  observationWeeks,
  postsByVia,
  questionLangComposition,
  reportStats,
  stanceDistanceByAreaPair,
  sustainedWritersByArea,
  totalVariationDistance,
  weekStartOf,
  weeklyActiveMembers,
} from "~/lib/metrics.server";
import { changeHomeArea } from "~/lib/profiles.server";
import type { Position } from "~/lib/stances";
import { deleteStanceRecord, loadOwnStances, setStance } from "~/lib/stances.server";
import { setVote } from "~/lib/votes.server";
import { addMember, createTestDb } from "./helpers/db";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const now = new Date("2026-10-01T00:00:00Z");
const ago = (ms: number) => new Date(now.getTime() - ms);

async function world() {
  const db = await createTestDb();
  await addMember(db, "ja1", "hana", { homeArea: "ja" });
  await addMember(db, "ja2", "jiro", { homeArea: "ja" });
  await addMember(db, "en1", "john", { homeArea: "en", readLangs: ["en"] });
  await addMember(db, "th1", "somchai", { homeArea: "th", readLangs: ["th"] });
  await addMember(db, "ot1", "kim", { homeArea: "other", readLangs: ["en"] });
  // ai: the ai_assistance value; "none" when left out (an explicit none), null for a post that states none (written on screen).
  const topic = async (author: string, at: Date, opts: { ai?: string | null } = {}) => {
    const res = await createTopic(db, author, { lang: "ja", title: "t", body: "b", aiAssistance: opts.ai === undefined ? "none" : opts.ai }, { now: at });
    if (!res.ok) throw new Error("topic failed");
    return res.id;
  };
  const reply = async (author: string, threadId: number, at: Date, opts: { ai?: string | null } = {}) => {
    const res = await createReply(db, author, threadId, { lang: "ja", body: "r", aiAssistance: opts.ai === undefined ? "none" : opts.ai }, { now: at });
    if (!res.ok) throw new Error("reply failed");
    return res.id;
  };
  return { db, topic, reply };
}

describe("crossAreaReplyRate", () => {
  // 2026-10-01 is Thursday; the week starts Monday, September 28, and the eight-week period starts August 10.
  const firstWeek = new Date("2026-08-10T00:00:00Z");
  const inWeek = (index: number, hours: number) => new Date(firstWeek.getTime() + index * 7 * DAY + hours * HOUR);

  it("starts weeks on the UTC Monday, whatever the time of the request", () => {
    expect(weekStartOf(new Date("2026-10-01T12:00:00Z"))).toEqual(new Date("2026-09-28T00:00:00Z"));
    expect(weekStartOf(new Date("2026-09-28T00:00:00Z"))).toEqual(new Date("2026-09-28T00:00:00Z"));
    expect(weekStartOf(new Date("2026-10-04T23:59:59Z"))).toEqual(new Date("2026-09-28T00:00:00Z"));
    expect(weekStartOf(new Date("2026-10-05T00:00:00Z"))).toEqual(new Date("2026-10-05T00:00:00Z"));
  });

  it("is the share of topics, per calendar week for 8 weeks (oldest first, this week last), whose replies that week came from 2+ areas", async () => {
    const { db, topic, reply } = await world();
    const old = ago(200 * DAY);
    // Week 7: A spans Japanese and English, B has two Japanese posts, and C uses only Thai.
    const a = await topic("ja1", old);
    const b = await topic("ja1", old);
    const c = await topic("ja1", old);
    await reply("ja1", a, inWeek(7, 10));
    await reply("en1", a, inWeek(7, 40));
    await reply("ja1", b, inWeek(7, 10));
    await reply("ja2", b, inWeek(7, 30));
    await reply("th1", c, inWeek(7, 50));
    // A deleted English reply does not make B cross-language; exclude deleted topics.
    const gone = await reply("en1", b, inWeek(7, 20));
    await db.update(entries).set({ deletedAt: inWeek(7, 21) }).where(eq(entries.id, gone));
    const f = await topic("ja1", old);
    await reply("ja1", f, inWeek(7, 10));
    await reply("en1", f, inWeek(7, 11));
    await db.update(entries).set({ deletedAt: inWeek(7, 12) }).where(eq(entries.id, f));
    // Do not count a future reply after Thursday noon, the current time.
    await reply("th1", b, new Date(now.getTime() + DAY));
    // Week 6: A uses only Thai; D spans English and Thai. Monday 00:00 belongs to the new week.
    await reply("th1", a, inWeek(6, 50));
    const d = await topic("ja1", old);
    await reply("en1", d, inWeek(6, 100));
    await reply("th1", d, inWeek(6, 120));
    await reply("ja1", d, inWeek(7, 0));
    // Oldest week, week 0: other and Japanese.
    const e = await topic("ja1", old);
    await reply("ot1", e, inWeek(0, 1));
    await reply("ja1", e, inWeek(0, 160));
    // Do not count anything before the eight-week period.
    await reply("en1", e, inWeek(0, -1));
    const g = await topic("ja1", old);
    await reply("en1", g, inWeek(-1, 100));

    const weeks = await crossAreaReplyRate(db, now);
    expect(weeks).toHaveLength(8);
    expect(weeks.map((w) => w.weekStart)).toEqual(Array.from({ length: 8 }, (_, i) => inWeek(i, 0)));
    // Current week: A, B, C, and D post in Japanese on Monday. D uses only Japanese; only A spans languages.
    expect(weeks.map((w) => [w.topics, w.crossArea, w.rate])).toEqual([
      [1, 1, 1],
      [0, 0, null],
      [0, 0, null],
      [0, 0, null],
      [0, 0, null],
      [0, 0, null],
      [2, 1, 0.5],
      [4, 1, 0.25],
    ]);
    expect((await crossAreaReplyRate(db, now, 2)).map((w) => w.topics)).toEqual([2, 4]);
    // The same week uses stable boundaries.
    const later = await crossAreaReplyRate(db, new Date("2026-10-04T23:00:00Z"));
    expect(later.map((w) => w.weekStart)).toEqual(weeks.map((w) => w.weekStart));
    expect(later.slice(0, 7)).toEqual(weeks.slice(0, 7));
  }, 30_000);

  it("returns 8 empty weeks with no rate when nothing has happened", async () => {
    const db = await createTestDb();
    const weeks = await crossAreaReplyRate(db, now);
    expect(weeks).toHaveLength(8);
    expect(weeks.every((w) => w.topics === 0 && w.crossArea === 0 && w.rate === null)).toBe(true);
  });
});

describe("sustainedWritersByArea", () => {
  it("counts members per home area with 2+ topics or replies in the last 30 days (deleted posts do not count)", async () => {
    const { db, topic, reply } = await world();
    const t = await topic("ja1", ago(5 * DAY));
    await reply("ja1", t, ago(4 * DAY));
    await reply("ja1", t, ago(3 * DAY));
    await reply("ja2", t, ago(3 * DAY));
    await reply("en1", t, ago(2 * DAY));
    await topic("en1", ago(1 * DAY));
    // A Thai post 31 days ago plus a recent post does not count as sustained participation.
    await reply("th1", t, ago(31 * DAY));
    await reply("th1", t, ago(2 * DAY));
    // The sole other-language post is deleted.
    await reply("ot1", t, ago(2 * DAY));
    const removed = await reply("ot1", t, ago(1 * DAY));
    await db.update(entries).set({ deletedAt: ago(DAY / 2) }).where(eq(entries.id, removed));
    const counts = await sustainedWritersByArea(db, now);
    expect(counts.map((c) => c.area)).toEqual([...AREAS]);
    expect(Object.fromEntries(counts.filter((c) => c.count > 0).map((c) => [c.area, c.count]))).toEqual({ ja: 1, en: 1 });
    // The period and count are configurable.
    const loose = await sustainedWritersByArea(db, now, { minPosts: 1 });
    expect(Object.fromEntries(loose.filter((c) => c.count > 0).map((c) => [c.area, c.count]))).toEqual({ ja: 2, en: 1, th: 1, other: 1 });
  });
});

describe("reportStats", () => {
  it("counts reports and takes the median time to resolution over resolved reports", async () => {
    const { db, topic } = await world();
    expect(await reportStats(db)).toEqual({ total: 0, open: 0, resolved: 0, autoResolved: 0, medianResolutionSeconds: null });
    const t = await topic("ja1", ago(10 * DAY));
    const add = (createdAgo: number, resolvedAfter: number | null) =>
      db.insert(translationReports).values({
        entryId: t,
        lang: "en",
        field: "body",
        reporterId: "en1",
        excerpt: "x",
        status: resolvedAfter === null ? "open" : "resolved",
        createdAt: ago(createdAgo),
        resolvedBy: resolvedAfter === null ? null : "ja1",
        resolvedAt: resolvedAfter === null ? null : new Date(ago(createdAgo).getTime() + resolvedAfter),
      });
    await add(5 * DAY, null);
    await add(4 * DAY, 1 * HOUR);
    expect(await reportStats(db)).toEqual({ total: 2, open: 1, resolved: 1, autoResolved: 0, medianResolutionSeconds: 3600 });
    await add(3 * DAY, 3 * HOUR);
    await add(2 * DAY, 10 * HOUR);
    expect(await reportStats(db)).toEqual({ total: 4, open: 1, resolved: 3, autoResolved: 0, medianResolutionSeconds: 3 * 3600 });
    await add(1 * DAY, 4 * HOUR);
    // Four resolved items take 1, 3, 4, and 10 hours; the median lies between 3 and 4.
    expect((await reportStats(db)).medianResolutionSeconds).toBe(3.5 * 3600);
  });

  it("counts the reports that were closed without a person (automatic re-translation, edit, deletion) apart, and leaves them out of the median", async () => {
    const { db, topic } = await world();
    const t = await topic("ja1", ago(10 * DAY));
    const add = (createdAgo: number, resolvedAfter: number, by: string | null) =>
      db.insert(translationReports).values({
        entryId: t,
        lang: "en",
        field: "body",
        reporterId: "en1",
        status: "resolved",
        createdAt: ago(createdAgo),
        resolvedBy: by,
        resolvedAt: new Date(ago(createdAgo).getTime() + resolvedAfter),
      });
    await add(4 * DAY, 10_000, null);
    await add(3 * DAY, 5_000, null);
    await add(2 * DAY, 2 * HOUR, "ja1");
    await add(1 * DAY, 4 * HOUR, "ja1");
    expect(await reportStats(db)).toEqual({ total: 4, open: 0, resolved: 4, autoResolved: 2, medianResolutionSeconds: 3 * 3600 });
    // No human-resolved items means no median.
    const { db: other, topic: otherTopic } = await world();
    const t2 = await otherTopic("ja1", ago(10 * DAY));
    await other.insert(translationReports).values({ entryId: t2, lang: "en", field: "body", reporterId: "en1", status: "resolved", createdAt: ago(DAY), resolvedBy: null, resolvedAt: ago(DAY - 1000) });
    expect(await reportStats(other)).toEqual({ total: 1, open: 0, resolved: 1, autoResolved: 1, medianResolutionSeconds: null });
  });
});

describe("aiAssistanceByArea", () => {
  it("counts declared levels per area of the author, topics and replies together, without deleted posts", async () => {
    const { db, topic, reply } = await world();
    const t = await topic("ja1", ago(5 * DAY), { ai: "draft" });
    await reply("ja1", t, ago(4 * DAY));
    await reply("ja2", t, ago(4 * DAY), { ai: "polish" });
    await reply("en1", t, ago(4 * DAY), { ai: "coauthor" });
    const removed = await reply("en1", t, ago(4 * DAY), { ai: "coauthor" });
    await db.update(entries).set({ deletedAt: ago(DAY) }).where(eq(entries.id, removed));
    const rows = await aiAssistanceByArea(db);
    expect(rows.map((r) => r.area)).toEqual([...AREAS]);
    const row = (area: string) => rows.find((r) => r.area === area)!;
    expect(row("ja")).toEqual({ area: "ja", counts: { none: 1, polish: 1, draft: 1, coauthor: 0 }, total: 3, unstated: 0 });
    expect(row("en")).toEqual({ area: "en", counts: { none: 0, polish: 0, draft: 0, coauthor: 1 }, total: 1, unstated: 0 });
    expect(row("th")).toEqual({ area: "th", counts: { none: 0, polish: 0, draft: 0, coauthor: 0 }, total: 0, unstated: 0 });
  });

  it("counts only the posts that have a value, and gives the posts without one as a separate number (posts written on screen state none)", async () => {
    const { db, topic, reply } = await world();
    const t = await topic("ja1", ago(5 * DAY), { ai: null });
    await reply("ja1", t, ago(4 * DAY), { ai: null });
    await reply("ja2", t, ago(4 * DAY), { ai: "polish" });
    // An explicit none is a value; it is counted, unlike no value.
    await reply("ja2", t, ago(4 * DAY), { ai: "none" });
    await reply("en1", t, ago(4 * DAY), { ai: null });
    const removed = await reply("en1", t, ago(4 * DAY), { ai: null });
    await db.update(entries).set({ deletedAt: ago(DAY) }).where(eq(entries.id, removed));
    const rows = await aiAssistanceByArea(db);
    const row = (area: string) => rows.find((r) => r.area === area)!;
    expect(row("ja")).toEqual({ area: "ja", counts: { none: 1, polish: 1, draft: 0, coauthor: 0 }, total: 2, unstated: 2 });
    expect(row("en")).toEqual({ area: "en", counts: { none: 0, polish: 0, draft: 0, coauthor: 0 }, total: 0, unstated: 1 });
  });
});

describe("metrics by the area at the time of writing", () => {
  it("do not change when a member changes home area afterwards", async () => {
    const { db, topic, reply } = await world();
    const week = (hours: number) => new Date(new Date("2026-09-28T00:00:00Z").getTime() + hours * HOUR);
    const t = await topic("ja1", week(1), { ai: "draft" });
    await reply("en1", t, week(2), { ai: "polish" });
    await reply("th1", t, week(3));
    await reply("ja2", t, week(4));
    await topic("ja2", week(5));
    const snapshot = async () => ({
      rate: await crossAreaReplyRate(db, now),
      writers: await sustainedWritersByArea(db, now),
      ai: await aiAssistanceByArea(db),
    });
    const before = await snapshot();
    expect(before.rate.at(-1)).toMatchObject({ topics: 1, crossArea: 1 });
    await db.update(profiles).set({ homeArea: "fr" }).where(eq(profiles.userId, "ja1"));
    await db.update(profiles).set({ homeArea: "de" }).where(eq(profiles.userId, "en1"));
    await db.update(profiles).set({ homeArea: "ko" }).where(eq(profiles.userId, "ja2"));
    expect(await snapshot()).toEqual(before);
  });

  it("count a sustained writer once, under the area of their latest post in the window", async () => {
    const { db, topic, reply } = await world();
    const t = await topic("ja2", ago(20 * DAY));
    // ja1 posts once in Japanese, then twice in English; the latest language is English.
    await reply("ja1", t, ago(10 * DAY));
    await changeHomeArea(db, "ja1", "en");
    await reply("ja1", t, ago(5 * DAY));
    await reply("ja1", t, ago(2 * DAY));
    // en1 has only one post, so participation is not sustained.
    await reply("en1", t, ago(3 * DAY));
    const counts = await sustainedWritersByArea(db, now);
    expect(Object.fromEntries(counts.filter((c) => c.count > 0).map((c) => [c.area, c.count]))).toEqual({ en: 1 });
    // The latest post is Japanese and the older one English, so classify as Japanese.
    await changeHomeArea(db, "ja2", "th");
    await reply("ja2", t, ago(1 * DAY));
    const after = await sustainedWritersByArea(db, now, { minPosts: 1 });
    expect(Object.fromEntries(after.filter((c) => c.count > 0).map((c) => [c.area, c.count]))).toEqual({ en: 2, th: 1 });
  });

  it("leave out posts whose author has no profile", async () => {
    const { db, topic, reply } = await world();
    await db.insert(user).values({ id: "ghost", name: "", email: "ghost@example.com", emailVerified: true });
    const t = await topic("ja1", ago(3 * DAY), { ai: "draft" });
    await reply("ghost", t, ago(2 * DAY));
    await reply("ghost", t, ago(1 * DAY));
    expect((await sustainedWritersByArea(db, now)).every((c) => c.count === 0)).toBe(true);
    expect((await aiAssistanceByArea(db)).reduce((sum, r) => sum + r.total, 0)).toBe(1);
  });
});

describe("hidden posts", () => {
  it("are not counted by any metric (deleted ones neither), including replies under a hidden topic", async () => {
    const { db, topic, reply } = await world();
    const week = weekStartOf(now);
    const at = (hours: number) => new Date(week.getTime() + hours * HOUR);
    const old = ago(200 * DAY);
    // A's hidden English reply does not make it cross-language; B's hidden topic excludes all its replies.
    const a = await topic("ja1", old);
    await reply("ja1", a, at(1));
    const hiddenReply = await reply("en1", a, at(2));
    const b = await topic("ja1", old);
    await reply("ja1", b, at(1));
    await reply("en1", b, at(2));
    const c = await topic("ja1", old);
    await reply("ja1", c, at(1));
    await reply("en1", c, at(2));
    // Exclude hidden posts from AI-assisted writer counts.
    const aiTopic = await topic("th1", ago(2 * DAY), { ai: "coauthor" });
    await reply("th1", aiTopic, ago(DAY), { ai: "draft" });
    const before = await getMetrics(db, now);
    expect(before.crossAreaReplyRate.at(-1)).toMatchObject({ topics: 4, crossArea: 3 });
    expect(before.sustainedWriters.find((w) => w.area === "th")!.count).toBe(1);
    expect(before.aiAssistance.find((r) => r.area === "th")!.counts).toMatchObject({ coauthor: 1, draft: 1 });
    await db.update(entries).set({ hiddenAt: at(3) }).where(eq(entries.id, hiddenReply));
    await db.update(entries).set({ hiddenAt: at(3) }).where(eq(entries.id, b));
    await db.update(entries).set({ hiddenAt: ago(HOUR) }).where(eq(entries.authorId, "th1"));
    const after = await getMetrics(db, now);
    // A's hidden English post is excluded, so A is not cross-language; exclude all of B; C remains cross-language.
    expect(after.crossAreaReplyRate.at(-1)).toMatchObject({ topics: 2, crossArea: 1 });
    // All of th1's posts are hidden, so do not count the writer or AI assistance.
    expect(after.sustainedWriters.find((w) => w.area === "th")!.count).toBe(0);
    expect(after.aiAssistance.find((r) => r.area === "th")).toMatchObject({ total: 0 });
  });
});

describe("replies under a hidden or a deleted topic", () => {
  it("are not counted as sustained writers or AI assistance declarations (the replies themselves are still published)", async () => {
    const { db, topic, reply } = await world();
    const hiddenTopic = await topic("en1", ago(5 * DAY));
    const deletedTopic = await topic("en1", ago(5 * DAY));
    const openTopic = await topic("en1", ago(5 * DAY));
    // th1 has two replies under a hidden parent and one under a deleted parent, all declaring AI assistance.
    await reply("th1", hiddenTopic, ago(4 * DAY), { ai: "draft" });
    await reply("th1", hiddenTopic, ago(3 * DAY), { ai: "draft" });
    await reply("th1", deletedTopic, ago(2 * DAY), { ai: "coauthor" });
    // ja1 provides the comparison under a visible parent.
    await reply("ja1", openTopic, ago(2 * DAY));
    await reply("ja1", openTopic, ago(1 * DAY));
    const before = await getMetrics(db, now);
    expect(before.sustainedWriters.find((w) => w.area === "th")!.count).toBe(1);
    expect(before.aiAssistance.find((r) => r.area === "th")!.total).toBe(3);
    await db.update(entries).set({ hiddenAt: ago(HOUR) }).where(eq(entries.id, hiddenTopic));
    await db.update(entries).set({ deletedAt: ago(HOUR) }).where(eq(entries.id, deletedTopic));
    const after = await getMetrics(db, now);
    expect(after.sustainedWriters.find((w) => w.area === "th")!.count).toBe(0);
    expect(after.aiAssistance.find((r) => r.area === "th")).toMatchObject({ total: 0 });
    // Replies under the visible parent remain unchanged.
    expect(after.sustainedWriters.find((w) => w.area === "ja")!.count).toBe(1);
    expect(after.aiAssistance.find((r) => r.area === "ja")!.total).toBe(2);
    // The replies themselves are neither deleted nor hidden.
    expect((await db.select().from(entries).where(eq(entries.authorId, "th1"))).every((e) => e.deletedAt === null && e.hiddenAt === null)).toBe(true);
  });
});

// ----: engagement and cross-language metrics (hand-computed fixtures; every time is an argument, never the clock) ----

type EngageWorld = Awaited<ReturnType<typeof engage>>;

// The members of world() (ja1, ja2, en1, th1, ot1) and more, with the helpers that make posts, Insightful and stances at given times.
async function engage() {
  const { db, topic, reply } = await world();
  for (const [id, handle, area, read] of [
    ["ja3", "jun", "ja", ["ja"]],
    ["en2", "emma", "en", ["en"]],
    ["th2", "ploy", "th", ["th"]],
    ["ot2", "lee", "other", ["en"]],
    ["ex", "mallory", "en", ["en"]],
    ["ko1", "minho", "ko", ["ko"]],
  ] as const) {
    await addMember(db, id, handle, { homeArea: area, readLangs: [...read] });
  }
  // A member without a profile (so a post without an author_area).
  await db.insert(user).values({ id: "ghost", name: "", email: "ghost@example.com", emailVerified: true });
  const at = (iso: string) => new Date(iso);
  const question = async (author: string, when: Date, opts: { lang?: Lang; altOf?: number } = {}) => {
    const res = await createTopic(db, author, { lang: opts.lang ?? "ja", title: "q", body: "b", asksStance: true, altOf: opts.altOf }, { now: when });
    if (!res.ok) throw new Error(`question failed: ${res.error}`);
    return res.id;
  };
  const replyTo = async (author: string, threadId: number, when: Date, parentId?: number) => {
    const res = await createReply(db, author, threadId, { lang: "ja", body: "r", parentId }, { now: when });
    if (!res.ok) throw new Error(`reply failed: ${res.error}`);
    return res.id;
  };
  const vote = async (voter: string, entryId: number, when: string | Date) => {
    const res = await setVote(db, voter, entryId, true, { now: typeof when === "string" ? at(when) : when });
    if (!res.ok || !res.changed) throw new Error(`vote failed: ${JSON.stringify(res)}`);
  };
  // Sets a stance at a time (the version is read from the record, so a sequence of calls is a history).
  const stance = async (userId: string, questionId: number, position: Position | null, when: string, trigger?: number) => {
    const state = (await loadOwnStances(db, userId, [questionId])).get(questionId)!;
    const res = await setStance(db, userId, { questionId, position, expectedVersion: state.version, triggerEntryId: trigger ?? null }, { now: at(when) });
    if (!res.ok || !res.changed) throw new Error(`stance failed: ${JSON.stringify(res)}`);
  };
  const exclude = (userId: string) => db.update(profiles).set({ reactionsExcludedAt: at("2026-09-01T00:00:00Z") }).where(eq(profiles.userId, userId));
  const startOf = (userId: string, when: string) => db.update(profiles).set({ createdAt: at(when) }).where(eq(profiles.userId, userId));
  const hide = (id: number) => db.update(entries).set({ hiddenAt: at("2026-09-30T00:00:00Z") }).where(eq(entries.id, id));
  const remove = (id: number) => db.update(entries).set({ deletedAt: at("2026-09-30T00:00:00Z") }).where(eq(entries.id, id));
  return { db, topic, reply, at, question, replyTo, vote, stance, exclude, startOf, hide, remove };
}

// 2026-10-01 is the Thursday of the week that starts on 2026-09-28; the eight weeks start on 2026-08-10, 08-17, 08-24, 08-31, 09-07, 09-14, 09-21 and 09-28.
const OLD = new Date("2026-06-01T00:00:00Z");
const unobserved = { observed: false, numerator: 0, denominator: 0, people: 0 };
const weekStarts = ["2026-08-10", "2026-08-17", "2026-08-24", "2026-08-31", "2026-09-07", "2026-09-14", "2026-09-21", "2026-09-28"].map((d) => new Date(`${d}T00:00:00Z`));

describe("observationWeeks and the rate cell", () => {
  it("lists the last weeks, oldest first, this week last", () => {
    expect(observationWeeks(now)).toEqual(weekStarts);
    expect(observationWeeks(now, 2)).toEqual(weekStarts.slice(-2));
  });
});

describe("crossAreaInsightfulRate", () => {
  it("is, per week, the Insightful on posts with a known area whose voter's area differs (numerator, denominator and people by hand)", async () => {
    const w = await engage();
    const t = await w.topic("ja1", OLD);
    const byOther = await w.reply("ot1", t, OLD); // area: other
    const noArea = await w.reply("ghost", t, OLD); // no author_area: not in the denominator
    const hiddenReply = await w.reply("ja1", t, OLD);
    const deletedReply = await w.reply("ja2", t, OLD);
    const enReply = await w.reply("en1", t, OLD);
    const hiddenTopic = await w.topic("ja2", OLD);
    const underHidden = await w.reply("th1", hiddenTopic, OLD);
    // Week 7 (2026-09-28 to now): five of seven are across languages
    await w.vote("en1", t, "2026-09-28T10:00:00Z"); // en on ja: across
    await w.vote("ja2", t, "2026-09-28T11:00:00Z"); // ja on ja: not across
    await w.vote("th1", t, "2026-09-28T12:00:00Z"); // th on ja: across
    await w.vote("ot2", byOther, "2026-09-28T13:00:00Z"); // other on other: the two values are equal, not across
    await w.vote("ja1", byOther, "2026-09-28T14:00:00Z"); // ja on other: across
    await w.vote("en1", byOther, "2026-09-28T20:00:00Z"); // across (en1 again: one person)
    await w.vote("th1", byOther, "2026-09-28T00:00:00Z"); // exactly Monday 00:00: this week. across
    // Not counted: a post without an area, a member under exclude_reactions, hidden, deleted and under-a-hidden-topic posts, and a vote after `now`
    await w.vote("en1", noArea, "2026-09-28T15:00:00Z");
    await w.vote("ex", t, "2026-09-28T16:00:00Z");
    await w.vote("en1", hiddenReply, "2026-09-28T17:00:00Z");
    await w.vote("en1", deletedReply, "2026-09-28T18:00:00Z");
    await w.vote("en1", underHidden, "2026-09-28T19:00:00Z");
    await w.vote("ot2", t, "2026-10-01T00:00:00.001Z");
    // Week 6: one, a millisecond before Monday. Week 0: one at the first millisecond; one a millisecond before the first week is outside
    await w.vote("ja2", byOther, "2026-09-27T23:59:59.999Z"); // ja on other: across
    await w.vote("ja2", enReply, "2026-08-10T00:00:00.000Z"); // ja on en: across
    await w.vote("ja1", enReply, "2026-08-09T23:59:59.999Z");
    await w.exclude("ex");
    await w.hide(hiddenReply);
    await w.remove(deletedReply);
    await w.hide(hiddenTopic);

    const weeks = await crossAreaInsightfulRate(w.db, now);
    expect(weeks.map((x) => x.weekStart)).toEqual(weekStarts);
    expect(weeks[0]).toMatchObject({ observed: true, numerator: 1, denominator: 1, people: 1, rate: 1 });
    for (const i of [1, 2, 3, 4, 5]) expect(weeks[i], `week ${i}`).toMatchObject(unobserved);
    expect(weeks[6]).toMatchObject({ observed: true, numerator: 1, denominator: 1, people: 1, rate: 1 });
    // 5 of 7; the people of the 7 are en1, ja2, th1, ot2, ja1 (en1 and th1 pressed twice)
    expect(weeks[7]).toEqual({ weekStart: weekStarts[7], observed: true, numerator: 5, denominator: 7, people: 5, rate: 5 / 7 });
    expect(await crossAreaInsightfulRate(w.db, now, 2)).toHaveLength(2);
  }, 60_000);

  it("is all not observed with no Insightful", async () => {
    const db = await createTestDb();
    const weeks = await crossAreaInsightfulRate(db, now);
    expect(weeks).toHaveLength(8);
    for (const x of weeks) expect(x).toMatchObject(unobserved);
  });
});

describe("crossAreaUpdateRate", () => {
  it("counts the changes of a stance with a trigger whose area differs from the member's area; a first registration, a withdrawal and a re-choice are not changes (by hand)", async () => {
    const w = await engage();
    const q = await w.question("ja1", OLD);
    const p1 = await w.replyTo("ja1", q, OLD); // triggers written in ja, en, th, th (another member), other
    const p2 = await w.replyTo("en1", q, OLD);
    const p3 = await w.replyTo("th1", q, OLD);
    const p5 = await w.replyTo("th2", q, OLD);
    const p6 = await w.replyTo("ot2", q, OLD);
    // en1 (week 7): first registration; Insightful on p1, then a change with p1 as the trigger (across: ja on en); a change without a trigger; a withdrawal; a re-registration;
    // Insightful on p3 and a change with p3 as the trigger (across: th on en)
    await w.stance("en1", q, "agree", "2026-09-28T01:00:00Z");
    await w.vote("en1", p1, "2026-09-28T04:00:00Z");
    await w.stance("en1", q, "disagree", "2026-09-28T05:00:00Z", p1);
    await w.stance("en1", q, "neither", "2026-09-28T06:00:00Z");
    await w.stance("en1", q, null, "2026-09-28T07:00:00Z");
    await w.stance("en1", q, "agree", "2026-09-28T08:00:00Z");
    await w.vote("en1", p3, "2026-09-28T08:30:00Z");
    await w.stance("en1", q, "disagree", "2026-09-28T09:00:00Z", p3);
    // th1: a change prompted by a post in en (across), then one prompted by a post of another th member (the same area: not across)
    await w.stance("th1", q, "agree", "2026-09-28T02:00:00Z");
    await w.vote("th1", p2, "2026-09-28T10:30:00Z");
    await w.stance("th1", q, "disagree", "2026-09-28T11:00:00Z", p2);
    await w.vote("th1", p5, "2026-09-28T11:30:00Z");
    await w.stance("th1", q, "agree", "2026-09-28T12:00:00Z", p5);
    // ot1: a change prompted by a post of another member of "other" (equal: not across)
    await w.stance("ot1", q, "agree", "2026-09-28T02:30:00Z");
    await w.vote("ot1", p6, "2026-09-28T12:30:00Z");
    await w.stance("ot1", q, "disagree", "2026-09-28T13:00:00Z", p6);
    // ja2: week 6, a millisecond before Monday (th trigger: across), and exactly at Monday 00:00 (en trigger: across, week 7)
    await w.stance("ja2", q, "agree", "2026-09-22T00:00:00Z");
    await w.vote("ja2", p3, "2026-09-22T01:00:00Z");
    await w.vote("ja2", p2, "2026-09-22T02:00:00Z");
    await w.stance("ja2", q, "disagree", "2026-09-27T23:59:59.999Z", p3);
    await w.stance("ja2", q, "neither", "2026-09-28T00:00:00.000Z", p2);
    // th2: week 5, a change without a trigger (one change, nothing in the denominator)
    await w.stance("th2", q, "agree", "2026-09-15T00:00:00Z");
    await w.stance("th2", q, "disagree", "2026-09-16T00:00:00Z");
    // A member under exclusion, and a hidden question: neither counts
    await w.vote("ex", p1, "2026-09-28T03:00:00Z");
    await w.stance("ex", q, "agree", "2026-09-28T03:30:00Z");
    await w.stance("ex", q, "disagree", "2026-09-28T05:00:00Z", p1);
    const hiddenQ = await w.question("ja1", OLD);
    const p7 = await w.replyTo("th1", hiddenQ, OLD);
    await w.vote("en2", p7, "2026-09-28T14:00:00Z");
    await w.stance("en2", hiddenQ, "agree", "2026-09-28T14:10:00Z");
    await w.stance("en2", hiddenQ, "disagree", "2026-09-28T14:20:00Z", p7);
    await w.exclude("ex");
    await w.hide(hiddenQ);

    const weeks = await crossAreaUpdateRate(w.db, now);
    const week = (i: number) => weeks[i];
    expect(weeks.map((x) => x.weekStart)).toEqual(weekStarts);
    // week 7: changes en1 x3, th1 x2, ot1 x1, ja2 x1 = 7; with a trigger: en1 x2, th1 x2, ot1, ja2 = 6; across: en1 x2, th1 (en), ja2 = 4; people: en1, th1, ot1, ja2
    expect(week(7)).toEqual({ weekStart: weekStarts[7], changes: 7, observed: true, numerator: 4, denominator: 6, people: 4, rate: 4 / 6 });
    expect(week(6)).toEqual({ weekStart: weekStarts[6], changes: 1, observed: true, numerator: 1, denominator: 1, people: 1, rate: 1 });
    // week 5: a change without a trigger: it is counted as a change, and the rate is not observed
    expect(week(5)).toEqual({ weekStart: weekStarts[5], changes: 1, ...unobserved });
    for (const i of [0, 1, 2, 3, 4]) expect(week(i), `week ${i}`).toEqual({ weekStart: weekStarts[i], changes: 0, ...unobserved });

    // The area is a copy made when the change was recorded: moving to another home area afterwards does not move a past week
    await w.db.update(profiles).set({ homeArea: "fr" }).where(eq(profiles.userId, "en1"));
    await w.db.update(profiles).set({ homeArea: "en" }).where(eq(profiles.userId, "ja2"));
    expect(await crossAreaUpdateRate(w.db, now)).toEqual(weeks);
  }, 60_000);
});

describe("weeklyActiveMembers", () => {
  it("counts a member once a week for a post, an Insightful or a stance; an excluded member's reactions do not count, but their post does (by hand)", async () => {
    const w = await engage();
    const q = await w.question("ja1", OLD);
    // Week 7 (2026-09-28 to now): ja1 (a post and a reply: once), en1 (Insightful only), th1 (a stance only), ja2 (a post, an Insightful and a stance: once),
    // th2 (a post; the member is excluded, but a post counts), ja3 (a post exactly at Monday 00:00)
    const t = await w.topic("ja1", w.at("2026-09-28T01:00:00Z"));
    await w.reply("ja1", t, w.at("2026-09-28T02:00:00Z"));
    await w.vote("en1", t, "2026-09-28T03:00:00Z");
    await w.stance("th1", q, "agree", "2026-09-28T04:00:00Z");
    await w.topic("ja2", w.at("2026-09-28T05:00:00Z"));
    await w.vote("ja2", t, "2026-09-28T06:00:00Z");
    await w.stance("ja2", q, "disagree", "2026-09-28T07:00:00Z");
    await w.topic("th2", w.at("2026-09-28T08:00:00Z"));
    await w.topic("ja3", w.at("2026-09-28T00:00:00.000Z"));
    // Not active: a member under exclusion with an Insightful and a stance only (ex), a member with a hidden post only (ot1), a member with a reply under a hidden topic only (ot2),
    // a post after now, and a post before the first week
    await w.vote("ex", t, "2026-09-28T07:30:00Z");
    await w.stance("ex", q, "agree", "2026-09-28T07:40:00Z");
    const hidden = await w.topic("ot1", w.at("2026-09-28T09:00:00Z"));
    const hiddenTopic = await w.topic("ko1", w.at("2026-09-27T00:00:00Z"));
    await w.reply("ot2", hiddenTopic, w.at("2026-09-28T09:30:00Z"));
    await w.topic("ja2", w.at("2026-10-01T05:00:00Z"));
    await w.topic("ja1", w.at("2026-08-09T23:59:59Z"));
    // Week 6: a post a millisecond before Monday (en2), a post (ja1), an Insightful on it (th1) and an Insightful by the excluded member
    await w.topic("en2", w.at("2026-09-27T23:59:59.999Z"));
    const p6 = await w.topic("ja1", w.at("2026-09-21T10:00:00Z"));
    await w.vote("th1", p6, "2026-09-22T00:00:00Z");
    await w.vote("ex", p6, "2026-09-22T01:00:00Z");
    await w.exclude("ex");
    await w.exclude("th2");
    await w.hide(hidden);
    await w.hide(hiddenTopic);

    const weeks = await weeklyActiveMembers(w.db, now);
    expect(weeks.map((x) => x.weekStart)).toEqual(weekStarts);
    // week 7: ja1, en1, th1, ja2, th2, ja3 = 6. Week 6: en2, ja1, th1 = 3
    expect(weeks.map((x) => x.members)).toEqual([0, 0, 0, 0, 0, 0, 3, 6]);
  }, 60_000);
});

describe("fourWeekRetention", () => {
  it("is, per cohort week, the members whose start is that week and who were active in the week 4 weeks later; not observed until that week has ended and for an empty cohort (by hand)", async () => {
    const w = await engage();
    const q = await w.question("ja1", OLD);
    const t = await w.topic("th2", OLD);
    // Cohort of 2026-08-10: ja1 (the first millisecond), ja2 (the last), ja3 starts a millisecond before the first cohort (outside)
    await w.startOf("ja1", "2026-08-10T00:00:00.000Z");
    await w.startOf("ja2", "2026-08-16T23:59:59.999Z");
    await w.startOf("ja3", "2026-08-09T23:59:59.999Z");
    // Cohort of 2026-08-17: en1, en2 and an excluded member (ex: not in the denominator)
    await w.startOf("en1", "2026-08-17T00:00:00.000Z");
    await w.startOf("en2", "2026-08-20T00:00:00Z");
    await w.startOf("ex", "2026-08-21T00:00:00Z");
    // Cohort of 2026-08-31: th1 (its retention week 2026-09-28 has not ended at `now`)
    await w.startOf("th1", "2026-08-31T00:00:00Z");
    // The retention week of the first cohort is [2026-09-07, 2026-09-14): ja1 posts at the first millisecond (retained); ja2 posts at 09-14 00:00 (outside) and a millisecond before 09-07 (outside)
    await w.topic("ja1", w.at("2026-09-07T00:00:00.000Z"));
    await w.topic("ja2", w.at("2026-09-14T00:00:00.000Z"));
    await w.topic("ja2", w.at("2026-09-06T23:59:59.999Z"));
    await w.topic("ja3", w.at("2026-09-08T00:00:00Z")); // ja3 is in no cohort
    // The second cohort's week is [2026-09-14, 2026-09-21): en1 records a stance (retained); en2 presses Insightful exactly at 09-21 (outside); ex is active but excluded
    await w.stance("en1", q, "agree", "2026-09-20T12:00:00Z");
    await w.vote("en2", t, "2026-09-21T00:00:00.000Z");
    await w.topic("ex", w.at("2026-09-15T00:00:00Z"));
    await w.exclude("ex");
    // th1 is active in its retention week, which is still running
    await w.topic("th1", w.at("2026-09-29T00:00:00Z"));

    const cohorts = await fourWeekRetention(w.db, now);
    expect(cohorts.map((x) => x.cohortWeek)).toEqual(weekStarts);
    expect(cohorts[0]).toEqual({ cohortWeek: weekStarts[0], observed: true, numerator: 1, denominator: 2, people: 2, rate: 0.5 });
    expect(cohorts[1]).toEqual({ cohortWeek: weekStarts[1], observed: true, numerator: 1, denominator: 2, people: 2, rate: 0.5 });
    // an empty cohort (2026-08-24), and the cohorts whose retention week has not ended (08-31: ends 10-05 > now)
    for (const i of [2, 3, 4, 5, 6, 7]) expect(cohorts[i], `cohort ${i}`).toEqual({ cohortWeek: weekStarts[i], ...unobserved });
    // the cohort of 08-24 would be observed (its week ends 09-28 <= now) if it had a member
    await w.startOf("ko1", "2026-08-24T12:00:00Z");
    const later = await fourWeekRetention(w.db, now);
    expect(later[2]).toEqual({ cohortWeek: weekStarts[2], observed: true, numerator: 0, denominator: 1, people: 1, rate: 0 });
  }, 60_000);

  it("takes the start from one place: memberStartAt is the created_at of the profile", async () => {
    const w = await engage();
    await w.startOf("ja1", "2026-08-10T00:00:00.000Z");
    const rows = await w.db.select({ id: profiles.userId }).from(profiles).where(sql`${memberStartAt} = ${new Date("2026-08-10T00:00:00.000Z").toISOString()}::timestamptz`);
    expect(rows.map((r) => r.id)).toEqual(["ja1"]);
  });
});

describe("firstParticipation", () => {
  it("is, per cohort week, the share of members whose first stance and whose first post come within 14 days of the start; the two are counted apart (by hand)", async () => {
    const w = await engage();
    const q = await w.question("ko1", OLD);
    const hiddenQ = await w.question("ko1", OLD);
    // Cohort of 2026-08-10: ja1 (stance exactly 14 days after the start: counted; post 3 days after), ja2 (stance 14 days and a millisecond after; a hidden post on day 1, a visible one on day 15),
    // ja3 (a stance on a question that is hidden later on day 1, a stance on a visible question on day 20; a post exactly 14 days after), en1 (nothing), ex (excluded: not in the denominator)
    await w.startOf("ja1", "2026-08-10T06:00:00Z");
    await w.startOf("ja2", "2026-08-12T00:00:00Z");
    await w.startOf("ja3", "2026-08-16T12:00:00Z");
    await w.startOf("en1", "2026-08-11T00:00:00Z");
    await w.startOf("ex", "2026-08-12T00:00:00Z");
    await w.stance("ja1", q, "agree", "2026-08-24T06:00:00.000Z");
    await w.topic("ja1", w.at("2026-08-13T06:00:00Z"));
    await w.stance("ja2", q, "agree", "2026-08-26T00:00:00.001Z");
    const hiddenPost = await w.topic("ja2", w.at("2026-08-13T00:00:00Z"));
    await w.topic("ja2", w.at("2026-08-27T00:00:00Z"));
    await w.stance("ja3", hiddenQ, "agree", "2026-08-17T12:00:00Z");
    await w.stance("ja3", q, "agree", "2026-09-05T12:00:00Z");
    await w.topic("ja3", w.at("2026-08-30T12:00:00.000Z"));
    await w.stance("ex", q, "agree", "2026-08-13T00:00:00Z");
    await w.topic("ex", w.at("2026-08-13T00:00:00Z"));
    // Cohort of 2026-08-17: th1 (a stance on day 1: the stance is reached, the post is not)
    await w.startOf("th1", "2026-08-17T00:00:00.000Z");
    await w.stance("th1", q, "agree", "2026-08-18T00:00:00Z");
    // Cohort of 2026-09-07: th2 (a post on day 1), its 14 days ended on 09-27 <= now
    await w.startOf("th2", "2026-09-13T23:00:00Z");
    await w.topic("th2", w.at("2026-09-14T00:00:00Z"));
    // Cohort of 2026-09-14: en2 reached a post at once, but the 14 days of its cohort have not all passed (09-14 + 21 days > now)
    await w.startOf("en2", "2026-09-14T00:00:00Z");
    await w.topic("en2", w.at("2026-09-14T01:00:00Z"));
    await w.exclude("ex");
    await w.hide(hiddenQ);
    await w.hide(hiddenPost);

    const cohorts = await firstParticipation(w.db, now);
    expect(cohorts.map((x) => x.cohortWeek)).toEqual(weekStarts);
    expect(cohorts[0].stance).toEqual({ observed: true, numerator: 1, denominator: 4, people: 4, rate: 0.25 });
    expect(cohorts[0].post).toEqual({ observed: true, numerator: 2, denominator: 4, people: 4, rate: 0.5 });
    expect(cohorts[1].stance).toEqual({ observed: true, numerator: 1, denominator: 1, people: 1, rate: 1 });
    expect(cohorts[1].post).toEqual({ observed: true, numerator: 0, denominator: 1, people: 1, rate: 0 });
    expect(cohorts[4].stance).toEqual({ observed: true, numerator: 0, denominator: 1, people: 1, rate: 0 });
    expect(cohorts[4].post).toEqual({ observed: true, numerator: 1, denominator: 1, people: 1, rate: 1 });
    // not every member of the cohort has had 14 days, or the cohort is empty
    for (const i of [2, 3, 5, 6, 7]) expect(cohorts[i], `cohort ${i}`).toEqual({ cohortWeek: weekStarts[i], stance: unobserved, post: unobserved });
  }, 60_000);
});

describe("crossAreaDirectionMatrix", () => {
  it("puts the Insightful and the replies in the cell (area of the post's author, area of the member), with the row total as the denominator (by hand)", async () => {
    const w = await engage();
    const t = await w.topic("ja1", OLD); // ja
    const u = await w.topic("ja2", OLD); // ja
    const b = await w.reply("th1", t, OLD); // th
    const noArea = await w.reply("ghost", t, OLD);
    const hiddenReply = await w.reply("th1", t, OLD);
    const hiddenTopic = await w.topic("ja1", OLD);
    // Insightful: row ja (posts t and u)
    await w.vote("en1", t, "2026-09-10T00:00:00Z");
    await w.vote("th1", t, "2026-09-10T01:00:00Z");
    await w.vote("ja2", t, "2026-09-10T02:00:00Z"); // the diagonal
    await w.vote("en1", u, "2026-09-10T03:00:00Z");
    await w.vote("en2", u, "2026-09-10T04:00:00Z");
    await w.vote("ja3", u, "2026-08-10T00:00:00.000Z"); // the first millisecond of the period: counted (the diagonal)
    // row th (post b); en2 presses exactly at `now`: counted
    await w.vote("en1", b, "2026-09-10T05:00:00Z");
    await w.vote("ja1", b, "2026-09-10T06:00:00Z");
    await w.vote("ja2", b, "2026-09-10T07:00:00Z");
    await w.vote("en2", b, "2026-10-01T00:00:00.000Z");
    // not counted: under exclusion, a post without an area, a hidden post, a post in a hidden topic, a millisecond before the period, a millisecond after now
    await w.vote("ex", t, "2026-09-10T08:00:00Z");
    await w.vote("en1", noArea, "2026-09-10T09:00:00Z");
    await w.vote("en1", hiddenReply, "2026-09-10T10:00:00Z");
    await w.vote("en1", hiddenTopic, "2026-09-10T11:00:00Z");
    await w.vote("ja3", t, "2026-08-09T23:59:59.999Z");
    await w.vote("en2", t, "2026-10-01T00:00:00.001Z");
    // Replies: row ja (replies to t and to u): en1 twice, ja2 (the diagonal), th1 to u; a reply to one's own post (ja1 on t), a replier under exclusion, a replier without an area
    await w.replyTo("en1", t, w.at("2026-09-11T00:00:00Z"));
    await w.replyTo("en1", t, w.at("2026-09-11T01:00:00Z"));
    await w.replyTo("ja2", t, w.at("2026-09-11T02:00:00Z"));
    await w.replyTo("th1", u, w.at("2026-09-11T03:00:00Z"));
    await w.replyTo("ja1", t, w.at("2026-09-11T04:00:00Z"));
    await w.replyTo("ex", t, w.at("2026-09-11T05:00:00Z"));
    await w.replyTo("ghost", t, w.at("2026-09-11T06:00:00Z"));
    // row th (replies to b, with parentId): en1, ja1 and ja3
    await w.replyTo("en1", t, w.at("2026-09-11T07:00:00Z"), b);
    await w.replyTo("ja1", t, w.at("2026-09-11T08:00:00Z"), b);
    await w.replyTo("ja3", t, w.at("2026-09-11T09:00:00Z"), b);
    // not counted: a reply to a post without an area, a reply to a hidden post, a reply under a hidden topic
    await w.replyTo("en1", t, w.at("2026-09-11T10:00:00Z"), noArea);
    await w.replyTo("en2", t, w.at("2026-09-11T11:00:00Z"), hiddenReply);
    await w.replyTo("en1", hiddenTopic, w.at("2026-09-11T12:00:00Z"));
    await w.exclude("ex");
    await w.hide(hiddenReply);
    await w.hide(hiddenTopic);

    const m = await crossAreaDirectionMatrix(w.db, now);
    expect(m.from).toEqual(weekStarts[0]);
    expect(m.to).toEqual(now);
    // posts that were reacted to: t and u (ja, by ja1 and ja2), b (th, by th1)
    expect(m.rows).toEqual([
      { authorArea: "ja", entries: 2, authors: 2 },
      { authorArea: "th", entries: 1, authors: 1 },
    ]);
    // The cells are in the order of the areas (the author's area, then the member's). Insightful, row ja = 6: (ja, ja) 2 by ja2, ja3; (ja, en) 3 by en1, en2; (ja, th) 1.
    // Row th = 4: (th, ja) 2 by ja1, ja2; (th, en) 2 by en1, en2
    expect(m.insightful).toEqual([
      { authorArea: "ja", reactorArea: "ja", numerator: 2, denominator: 6, people: 2 },
      { authorArea: "ja", reactorArea: "en", numerator: 3, denominator: 6, people: 2 },
      { authorArea: "ja", reactorArea: "th", numerator: 1, denominator: 6, people: 1 },
      { authorArea: "th", reactorArea: "ja", numerator: 2, denominator: 4, people: 2 },
      { authorArea: "th", reactorArea: "en", numerator: 2, denominator: 4, people: 2 },
    ]);
    // Replies, row ja = 4: (ja, ja) 1 by ja2; (ja, en) 2 by en1; (ja, th) 1 by th1. Row th = 3: (th, ja) 2 by ja1, ja3; (th, en) 1 by en1
    expect(m.replies).toEqual([
      { authorArea: "ja", reactorArea: "ja", numerator: 1, denominator: 4, people: 1 },
      { authorArea: "ja", reactorArea: "en", numerator: 2, denominator: 4, people: 1 },
      { authorArea: "ja", reactorArea: "th", numerator: 1, denominator: 4, people: 1 },
      { authorArea: "th", reactorArea: "ja", numerator: 2, denominator: 3, people: 2 },
      { authorArea: "th", reactorArea: "en", numerator: 1, denominator: 3, people: 1 },
    ]);
    // the direction matters: nothing is in the cell (th, th) or (en, ja), and a cell is not mirrored
    expect(m.insightful.some((c) => c.authorArea === "en")).toBe(false);
  }, 60_000);

  it("is empty with nothing to count", async () => {
    const db = await createTestDb();
    expect(await crossAreaDirectionMatrix(db, now)).toEqual({ from: weekStarts[0], to: now, rows: [], insightful: [], replies: [] });
  });
});

describe("stanceDistanceByAreaPair", () => {
  async function distanceWorld() {
    const w = await engage();
    const q1 = await w.question("ko1", OLD);
    const q2 = await w.question("ko1", OLD);
    const onlyJa = await w.question("ko1", OLD);
    // Q1: ja2 agrees and en1 disagrees in week 5; ja3 disagrees and en2 agrees in week 6; en1 withdraws and ja2 changes to disagree in week 7
    await w.stance("ja2", q1, "agree", "2026-09-14T12:00:00Z");
    await w.stance("en1", q1, "disagree", "2026-09-15T12:00:00Z");
    await w.stance("ja3", q1, "disagree", "2026-09-22T12:00:00Z");
    await w.stance("en2", q1, "agree", "2026-09-23T12:00:00Z");
    await w.stance("en1", q1, null, "2026-09-29T12:00:00Z");
    await w.stance("ja2", q1, "disagree", "2026-09-30T12:00:00Z");
    // Q2: en1 chooses neither in week 6; ja2 chooses neither exactly at Monday 00:00 (week 7); th1 agrees in week 7
    await w.stance("en1", q2, "neither", "2026-09-25T12:00:00Z");
    await w.stance("ja2", q2, "neither", "2026-09-28T00:00:00.000Z");
    await w.stance("th1", q2, "agree", "2026-09-29T00:00:00Z");
    // a question with a stance from one area only: no pair
    await w.stance("ja2", onlyJa, "agree", "2026-09-29T00:00:00Z");
    // a hidden question and a member under exclusion: neither counts
    const hiddenQ = await w.question("ko1", OLD);
    await w.stance("ja2", hiddenQ, "agree", "2026-09-29T01:00:00Z");
    await w.stance("en1", hiddenQ, "disagree", "2026-09-29T01:00:00Z");
    await w.stance("ex", q1, "agree", "2026-09-29T02:00:00Z");
    await w.exclude("ex");
    await w.hide(hiddenQ);
    return { ...w, q1, q2 };
  }

  it("is the mean of the total variation distances of the questions where both areas have a stance at the end of each week, rebuilt from the changes (by hand)", async () => {
    const w = await distanceWorld();
    const points = await stanceDistanceByAreaPair(w.db, now);
    const pair = (a: string, b: string) => points.filter((p) => p.a === a && p.b === b);
    expect(points.map((p) => `${p.a}|${p.b}`).filter((k, i, all) => all.indexOf(k) === i)).toEqual(["ja|en", "ja|th", "en|th"]);
    const ends = [...weekStarts.slice(1), now];
    const jaEn = pair("ja", "en");
    expect(jaEn.map((p) => p.weekEnd)).toEqual(ends);
    // up to the end of week 4 (09-14 00:00) nobody had chosen anything: not observed
    for (const i of [0, 1, 2, 3]) expect(jaEn[i], `week ${i}`).toMatchObject({ questions: 0, people: 0, sumDistance: 0, mean: null });
    // end of week 5 (09-21): Q1 ja {agree 1} against en {disagree 1}: distance 1
    expect(jaEn[5]).toMatchObject({ questions: 1, people: 2, sumDistance: 1, mean: 1 });
    // end of week 6 (09-28 00:00): Q1 ja {agree 1, disagree 1} against en {disagree 1, agree 1}: 0. Q2 has only en (ja2's stance is at exactly 09-28 00:00: the next week)
    expect(jaEn[6]).toMatchObject({ questions: 1, people: 4, sumDistance: 0, mean: 0 });
    // now: Q1 ja {disagree 2} against en {agree 1} (en1 withdrew): 1. Q2 ja {neither} against en {neither}: 0. mean 1/2; people ja2, ja3, en2, en1
    expect(jaEn[7]).toMatchObject({ questions: 2, people: 4, sumDistance: 1, mean: 0.5 });
    // ja with th and en with th: only Q2 at the end of this week, neither against agree: 1
    expect(pair("ja", "th").map((p) => p.mean)).toEqual([null, null, null, null, null, null, null, 1]);
    expect(pair("ja", "th")[7]).toMatchObject({ questions: 1, people: 2, sumDistance: 1 });
    expect(pair("en", "th")[7]).toMatchObject({ questions: 1, people: 2, sumDistance: 1, mean: 1 });
  }, 60_000);

  it("keeps the area copied on each row (a move to another home area changes nothing), and a member who deletes their record leaves the past weeks too", async () => {
    const w = await distanceWorld();
    const before = await stanceDistanceByAreaPair(w.db, now);
    await w.db.update(profiles).set({ homeArea: "fr" }).where(eq(profiles.userId, "ja2"));
    await w.db.update(profiles).set({ homeArea: "ja" }).where(eq(profiles.userId, "en1"));
    expect(await stanceDistanceByAreaPair(w.db, now)).toEqual(before);
    // en2 deletes their record of Q1: at the end of week 6 en holds only en1's disagree: ja {agree 1, disagree 1} against en {disagree 1}: 0.5
    await deleteStanceRecord(w.db, "en2", w.q1);
    const after = await stanceDistanceByAreaPair(w.db, now);
    const jaEn = after.filter((p) => p.a === "ja" && p.b === "en");
    expect(jaEn[6]).toMatchObject({ questions: 1, people: 3, sumDistance: 0.5, mean: 0.5 });
  }, 60_000);

  it("uses the total variation distance: 0 for the same distribution, 1 for the opposite, 1/2 for half apart", () => {
    expect(totalVariationDistance({ agree: 2, disagree: 2, neither: 0 }, { agree: 1, disagree: 1, neither: 0 })).toBe(0);
    expect(totalVariationDistance({ agree: 3, disagree: 0, neither: 0 }, { agree: 0, disagree: 0, neither: 5 })).toBe(1);
    expect(totalVariationDistance({ agree: 1, disagree: 1, neither: 0 }, { agree: 0, disagree: 1, neither: 0 })).toBe(0.5);
  });

  it("is empty with no stances", async () => {
    const db = await createTestDb();
    expect(await stanceDistanceByAreaPair(db, now)).toEqual([]);
  });
});

describe("firstStancesByArea", () => {
  it("counts the oldest change of each member and question (a re-choice after a withdrawal is not first) by the area on that row; the period is the time of the first stance (by hand)", async () => {
    const w = await engage();
    const q1 = await w.question("ko1", OLD);
    const q2 = await w.question("ko1", OLD);
    const hiddenQ = await w.question("ko1", OLD);
    // Q1: ja2 agree, ja3 disagree; en1 disagree (then withdraws and chooses agree: not a first stance), en2 agree
    await w.stance("ja2", q1, "agree", "2026-09-10T00:00:00Z");
    await w.stance("ja3", q1, "disagree", "2026-09-10T01:00:00Z");
    await w.stance("en1", q1, "disagree", "2026-09-10T02:00:00Z");
    await w.stance("en1", q1, null, "2026-09-10T03:00:00Z");
    await w.stance("en1", q1, "agree", "2026-09-10T04:00:00Z");
    await w.stance("en2", q1, "agree", "2026-09-10T05:00:00Z");
    // Q2: en1 neither, th1 agree. ja2's first stance on Q2 is before the period; a later re-choice does not make it first
    await w.stance("en1", q2, "neither", "2026-09-11T00:00:00Z");
    await w.stance("th1", q2, "agree", "2026-09-11T01:00:00Z");
    await w.stance("ja2", q2, "agree", "2026-08-09T23:59:59.999Z");
    await w.stance("ja2", q2, null, "2026-09-12T00:00:00Z");
    await w.stance("ja2", q2, "disagree", "2026-09-12T01:00:00Z");
    // The period starts at 2026-08-10 00:00: a first stance at that millisecond is in
    await w.stance("ja3", q2, "neither", "2026-08-10T00:00:00.000Z");
    // a hidden question and a member under exclusion
    await w.stance("th2", hiddenQ, "agree", "2026-09-12T00:00:00Z");
    await w.stance("ex", q1, "agree", "2026-09-12T00:00:00Z");
    await w.exclude("ex");
    await w.hide(hiddenQ);

    const rows = await firstStancesByArea(w.db, now);
    // ja: Q1 by ja2 (agree) and ja3 (disagree), Q2 by ja3 (neither) = 3 first stances over 2 questions by 2 people
    // en: Q1 by en1 (disagree) and en2 (agree), Q2 by en1 (neither) = 3 over 2 questions by 2 people. th: Q2 by th1 (agree)
    expect(rows).toEqual([
      {
        area: "ja",
        questions: 2,
        people: 2,
        counts: { agree: { numerator: 1, denominator: 3, people: 1 }, disagree: { numerator: 1, denominator: 3, people: 1 }, neither: { numerator: 1, denominator: 3, people: 1 } },
      },
      {
        area: "en",
        questions: 2,
        people: 2,
        counts: { agree: { numerator: 1, denominator: 3, people: 1 }, disagree: { numerator: 1, denominator: 3, people: 1 }, neither: { numerator: 1, denominator: 3, people: 1 } },
      },
      {
        area: "th",
        questions: 1,
        people: 1,
        counts: { agree: { numerator: 1, denominator: 1, people: 1 }, disagree: { numerator: 0, denominator: 1, people: 0 }, neither: { numerator: 0, denominator: 1, people: 0 } },
      },
    ]);
  }, 60_000);

  it("is empty with no stances", async () => {
    const db = await createTestDb();
    expect(await firstStancesByArea(db, now)).toEqual([]);
  });
});

describe("questionLangComposition", () => {
  it("counts the questions by original language, by week and over the period, with alternative framings, without hidden and deleted ones or plain topics (by hand)", async () => {
    const w = await engage();
    // week 7: two in ja (ja1, ja2), one in en (en1). week 6: one in en by en1, an alternative framing of the question (in ja by ja1: a ja question too)
    const first = await w.question("ja1", w.at("2026-09-29T00:00:00Z"));
    await w.question("ja2", w.at("2026-09-30T00:00:00Z"));
    await w.question("en1", w.at("2026-09-28T00:00:00.000Z"), { lang: "en" });
    await w.question("en1", w.at("2026-09-27T23:59:59.999Z"), { lang: "en" });
    await w.question("ja1", w.at("2026-09-22T00:00:00Z"), { altOf: first });
    // not counted: a topic that asks nothing, a hidden question, a deleted question, a question before the first week and one after now
    await w.topic("ja1", w.at("2026-09-29T00:00:00Z"));
    const hidden = await w.question("th1", w.at("2026-09-29T00:00:00Z"), { lang: "en" });
    const deleted = await w.question("th1", w.at("2026-09-29T00:00:00Z"), { lang: "en" });
    await w.question("ja3", w.at("2026-08-09T23:59:59.999Z"));
    await w.question("ja3", w.at("2026-10-01T00:00:00.001Z"));
    await w.hide(hidden);
    await w.remove(deleted);

    const rows = await questionLangComposition(w.db, now);
    const of = (week: Date | null) => rows.filter((r) => (r.weekStart === null ? week === null : week !== null && r.weekStart.getTime() === week.getTime()));
    expect(of(weekStarts[7])).toEqual([
      { weekStart: weekStarts[7], lang: "ja", numerator: 2, denominator: 3, people: 2 },
      { weekStart: weekStarts[7], lang: "en", numerator: 1, denominator: 3, people: 1 },
    ]);
    // week 6: en (en1) and the alternative framing in ja (ja1)
    expect(of(weekStarts[6])).toEqual([
      { weekStart: weekStarts[6], lang: "ja", numerator: 1, denominator: 2, people: 1 },
      { weekStart: weekStarts[6], lang: "en", numerator: 1, denominator: 2, people: 1 },
    ]);
    // a week without a question has no row (not observed)
    for (const i of [0, 1, 2, 3, 4, 5]) expect(of(weekStarts[i]), `week ${i}`).toEqual([]);
    // the whole period: ja 3 of 5 (ja1 x2, ja2), en 2 of 5 (en1 x2: one person)
    expect(of(null)).toEqual([
      { weekStart: null, lang: "ja", numerator: 3, denominator: 5, people: 2 },
      { weekStart: null, lang: "en", numerator: 2, denominator: 5, people: 1 },
    ]);
  }, 60_000);
});

describe("postsByVia", () => {
  it("counts the readable posts by how they were written, with the people behind each (by hand)", async () => {
    const w = await engage();
    const t = await w.topic("ja1", w.at("2026-09-28T01:00:00Z"));
    await w.reply("ja2", t, w.at("2026-09-28T02:00:00Z"));
    const r2 = await w.reply("ja2", t, w.at("2026-09-28T03:00:00Z"));
    const r3 = await w.reply("en1", t, w.at("2026-09-28T04:00:00Z"));
    const hidden = await w.reply("th1", t, w.at("2026-09-28T05:00:00Z"));
    const deleted = await w.reply("th2", t, w.at("2026-09-28T06:00:00Z"));
    // r2 and r3 came through the API; the hidden and the deleted post are not counted. Readable: t (web, ja1), the first reply (web, ja2), r2 (api, ja2), r3 (api, en1)
    await w.db.update(entries).set({ via: "api" }).where(eq(entries.id, r2));
    await w.db.update(entries).set({ via: "api" }).where(eq(entries.id, r3));
    await w.hide(hidden);
    await w.remove(deleted);
    // 4 readable posts: web 2 by 2 people (ja1, ja2), api 2 by 2 people (ja2, en1)
    expect(await postsByVia(w.db)).toEqual([
      { via: "web", numerator: 2, denominator: 4, people: 2 },
      { via: "api", numerator: 2, denominator: 4, people: 2 },
    ]);
    // a topic hidden takes its replies with it
    await w.hide(t);
    expect(await postsByVia(w.db)).toEqual([]);
  }, 60_000);

  it("has no row with no readable post (not observed)", async () => {
    const db = await createTestDb();
    expect(await postsByVia(db)).toEqual([]);
  });
});

describe("the new metrics return no question id", () => {
  it("has no question id in the stance numbers: the shapes carry areas, counts and people only", async () => {
    const w = await engage();
    const q = await w.question("ja1", OLD);
    await w.stance("ja2", q, "agree", "2026-09-29T00:00:00Z");
    await w.stance("en1", q, "disagree", "2026-09-29T00:00:00Z");
    const metrics = await getMetrics(w.db, now);
    for (const part of [metrics.stanceDistance, metrics.firstStances, metrics.directionMatrix, metrics.questionLangs]) {
      expect(JSON.stringify(part)).not.toMatch(/question_?id|questionId|"id"/i);
    }
    expect(metrics.stanceDistance.length).toBeGreaterThan(0);
    expect(metrics.firstStances.length).toBeGreaterThan(0);
  });
});

describe("getMetrics and /admin/metrics", () => {
  it("bundles the metrics", async () => {
    const db = await createTestDb();
    const metrics = await getMetrics(db, now);
    expect(Object.keys(metrics).sort()).toEqual([
      "activeMembers",
      "aiAssistance",
      "crossAreaInsightful",
      "crossAreaReplyRate",
      "crossAreaUpdate",
      "directionMatrix",
      "firstParticipation",
      "firstStances",
      "now",
      "postsByVia",
      "questionLangs",
      "reports",
      "retention",
      "stanceDistance",
      "sustainedWriters",
    ]);
  });

  describe("route", () => {
    let h: RouteHarness;
    const saved = process.env.OPERATOR_EMAILS;
    beforeAll(async () => {
      h = await setupRouteHarness();
      await h.signIn("hana", { homeArea: "ja" });
      await h.signIn("somchai", { homeArea: "th", readLangs: ["th"] });
    });
    afterAll(() => {
      h.restore();
      if (saved === undefined) delete process.env.OPERATOR_EMAILS;
      else process.env.OPERATOR_EMAILS = saved;
    });

    it("is for operators only: visitors go to the login, other members get 404", async () => {
      const { loader } = await import("~/routes/admin-metrics");
      process.env.OPERATOR_EMAILS = "hana@example.com";
      expect(await h.outcome(() => loader(h.args(h.request("/admin/metrics"))))).toMatchObject({ status: 302, location: "/login?next=%2Fadmin%2Fmetrics" });
      expect(await h.outcome(() => loader(h.args(h.request("/admin/metrics", { as: "somchai" }))))).toMatchObject({ status: 404 });
      process.env.OPERATOR_EMAILS = "";
      expect(await h.outcome(() => loader(h.args(h.request("/admin/metrics", { as: "hana" }))))).toMatchObject({ status: 404 });
    });

    it("returns the metrics (week starts as dates) to an operator", async () => {
      const { loader } = await import("~/routes/admin-metrics");
      process.env.OPERATOR_EMAILS = "hana@example.com";
      const res = await h.outcome(() => loader(h.args(h.request("/admin/metrics", { as: "hana" }))));
      expect(res.status).toBe(200);
      const value = res.value as {
        weeks: string[];
        crossAreaReplyRate: Array<{ weekStart: string; people: number }>;
        insightful: Array<{ weekStart: string; observed: boolean }>;
        update: Array<{ weekStart: string; changes: number }>;
        active: Array<{ weekStart: string; members: number }>;
        retention: Array<{ cohortWeek: string; observed: boolean }>;
        firstParticipation: Array<{ cohortWeek: string; stance: { observed: boolean }; post: { observed: boolean } }>;
        direction: { rows: unknown[] };
        distance: unknown[];
        firstStances: unknown[];
        questionLangs: unknown[];
        sustainedWriters: unknown[];
        aiAssistance: unknown[];
        reports: { total: number };
        postsByVia: unknown[];
      };
      expect(value.crossAreaReplyRate).toHaveLength(8);
      expect(value.crossAreaReplyRate[0].weekStart).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      // the new sections: eight weeks (or cohorts) each, dates as strings, nothing observed yet in an empty database
      expect(value.weeks).toHaveLength(8);
      expect(value.weeks[0]).toBe(value.crossAreaReplyRate[0].weekStart);
      for (const list of [value.insightful, value.update, value.active, value.retention, value.firstParticipation]) expect(list).toHaveLength(8);
      expect(value.insightful.every((w) => w.observed === false)).toBe(true);
      expect(value.firstParticipation.every((c) => c.stance.observed === false && c.post.observed === false)).toBe(true);
      expect(value.direction.rows).toEqual([]);
      expect([value.distance, value.firstStances, value.questionLangs, value.postsByVia]).toEqual([[], [], [], []]);
      expect(value.sustainedWriters).toHaveLength(AREAS.length);
      expect(value.aiAssistance).toHaveLength(AREAS.length);
      expect(value.reports.total).toBe(0);
    });
  });
});
