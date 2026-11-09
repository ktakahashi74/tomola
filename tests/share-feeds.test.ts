import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { and, eq, inArray, sql } from "drizzle-orm";
import { createTopic } from "~/lib/entries.server";
import { entries, profiles, translations, villages } from "~/lib/db/schema";
import { createTranslationHandlers } from "~/lib/jobs/translation-jobs.server";
import { runDueJobs } from "~/lib/jobs/queue.server";
import { createFakeEngine } from "~/lib/llm/engines/fake.server";
import { rewriteMedia } from "~/lib/media-processing.server";
import { putMedia } from "~/lib/media-store.server";
import { llmsTxt } from "~/lib/api/guides.server";
import { setTestLocale } from "./stubs/paraglide-runtime";
import { BASE, setupRouteHarness, type RouteHarness } from "./helpers/route-harness";

vi.mock("~/paraglide/messages.js", async () => ({ m: (await import("./helpers/messages-json")).jsonMessages() }));

// Shared previews (Open Graph) and RSS feeds: what they carry, and that nothing a reader who has not logged in may not read gets into any of them.
let h: RouteHarness;
const ids: Record<string, number> = {};
const root = { id: "root", loaderData: { publicReading: true, siteOrigin: BASE } };
type Tag = Record<string, string>;

const feed = async (path: string, params: Record<string, string> = {}, opts: { as?: string } = {}) => {
  const { loader } = await import("~/routes/feed");
  const response = await loader(h.args(h.request(path, opts), params)) as Response;
  return { response, text: await response.text() };
};
const itemTitles = (xml: string) => [...xml.matchAll(/<item><title>([^<]*)<\/title>/g)].map(match => match[1]);
const tagOf = (tags: Tag[], key: string) => tags.find(tag => tag.property === key || tag.name === key)?.content;

async function topicMeta(path: string, id: number, opts: { as?: string; headers?: Record<string, string> } = {}) {
  const { loader, meta } = await import("~/routes/topic");
  const request = h.request(path, opts);
  const loaderData = await loader(h.args(request, { id: String(id) })) as never;
  const url = new URL(request.url);
  return (meta as unknown as (args: unknown) => Tag[])({ loaderData, location: { pathname: url.pathname, search: url.search }, matches: [root] });
}

async function mediaId(memberId: string, color: number): Promise<string> {
  const png = await sharp({ create: { width: 64, height: 32, channels: 3, background: { r: color, g: 80, b: 120 } } }).png().toBuffer();
  const saved = await putMedia(h.db, memberId, await rewriteMedia(png));
  return saved.url;
}

beforeAll(async () => {
  vi.stubEnv("BETTER_AUTH_URL", BASE);
  vi.stubEnv("PUBLIC_READING", "1");
  // Villages are off while the fixtures are written (a topic then needs no village); the tests turn them on.
  vi.stubEnv("VILLAGES", "");
  h = await setupRouteHarness();
  await h.signIn("feed_author", { homeArea: "en", readLangs: ["en"] });
  await h.signIn("feed_ja", { homeArea: "ja", readLangs: ["ja"] });
  await h.signIn("feed_quiet", { homeArea: "en", readLangs: ["en"] });
  await h.signIn("feed_bulk", { homeArea: "en", readLangs: ["en"] });
  await h.db.update(profiles).set({ displayName: "日本語の書き手", displayNameLatin: "Japanese Writer" }).where(eq(profiles.userId, h.ids.feed_ja));
  const post = async (name: string, author: string, input: { title?: string; body: string; lang: "en" | "ja" }) => {
    const result = await createTopic(h.db, h.ids[author], input);
    if (!result.ok) throw new Error(`${name}: ${result.error}`);
    ids[name] = result.id;
  };
  const figure = await mediaId(h.ids.feed_author, 20);
  const stolen = await mediaId(h.ids.feed_ja, 90);
  await post("essay", "feed_author", { title: "Alpha & <Omega> essay", lang: "en", body: `# Heading\n\nThis is **bold**, a [link](https://example.com/secret-path) and \`code\`.\n\n![A bar chart of \\[things\\]](${figure})\n\n${"More words follow here. ".repeat(30)}` });
  await post("japanese", "feed_ja", { title: "日本語の題", lang: "ja", body: "これは**太字**を含む日本語の本文です。".repeat(30) });
  await post("remark", "feed_author", { lang: "en", body: "A short remark with `inline code`" });
  await post("copied", "feed_author", { title: "Copied image", lang: "en", body: `Text\n\n![theirs](${stolen})` });
  await post("hidden", "feed_author", { title: "Hidden title", lang: "en", body: "Hidden body" });
  await post("deleted", "feed_author", { title: "Deleted title", lang: "en", body: "Deleted body" });
  await h.db.update(entries).set({ hiddenAt: new Date() }).where(eq(entries.id, ids.hidden));
  await h.db.update(entries).set({ deletedAt: new Date() }).where(eq(entries.id, ids.deleted));
  for (const [name, kind, endedAt] of [["open", "open", null], ["pub", "invite_public", null], ["closed", "closed", null], ["ended", "open", new Date()]] as const) {
    const [village] = await h.db.insert(villages).values({ slug: `feed-${name}`, kind, name: `Village ${name}`, description: `The ${name} village talks about **gardens** and more.`, endedAt }).returning();
    await post(`in-${name}`, "feed_author", { title: `Topic in ${name}`, lang: "en", body: `Body in ${name} village` });
    await h.db.update(entries).set({ villageId: village.id }).where(eq(entries.id, ids[`in-${name}`]));
  }
  await runDueJobs(h.db, createTranslationHandlers({ llm: { engines: { primary: createFakeEngine(), secondary: null, judge: null }, env: {} } }), { now: new Date("2031-01-01"), limit: 1000, logger: { error: () => {}, warn: () => {} } });
  for (const name of ["body-only", "title-only", "untranslated", "failed"]) {
    await post(name, "feed_ja", { title: `原文の題 ${name}`, body: `原文の本文 ${name}`, lang: "ja" });
    const [source] = await h.db.select().from(entries).where(eq(entries.id, ids[name]));
    for (const field of name === "body-only" ? ["body"] as const : name === "title-only" ? ["title"] as const : name === "failed" ? ["title", "body"] as const : []) {
      await h.db.insert(translations).values({ entryId: source.id, field, lang: "en", kind: "primary", engine: "fake", sourceHash: source.sourceHash, mentionRevision: source.mentionRevision, text: `Translated ${field}`, flags: name === "failed" ? ["untranslated"] : [] });
    }
  }
  // Keep the feed's newest-page fixtures unchanged.
  await h.db.update(entries).set({ createdAt: new Date("2020-01-01") }).where(inArray(entries.id, [ids["body-only"], ids["title-only"], ids.untranslated, ids.failed]));
  await h.db.update(translations).set({ text: `図の説明\n\n![図の代替文](${figure})` }).where(and(eq(translations.entryId, ids.essay), eq(translations.lang, "ja"), eq(translations.field, "body")));
  for (let i = 1; i <= 35; i++) await post(`bulk-${i}`, "feed_bulk", { title: `Bulk ${i}`, lang: "en", body: `Bulk body ${i}` });
  // The bulk topics are older than the fixtures above, so the newest 30 of the site hold every fixture.
  await h.db.update(entries).set({ createdAt: sql`${entries.createdAt} - interval '1 day'` }).where(inArray(entries.id, Array.from({ length: 35 }, (_, i) => ids[`bulk-${i + 1}`])));
}, 120000);
beforeEach(() => { vi.stubEnv("PUBLIC_READING", "1"); vi.stubEnv("VILLAGES", "1"); setTestLocale("en"); });
afterAll(() => { h.restore(); vi.unstubAllEnvs(); setTestLocale("en"); });

describe("the feeds", () => {
  it("lists the public topics newest first, as RSS with escaped text and permanent links", async () => {
    const { response, text } = await feed("/feed.xml");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/rss+xml; charset=utf-8");
    expect(response.headers.get("x-robots-tag")).toBe("noindex");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(text).toMatch(/^<\?xml version="1\.0" encoding="UTF-8"\?>/);
    // The newest topic is first, the feed is cut at 30 items (the 7 readable fixtures, then the newest of the bulk topics).
    const titles = itemTitles(text);
    expect(titles[0]).toBe("Topic in ended");
    expect(titles).toHaveLength(30);
    expect(titles.filter(title => title.startsWith("Bulk"))).toEqual(Array.from({ length: 23 }, (_, i) => `Bulk ${35 - i}`));
    expect(text).toContain(`<guid isPermaLink="true">${BASE}/t/${ids["bulk-35"]}</guid>`);
    expect(text).toContain(`<atom:link href="${BASE}/feed.xml" rel="self"`);
    expect(text).not.toContain("<language>");
  });

  it("carries the title, the beginning of the body as plain text, the author and the village, and never the whole body", async () => {
    const { text: member } = await feed("/feed.xml");
    expect(member).not.toContain("secret-path");
    expect(itemTitles(member)).toContain("Alpha &amp; &lt;Omega&gt; essay");
    const essay = member.split("<item>").find(item => item.includes("Alpha"))!;
    expect(essay).toContain("This is bold, a link and code.");
    expect(essay).not.toContain("**");
    expect(essay).not.toContain("secret-path");
    expect(essay).toContain("<dc:creator>@feed_author</dc:creator>");
    // A short remark has no title: the line it begins with names it.
    expect(itemTitles(member)).toContain("A short remark with inline code");
    // The category is the name of a village that people made.
    expect(member).toContain("<category>Village open</category>");
  });

  it("leaves out hidden, deleted and closed-village topics, and ended villages have no feed", async () => {
    for (const [path, params] of [["/feed.xml", {}], ["/v/feed-open/feed.xml", { slug: "feed-open" }], ["/v/feed-pub/feed.xml", { slug: "feed-pub" }]] as const) {
      const { text } = await feed(path, params);
      for (const secret of ["Hidden title", "Deleted title", "Hidden body", "Deleted body", "Topic in closed", "Body in closed"]) expect(text, `${path} ${secret}`).not.toContain(secret);
    }
    const open = (await feed("/v/feed-open/feed.xml", { slug: "feed-open" })).text;
    expect(itemTitles(open)).toEqual(["Topic in open"]);
    expect(open).toContain("<title>Village open</title>");
    expect(open).toContain("The open village talks about **gardens** and more.");
    expect((await feed("/v/feed-pub/feed.xml", { slug: "feed-pub" })).response.status).toBe(200);
    for (const slug of ["feed-closed", "feed-ended", "nobody"]) expect((await feed(`/v/${slug}/feed.xml`, { slug })).response.status, slug).toBe(404);
  });

  it("is a 404 for the whole site and a village while the site is closed to readers who have not logged in, and without villages", async () => {
    vi.stubEnv("PUBLIC_READING", "");
    for (const [path, params] of [["/feed.xml", {}], ["/v/feed-open/feed.xml", { slug: "feed-open" }]] as const) {
      const { response, text } = await feed(path, params);
      expect(response.status, path).toBe(404);
      expect(text).not.toContain("<item>");
    }
    vi.stubEnv("PUBLIC_READING", "1");
    vi.stubEnv("VILLAGES", "");
    expect((await feed("/v/feed-open/feed.xml", { slug: "feed-open" })).response.status).toBe(404);
    expect((await feed("/feed.xml")).response.status).toBe(200);
  });

  it("gives the title and description in the asked language, the original where there is no translation yet, and links that keep the language", async () => {
    const { text } = await feed("/feed.xml?lang=en");
    expect(text).toContain("<language>en</language>");
    expect(text).toContain("<title>[en] 日本語の題</title>");
    expect(text).toContain(`<guid isPermaLink="true">${BASE}/t/${ids.japanese}?lang=en</guid>`);
    expect(text).toContain(`<atom:link href="${BASE}/feed.xml?lang=en"`);
    const original = (await feed("/feed.xml")).text;
    expect(original).toContain("<title>日本語の題</title>");
    expect(original).toContain("これは太字を含む日本語の本文です。");
    // A topic already in the asked language is as it is; a language with no translation row falls back to the original.
    const essayInFrench = (await feed("/feed.xml?lang=fr")).text;
    expect(essayInFrench).toContain("<title>[fr] Alpha &amp; &lt;Omega&gt; essay</title>");
    // Without ?lang= the words the site writes into the feed do not follow the language of the request.
    setTestLocale("ja");
    const fixed = (await feed("/feed.xml")).text;
    setTestLocale("en");
    expect(fixed).toContain("<description>tomola is a place to read essays");
    expect(fixed).toBe((await feed("/feed.xml")).text);
    const bad = await feed("/feed.xml?lang=zz");
    expect(bad.response.status).toBe(400);
    expect((await feed("/feed.xml?lang=all")).response.status).toBe(400);
  });

  it("answers GET and HEAD only, and a signed-in member sees the same public feed", async () => {
    const { loader } = await import("~/routes/feed");
    const post = await loader(h.args(new Request(`${BASE}/feed.xml`, { method: "POST" }), {})) as Response;
    expect(post.status).toBe(405);
    const head = await loader(h.args(new Request(`${BASE}/feed.xml`, { method: "HEAD" }), {})) as Response;
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    const signed = await feed("/feed.xml", {}, { as: "feed_quiet" });
    expect(signed.response.status).toBe(200);
    expect(itemTitles(signed.text)).toEqual(itemTitles((await feed("/feed.xml")).text));
    // There is no feed of one member's topics (a member's page is for members).
    expect(llmsTxt()).not.toContain("/u/<handle>/feed.xml");
  });

  it("is listed in the guide for AI tools once, one line each", () => {
    const guide = llmsTxt();
    expect(guide).toContain(`${BASE}/feed.xml`);
    expect(guide).toContain(`${BASE}/v/<slug>/feed.xml`);
    vi.stubEnv("PUBLIC_READING", "");
    expect(llmsTxt()).not.toContain("feed.xml");
  });
});

describe("the preview of a topic", () => {
  it("names the title, a plain-text description and the time, and shows the first image of the topic, with its size, its text and an absolute address", async () => {
    const tags = await topicMeta(`/t/${ids.essay}`, ids.essay);
    expect(tagOf(tags, "og:title")).toBe("Alpha & <Omega> essay");
    expect(tagOf(tags, "og:type")).toBe("article");
    expect(tagOf(tags, "og:site_name")).toBe("tomola");
    expect(tagOf(tags, "og:url")).toBe(`${BASE}/t/${ids.essay}`);
    expect(tagOf(tags, "og:locale")).toBe("en_US");
    const description = tagOf(tags, "og:description")!;
    expect(description).toMatch(/^Heading This is bold, a link and code\./);
    expect(description).not.toMatch(/[*#`]|secret-path/);
    expect([...new Intl.Segmenter().segment(description)].length).toBeLessThanOrEqual(161);
    expect(tagOf(tags, "description")).toBe(description);
    expect(tagOf(tags, "article:published_time")).toMatch(/^\d{4}-\d\d-\d\dT/);
    const image = tagOf(tags, "og:image")!;
    expect(image).toMatch(new RegExp(`^${BASE}/media/[a-f0-9]{64}-64x32\\.webp$`));
    expect(tagOf(tags, "og:image:width")).toBe("64");
    expect(tagOf(tags, "og:image:height")).toBe("32");
    expect(tagOf(tags, "twitter:image:alt")).toBe("A bar chart of [things]");
    expect(tagOf(tags, "twitter:card")).toBe("summary_large_image");
  });

  it("uses the site image for a topic with no image, and names a titleless topic by the beginning of its body", async () => {
    const tags = await topicMeta(`/t/${ids.remark}`, ids.remark);
    expect(tagOf(tags, "og:title")).toBe("A short remark with inline code");
    expect(tagOf(tags, "og:image")).toBe(`${BASE}/icons/share-default.png`);
    expect(tagOf(tags, "og:image:width")).toBe("512");
    expect(tagOf(tags, "og:image:height")).toBe("512");
    expect(tagOf(tags, "og:image:alt")).toBe("tomola");
    expect(tagOf(tags, "twitter:card")).toBe("summary");
  });

  it("does not preview an image that another member's topic only points at", async () => {
    const tags = await topicMeta(`/t/${ids.copied}`, ids.copied);
    expect(tagOf(tags, "og:title")).toBe("Copied image");
    expect(tagOf(tags, "og:image")).toBe(`${BASE}/icons/share-default.png`);
    expect(tagOf(tags, "twitter:card")).toBe("summary");
  });

  it("keeps an explicit language in the address", async () => {
    const tags = await topicMeta(`/t/${ids.japanese}?lang=en`, ids.japanese);
    expect(tagOf(tags, "og:title")).toBe("[en] 日本語の題");
    expect(tagOf(tags, "og:description")).toMatch(/^\[en\] /);
    expect(tagOf(tags, "og:url")).toBe(`${BASE}/t/${ids.japanese}?lang=en`);
    expect(tagOf(tags, "og:locale")).toBe("en_US");
    const original = await topicMeta(`/t/${ids.japanese}?lang=ja`, ids.japanese);
    expect(tagOf(original, "og:title")).toBe("日本語の題");
    expect(tagOf(original, "og:locale")).toBe("ja_JP");
    const description = tagOf(original, "og:description")!;
    expect(description.endsWith("…")).toBe(true);
    expect([...new Intl.Segmenter().segment(description)].length).toBeLessThanOrEqual(121);
    expect(description).not.toContain("*");
  });

  it("uses source language for a bare address despite an English screen or request, and honors the preview hint independently", async () => {
    const path = `/t/${ids.japanese}`;
    const original = await topicMeta(path, ids.japanese, { headers: { "Accept-Language": "en", Cookie: "PARAGLIDE_LOCALE=en" } });
    expect(tagOf(original, "og:title")).toBe("日本語の題");
    expect(tagOf(original, "og:description")).toMatch(/^これは太字/);
    expect(tagOf(original, "og:locale")).toBe("ja_JP");
    expect(tagOf(original, "article:author")).toBe("日本語の書き手");
    const marked = await topicMeta(`${path}?sl=en`, ids.japanese);
    expect(tagOf(marked, "og:title")).toBe("[en] 日本語の題");
    expect(tagOf(marked, "og:description")).toMatch(/^\[en\]/);
    expect(tagOf(marked, "og:locale")).toBe("en_US");
    expect(tagOf(marked, "article:author")).toBe("Japanese Writer");
    expect(tagOf(marked, "og:url")).toBe(`${BASE}${path}?sl=en`);
    expect(marked.find(tag => "title" in tag)?.title).toBe(original.find(tag => "title" in tag)?.title);
    const explicit = await topicMeta(`${path}?lang=ja&sl=en`, ids.japanese);
    expect(tagOf(explicit, "og:locale")).toBe("ja_JP");
    expect(tagOf(explicit, "og:url")).toBe(`${BASE}${path}?lang=ja`);
    vi.stubEnv("ENABLED_LANGS", "ja,en");
    for (const sl of ["fr", "xx", "en%20"]) expect(tagOf(await topicMeta(`${path}?sl=${sl}`, ids.japanese), "og:locale")).toBe("ja_JP");
    vi.stubEnv("ENABLED_LANGS", "");
  });

  it("falls back as a complete source-language card when either translation field is absent or unusable", async () => {
    for (const name of ["body-only", "title-only", "untranslated", "failed"]) {
      for (const suffix of ["?sl=en", "?lang=en&sl=ja"]) {
        const tags = await topicMeta(`/t/${ids[name]}${suffix}`, ids[name]);
        expect(tagOf(tags, "og:title")).toBe(`原文の題 ${name}`);
        expect(tagOf(tags, "og:description")).toBe(`原文の本文 ${name}`);
        expect(tagOf(tags, "og:locale")).toBe("ja_JP");
        expect(tagOf(tags, "og:url")).toBe(`${BASE}/t/${ids[name]}${suffix.startsWith("?sl") ? "?sl=en" : "?lang=en"}`);
      }
    }
    const remark = await topicMeta(`/t/${ids.remark}?sl=ja`, ids.remark);
    expect(tagOf(remark, "og:title")).toMatch(/^\[ja\]/);
    expect(tagOf(remark, "og:locale")).toBe("ja_JP");
    const picture = await topicMeta(`/t/${ids.essay}?sl=ja`, ids.essay);
    expect(tagOf(picture, "og:image:alt")).toBe("図の代替文");
    expect(tagOf(picture, "twitter:card")).toBe("summary_large_image");
  });

  it("gives no preview for a hidden, deleted or closed-village topic, nor when the site is closed to readers who have not logged in", async () => {
    const hidden = await topicMeta(`/t/${ids.hidden}?sl=ja`, ids.hidden);
    expect(tagOf(hidden, "og:title")).toBeUndefined();
    expect(JSON.stringify(hidden)).not.toContain("Hidden");
    for (const name of ["deleted", "in-closed"]) {
      await expect(topicMeta(`/t/${ids[name]}?sl=ja`, ids[name]), name).rejects.toMatchObject({ init: { status: 404 } });
    }
    expect(tagOf(await topicMeta(`/t/${ids["in-pub"]}`, ids["in-pub"]), "og:title")).toBe("Topic in pub");
    vi.stubEnv("PUBLIC_READING", "");
    const { loader, meta } = await import("~/routes/topic");
    const loaderData = await loader(h.args(h.request(`/t/${ids.essay}`, { as: "feed_author" }), { id: String(ids.essay) })) as never;
    expect((loaderData as { share: unknown }).share).toBeNull();
    const closedRoot = { id: "root", loaderData: { publicReading: false, siteOrigin: null } };
    const tags = (meta as unknown as (args: unknown) => Tag[])({ loaderData, location: { pathname: `/t/${ids.essay}`, search: "" }, matches: [closedRoot] });
    expect(tags.some(tag => tag.property?.startsWith("og:") || tag.name?.startsWith("twitter:"))).toBe(false);
  });
});

describe("the preview of the home page and of a village", () => {
  it("previews the home page with the site's own introduction, and links its feed", async () => {
    const { meta } = await import("~/routes/home");
    const tags = (meta as unknown as (args: unknown) => Tag[])({ location: { pathname: "/", search: "?lang=ja" }, matches: [root] });
    expect(tagOf(tags, "og:title")).toBe("tomola");
    expect(tagOf(tags, "og:type")).toBe("website");
    expect(tagOf(tags, "og:description")).toContain("tomola is a place to read essays");
    expect(tagOf(tags, "og:url")).toBe(`${BASE}/?lang=ja`);
    expect(tagOf(tags, "og:image")).toBe(`${BASE}/icons/share-default.png`);
    expect(tagOf(tags, "twitter:card")).toBe("summary");
    expect(tags.find(tag => tag.rel === "alternate" && tag.type === "application/rss+xml")).toMatchObject({ href: `${BASE}/feed.xml?lang=ja` });
  });

  it("previews a village with its name and description in plain text, and links its feed unless it has ended", async () => {
    const { loader, meta } = await import("~/routes/village");
    const call = async (slug: string) => {
      const loaderData = await loader(h.args(h.request(`/v/${slug}`), { slug })) as never;
      return (meta as unknown as (args: unknown) => Tag[])({ loaderData, location: { pathname: `/v/${slug}`, search: "" }, matches: [root] });
    };
    const open = await call("feed-open");
    expect(tagOf(open, "og:title")).toBe("Village open");
    expect(tagOf(open, "og:description")).toBe("The open village talks about **gardens** and more.");
    expect(tagOf(open, "og:url")).toBe(`${BASE}/v/feed-open`);
    expect(tagOf(open, "og:image")).toBe(`${BASE}/icons/share-default.png`);
    expect(tagOf(open, "twitter:card")).toBe("summary");
    expect(open.find(tag => tag.rel === "alternate" && tag.type === "application/rss+xml")).toMatchObject({ href: `${BASE}/v/feed-open/feed.xml` });
    const ended = await call("feed-ended");
    expect(ended.some(tag => tag.type === "application/rss+xml")).toBe(false);
    await expect(call("feed-closed")).rejects.toMatchObject({ init: { status: 404 } });
  });
});
