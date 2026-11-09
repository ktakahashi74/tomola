import { seedReplies } from "./helpers/fixtures";
import { and, eq, inArray } from "drizzle-orm";
import { createElement } from "react";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { Pagination } from "~/components/pagination";
import { TopicList } from "~/components/topic-list";
import { entries, profiles, roles, translations } from "~/lib/db/schema";
import { createReply, createTopic, getEntryViews, listTopics, replyPage } from "~/lib/entries.server";
import { setFollow } from "~/lib/follows.server";
import { loadLatestReplyLocations } from "~/lib/reply-locations.server";
import { toTopicItems } from "~/lib/topic-list.server";
import { renderInRouter } from "./helpers/render-in-router";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";

let h: RouteHarness;
const at = (n: number) => new Date(Date.UTC(2030, 0, 1, 0, 0, n));
const ids: Record<string, number> = {};

async function topic(body: string, asksStance = false) {
  const result = await createTopic(h.db, h.ids.writer, { lang: "en", body, ...(asksStance ? { title: body, asksStance } : {}) });
  if (!result.ok) throw new Error("topic failed");
  return result.id;
}
async function reply(threadId: number, body: string, n: number, lang = "en", stanceTag?: "agree") {
  const result = await createReply(h.db, h.ids.writer, threadId, { lang, body, ...(stanceTag ? { stanceTag } : {}) }, { now: at(n) });
  if (!result.ok) throw new Error("reply failed");
  return result.id;
}
async function cards(readLangs: ("en" | "ja")[] = ["en"], displayLang: "en" | "ja" = "en") {
  const page = await listTopics(h.db, { kind: "all" }, { limit: 100, viewer: { userId: h.ids.boss, scope: { operator: true, langs: [] } } });
  return toTopicItems(h.db, page.topics, { readLangs, displayLang });
}
async function thread(id: number, query = "", as: string | null = "reader") {
  const { loader } = await import("~/routes/topic");
  return (await loader(h.args(h.request(`/t/${id}${query}`, as ? { as } : {}), { id: String(id) })));
}

beforeAll(async () => {
  vi.stubEnv("OPERATOR_EMAILS", "boss@example.com");
  h = await setupRouteHarness();
  for (const who of ["writer", "reader", "boss", "engmod"]) await h.signIn(who, { homeArea: "en", readLangs: ["en"] });
  await h.db.insert(roles).values({ userId: h.ids.engmod, role: "moderator", lang: "en" });
  ids.empty = await topic("No replies");
  ids.withheld = await topic("All replies withheld");
  const deleted = await reply(ids.withheld, "DELETED_SECRET", 1);
  const hidden = await reply(ids.withheld, "HIDDEN_SECRET", 2);
  await h.db.update(entries).set({ deletedAt: at(300) }).where(eq(entries.id, deleted));
  await h.db.update(entries).set({ hiddenAt: at(300) }).where(eq(entries.id, hidden));

  ids.long = await topic("A long thread");
  const longReplies = await seedReplies(h.db, h.ids.writer, ids.long, Array.from({ length: 205 }, (_, i) => ({ body: i === 100 ? "Visible latest reply" : `Withheld reply ${i + 1}`, createdAt: at(i + 1), lang: "en" })));
  ids.latest = longReplies[100];
  // The latest visible reply is on page two; later placeholders extend the
  // thread to page three. Earlier placeholders must count toward its page.
  await h.db.update(entries).set({ deletedAt: at(300) }).where(inArray(entries.id, longReplies.filter((_, i) => i !== 100 && i !== 204)));
  await h.db.update(entries).set({ hiddenAt: at(300) }).where(eq(entries.id, longReplies[204]));

  ids.question = await topic("Question with reasons", true);
  ids.questionReply = await reply(ids.question, "QUESTION_REASON_SECRET", 1, "en", "agree");
  ids.translated = await topic("Reply in Japanese");
  ids.japaneseReply = await reply(ids.translated, "**日本語の原文**。[リンク](https://example.com) 👨‍👩‍👧‍👦", 1, "ja");
  const view = (await getEntryViews(h.db, [ids.japaneseReply])).get(ids.japaneseReply)!;
  await h.db.insert(translations).values({ entryId: view.id, field: "body", lang: "en", kind: "primary", text: "**Translated reply** with a [link](https://example.com).", engine: "fake", model: "test-model", sourceHash: view.sourceHash, fallback: true });

  ids.ten = await topic("Ten replies");
  await seedReplies(h.db, h.ids.writer, ids.ten, Array.from({ length: 10 }, (_, i) => ({ body: `Threshold reply ${i + 1}`, createdAt: at(i + 1), lang: "en" })));
});
afterAll(() => { h.restore(); vi.unstubAllEnvs(); });

it("counts withheld replies for positions, but never chooses them even for privileged readers", async () => {
  const selected = (await loadLatestReplyLocations(h.db, [ids.long, ids.empty, ids.withheld])).get(ids.long)!;
  expect(selected).toEqual({ id: ids.latest, page: 2 });
  expect(selected.page).toBe(await replyPage(h.db, ids.long, ids.latest));
  expect((await loadLatestReplyLocations(h.db, [ids.empty, ids.withheld])).size).toBe(0);
  const topicCards = await cards();
  for (const as of ["writer", "reader", "boss", "engmod"]) {
    const data = await thread(ids.long, "?lang=ja", as);
    expect(data.latestReplyHref, as).toBe(`/t/${ids.long}?page=2&lang=ja#c-${ids.latest}`);
    expect(data.pageCount).toBe(3);
    expect(data.replyCount).toBe(topicCards.find(c => c.id === ids.long)?.replyCount);
  }
  expect(topicCards.find(c => c.id === ids.long)?.latestReply).toMatchObject({ id: ids.latest, page: 2 });
  expect(topicCards.find(c => c.id === ids.empty)?.latestReply).toBeNull();
  expect(topicCards.find(c => c.id === ids.withheld)?.latestReply).toBeNull();
  expect(JSON.stringify(topicCards)).not.toMatch(/DELETED_SECRET|HIDDEN_SECRET|Withheld reply/);
});

it("uses creation time before id, breaking identical timestamps by id", async () => {
  const id = await topic("Ordering");
  const first = await reply(id, "Same time first", 10);
  const last = await reply(id, "Same time last", 10);
  await reply(id, "Larger id but older", 9);
  expect(last).toBeGreaterThan(first);
  expect((await loadLatestReplyLocations(h.db, [id])).get(id)?.id).toBe(last);
});

it("treats excluded writers like other replies, including on an authorized hidden topic row", async () => {
  await h.db.update(profiles).set({ reactionsExcludedAt: at(300) }).where(eq(profiles.userId, h.ids.writer));
  await h.db.update(entries).set({ hiddenAt: at(300) }).where(eq(entries.id, ids.translated));
  try {
    expect((await cards()).find(c => c.id === ids.translated)).toMatchObject({ hidden: true, latestReply: { id: ids.japaneseReply } });
  } finally {
    await h.db.update(profiles).set({ reactionsExcludedAt: null }).where(eq(profiles.userId, h.ids.writer));
    await h.db.update(entries).set({ hiddenAt: null }).where(eq(entries.id, ids.translated));
  }
});

it("keeps reply bodies and authors out of row data and rendered markup", async () => {
  const question = (await cards()).find(c => c.id === ids.question)!;
  expect(question.latestReply).toEqual({ id: ids.questionReply, page: 1 });
  const html = await renderInRouter(() => createElement(TopicList, { topics: [question], langParam: "ja", empty: "none", reader: true }));
  expect(html).toContain(`href="/t/${ids.question}?lang=ja#c-${ids.questionReply}"`);
  expect(html).not.toContain("QUESTION_REASON_SECRET");
  expect(question.latestReply).not.toHaveProperty("authorHandle");
  expect(question.latestReply).not.toHaveProperty("excerpt");
  expect(JSON.stringify(await cards())).not.toMatch(/Translated reply|日本語の原文|QUESTION_REASON_SECRET/);
});

it("adds thread jumps only above ten replies and never for tag filters", async () => {
  expect((await thread(ids.ten)).latestReplyHref).toBeNull();
  const newest = await reply(ids.ten, "Eleventh reply", 11);
  expect((await thread(ids.ten)).latestReplyHref).toBe(`/t/${ids.ten}#c-${newest}`);
  expect((await thread(ids.long, "?tag=agree")).latestReplyHref).toBeNull();
  const question = await topic("Filtered pagination", true);
  await seedReplies(h.db, h.ids.writer, question, Array.from({ length: 201 }, (_, i) => ({ body: i < 101 ? `Filtered reply ${i + 1}` : `Unmarked reply ${i + 1}`, createdAt: at(i + 1), lang: "en", ...(i < 101 ? { stanceTag: "agree" as const } : {}) })));
  expect((await thread(question)).pageCount).toBe(3);
  const data = await thread(question, "?tag=agree&lang=ja");
  expect(data).toMatchObject({ pageCount: 2, latestReplyHref: null, replyCount: 201 });
  expect((await thread(question, "?page=3")).replyCount).toBe(201);
  const html = await renderInRouter(() => createElement(Pagination, { page: 1, hasNext: true, lastPage: data.pageCount, anchor: "#replies" }), `/t/${question}?tag=agree&lang=ja`);
  expect(html.match(new RegExp(`href="/t/${question}\\?tag=agree&amp;lang=ja&amp;page=2#replies"`, "g"))).toHaveLength(2);
});

it("keeps default pagination unchanged and omits the last jump on the last page", async () => {
  const old = await renderInRouter(() => createElement(Pagination, { page: 1, hasNext: true }), "/?lang=ja");
  expect(old.match(/<a /g)).toHaveLength(1);
  const last = await renderInRouter(() => createElement(Pagination, { page: 3, hasNext: false, lastPage: 3, anchor: "#replies" }), "/t/1?page=3&lang=ja");
  expect(last.match(/<a /g)).toHaveLength(1);
  expect(last).toContain('href="/t/1?lang=ja&amp;page=2#replies"');
});

it("shares latest-reply positions across home, source-language and followed lists, including public readers", async () => {
  const { loader: home } = await import("~/routes/home");
  const { loader: area } = await import("~/routes/area");
  const { loader: following } = await import("~/routes/following");
  await setFollow(h.db, h.ids.reader, ids.long, true);
  expect((await home(h.args(h.request("/", { as: "reader" })))).topics?.find(c => c.id === ids.long)?.latestReply?.id).toBe(ids.latest);
  expect((await area(h.args(h.request("/a/en", { as: "reader" }), { lang: "en" }))).topics.find(c => c.id === ids.long)?.latestReply?.id).toBe(ids.latest);
  expect((await following(h.args(h.request("/following?all=1", { as: "reader" })))).topics.find(c => c.id === ids.long)?.latestReply?.id).toBe(ids.latest);
  vi.stubEnv("PUBLIC_READING", "1");
  expect((await home(h.args(h.request("/")))).topics?.find(c => c.id === ids.long)?.latestReply?.id).toBe(ids.latest);
  expect((await thread(ids.long, "", null)).latestReplyHref).toContain(`#c-${ids.latest}`);
  vi.unstubAllEnvs();
});
