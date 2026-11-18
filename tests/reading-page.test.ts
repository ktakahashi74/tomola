import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { entries, follows, profiles, topicListingStats } from "~/lib/db/schema";
import { createTopic, listTopics, type TopicScope } from "~/lib/entries.server";
import { listIntroductions } from "~/lib/introductions.server";
import { listSavedTopics, setTopicSaved } from "~/lib/saved-topics.server";
import { loadMemberPageContent, resolveMemberPage } from "~/lib/member-pages.server";
import { appendReadingItems, decodeReadingCursor, encodeReadingCursor, readReadingRequest, readingHref, readingLatestHref, type ReadingPage } from "~/lib/reading-page";
import { rememberViewingPosts } from "~/lib/list-seen";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";

let h: RouteHarness;
const ids: number[] = [];
const request = (order: string, query = "", param = "list") => readReadingRequest(new Request(`http://localhost/${query}`), order, 1, param);
const next = (page: ReadingPage) => readingHref("?lang=en", page, true);
const topicIds = (page: { topics: { id: number }[] }) => page.topics.map(topic => topic.id);

beforeAll(async () => {
  h = await setupRouteHarness();
  await h.signIn("cursor_writer", { homeArea: "en", readLangs: ["en"] });
  await h.signIn("cursor_reader", { homeArea: "en", readLangs: ["en"] });
  for (let index = 0; index < 65; index++) {
    const made = await createTopic(h.db, h.ids.cursor_writer, { lang: index % 2 ? "ja" : "en", ...(index % 3 ? { title: `Cursor post ${index}` } : {}), body: "Cursor fixture.", asksStance: index % 4 === 1 && index % 3 !== 0 }, { now: new Date("2026-01-01T00:00:00Z") });
    if (!made.ok) throw new Error(made.error);
    ids.push(made.id);
  }
  await h.db.insert(follows).values(ids.map(threadId => ({ userId: h.ids.cursor_reader, threadId, state: "following" as const })));
});
afterAll(() => h.restore());

for (const order of ["created", "activity", "insightful"] as const) {
  describe(`${order} cursor boundaries`, () => {
    const scopes: TopicScope[] = [{ kind: "all" }, { kind: "langs", langs: ["en"] }, { kind: "not-langs", langs: ["ja"] }];
    for (const scope of scopes) for (const filter of [{}, { asksOnly: true }, { titledOnly: true }]) {
      it(`matches the complete order for ${scope.kind} and ${JSON.stringify(filter)}`, async () => {
        const options = { order, ...filter };
        const expected = await listTopics(h.db, scope, { ...options, limit: 100 });
        let page = await listTopics(h.db, scope, { ...options, reading: request(order) });
        const all = [...page.topics];
        for (let count = 0; page.hasNext && count < 5; count++) {
          page = await listTopics(h.db, scope, { ...options, reading: request(order, next(page.list!)) });
          all.push(...page.topics);
        }
        expect(all.map(topic => topic.id)).toEqual(topicIds(expected));
        expect(new Set(all.map(topic => topic.id)).size).toBe(all.length);
        expect(page.list!.next).toBeNull();
      });
    }
  });
}

it("keeps tied timestamps stable after insertion, and restores the frozen head and expanded count", async () => {
  const first = await listTopics(h.db, { kind: "all" }, { order: "created", reading: request("created") });
  const made = await createTopic(h.db, h.ids.cursor_writer, { lang: "en", title: "New head", body: "New head" }, { now: new Date("2026-02-01T00:00:00Z") });
  if (!made.ok) throw new Error(made.error);
  const second = await listTopics(h.db, { kind: "all" }, { order: "created", reading: request("created", next(first.list!)) });
  expect(topicIds(second).some(id => topicIds(first).includes(id))).toBe(false);
  const expanded = { ...first.list!, count: 60, next: second.list!.next };
  const restored = await listTopics(h.db, { kind: "all" }, { order: "created", reading: request("created", readingHref("", expanded, false)) });
  expect(topicIds(restored)).toEqual([...topicIds(first), ...topicIds(second)]);
  expect(topicIds(restored)).not.toContain(made.id);
  expect(restored.list).toMatchObject({ restored: true, older: false });
  await h.db.update(entries).set({ hiddenAt: new Date() }).where(eq(entries.id, made.id));
});

it("retains timestamp microseconds in the cursor", async () => {
  await h.db.execute(sql`update entries set created_at = '2026-01-02 00:00:00.000123+00' where id = ${ids[64]}`);
  const first = await listTopics(h.db, { kind: "all" }, { order: "created", reading: { ...request("created"), count: 1 } });
  expect(decodeReadingCursor(first.list!.next!, "created").keys[0]).toContain("000123");
  const second = await listTopics(h.db, { kind: "all" }, { order: "created", reading: request("created", next(first.list!)) });
  expect(topicIds(second)).not.toContain(ids[64]);
  await h.db.update(entries).set({ createdAt: new Date("2026-01-01T00:00:00Z") }).where(eq(entries.id, ids[64]));
});

it("uses the original range for old page URLs and continues from that range by cursor", async () => {
  const { loader } = await import("~/routes/home");
  const old = await loader(h.args(h.request("/?page=2", { as: "cursor_reader" })));
  const expected = await listTopics(h.db, { kind: "all" }, { page: 2, order: "created" });
  expect(topicIds(old)).toEqual(topicIds(expected));
  expect(old.list.older).toBe(true);
  const continuation = await loader(h.args(h.request(`/${next(old.list)}`, { as: "cursor_reader" })));
  expect(topicIds(continuation)).toEqual(topicIds(await listTopics(h.db, { kind: "all" }, { page: 3, order: "created" })));
  const restoredHref = readingHref("?page=2", { ...old.list, count: old.topics.length + continuation.topics.length }, false);
  const restored = await loader(h.args(h.request(`/${restoredHref}`, { as: "cursor_reader" })));
  expect(topicIds(restored)).toEqual([...topicIds(old), ...topicIds(continuation)]);
  expect(restored.list).toMatchObject({ restored: true, older: false });
});

it("keeps followed membership, unread and empty-language boundaries", async () => {
  for (const unreadOnly of [false, true]) {
    const scope: TopicScope = { kind: "followed", userId: h.ids.cursor_reader, unreadOnly };
    const first = await listTopics(h.db, scope, { reading: request("activity") });
    const second = await listTopics(h.db, scope, { reading: request("activity", next(first.list!)) });
    expect([...topicIds(first), ...topicIds(second)]).toEqual(topicIds(await listTopics(h.db, scope, { limit: 60 })));
  }
  const empty = await listTopics(h.db, { kind: "langs", langs: [] }, { reading: request("activity") });
  expect(empty.list!.next).toBeNull();
});

it("deduplicates IDs when a mutable Insightful value crosses a boundary", async () => {
  const first = await listTopics(h.db, { kind: "all" }, { order: "insightful", reading: request("insightful") });
  const moved = first.topics[0].id;
  for (const topic of first.topics) await h.db.update(topicListingStats).set({ insightfulCount: 1 }).where(eq(topicListingStats.topicId, topic.id));
  await h.db.update(topicListingStats).set({ insightfulCount: 2 }).where(eq(topicListingStats.topicId, moved));
  const raised = await listTopics(h.db, { kind: "all" }, { order: "insightful", reading: request("insightful") });
  await h.db.update(topicListingStats).set({ insightfulCount: 0 }).where(eq(topicListingStats.topicId, moved));
  const more = await listTopics(h.db, { kind: "all" }, { order: "insightful", reading: request("insightful", next(raised.list!)) });
  expect(topicIds(more)).toContain(moved);
  const merged = appendReadingItems(raised.topics, more.topics);
  expect(new Set(topicIds({ topics: merged })).size).toBe(merged.length);
  expect(topicIds({ topics: merged }).filter(id => id === moved)).toHaveLength(1);
  for (const topic of first.topics) await h.db.update(topicListingStats).set({ insightfulCount: 0 }).where(eq(topicListingStats.topicId, topic.id));
});

it("reads saved and introduction lists with their own ordering values", async () => {
  for (const id of ids) await setTopicSaved(h.db, h.ids.cursor_reader, id, true, { now: new Date("2026-03-01T00:00:00Z") });
  const first = await listSavedTopics(h.db, h.ids.cursor_reader, { reading: request("saved") });
  const second = await listSavedTopics(h.db, h.ids.cursor_reader, { reading: request("saved", next(first.list!)) });
  expect([...topicIds(first), ...topicIds(second)]).toEqual([...ids].reverse().slice(0, 60));
  await h.db.update(profiles).set({ introEntryId: ids[2] }).where(eq(profiles.userId, h.ids.cursor_writer));
  const intro = await listIntroductions(h.db, { reading: request("created") });
  expect(topicIds(intro)).toEqual([ids[2]]);
  expect(intro.list!.next).toBeNull();
});

it("loads 30 posts on member pages and restores an expanded range", async () => {
  const member = (await resolveMemberPage(h.db, "cursor_writer"))!;
  const opts = { viewerId: h.ids.cursor_reader, readLangs: ["en"] as const, displayLang: "en" as const, page: 1 };
  const first = await loadMemberPageContent(h.db, member, { ...opts, reading: request("created") });
  const second = await loadMemberPageContent(h.db, member, { ...opts, reading: request("created", next(first.list!)) });
  expect(first.topics).toHaveLength(30);
  expect(second.topics).toHaveLength(30);
  expect(new Set([...topicIds(first), ...topicIds(second)]).size).toBe(60);
  const restored = await loadMemberPageContent(h.db, member, { ...opts, reading: request("created", readingHref("", { ...first.list!, count: 60 }, false)) });
  expect(topicIds(restored)).toEqual([...topicIds(first), ...topicIds(second)]);
});

it("rejects malformed, wrong-order, excessive and wrong-arity cursors and caps restoration", async () => {
  for (const query of ["?list_after=broken", "?list_count=301", "?list_count=0", "?list_count=1e2"]) expect(() => request("created", query)).toThrow();
  const bad = encodeReadingCursor({ order: "activity", keys: ["2026-01-01T00:00:00Z", 1] });
  expect(() => request("created", `?list_after=${bad}`)).toThrow();
  const wrongArity = encodeReadingCursor({ order: "created", keys: [1, "2026-01-01T00:00:00Z", 1] });
  expect(() => request("created", `?list_after=${wrongArity}`)).toThrow();
  const restored = await listTopics(h.db, { kind: "all" }, { order: "created", reading: request("created", "?list_count=300") });
  expect(restored.topics.length).toBeLessThanOrEqual(300);
  expect(readingLatestHref("?lang=en&list_after=x&list_start=y&list_count=300", restored.list!)).toBe("?lang=en");
});

it.each([
  "2026-02-30 00:00:00+00", "1900-02-29T00:00:00Z", "0000-01-01 00:00:00+00",
  "2026-01-01 00:00:00+99", "2026-01-01T00:00:00-15:60", "2026-01-01T24:00:00Z",
])("rejects an out-of-range cursor timestamp before querying the database (%s)", (time) => {
  const cursor = encodeReadingCursor({ order: "created", keys: [time, 1] });
  expect(() => request("created", `?list_start=${cursor}`)).toThrow(expect.objectContaining({ status: 400 }));
});

it("accepts valid leap dates and PostgreSQL offsets while preserving cursor precision", () => {
  const time = "2000-02-29 23:59:59.123456-15:59";
  const cursor = encodeReadingCursor({ order: "created", keys: [time, 1] });
  expect(request("created", `?list_after=${cursor}`).after?.keys).toEqual([time, 1]);
});

it("marks appended posts against the frozen guest boundary without writing again", () => {
  let value = JSON.stringify([["/", "2026-01-01T00:00:00Z"]]);
  let writes = 0;
  const storage = { getItem: () => value, setItem: (_: string, next: string) => { value = next; writes++; } };
  const view = {};
  const head = { id: 1, createdAt: "2026-01-03T00:00:00Z" };
  rememberViewingPosts(storage, "/", [head], view);
  const marks = rememberViewingPosts(storage, "/", [head, { id: 2, createdAt: "2026-01-02T00:00:00Z" }, { id: 3, createdAt: "2025-01-01T00:00:00Z" }], view);
  expect(marks).toEqual({ newIds: [1, 2], boundaryAfter: 2 });
  expect(writes).toBe(1);
});
