import { seedReplies } from "./helpers/fixtures";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { entries } from "~/lib/db/schema";
import { createReply, createTopic, getThread, listTopics, recomputeThreadActivity, replyLocation, replyPage, softDeleteEntry } from "~/lib/entries.server";
import type { Lang } from "~/lib/languages";
import { checkPagination, pageSearch, parsePageParam } from "~/lib/pagination";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";
import { addMember, createTestDb } from "./helpers/db";

// Use a time before the actual present so a later post created with the real clock comes last.
const at = (minutes: number) => new Date(Date.UTC(2026, 8, 1, 0, minutes));

async function topic(db: Parameters<typeof createTopic>[0], lang: Lang, title: string, minutes: number, author = "u1") {
  const res = await createTopic(db, author, { lang, title, body: `${title} 本文`, }, { now: at(minutes) });
  if (!res.ok) throw new Error("topic failed");
  return res.id;
}
async function reply(db: Parameters<typeof createTopic>[0], threadId: number, minutes: number, author = "u1") {
  const res = await createReply(db, author, threadId, { lang: "ja", body: `返信 ${minutes}` }, { now: at(minutes) });
  if (!res.ok) throw new Error("reply failed");
  return res.id;
}
const row = async (db: Parameters<typeof createTopic>[0], id: number) => (await db.select().from(entries).where(eq(entries.id, id)))[0];

describe("entries.last_activity_at and entries.reply_count", () => {
  it("are the topic's own time and 0 for a new topic, and follow replies as they are created", async () => {
    const db = await createTestDb();
    await addMember(db, "u1", "hana");
    const t = await topic(db, "ja", "話題", 0);
    expect(await row(db, t)).toMatchObject({ replyCount: 0, lastActivityAt: at(0) });
    const r1 = await reply(db, t, 5);
    expect(await row(db, t)).toMatchObject({ replyCount: 1, lastActivityAt: at(5) });
    // A past-dated reply does not move last activity backward.
    await reply(db, t, 3);
    expect(await row(db, t)).toMatchObject({ replyCount: 2, lastActivityAt: at(5) });
    await reply(db, t, 9);
    expect(await row(db, t)).toMatchObject({ replyCount: 3, lastActivityAt: at(9) });
    // Reply rows do not use aggregate columns.
    expect(await row(db, r1)).toMatchObject({ replyCount: 0 });
  });

  it("are recounted after a reply is deleted (recomputeThreadActivity)", async () => {
    const db = await createTestDb();
    await addMember(db, "u1", "hana");
    const t = await topic(db, "ja", "話題", 0);
    await reply(db, t, 5);
    const last = await reply(db, t, 9);
    await db.update(entries).set({ deletedAt: at(10) }).where(eq(entries.id, last));
    await recomputeThreadActivity(db, t);
    expect(await row(db, t)).toMatchObject({ replyCount: 1, lastActivityAt: at(5) });
    await db.update(entries).set({ deletedAt: at(11) }).where(and(eq(entries.threadId, t), eq(entries.kind, "reply")));
    await recomputeThreadActivity(db, t);
    expect(await row(db, t)).toMatchObject({ replyCount: 0, lastActivityAt: at(0) });
    // A non-topic ID has no effect.
    await recomputeThreadActivity(db, 99999);
  });

  it("follow softDeleteEntry: a deleted reply leaves the count and the last activity; a deleted topic leaves the lists", async () => {
    const db = await createTestDb();
    await addMember(db, "u1", "hana");
    const t = await topic(db, "ja", "話題", 0);
    const r1 = await reply(db, t, 5);
    const r2 = await reply(db, t, 9);
    expect(await softDeleteEntry(db, r2, { now: at(10) })).toEqual({ ok: true, threadId: t });
    expect(await row(db, t)).toMatchObject({ replyCount: 1, lastActivityAt: at(5) });
    expect((await row(db, r2)).deletedAt).toEqual(at(10));
    expect(await softDeleteEntry(db, r2)).toEqual({ ok: false, error: "not_found" });
    expect(await softDeleteEntry(db, 424242)).toEqual({ ok: false, error: "not_found" });
    // Pagination counts deleted replies even when no placeholder is needed. reply_count counts only nondeleted replies.
    expect((await getThread(db, t))).toMatchObject({ replyCount: 1, replyTotal: 2, pageCount: 1 });
    const replies = (await getThread(db, t))!.replies;
    expect(replies.map((r) => [r.id, r.visibility])).toEqual([[r1, "visible"]]);
    expect(await softDeleteEntry(db, t)).toEqual({ ok: true, threadId: t });
    expect((await listTopics(db)).topics).toEqual([]);
    expect(await getThread(db, t)).toBeNull();
  });
});

describe("listTopics", () => {
  it("orders by the last activity (newest first), then by id, and excludes deleted topics", async () => {
    const db = await createTestDb();
    await addMember(db, "u1", "hana");
    const old = await topic(db, "ja", "古い", 0);
    const mid = await topic(db, "ja", "中", 10);
    const hidden = await topic(db, "ja", "消えた", 20);
    await db.update(entries).set({ deletedAt: at(21) }).where(eq(entries.id, hidden));
    await reply(db, old, 30);
    const tie = await topic(db, "ja", "同時", 10);
    expect((await listTopics(db)).topics.map((t) => t.id)).toEqual([old, tie, mid]);
  });

  it("filters by original language (langs, not-langs) and pages 30 at a time with hasNext", async () => {
    const db = await createTestDb();
    await addMember(db, "u1", "hana");
    for (let i = 0; i < 35; i++) await topic(db, i % 2 === 0 ? "ja" : "en", `題${i}`, i);
    const all1 = await listTopics(db, { kind: "all" });
    expect(all1).toMatchObject({ page: 1, limit: 30, hasNext: true });
    expect(all1.topics).toHaveLength(30);
    const all2 = await listTopics(db, { kind: "all" }, { page: 2 });
    expect(all2).toMatchObject({ page: 2, hasNext: false });
    expect(all2.topics).toHaveLength(5);
    expect(new Set([...all1.topics, ...all2.topics].map((t) => t.id)).size).toBe(35);
    const ja = await listTopics(db, { kind: "langs", langs: ["ja"] }, { limit: 100 });
    expect(ja.topics).toHaveLength(18);
    expect(ja.topics.every((t) => t.lang === "ja")).toBe(true);
    const notJa = await listTopics(db, { kind: "not-langs", langs: ["ja"] }, { limit: 10 });
    expect(notJa.topics).toHaveLength(10);
    expect(notJa.hasNext).toBe(true);
    expect(notJa.topics.every((t) => t.lang === "en")).toBe(true);
    // Multiple languages for a reader in the "その他" area.
    const two = await listTopics(db, { kind: "langs", langs: ["ja", "en"] }, { limit: 100 });
    expect(two.topics).toHaveLength(35);
    expect((await listTopics(db, { kind: "langs", langs: ["fr"] })).topics).toEqual([]);
    expect((await listTopics(db, { kind: "langs", langs: [] })).topics).toEqual([]);
    expect((await listTopics(db, { kind: "not-langs", langs: [] }, { limit: 100 })).topics).toHaveLength(35);
  });

  it("rejects an invalid page or limit", async () => {
    const db = await createTestDb();
    for (const bad of [{ page: 0 }, { page: -1 }, { page: 1.5 }, { page: Number.NaN }, { page: 10_001 }, { limit: 0 }, { limit: -5 }, { limit: 101 }, { limit: 2.5 }, { limit: Number.POSITIVE_INFINITY }]) {
      await expect(listTopics(db, { kind: "all" }, bad), JSON.stringify(bad)).rejects.toThrow(RangeError);
      await expect(getThread(db, 1, bad)).rejects.toThrow(RangeError);
    }
    expect(checkPagination({ page: 3, limit: 20 })).toEqual({ page: 3, limit: 20, offset: 40 });
    expect(checkPagination()).toEqual({ page: 1, limit: 30, offset: 0 });
    expect(checkPagination({ limit: 100 }).limit).toBe(100);
  });
});

describe("the thread's replies are paged 100 at a time", () => {
  it("returns the page, the total and the page count from the stored reply_count, and locates a reply", async () => {
    const db = await createTestDb();
    await addMember(db, "u1", "hana");
    const t = await topic(db, "ja", "長い話題", 0);
    const ids = await seedReplies(db, "u1", t, Array.from({ length: 205 }, (_, i) => ({ body: `返信 ${i + 1}`, createdAt: at(i + 1) })));
    const p1 = (await getThread(db, t))!;
    expect(p1).toMatchObject({ page: 1, pageSize: 100, pageCount: 3, replyCount: 205 });
    expect(p1.replies).toHaveLength(100);
    expect(p1.replies[0].id).toBe(ids[0]);
    const p3 = (await getThread(db, t, { page: 3 }))!;
    expect(p3.replies.map((r) => r.id)).toEqual(ids.slice(200));
    expect((await getThread(db, t, { page: 4 }))!.replies).toEqual([]);
    expect((await getThread(db, t, { limit: 50, page: 2 }))!.replies[0].id).toBe(ids[50]);
    expect(await replyPage(db, t, ids[0])).toBe(1);
    expect(await replyPage(db, t, ids[99])).toBe(1);
    expect(await replyPage(db, t, ids[100])).toBe(2);
    expect(await replyPage(db, t, ids[204])).toBe(3);
    expect(await replyLocation(db, t, ids[204])).toBe(`/t/${t}?page=3#c-${ids[204]}`);
    expect(await replyLocation(db, t, ids[3])).toBe(`/t/${t}#c-${ids[3]}`);
    // If supplied, preserve ?lang=, the page-only display language, after pagination parameters and before the anchor.
    expect(await replyLocation(db, t, ids[204], { lang: "th" })).toBe(`/t/${t}?page=3&lang=th#c-${ids[204]}`);
    expect(await replyLocation(db, t, ids[3], { lang: "en" })).toBe(`/t/${t}?lang=en#c-${ids[3]}`);
    expect(await replyLocation(db, t, ids[3], { lang: null })).toBe(`/t/${t}#c-${ids[3]}`);
    // Treat a reply outside the thread as belonging to page 1.
    expect(await replyPage(db, t, 424242)).toBe(1);
  }, 30_000);
});

describe("pagination helpers", () => {
  it("parses ?page= and rewrites it while keeping other parameters", () => {
    expect(parsePageParam(null)).toBe(1);
    expect(parsePageParam("3")).toBe(3);
    for (const bad of ["0", "-1", "abc", "1e2", "01", "1.5", "", "10001", "9999999999"]) expect(parsePageParam(bad), bad).toBeNull();
    expect(parsePageParam("10000")).toBe(10_000);
    expect(pageSearch("?lang=en&page=2", 3)).toBe("?lang=en&page=3");
    expect(pageSearch("?lang=en&page=2", 1)).toBe("?lang=en");
    expect(pageSearch("", 1)).toBe("");
    expect(pageSearch("", 2)).toBe("?page=2");
    expect(pageSearch("?lang=en&page=3&membersPage=2", 1, "membersPage")).toBe("?lang=en&page=3");
    expect(pageSearch("?lang=en&page=3", 2, "membersPage")).toBe("?lang=en&page=3&membersPage=2");
  });

});

describe("home, latest and area pages (routes)", () => {
  let h: RouteHarness;
  const ids: Record<string, number> = {};
  beforeAll(async () => {
    h = await setupRouteHarness();
    await h.signIn("hana", { homeArea: "ja", readLangs: ["ja"] });
    await h.signIn("john", { homeArea: "en", readLangs: ["en", "ja"] });
    await h.signIn("lee", { homeArea: "other", readLangs: ["ko", "vi"] });
    const make = async (who: string, lang: Lang, title: string, minutes: number) => {
      const res = await createTopic(h.db, h.ids[who], { lang, title, body: `${title} 本文` }, { now: at(minutes) });
      if (!res.ok) throw new Error("topic failed");
      ids[title] = res.id;
    };
    await make("hana", "ja", "日本語1", 1);
    await make("hana", "ja", "日本語2", 2);
    await make("john", "en", "English1", 3);
    await make("lee", "ko", "한국어1", 4);
    await make("lee", "vi", "Tiếng Việt1", 5);
    await make("john", "de", "Deutsch1", 6);
    // A reply to an old topic moves that topic to the top.
    const reply = await createReply(h.db, h.ids.john, ids["日本語1"], { lang: "en", body: "reply" }, { now: at(20) });
    if (!reply.ok) throw new Error("reply failed");
  });
  afterAll(() => h.restore());

  const titles = (items: Array<{ id: number }>) => items.map((t) => Object.entries(ids).find(([, id]) => id === t.id)![0]);

  it("/latest lists every topic and /a/:lang lists one original language, 404 for unknown languages", async () => {
    // Fill more than one page while retaining the original-language fixtures.
    for (let i = 0; i < 12; i++) {
      const res = await createTopic(h.db, h.ids.john, { lang: "fr", title: `Français${i}`, body: "b" }, { now: at(100 + i) });
      if (!res.ok) throw new Error("topic failed");
    }
    for (let i = 0; i < 30; i++) {
      const res = await createTopic(h.db, h.ids.hana, { lang: "ja", title: `追加${i}`, body: "b" }, { now: at(200 + i) });
      if (!res.ok) throw new Error("topic failed");
    }
    const latest = await import("~/routes/latest");
    const area = await import("~/routes/area");
    const all = (await latest.loader(await h.signedArgs(h.request("/latest", { as: "hana" })))) as { topics: Array<{ id: number }>; page: number; hasNext: boolean };
    expect(all.topics).toHaveLength(30);
    expect(all.hasNext).toBe(true);
    const page2 = (await latest.loader(await h.signedArgs(h.request("/latest?page=2", { as: "hana" })))) as { topics: unknown[] };
    expect(page2.topics.length).toBeGreaterThan(0);
    const ko = (await area.loader(await h.signedArgs(h.request("/a/ko", { as: "hana" }), { lang: "ko" }))) as { lang: string; topics: Array<{ id: number; lang: string }> };
    expect(ko.lang).toBe("ko");
    expect(titles(ko.topics)).toEqual(["한국어1"]);
    const de = (await area.loader(await h.signedArgs(h.request("/a/de", { as: "hana" }), { lang: "de" }))) as { topics: unknown[] };
    expect(de.topics).toHaveLength(1);
    const hant = (await area.loader(await h.signedArgs(h.request("/a/zh-Hant", { as: "hana" }), { lang: "zh-Hant" }))) as { topics: unknown[] };
    expect(hant.topics).toEqual([]);
    for (const lang of ["xx", "other", "JA", "ja-JP", ""]) {
      expect((await h.outcome(async () => (await area.loader(await h.signedArgs(h.request(`/a/${lang}`, { as: "hana" }), { lang }))))).status, lang).toBe(404);
    }
    expect((await h.outcome(async () => (await area.loader(await h.signedArgs(h.request("/a/ja?page=0", { as: "hana" }), { lang: "ja" }))))).status).toBe(404);
  });

  it("the member pages require a login", async () => {
    for (const [name, load] of [
      ["home", () => import("~/routes/home")],
      ["latest", () => import("~/routes/latest")],
      ["area", () => import("~/routes/area")],
    ] as const) {
      const mod = await load();
      expect(await h.outcome(async () => (await mod.loader(await h.signedArgs(h.request("/x"), { lang: "ja" })))), name).toMatchObject({ status: 302, location: "/login?next=%2Fx" });
    }
  });

  it("the thread page pages replies, answers 404 past the last page, and redirects a new reply to its page", async () => {
    const topicRoute = await import("~/routes/topic");
    const t = await createTopic(h.db, h.ids.hana, { lang: "ja", title: "長い", body: "本文" }, { now: at(300) });
    if (!t.ok) throw new Error("topic failed");
    await seedReplies(h.db, h.ids.hana, t.id, Array.from({ length: 100 }, (_, i) => ({ body: `r${i}`, createdAt: at(301 + i) })));
    const params = { id: String(t.id) };
    type TopicData = { replies: unknown[]; page: number; hasNextPage: boolean };
    const p1 = (await topicRoute.loader(await h.signedArgs(h.request(`/t/${t.id}`, { as: "hana" }), params))) as unknown as TopicData;
    expect(p1).toMatchObject({ page: 1, hasNextPage: false });
    expect(p1.replies).toHaveLength(100);
    expect((await h.outcome(async () => (await topicRoute.loader(await h.signedArgs(h.request(`/t/${t.id}?page=2`, { as: "hana" }), params))))).status).toBe(404);
    const posted = await h.outcome(async () => topicRoute.action(await h.signedArgs(h.request(`/t/${t.id}`, { as: "hana", form: { body: "101番目", lang: "ja" } }), params)));
    expect(posted.status).toBe(302);
    const published = new URL(posted.location!, "http://localhost");
    expect(published.pathname).toBe(`/t/${t.id}`);
    expect(published.searchParams.get("page")).toBe("2");
    expect(published.searchParams.get("posted")).toMatch(/^[1-9]\d*$/);
    expect(published.hash).toBe(`#c-${published.searchParams.get("posted")}`);
    const p2 = (await topicRoute.loader(await h.signedArgs(h.request(`/t/${t.id}?page=2`, { as: "hana" }), params))) as unknown as TopicData;
    expect(p2).toMatchObject({ page: 2, hasNextPage: false });
    expect(p2.replies).toHaveLength(1);
    expect((await topicRoute.loader(await h.signedArgs(h.request(`/t/${t.id}`, { as: "hana" }), params)) as unknown as TopicData).hasNextPage).toBe(true);
  });
});
