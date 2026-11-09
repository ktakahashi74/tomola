import { quietLogger as quiet } from "./helpers/logger";
import { eq } from "drizzle-orm";
import { createElement } from "react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { drafts, entries, profiles, translations } from "~/lib/db/schema";
import { createReply, createTopic, softDeleteEntry } from "~/lib/entries.server";
import { runDueJobs } from "~/lib/jobs/queue.server";
import { createTranslationHandlers } from "~/lib/jobs/translation-jobs.server";
import { createFakeEngine } from "~/lib/llm/engines/fake.server";
import * as markdownModule from "~/lib/markdown.server";
import { RENDER_VERSION } from "~/lib/markdown.server";
import { hideEntry } from "~/lib/moderation.server";
import { TOPICS_PER_PAGE } from "~/lib/pagination";
import type { TopicItem } from "~/lib/topic-list.server";
import { assertStartupConfig } from "~/lib/startup-checks.server";
import { setStance } from "~/lib/stances.server";
import { skipRevalidationFor } from "~/lib/stance-ui";
import { setVote } from "~/lib/votes.server";
import { getMd, parseBlocks } from "./helpers/md";
import { renderInRouter } from "./helpers/render-in-router";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";

// List order, filters, row metadata, visibility, pagination and Markdown parity.
const at = (minutes: number) => new Date(Date.UTC(2030, 0, 1, 0, minutes));


let h: RouteHarness;
const ids: Record<string, number> = {};

type Card = TopicItem;
type HomeData = {
  layout: "unified";
  order: "created" | "activity" | "insightful";
  filter: "all" | "asks" | "long";
  topics: Card[];
  page: number;
  hasNext: boolean;
  langParam: string | null;
};

async function make(who: string, lang: string, title: string | null, body: string, minutes: number, extra: Record<string, unknown> = {}): Promise<number> {
  const res = await createTopic(h.db, h.ids[who], { lang, ...(title === null ? {} : { title }), body, ...extra }, { now: at(minutes) });
  if (!res.ok) throw new Error(`topic failed: ${res.error}`);
  return res.id;
}

const loadHome = async (as: string, path = "/") => {
  const { loader } = await import("~/routes/home");
  return (await loader(h.args(h.request(path, { as })))) as unknown as HomeData;
};
const loadArea = async (as: string, lang: string, path: string) => {
  const { loader } = await import("~/routes/area");
  return (await loader(h.args(h.request(path, { as }), { lang }))) as unknown as { topics: Card[]; hasNext: boolean; order: string; filter: string };
};
const idsOf = (topics: Card[]) => topics.map((c) => c.id);
const translateAll = async () => {
  const handlers = createTranslationHandlers({ llm: { engines: { primary: createFakeEngine(), secondary: null, judge: null }, env: {} } });
  await runDueJobs(h.db, handlers, { now: new Date("2031-01-01T00:00:00Z"), logger: quiet, limit: 1000 });
};

afterEach(() => vi.unstubAllEnvs());

describe("the order and the filters of the stream", () => {
  beforeAll(async () => {
    h = await setupRouteHarness();
    await h.signIn("hana", { homeArea: "ja", readLangs: ["ja"] });
    await h.signIn("john", { homeArea: "en", readLangs: ["en"] });
    await h.signIn("somchai", { homeArea: "th", readLangs: ["th", "ja"] });
    await h.signIn("kim", { homeArea: "ja", readLangs: ["ja", "en"] });
  });
  afterAll(() => h.restore());

  it("shows the topics of every language in one stream, newest posts first; a reply does not lift an old topic; ?order=activity puts it first", async () => {
    ids.ja = await make("hana", "ja", "日本語の題", "日本語の本文", 1);
    ids.en = await make("john", "en", "An English title", "English body", 2);
    ids.th = await make("somchai", "th", "หัวข้อ", "เนื้อหา", 3);
    const reply = await createReply(h.db, h.ids.john, ids.ja, { lang: "en", body: "a reply" }, { now: at(20) });
    if (!reply.ok) throw new Error("reply failed");
    const created = await loadHome("hana");
    expect(created).toMatchObject({ layout: "unified", order: "created", filter: "all", page: 1, hasNext: false });
    expect(idsOf(created.topics)).toEqual([ids.th, ids.en, ids.ja]);
    expect(new Set(created.topics.map((c) => c.lang))).toEqual(new Set(["ja", "en", "th"]));
    const activity = await loadHome("hana", "/?order=activity");
    expect(activity.order).toBe("activity");
    expect(idsOf(activity.topics)).toEqual([ids.ja, ids.th, ids.en]);
    expect((await loadHome("hana", "/?order=created")).order).toBe("created");
    expect(idsOf((await loadHome("hana", "/?order=")).topics)).toEqual(idsOf(created.topics));
  });

  it("the default does not order by the number of Insightful: an old topic with many presses does not rise", async () => {
    for (const who of ["john", "somchai", "kim"]) expect((await setVote(h.db, h.ids[who], ids.ja, true)).ok).toBe(true);
    const created = await loadHome("hana");
    expect(idsOf(created.topics)).toEqual([ids.th, ids.en, ids.ja]);
    expect(created.topics.find((c) => c.id === ids.ja)?.insightful.total).toBe(3);
    expect(idsOf((await loadHome("hana", "/?order=activity")).topics)).toEqual([ids.ja, ids.th, ids.en]);
  });

  it("gives the same ids in the same order to readers who differ in main language, stance and what they read", async () => {
    const q = await make("hana", "ja", "賛否を聞く命題", "条件です。", 30, { asksStance: true });
    ids.q = q;
    expect((await setStance(h.db, h.ids.kim, { questionId: q, position: "agree", expectedVersion: 0 }, { now: at(31) })).ok).toBe(true);
    const lists = await Promise.all(["hana", "john", "somchai", "kim"].map(async (who) => idsOf((await loadHome(who)).topics)));
    for (const list of lists) expect(list).toEqual(lists[0]);
    const activity = await Promise.all(["hana", "john", "somchai", "kim"].map(async (who) => idsOf((await loadHome(who, "/?order=activity")).topics)));
    for (const list of activity) expect(list).toEqual(activity[0]);
  });

  it("?asks=1 keeps the questions only; ?long=1 keeps the topics with a title (a titleless topic is out, a short topic with a title is in); both gives the questions only", async () => {
    ids.bare = await make("hana", "ja", null, "題のない、とても長い本文。".repeat(300), 40);
    ids.shortTitled = await make("hana", "ja", "短い本文の、題のある話題", "短い。", 41);
    const asks = await loadHome("hana", "/?asks=1");
    expect(asks.filter).toBe("asks");
    expect(idsOf(asks.topics)).toEqual([ids.q]);
    const long = await loadHome("hana", "/?long=1");
    expect(long.filter).toBe("long");
    const longIds = idsOf(long.topics);
    expect(longIds).toContain(ids.shortTitled);
    expect(longIds).toContain(ids.q);
    expect(longIds).not.toContain(ids.bare);
    expect(long.topics.every((c) => !c.title.fromBody)).toBe(true);
    const both = await loadHome("hana", "/?asks=1&long=1");
    expect(both.filter).toBe("asks");
    expect(idsOf(both.topics)).toEqual([ids.q]);
    expect(idsOf((await loadHome("hana", "/?asks=1&order=activity")).topics)).toEqual([ids.q]);
  });

  it("answers 400 for an order it does not know and 404 for a bad page", async () => {
    const { loader } = await import("~/routes/home");
    for (const bad of ["x", "CREATED", "recent", "1"]) expect((await h.outcome(async () => (await loader(h.args(h.request(`/?order=${bad}`, { as: "hana" })))))).status, bad).toBe(400);
    for (const bad of ["0", "-1", "x"]) expect((await h.outcome(async () => (await loader(h.args(h.request(`/?page=${bad}`, { as: "hana" })))))).status, bad).toBe(404);
  });

  it("pages by TOPICS_PER_PAGE and the links keep the order, the filter and ?lang= (the loader says there is a next page; the screen carries the query)", async () => {
    const many: number[] = [];
    for (let i = 0; i < TOPICS_PER_PAGE + 2; i++) many.push(await make("hana", "ja", `ページ送りの題 ${i}`, "本文", 100 + i));
    const p1 = await loadHome("hana");
    expect(p1.topics).toHaveLength(TOPICS_PER_PAGE);
    expect(p1.hasNext).toBe(true);
    expect(idsOf(p1.topics)[0]).toBe(many.at(-1));
    const p2 = await loadHome("hana", "/?page=2");
    expect(p2).toMatchObject({ page: 2 });
    expect(p2.topics.length).toBeGreaterThan(0);
    expect(idsOf(p2.topics).some((id) => idsOf(p1.topics).includes(id))).toBe(false);
    // the screen: the order switch, the filter and the pagination links
    const { default: Home } = await import("~/routes/home");
    const html = await renderInRouter(() => createElement(Home as never, { loaderData: { ...p1, aiOpen: { mdUrl: "http://x/home.md", mdPath: "/home.md" }, stanceMessage: null, filter: "long", order: "activity" }, actionData: undefined, params: {}, matches: [] } as never), "/?order=activity&long=1&lang=en");
    // (the interface texts are empty in the unit tests; the words are checked in the browser tests)
    expect(html).toContain('href="/?order=activity&amp;long=1&amp;lang=en&amp;page=2"');
    // the order switch: the current one is marked, and the link to the default order drops ?order=
    expect(html).toMatch(/<a aria-current="page" class="[^"]*" href="\/\?order=activity&amp;long=1&amp;lang=en"/);
    expect(html).toContain('href="/?long=1&amp;lang=en"');
    // the filter: the current one is marked; switching keeps the order and the language and drops the page
    expect(html).toMatch(/<a aria-current="true" class="[^"]*" href="\/\?order=activity&amp;lang=en&amp;long=1"/);
    expect(html).toContain('href="/?order=activity&amp;lang=en"');
    expect(html).toContain('href="/?order=activity&amp;lang=en&amp;asks=1"');
  });
});

describe("the data and rendering of a row", () => {
  beforeAll(async () => {
    h = await setupRouteHarness();
    await h.signIn("hana", { homeArea: "ja", readLangs: ["ja"] });
    await h.signIn("john", { homeArea: "en", readLangs: ["en"] });
    await h.signIn("kim", { homeArea: "ja", readLangs: ["ja", "en"] });
    await h.signIn("moriko", { homeArea: "ja", readLangs: ["ja"] });
  });
  afterAll(() => h.restore());
  const draw = async (who: string, path = "/") => {
    const { default: Home } = await import("~/routes/home");
    const data = await loadHome(who, path);
    return renderInRouter(() => createElement(Home as never, { loaderData: data, actionData: undefined, params: {}, matches: [] } as never), path);
  };

  it("uses the readable title or its translation, with a pending mark when no translation exists", async () => {
    ids.a = await make("hana", "ja", "朝の題", "BODY_SECRET", 1);
    ids.b = await make("hana", "ja", null, "夕方の短い発言。", 2);
    expect((await loadHome("john")).topics.find(t => t.id === ids.a)?.title).toMatchObject({ pending: true, lang: "ja" });
    await translateAll();
    expect((await loadHome("john")).topics.find(t => t.id === ids.a)?.title).toMatchObject({ pending: false, lang: "en", kind: "primary", fromBody: false });
    for (const who of ["hana", "kim"]) {
      expect((await loadHome(who)).topics.find(t => t.id === ids.a)?.title).toMatchObject({ text: "朝の題", lang: "ja", kind: null });
    }
    expect((await loadHome("john")).topics.find(t => t.id === ids.b)?.title).toMatchObject({ fromBody: true, lang: "en" });
    expect((await loadHome("hana")).topics.find(t => t.id === ids.b)?.title).toMatchObject({ fromBody: true, text: "夕方の短い発言。" });
    expect(JSON.stringify(await loadHome("hana"))).not.toContain("BODY_SECRET");
    expect(await draw("hana")).not.toContain("BODY_SECRET");
  });

  it("carries latest reply positions but no reply authors, bodies, excerpts or card actions", async () => {
    const reply = await createReply(h.db, h.ids.kim, ids.a, { lang: "ja", body: "REPLY_SECRET" }, { now: at(50) });
    if (!reply.ok) throw new Error("reply failed");
    const row = (await loadHome("hana")).topics.find(t => t.id === ids.a)!;
    expect(row).toMatchObject({ replyCount: 1, latestReply: { id: reply.id, page: 1 }, createdAt: at(1).toISOString(), lastActivityAt: at(50).toISOString() });
    expect(Object.keys(row.latestReply!).sort()).toEqual(["id", "page"]);
    const html = await draw("hana", "/?lang=en");
    expect(html).toContain(`href="/t/${ids.a}?lang=en#c-${reply.id}"`);
    expect(html).toContain(`href="/t/${ids.a}?lang=en"`);
    expect(html).not.toContain("REPLY_SECRET");
    expect(html).not.toMatch(/action="\/(?:vote|follow)"|<article|<textarea/);
  });

  it("shows creation time for newest order and last activity for recent replies", async () => {
    const created = await draw("hana");
    const activity = await draw("hana", "/?order=activity");
    const row = (html: string) => html.split(`<li id="q-${ids.a}"`)[1]?.split("</li>")[0] ?? "";
    expect(row(created)).toContain(`dateTime="${at(1).toISOString()}"`);
    expect(row(activity)).toContain(`dateTime="${at(50).toISOString()}"`);
    // The text under the pointer is a readable date, never the machine string.
    expect(row(created)).not.toContain(`title="${at(1).toISOString()}"`);
    expect(row(created)).toMatch(/title="[A-Z][a-z]+ \d{1,2}, \d{4} at /);
  });

  it("shows aggregate Insightful counts without personal reaction or follow state", async () => {
    expect((await setVote(h.db, h.ids.kim, ids.a, true)).ok).toBe(true);
    for (const who of ["hana", "kim"]) {
      const row = (await loadHome(who)).topics.find(t => t.id === ids.a)!;
      expect(row.insightful).toEqual({ total: 1, langs: 1 });
      for (const key of ["body", "translation", "followState", "mine", "sourceVersion"]) expect(row).not.toHaveProperty(key);
    }
  });

  it("keeps hidden topics restricted to authorized viewers and omits deleted topics", async () => {
    const hidden = await make("hana", "ja", "Hidden topic", "HIDDEN_BODY", 80);
    const gone = await make("hana", "ja", "Deleted topic", "DELETED_BODY", 81);
    await hideEntry(h.db, { id: h.ids.moriko, scope: { operator: true, langs: [] } }, { entryId: hidden, reason: "spam", note: "n" });
    await softDeleteEntry(h.db, gone);
    expect((await loadHome("hana")).topics.find(t => t.id === hidden)).toMatchObject({ hidden: true, canChoose: false });
    expect((await loadHome("hana")).topics.some(t => t.id === gone)).toBe(false);
    for (const who of ["john", "kim"]) expect((await loadHome(who)).topics.some(t => t.id === hidden || t.id === gone)).toBe(false);
  });

  it("keeps question stances compact and distributions gated by the viewer's choice", async () => {
    const q = await make("hana", "ja", "Question", "QUESTION_BODY", 90, { asksStance: true });
    expect((await loadHome("kim")).topics.find(t => t.id === q)).toMatchObject({ asksStance: true, stance: { position: null }, distribution: null });
    expect((await setStance(h.db, h.ids.kim, { questionId: q, position: "agree", expectedVersion: 0 })).ok).toBe(true);
    expect((await loadHome("kim")).topics.find(t => t.id === q)?.distribution).toMatchObject({ total: 1, counts: { agree: 1 } });
    expect((await loadHome("hana")).topics.find(t => t.id === q)?.distribution).toBeNull();
    const html = await draw("hana");
    expect(html).toContain('action="/stance"');
    expect(html).not.toContain("QUESTION_BODY");
    expect(JSON.stringify((await loadHome("hana")).topics)).not.toContain(h.ids.kim);
  });

  it("keeps rows readable during suspension and removes stance submissions", async () => {
    const q = await make("hana", "ja", "Suspension controls", "A question remains readable.", 95, { asksStance: true });
    await h.db.update(profiles).set({ suspendedUntil: new Date("2099-01-01T00:00:00Z") }).where(eq(profiles.userId, h.ids.kim));
    try {
      expect((await loadHome("kim")).topics.find(t => t.id === q)).toMatchObject({ canChoose: false });
      const html = await draw("kim");
      const row = html.split(`<li id="q-${q}"`)[1]?.split("</li>")[0] ?? "";
      expect(row).toContain("Suspension controls");
      expect(row).not.toContain('name="position"');
    } finally {
      await h.db.update(profiles).set({ suspendedUntil: null }).where(eq(profiles.userId, h.ids.kim));
    }
    expect((await loadHome("kim")).topics.find(t => t.id === q)?.canChoose).toBe(true);
  });
});

describe("the queries, the saved renders and the revalidation", () => {
  beforeAll(async () => {
    h = await setupRouteHarness();
    await h.signIn("hana", { homeArea: "ja", readLangs: ["ja"] });
    await h.signIn("john", { homeArea: "en", readLangs: ["en"] });
  });
  afterAll(() => h.restore());

  type Client = { query: (...args: unknown[]) => unknown };
  const clientOf = () => (h.db as unknown as { $client: Client }).$client;
  async function countQueries(run: () => Promise<unknown>): Promise<number> {
    const spy = vi.spyOn(clientOf(), "query");
    try {
      await run();
      return spy.mock.calls.length;
    } finally {
      spy.mockRestore();
    }
  }

  it("makes the same number of queries for a page of thirty rows as for a page of three, and draws nothing when the saved renders are current", { timeout: 20_000 }, async () => {
    // three cards that use every branch: a translated topic with a title, a topic without a title, a question the reader chose a stance on
    const small = [await make("hana", "ja", "翻訳される題", "本文。", 1), await make("hana", "ja", null, "題のない本文。", 2), await make("hana", "ja", "命題", "条件。", 3, { asksStance: true })];
    await translateAll();
    expect((await setStance(h.db, h.ids.john, { questionId: small[2], position: "agree", expectedVersion: 0 }, { now: at(4) })).ok).toBe(true);
    // Warm one-time session and rate-limit cleanup before comparing page size.
    await loadHome("john");
    const three = await countQueries(() => loadHome("john"));
    expect((await loadHome("john")).topics).toHaveLength(3);
    // twenty-seven more of the same kinds
    for (let i = 0; i < TOPICS_PER_PAGE - 3; i++) {
      await make("hana", "ja", i % 3 === 0 ? null : `題 ${i}`, `本文 ${i}`, 10 + i, i % 3 === 2 ? { asksStance: true } : {});
    }
    await translateAll();
    const thirty = await countQueries(() => loadHome("john"));
    expect((await loadHome("john")).topics).toHaveLength(TOPICS_PER_PAGE);
    expect(thirty).toBe(three);
    expect(thirty).toBeLessThan(40);
    // no render function is called: every saved render is current
    const spies = [
      vi.spyOn(markdownModule, "renderEntry"),
      vi.spyOn(markdownModule, "renderEntryOrPlain"),
      vi.spyOn(markdownModule, "tryRenderEntry"),
      vi.spyOn(markdownModule, "renderMarkdownOrPlain"),
      vi.spyOn(markdownModule, "tryRenderMarkdown"),
    ];
    await loadHome("john");
    await loadHome("hana");
    for (const spy of spies) { expect(spy).not.toHaveBeenCalled(); spy.mockRestore(); }
  });

  it("does not rebuild stale body renders when reading titles", async () => {
    await h.db.update(entries).set({ htmlVersion: RENDER_VERSION - 1 });
    await h.db.update(translations).set({ htmlVersion: RENDER_VERSION - 1 });
    const spy = vi.spyOn(markdownModule, "renderEntryOrPlain");
    try {
      await loadHome("john");
      await loadHome("hana");
      expect(spy).not.toHaveBeenCalled();
      const rows = await h.db.select({ v: entries.htmlVersion }).from(entries);
      expect(rows.every(r => r.v === RENDER_VERSION - 1)).toBe(true);
    } finally { spy.mockRestore(); }
  });

  it("does not reload the list after a one-tap press (/vote, /stance) and does after an ordinary submission or an ordinary move", async () => {
    const { shouldRevalidate } = await import("~/routes/home");
    const area = await import("~/routes/area");
    for (const route of [shouldRevalidate, area.shouldRevalidate]) {
      const call = (formAction: string | undefined) => route({ formAction, defaultShouldRevalidate: true } as never);
      expect(call("/vote")).toBe(false);
      expect(call("/stance")).toBe(false);
      // Ordinary navigation and non-self-updating submissions revalidate.
      expect(call("/?index")).toBe(true);
      expect(call("/")).toBe(true);
      expect(call(undefined)).toBe(true);
    }
    // the table of self-updating actions has no entry for the home's action
    expect(skipRevalidationFor("/?index")).toBe(false);
    expect(skipRevalidationFor("/vote?x=1#y")).toBe(true);
  });
});

describe("home page", () => {
  beforeAll(async () => {
    h = await setupRouteHarness();
    await h.signIn("hana", { homeArea: "ja", readLangs: ["ja"] });
    await h.signIn("john", { homeArea: "en", readLangs: ["en"] });
    ids.l1 = await make("hana", "ja", "日本語の話題", "本文", 1);
    ids.l2 = await make("john", "en", "English topic", "body", 2);
  });
  afterAll(() => h.restore());

  const draw = async (data: unknown, path = "/") => {
    const { default: Home } = await import("~/routes/home");
    return renderInRouter(() => createElement(Home as never, { loaderData: { ...(data as object), aiOpen: { mdUrl: "http://x/home.md", mdPath: "/home.md" }, stanceMessage: null }, actionData: undefined, params: {}, matches: [] } as never), path);
  };

  it("ignores HOME_LAYOUT=split at startup and renders one stream", async () => {
    vi.stubEnv("HOME_LAYOUT", "split");
    expect(() => assertStartupConfig({ TOMOLA_OPERATOR_DIR: process.env.TOMOLA_OPERATOR_DIR, NODE_ENV: "test", HOME_LAYOUT: "split" }, () => {})).not.toThrow();
    const data = await loadHome("hana");
    expect(data.layout).toBe("unified");
    expect(idsOf(data.topics)).toEqual([ids.l2, ids.l1]);
    const html = await draw(data);
    for (const id of [ids.l1, ids.l2]) expect(html).toContain(`<li id="q-${id}"`);
    expect(html).not.toContain("<section");
  });

  it("the default home has rows, without an input form", async () => {
    const html = await draw(await loadHome("hana"));
    expect(html).not.toContain('name="body"');
    expect(html).not.toMatch(/<textarea\b|<form[^>]*action="\/(?:\?index)?"/);
    expect(html).not.toContain("<article");
    expect(html).toContain(`<li id="q-${ids.l1}"`);
    const layout = await import("~/routes/member-layout");
    const navigation = await layout.loader(h.args(h.request("/", { as: "hana" })));
    const header = await renderInRouter(() => createElement(layout.default as never, { loaderData: navigation, params: {}, matches: [] } as never));
    expect(header).not.toContain('href="/latest"');
  });

  it("rejects home POSTs without creating a topic or draft", async () => {
    const { action } = await import("~/routes/home");
    const before = await h.db.select().from(entries);
    for (const intent of ["", "draft", "collapse"]) {
      for (const as of ["hana", undefined]) {
        const request = h.request("/?index", { as, form: { body: "Must not publish", intent } });
        await expect(Promise.resolve().then(() => action(h.args(request)))).rejects.toMatchObject({ init: { status: 405, headers: { Allow: "GET, HEAD" } } });
      }
    }
    expect(await h.db.select().from(entries)).toEqual(before);
    expect(await h.db.select().from(drafts)).toEqual([]);
  });

  it("/a/:lang uses the same rows (the same component and the same data shape), in the same order and with the same filters", async () => {
    const home = await loadHome("hana");
    const area = await loadArea("hana", "ja", "/a/ja");
    expect(area).toMatchObject({ order: "created", filter: "all" });
    expect(idsOf(area.topics)).toEqual([ids.l1]);
    expect(Object.keys(area.topics[0]).sort()).toEqual(Object.keys(home.topics.find((c) => c.id === ids.l1)!).sort());
    expect(await loadArea("hana", "ja", "/a/ja?order=activity")).toMatchObject({ order: "activity" });
    expect((await loadArea("hana", "ja", "/a/ja?long=1")).filter).toBe("long");
    const { default: Area } = await import("~/routes/area");
    const html = await renderInRouter(() => createElement(Area as never, { loaderData: { ...area, lang: "ja", langParam: null, page: 1, aiOpen: { mdUrl: "http://x/a/ja.md", mdPath: "/a/ja.md" }, stanceMessage: null }, params: {}, matches: [] } as never), "/a/ja");
    expect(html).toContain(`<li id="q-${ids.l1}"`);
    expect(html).not.toContain('name="body"');
    expect(html).toMatch(/<a lang="ja" aria-current="page" [^>]*href="\/a\/ja"/);
    expect(html).toMatch(/<a [^>]*href="\/"[^>]*>/);
  }, 20_000);
});

describe("/home.md", () => {
  let k: string;
  beforeAll(async () => {
    h = await setupRouteHarness();
    await h.signIn("hana", { homeArea: "ja", readLangs: ["ja"] });
    await h.signIn("john", { homeArea: "en", readLangs: ["en"] });
    ids.m1 = await make("hana", "ja", "索引の題", "本文の合言葉BODYWORD。", 1);
    ids.m2 = await make("john", "en", null, "A short remark without a title.", 2);
    ids.m3 = await make("hana", "ja", "賛否の命題", "条件。", 3, { asksStance: true });
    const reply = await createReply(h.db, h.ids.john, ids.m1, { lang: "en", body: "reply" }, { now: at(10) });
    if (!reply.ok) throw new Error("reply failed");
    k = "";
  });
  afterAll(() => h.restore());
  const md = async (path: string, as = "hana") => parseBlocks(await (await getMd(h, path, { as })).text());
  const itemIds = (block: { body: string }) => [...block.body.matchAll(/^- id: p-(\d+)/gm)].map((m) => Number(m[1]));

  it("is an index: the id, the title or the excerpt, the language, the author, the counts and the links; no body, no html", async () => {
    const blocks = await md("/home.md");
    expect(blocks[0].fm).toMatchObject({ type: "index", title: "Home: topics in every language, newest first", order: "created", canonical: "http://localhost:5173/" });
    expect(blocks[0].fm).not.toHaveProperty("asks_only");
    expect(blocks[0].fm).not.toHaveProperty("titled_only");
    const { parse } = await import("yaml");
    const items = parse(blocks[0].body, { schema: "core" }) as Array<Record<string, unknown>>;
    expect(items.map((i) => i.id)).toEqual([`p-${ids.m3}`, `p-${ids.m2}`, `p-${ids.m1}`]);
    const [question, bare, titled] = items;
    expect(titled).toMatchObject({ title: "索引の題", lang: "ja", author: "@hana", display_name: null, display_name_latin: null, replies: 1, md: `http://localhost:5173/t/${ids.m1}.md?lang=ja`, canonical: `http://localhost:5173/t/${ids.m1}` });
    expect(titled.created).toBe("2030-01-01T00:01:00Z");
    expect(titled).not.toHaveProperty("excerpt");
    expect(question).toMatchObject({ asks_stance: true });
    // a topic without a title has no title key, and has an excerpt (the beginning of the body)
    expect(bare).not.toHaveProperty("title");
    expect(bare).toMatchObject({ excerpt: "A short remark without a title." });
    // not the body: neither the text of a body nor html
    expect(blocks[0].body).not.toContain("BODYWORD");
    expect(blocks[0].body).not.toMatch(/<p>|<div/);
    expect(Object.keys(titled).sort()).toEqual(["author", "canonical", "created", "display_name", "display_name_latin", "id", "insightful", "insightful_langs", "lang", "last_activity", "md", "replies", "title"]);
  });

  it("has the same ids in the same order as the screen, with the same filters and the same order switch", async () => {
    for (const [screen, twin] of [
      ["/", "/home.md"],
      ["/?order=activity", "/home.md?order=activity"],
      ["/?order=insightful", "/home.md?order=insightful"],
      ["/?asks=1", "/home.md?asks=1"],
      ["/?long=1", "/home.md?long=1"],
      ["/?asks=1&long=1&order=activity", "/home.md?asks=1&long=1&order=activity"],
    ] as const) {
      expect(itemIds((await md(twin))[0]), twin).toEqual(idsOf((await loadHome("hana", screen)).topics));
    }
    const activity = await md("/home.md?order=activity");
    expect(activity[0].fm).toMatchObject({ order: "activity", title: "Home: topics in every language, most recent activity first" });
    expect((await md("/home.md?asks=1"))[0].fm).toMatchObject({ asks_only: true });
    expect((await md("/home.md?long=1"))[0].fm).toMatchObject({ titled_only: true });
    expect((await md("/home.md?long=1"))[0].body).not.toMatch(new RegExp(`id: p-${ids.m2}\\b`));
    // questions only wins over long posts only
    expect((await md("/home.md?asks=1&long=1"))[0].fm).toMatchObject({ asks_only: true });
    expect((await md("/home.md?asks=1&long=1"))[0].fm).not.toHaveProperty("titled_only");
  });

  it("answers 400 for an order it does not know and keeps the order and the filters in the link to the next page", async () => {
    const bad = await getMd(h, "/home.md?order=newest", { as: "hana" });
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain("invalid_order");
    for (let i = 0; i < TOPICS_PER_PAGE; i++) await make("hana", "ja", `追加 ${i}`, "b", 100 + i);
    const first = await md("/home.md?order=activity&long=1&lang=en");
    const next = (first.at(-1)!.fm as { next: string }).next;
    expect(new URL(next).pathname).toBe("/home.md");
    expect(Object.fromEntries(new URL(next).searchParams)).toEqual({ order: "activity", long: "1", lang: "en", page: "2" });
    // the second page is the screen's second page
    expect(itemIds((await md("/home.md?page=2"))[0])).toEqual(idsOf((await loadHome("hana", "/?page=2")).topics));
    expect(k).toBe("");
  });

  it("the language list and /latest have the same options, the created time and the excerpt of a topic without a title", async () => {
    const area = await md("/a/ja.md?order=created");
    expect(area[0].fm).toMatchObject({ lang: "ja", order: "created" });
    expect(area[0].body).toContain("created:");
    expect((await md("/a/en.md"))[0].body).toContain("excerpt:");
    const latest = await md("/latest.md?long=1");
    expect(latest[0].fm).toMatchObject({ titled_only: true });
    expect(latest[0].body).not.toMatch(new RegExp(`id: p-${ids.m2}\\b`));
    expect((await getMd(h, "/latest.md?order=x", { as: "hana" })).status).toBe(400);
    expect((await getMd(h, "/a/ja.md?order=x", { as: "hana" })).status).toBe(400);
  });

});
