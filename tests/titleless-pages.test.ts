import { quietLogger as quiet } from "./helpers/logger";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StaticRouter } from "react-router";
import { eq } from "drizzle-orm";
import { parse as parseYaml } from "yaml";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { TopicList } from "~/components/topic-list";
import { TranslationReportForm } from "~/components/translation-report-form";
import { TranslatedEntry } from "~/components/translated-entry";
import { entries } from "~/lib/db/schema";
import { createDraft } from "~/lib/drafts.server";
import { createReply, createTopic, editEntry } from "~/lib/entries.server";
import { embeddingInput } from "~/lib/embeddings.server";
import type { EntryDisplay } from "~/lib/entry-display.server";
import { createEmbeddingHandlers } from "~/lib/jobs/embedding-jobs.server";
import { runDueJobs, type JobHandlers } from "~/lib/jobs/queue.server";
import { createTranslationHandlers } from "~/lib/jobs/translation-jobs.server";
import { buildChangesMarkdown } from "~/lib/md/changes.server";
import { buildManifest } from "~/lib/md/manifest.server";
import { createFakeEmbeddingEngine } from "~/lib/llm/engines/fake-embedding.server";
import { createFakeEngine } from "~/lib/llm/engines/fake.server";
import { listNotifications } from "~/lib/notifications.server";
import { searchEntries } from "~/lib/search.server";
import { m } from "~/paraglide/messages.js";
import { getMd, parseBlocks, parseThreadBlocks } from "./helpers/md";
import { renderInRouter } from "./helpers/render-in-router";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";

// The ordinary tests replace the messages by empty strings; these ones read the real texts (what a reader sees).
vi.mock("~/paraglide/messages.js", async () => ({ m: (await import("./helpers/messages-json")).jsonMessages() }));

// what the pages, the lists, the search and the Markdown twins show for a topic without a title (the beginning of the body, in the reader's language).


const embeddingRequests: Array<{ task: string; title?: string; text: string }> = [];
const baseEmbedding = createFakeEmbeddingEngine();
const embeddingEngine = { ...baseEmbedding, embed: async (req: Parameters<typeof baseEmbedding.embed>[0]) => (embeddingRequests.push({ task: req.task, title: req.title, text: req.text }), baseEmbedding.embed(req)) };
const handlers = (): JobHandlers => ({
  ...createEmbeddingHandlers({ llm: { env: {}, embeddingEngine } }),
  ...createTranslationHandlers({ llm: { env: {}, engines: { primary: createFakeEngine(), secondary: null, judge: null } } }),
});

let h: RouteHarness;
let hana: string;
let john: string;
let titled: number;
let bare: number;
let bareEn: number;
let reply: number;
let imageOnly: number;

const FIRST_LINE = "朝のうちは涼しかったのに、昼には暑くなった。";
const settle = () => runDueJobs(h.db, handlers(), { now: new Date(), logger: quiet, limit: 1000 });

beforeAll(async () => {
  h = await setupRouteHarness();
  hana = await h.signIn("hana", { homeArea: "ja", readLangs: ["ja"] });
  john = await h.signIn("john", { homeArea: "en", readLangs: ["en"] });
  const a = await createTopic(h.db, hana, { lang: "ja", title: "題のある話題", body: "題のある話題の本文。" });
  const b = await createTopic(h.db, hana, { lang: "ja", body: `${FIRST_LINE}\n\n二段落目です。` });
  const c = await createTopic(h.db, john, { lang: "en", body: "A quiet morning and a loud afternoon." });
  const d = await createTopic(h.db, hana, { lang: "ja", body: "![](https://example.com/a.png)" });
  if (!a.ok || !b.ok || !c.ok || !d.ok) throw new Error("topic failed");
  [titled, bare, bareEn, imageOnly] = [a.id, b.id, c.id, d.id];
  const r = await createReply(h.db, john, bare, { lang: "en", body: "Same here." });
  if (!r.ok) throw new Error("reply failed");
  reply = r.id;
  await settle();
});
afterAll(() => h.restore());

const load = async (route: string, path: string, as: string, params: Record<string, string> = {}) => {
  const mod = (await import(`../app/routes/${route}`)) as { loader: (a: never) => Promise<unknown> };
  return (await mod.loader(h.args(h.request(path, { as }), params))) as never;
};

describe("the thread page of a topic without a title", () => {
  type Loaded = { topic: { title: string | null; headline: string | null; display: EntryDisplay } };
  const metaTitle = async (loaderData: unknown, search = "") => {
    const mod = (await import("~/routes/topic")) as unknown as { meta: (a: never) => Array<{ title?: string }> };
    return mod.meta({ loaderData, location: { search } } as never).find((x) => x.title !== undefined)?.title;
  };

  it("gives the heading and the browser title the beginning of the body (the translation for a reader who reads one)", async () => {
    const ja = (await load("topic", `/t/${bare}`, "hana", { id: String(bare) })) as Loaded;
    expect(ja.topic).toMatchObject({ title: null, headline: FIRST_LINE });
    expect(await metaTitle(ja)).toBe(FIRST_LINE);

    const en = (await load("topic", `/t/${bare}`, "john", { id: String(bare) })) as Loaded;
    expect(en.topic.display.shown).toBe("translation");
    expect(en.topic.display.translation?.headline).toBe(`[en] ${FIRST_LINE}`);
    expect(await metaTitle(en)).toBe(`[en] ${FIRST_LINE}`);
    // The original is shown when asked for: the line is the beginning of the original.
    const orig = (await load("topic", `/t/${bare}?orig=${bare}`, "john", { id: String(bare) })) as Loaded;
    expect(orig.topic.display.shown).toBe("original");
    expect(await metaTitle(orig)).toBe(FIRST_LINE);
  });

  it("keeps the title for a topic that has one, and the site name when the page is not loaded", async () => {
    const ja = (await load("topic", `/t/${titled}`, "hana", { id: String(titled) })) as Loaded;
    expect(ja.topic).toMatchObject({ title: "題のある話題", headline: null });
    expect(await metaTitle(ja)).toBe("題のある話題");
    const en = (await load("topic", `/t/${titled}`, "john", { id: String(titled) })) as Loaded;
    expect(await metaTitle(en)).toBe("[en] 題のある話題");
    expect(await metaTitle(undefined)).toBe(m.site_name());
  });

  it("has no line when the body has no text at all (the browser title is the site name; the heading says so, see TranslatedEntry below)", async () => {
    const data = (await load("topic", `/t/${imageOnly}`, "hana", { id: String(imageOnly) })) as Loaded;
    expect(data.topic).toMatchObject({ title: null, headline: "" });
    expect(await metaTitle(data)).toBe(m.site_name());
  });

  it("takes a body of zero width and direction control characters for no text too (the words of the site, not an empty or odd heading)", async () => {
    const invisible = await createTopic(h.db, hana, { lang: "ja", body: "\u200b\u202e\u200d\u2066" });
    if (!invisible.ok) throw new Error("topic failed");
    const data = (await load("topic", `/t/${invisible.id}`, "hana", { id: String(invisible.id) })) as Loaded;
    expect(data.topic).toMatchObject({ title: null, headline: "" });
    expect(await metaTitle(data)).toBe(m.site_name());
  });

  describe("TranslatedEntry", () => {
    const translation: NonNullable<EntryDisplay["translation"]> = {
      lang: "th", kind: "primary", engine: "fake", model: "m", fallback: false, stale: false, html: "<p>แปล</p>", title: null, headline: "บรรทัดแรกแปล", older: null, reportNotice: null,
    };
    const render = (props: { title: string | null; headline?: string; display: EntryDisplay; kind?: "topic" | "reply" }) =>
      renderToStaticMarkup(
        createElement(
          StaticRouter,
          { location: "/t/5" },
          createElement(TranslatedEntry, { id: 5, kind: props.kind ?? "topic", lang: "ja", title: props.title, headline: props.headline, html: "<p>原文</p>", display: props.display, meta: createElement("div", null, "meta") }),
        ),
      );

    it("keeps a screen-reader heading with the original first line in its language", () => {
      const html = render({ title: null, headline: "原文の一行目", display: { shown: "original", pending: false, translation } });
      expect(html).toMatch(/<h1 dir="auto" lang="ja" class="sr-only">原文の一行目<\/h1>/);
    });

    it("keeps a screen-reader heading with the translated first line in its language", () => {
      const html = render({ title: null, headline: "原文の一行目", display: { shown: "translation", pending: false, translation } });
      expect(html).toMatch(/<h1 dir="auto" lang="th" class="sr-only">บรรทัดแรกแปล<\/h1>/);
    });

    it("always has a heading element for a topic, with the words of the site when there is no text; a title keeps the large heading; a reply has none", () => {
      expect(render({ title: null, headline: "", display: { shown: "original", pending: false, translation: null } })).toContain(`>${m.headline_empty()}</h1>`);
      expect(render({ title: "原題", display: { shown: "original", pending: false, translation: null } })).toMatch(/<h1 dir="auto" lang="ja" class="text-2xl font-bold">原題<\/h1>/);
      expect(render({ kind: "reply", title: null, display: { shown: "original", pending: false, translation: null } })).not.toContain("<h1");
    });
  });
});

describe("the translation report form", () => {
  const render = (props: { kind: "topic" | "reply"; hasTitle?: boolean; reports?: { id: number; lang: string; field: string; excerpt: string; note: string }[] }) => renderInRouter(() => createElement(TranslationReportForm, { entryId: 5, lang: "en", ...props }), "/t/5");

  it("offers the body and the title as two buttons for a topic with a title, and the choice of part only once both are reported", async () => {
    for (const props of [{ kind: "topic" as const }, { kind: "topic" as const, hasTitle: true }]) {
      const first = await render(props);
      expect(first).toMatch(/<button(?=[^>]*name="field")(?=[^>]*value="body")/);
      expect(first).toMatch(/<button(?=[^>]*name="field")(?=[^>]*value="title")/);
      expect(first).not.toContain('role="combobox"');
      const bodyOnly = await render({ ...props, reports: [{ id: 7, lang: "en", field: "body", excerpt: "", note: "" }] });
      expect(bodyOnly).not.toContain('role="combobox"');
      const both = await render({ ...props, reports: [{ id: 7, lang: "en", field: "body", excerpt: "", note: "" }, { id: 8, lang: "en", field: "title", excerpt: "", note: "" }] });
      expect(both).toContain('role="combobox"');
      expect(both).toContain("Body");
    }
  });

  it("offers no title for a topic without one, and reports the body (no select, no title button)", async () => {
    const html = await render({ kind: "topic", hasTitle: false });
    expect(html).not.toContain("<select");
    expect(html).not.toContain('value="title"');
    expect(html).toMatch(/<button(?=[^>]*name="field")(?=[^>]*value="body")/);
  });

  it("reports the body for a reply, as before", async () => {
    const html = await render({ kind: "reply" });
    expect(html).not.toContain("<select");
    expect(html).not.toContain('value="title"');
    expect(html).toMatch(/<button(?=[^>]*name="field")(?=[^>]*value="body")/);
  });
});

describe("lists", () => {
  type Item = { id: number; title: { text: string; lang: string; kind: string | null; fromBody: boolean; pending: boolean } };
  const items = async (route: string, path: string, as: string, params: Record<string, string> = {}) => {
    const data = (await load(route, path, as, params)) as { items?: Item[]; topics?: Item[]; sections?: unknown };
    return data;
  };

  it("names a topic without a title by the beginning of its body in the reader's language, on /latest", async () => {
    const data = (await items("latest", "/latest", "john")) as { topics: Item[] };
    const byId = new Map(data.topics.map((t) => [t.id, t.title]));
    expect(byId.get(bare)).toMatchObject({ text: `[en] ${FIRST_LINE}`, lang: "en", kind: "primary", fromBody: true, pending: false });
    expect(byId.get(bareEn)).toMatchObject({ text: "A quiet morning and a loud afternoon.", lang: "en", kind: null, fromBody: true });
    expect(byId.get(titled)).toMatchObject({ text: "[en] 題のある話題", fromBody: false });
    const ja = (await items("latest", "/latest", "hana")) as { topics: Item[] };
    expect(new Map(ja.topics.map((t) => [t.id, t.title])).get(bare)).toMatchObject({ text: FIRST_LINE, lang: "ja", kind: null, fromBody: true });
  });

  it("links the line in the list component, and says so when there is no text", () => {
    const item = (id: number, text: string, fromBody: boolean) => ({
      id, createdAt: "2026-10-03T00:00:00Z", lastActivityAt: "2026-10-03T00:00:00Z", latestReply: null, lang: "ja" as const, authorHandle: "hana", replyCount: 0, hidden: false, asksStance: false, insightful: { total: 0, langs: 0 },
      title: { text, lang: "ja" as const, kind: null, engine: null, fallback: false, stale: false, pending: false, fromBody },
    });
    const html = renderToStaticMarkup(createElement(StaticRouter, { location: "/latest" }, createElement(TopicList, { topics: [item(1, FIRST_LINE, true), item(2, "", true), item(3, "題", false)], langParam: null, empty: "none" })));
    expect(html).toMatch(new RegExp(`href="/t/1"[^>]*>${FIRST_LINE}</a>`));
    expect(html).toMatch(new RegExp(`href="/t/2"[^>]*>${m.headline_empty().replace(/[()]/g, "\\$&")}</a>`));
    expect(html).toMatch(/href="\/t\/3"[^>]*>題<\/a>/);
  });
});

describe("search", () => {
  const search = (q: string, readLangs: Array<"en" | "ja">, displayLang: "en" | "ja") => searchEntries(h.db, q, { readLangs, displayLang, llm: { env: {}, embeddingEngine } });

  it("finds a topic without a title by its body, and names it by the beginning of the body (a reply names the topic of its thread the same way)", async () => {
    const hits = await search("A quiet morning and a loud afternoon", ["en"], "en");
    const own = hits.find((x) => x.id === bareEn)!;
    expect(own.title).toEqual({ text: "A quiet morning and a loud afternoon.", lang: "en", translation: null, pending: false, fromBody: true });
    const viaReply = (await search("Same here", ["en"], "en")).find((x) => x.id === reply)!;
    expect(viaReply.title).toMatchObject({ text: `[en] ${FIRST_LINE}`, lang: "en", fromBody: true, translation: { kind: "primary" } });
    // A reader of the original language gets the original line, and the translation is not asked for.
    const ja = (await search("朝のうちは涼しかったのに、昼には暑くなった", ["ja"], "ja")).find((x) => x.id === bare);
    expect(ja?.title).toMatchObject({ text: FIRST_LINE, lang: "ja", fromBody: true, pending: false });
  });

  it("marks the line pending when the translation of the body is not there yet", async () => {
    // A topic and a reply that are embedded but not translated yet.
    const fresh = await createTopic(h.db, hana, { lang: "ja", body: "まだ訳のない一行目。" });
    if (!fresh.ok) throw new Error("topic failed");
    const r = await createReply(h.db, john, fresh.id, { lang: "en", body: "Waiting for the translation." });
    if (!r.ok) throw new Error("reply failed");
    await runDueJobs(h.db, createEmbeddingHandlers({ llm: { env: {}, embeddingEngine } }), { now: new Date(), logger: quiet, limit: 1000 });
    const hit = (await search("Waiting for the translation", ["en"], "en")).find((x) => x.id === r.id)!;
    expect(hit.title).toEqual({ text: "まだ訳のない一行目。", lang: "ja", translation: null, pending: true, fromBody: true });
    await settle();
    const done = (await search("Waiting for the translation", ["en"], "en")).find((x) => x.id === r.id)!;
    expect(done.title).toMatchObject({ text: "[en] まだ訳のない一行目。", lang: "en", pending: false, fromBody: true });
  });

  it("never gives the embedding model an empty or missing title", () => {
    expect(embeddingInput({ title: null, body: "本文" })).toEqual({ text: "本文" });
    expect(embeddingInput({ title: "", body: "本文" })).toEqual({ text: "本文" });
    expect(embeddingInput({ title: "題", body: "本文" })).toEqual({ text: "本文", title: "題" });
    // What the jobs sent for the topics of this file: no title key for the topics without a title.
    const documents = embeddingRequests.filter((r) => r.task === "document");
    expect(documents.find((r) => r.text.startsWith(FIRST_LINE))?.title).toBeUndefined();
    expect(documents.find((r) => r.text.startsWith("題のある話題の本文"))?.title).toBe("題のある話題");
    expect(documents.every((r) => r.title === undefined || r.title.trim() !== "")).toBe(true);
  });
});

describe("notifications screen", () => {
  it("names the topic of a reply by the beginning of its body, in the reader's language", async () => {
    const created = await createReply(h.db, john, bare, { lang: "en", body: "Another reply." });
    if (!created.ok) throw new Error("reply failed");
    await settle();
    const [item] = (await listNotifications(h.db, hana, { display: { readLangs: ["ja"], displayLang: "ja" } })).items;
    expect(item).toMatchObject({ unavailable: false, topicTitle: FIRST_LINE, actorHandle: "john" });
    // A reader of English sees the translated line; without display options the original is kept.
    expect((await listNotifications(h.db, hana, { display: { readLangs: ["en"], displayLang: "en" } })).items[0].topicTitle).toBe(`[en] ${FIRST_LINE}`);
    expect((await listNotifications(h.db, hana)).items[0].topicTitle).toBe(FIRST_LINE);
    // The sentence of the screen takes that line as {title}, and says so for a body without text.
    const mod = (await import("~/routes/notifications")) as unknown as { loader: (a: never) => Promise<{ items: Array<{ topicTitle: string | null }> }> };
    const page = await mod.loader(h.args(h.request("/notifications", { as: "hana" })));
    expect(page.items[0].topicTitle).toBe(FIRST_LINE);
    expect(m.notification_reply_to_topic({ handle: "john", title: page.items[0].topicTitle! })).toContain(FIRST_LINE);
  });

  it("gives no line, and leaks no body text, for a topic without a title that was hidden or deleted after the reply (and for a hidden reply)", async () => {
    const SECRET = "SECRET-BODY-OF-A-SHORT-REMARK";
    const topic = await createTopic(h.db, hana, { lang: "ja", body: `${SECRET} 一行目。\n\n二行目。` });
    if (!topic.ok) throw new Error("topic failed");
    const replyTo = await createReply(h.db, john, topic.id, { lang: "en", body: "A reply to the remark." });
    if (!replyTo.ok) throw new Error("reply failed");
    await settle();
    const display = { readLangs: ["ja"] as Array<"ja">, displayLang: "ja" as const };
    const listed = async () => (await listNotifications(h.db, hana, { display })).items;
    // Shown first: the line is the beginning of the body.
    const shown = (await listed()).find((i) => i.entryId === replyTo.id);
    expect(shown).toMatchObject({ unavailable: false, topicTitle: expect.stringContaining(SECRET) });
    const notificationId = shown!.id;

    // The list of the service and the loader of the screen both say the post is gone: no line, no reply, no replier, and nothing of the body anywhere in the data.
    const noLeak = async (label: string) => {
      const mod = (await import("~/routes/notifications")) as unknown as { loader: (a: never) => Promise<{ items: Array<{ id: number }> }> };
      const page = await mod.loader(h.args(h.request("/notifications", { as: "hana" })));
      for (const data of [await listed(), page.items]) {
        expect(data.find((i) => i.id === notificationId), label).toMatchObject({ unavailable: true, topicTitle: null, threadId: null, entryId: null, actorHandle: null });
      }
      expect(JSON.stringify(await listed()), label).not.toContain(SECRET);
      expect(JSON.stringify(page), label).not.toContain(SECRET);
    };
    const set = (id: number, values: { hiddenAt?: Date | null; deletedAt?: Date | null }) => h.db.update(entries).set(values).where(eq(entries.id, id));

    await set(topic.id, { hiddenAt: new Date() });
    await noLeak("topic hidden");
    await set(topic.id, { hiddenAt: null });
    await set(replyTo.id, { hiddenAt: new Date() });
    await noLeak("reply hidden");
    await set(replyTo.id, { hiddenAt: null });
    await set(topic.id, { deletedAt: new Date() });
    await noLeak("topic deleted");
  });
});

describe("the drafts of a member", () => {
  it("lists a topic draft without a title by the beginning of its body, and names a reply draft's thread by its title or the beginning of its body", async () => {
    const own = await createDraft(h.db, hana, { kind: "topic", lang: "ja", title: "", body: "# 見出しの下書き\n\n続き" });
    const toBare = await createDraft(h.db, hana, { kind: "reply", lang: "ja", threadId: bare, body: "返信の下書き" });
    const toTitled = await createDraft(h.db, hana, { kind: "reply", lang: "ja", threadId: titled, body: "返信の下書き2" });
    const empty = await createDraft(h.db, hana, { kind: "topic", lang: "ja", body: "" });
    if (!own.ok || !toBare.ok || !toTitled.ok || !empty.ok) throw new Error("draft failed");
    const mod = (await import("~/routes/drafts")) as unknown as { loader: (a: never) => Promise<{ drafts: Array<{ id: number; title: string | null; headline: string; threadTitle: string | null }> }> };
    const { drafts } = await mod.loader(h.args(h.request("/drafts", { as: "hana" })));
    const byId = new Map(drafts.map((d) => [d.id, d]));
    expect(byId.get(own.id)).toMatchObject({ title: null, headline: "見出しの下書き" });
    expect(byId.get(toBare.id)?.threadTitle).toBe(FIRST_LINE);
    expect(byId.get(toTitled.id)?.threadTitle).toBe("題のある話題");
    // The "(untitled)" mark is only for a draft with no text either.
    expect(byId.get(empty.id)).toMatchObject({ title: null, headline: "" });
    const one = (await import("~/routes/draft")) as unknown as { loader: (a: never) => Promise<{ draft: { threadTitle: string | null } }> };
    expect((await one.loader(h.args(h.request(`/drafts/${toBare.id}`, { as: "hana" }), { id: String(toBare.id) }))).draft.threadTitle).toBe(FIRST_LINE);
  });
});

describe("Markdown twins", () => {
  const blocksOf = async (path: string, as = "hana") => parseThreadBlocks(await (await getMd(h, path, { as })).text(), /^\/t\/\d+\.md/.test(path) ? "required" : "any");
  // The items of a list (a YAML array in the body of the blocks that hold one).
  const itemsOf = (blocks: ReturnType<typeof parseBlocks>) => blocks.flatMap((b) => (Array.isArray(parseYaml(b.body)) ? (parseYaml(b.body) as Array<Record<string, unknown>>) : []));
  const listItems = async (path: string) => itemsOf(await blocksOf(path));

  it("leaves the title key out of the thread of a topic without a title (not empty, not null), and puts it in for a topic that has one", async () => {
    const first = (await blocksOf(`/t/${bare}.md`))[0];
    expect(first.fm.id).toBe(`p-${bare}`);
    expect("title" in first.fm).toBe(false);
    expect(first.body).toContain(FIRST_LINE);
    const text = await (await getMd(h, `/t/${bare}.md`, { as: "hana" })).text();
    expect(text).not.toMatch(/^title:/m);
    expect((await blocksOf(`/t/${titled}.md`))[0].fm.title).toBe("題のある話題");
    // The translation block: the title of the translation only for a topic that has a title.
    const tr = (await blocksOf(`/t/${bare}.md?lang=en`)).find((b) => b.fm.type === "translation" && b.fm.translation_of === `p-${bare}`)!;
    expect(tr.fm.lang).toBe("en");
    expect("title" in tr.fm).toBe(false);
    expect(tr.body).toContain(FIRST_LINE);
    const trTitled = (await blocksOf(`/t/${titled}.md?lang=en`)).find((b) => b.fm.type === "translation")!;
    expect(trTitled.fm.title).toBe("[en] 題のある話題");
  });

  it("shows an excerpt instead of a title in the lists (and excerpt_translation with ?lang=)", async () => {
    const list = await listItems("/latest.md");
    const bareItem = list.find((x) => x.id === `p-${bare}`)!;
    expect("title" in bareItem).toBe(false);
    expect(bareItem.excerpt).toBe(FIRST_LINE);
    expect("excerpt_translation" in bareItem).toBe(false);
    const titledItem = list.find((x) => x.id === `p-${titled}`)!;
    expect(titledItem.title).toBe("題のある話題");
    expect("excerpt" in titledItem).toBe(false);
    const withLang = await listItems("/latest.md?lang=en");
    const bareWithLang = withLang.find((x) => x.id === `p-${bare}`)!;
    expect(bareWithLang.excerpt).toBe(FIRST_LINE);
    expect(bareWithLang.excerpt_translation).toMatchObject({ lang: "en", status: "machine", text: `[en] ${FIRST_LINE}` });
    expect("title_translation" in bareWithLang).toBe(false);
    const titledWithLang = withLang.find((x) => x.id === `p-${titled}`)!;
    expect(titledWithLang.title_translation).toMatchObject({ text: "[en] 題のある話題" });
    expect("excerpt_translation" in titledWithLang).toBe(false);
  });

  it("leaves the title out of the change feed for a topic without a title, and reports adding and removing a title as edited", async () => {
    const feed = async (since: Date) => itemsOf(parseBlocks(await buildChangesMarkdown(h.db, { since, k: null })));
    const created = (await feed(new Date("2000-01-01T00:00:00Z"))).find((x) => x.id === `p-${bare}`)!;
    expect(created.change).toBe("created");
    expect("title" in created).toBe(false);
    expect((await feed(new Date("2000-01-01T00:00:00Z"))).find((x) => x.id === `p-${titled}`)?.title).toBe("題のある話題");
    // Adding a title is an edit, and the title shows; removing it again is an edit without the key.
    const [row] = await h.db.select({ createdAt: entries.createdAt }).from(entries).where(eq(entries.id, bare));
    const since = new Date(row.createdAt.getTime() + 10_000);
    const body = `${FIRST_LINE}\n\n二段落目です。`;
    await editEntry(h.db, hana, bare, { title: "後から付けた題", body }, { now: new Date(row.createdAt.getTime() + 60_000) });
    expect((await feed(since)).find((x) => x.id === `p-${bare}`)).toMatchObject({ change: "edited", title: "後から付けた題" });
    await editEntry(h.db, hana, bare, { title: "", body }, { now: new Date(row.createdAt.getTime() + 120_000) });
    const removed = (await feed(since)).find((x) => x.id === `p-${bare}`)!;
    expect(removed.change).toBe("edited");
    expect("title" in removed).toBe(false);
  });

  it("leaves the title out of the search twin for a topic without a title (title for a topic, thread_title for a reply), and keeps the excerpt", async () => {
    const search = (q: string) => listItems(`/search.md?q=${encodeURIComponent(q)}`);
    const replyItem = (await search("Same here")).find((x) => x.id === `c-${reply}`)!;
    expect("thread_title" in replyItem).toBe(false);
    expect("title" in replyItem).toBe(false);
    expect(replyItem.excerpt).toBe("Same here.");
    const own = (await search("A quiet morning and a loud afternoon")).find((x) => x.id === `p-${bareEn}`)!;
    expect("title" in own).toBe(false);
    expect(own.excerpt).toBe("A quiet morning and a loud afternoon.");
    // A topic that has a title keeps it, and so does the reply in its thread.
    const titledItem = (await search("題のある話題の本文")).find((x) => x.id === `p-${titled}`)!;
    expect(titledItem.title).toBe("題のある話題");
  });

  it("gives no title and no title_translation in the search twin with ?lang= for a topic without a title, and the translation of the excerpt instead", async () => {
    const search = async (q: string, lang: string) => {
      const blocks = await blocksOf(`/search.md?q=${encodeURIComponent(q)}&lang=${lang}`, "john");
      return itemsOf(blocks);
    };
    const items = await search(FIRST_LINE, "en");
    const own = items.find((x) => x.id === `p-${bare}`)!;
    expect(own, JSON.stringify(items.map((x) => x.id))).toBeDefined();
    expect("title" in own).toBe(false);
    expect("title_translation" in own).toBe(false);
    expect(own.excerpt).toContain(FIRST_LINE);
    expect(own.excerpt_translation).toMatchObject({ lang: "en", text: expect.stringContaining("[en]") });
    // A reply in that thread: no thread_title either, with or without a translation (the reply is English, so asking for Japanese translates its excerpt).
    for (const lang of ["en", "ja"]) {
      const replyItem = (await search("Same here", lang)).find((x) => x.id === `c-${reply}`)!;
      expect(replyItem, lang).toBeDefined();
      expect("thread_title" in replyItem, lang).toBe(false);
      expect("title" in replyItem, lang).toBe(false);
      expect("title_translation" in replyItem, lang).toBe(false);
    }
    // A topic with a title keeps title and title_translation under the same request.
    const withTitle = (await search("題のある話題の本文", "en")).find((x) => x.id === `p-${titled}`)!;
    expect(withTitle.title).toBe("題のある話題");
    expect(withTitle.title_translation).toMatchObject({ lang: "en", text: "[en] 題のある話題" });
  });

  it("hashes a topic without a title in the manifest by its source version, like any topic", async () => {
    const manifest = await buildManifest(h.db, { after: 0, k: null });
    const row = manifest.topics.find((t) => t.md.includes(`/t/${bare}.md`));
    expect(row?.content_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.updated_at).toBeTruthy();
  });
});
