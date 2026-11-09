import { eq } from "drizzle-orm";
import { createElement } from "react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ReadingLangMenu } from "~/components/reading-lang-menu";
import { entries, profiles, translations } from "~/lib/db/schema";
import { readingLanguageChoice, screenReadLangsFor } from "~/lib/display-lang.server";
import { createReply, createTopic, replyLocationAt } from "~/lib/entries.server";
import type { Lang } from "~/lib/languages";
import { carriedLang, readingLangSearch, setCarriedLang } from "~/lib/reading-lang";
import { negotiateUiLocale } from "~/lib/http/locale.server";
import { getMd } from "./helpers/md";
import { renderInRouter } from "./helpers/render-in-router";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";
import { setTestLocale } from "./stubs/paraglide-runtime";

afterEach(() => { vi.unstubAllEnvs(); setTestLocale("en"); });

function languageSearch(html: string, lang: Lang) {
  const tag = (html.match(/<a\b[^>]*>/g) ?? []).find(tag => tag.includes(`hrefLang="${lang}"`));
  expect(tag).toBeDefined();
  return new URL(/\bhref="([^"]+)"/.exec(tag!)![1].replaceAll("&amp;", "&"), "http://x").search;
}

it.each([
  ["?order=activity&asks=1&page=2", "fr", "en", "?order=activity&asks=1&lang=fr&rl=1"],
  ["?order=insightful&long=1&lang=fr&rl=1&page=3", "en", "en", "?order=insightful&long=1"],
  ["?lang=fr&page=2", "en", "en", ""],
  ["?orig=7&tag=objection&lang=en&page=2", "ja", "en", "?orig=7&tag=objection&lang=ja&rl=1"],
  ["?lang=ja&lang=en&page=2", "fr", "en", "?lang=fr&rl=1"],
  ["?manage=1&order=activity&asks=1&page=3&membersPage=2", "ja", "en", "?order=activity&asks=1&membersPage=2&lang=ja&rl=1"],
  ["", "en", null, "?lang=en&rl=1"],
  ["?lang=fr&rl=1&page=2", "en", null, "?lang=en&rl=1"],
] as const)("language link keeps unrelated state and returns to page one: %s", (search, target, usual, expected) => {
  expect(readingLangSearch(search, target, usual)).toBe(expected);
});

// The screen is in a language only because of the address: every choice keeps it (rl=<language of the screen>), including the usual language and the one now read.
it.each([
  ["?lang=fr", "fr", "ja", "fr", "?lang=fr&rl=fr"],
  ["?lang=fr", "ja", "ja", "fr", "?lang=ja&rl=fr"],
  ["?lang=de&rl=fr&page=2", "de", "ja", "fr", "?lang=de&rl=fr"],
  ["?order=activity&lang=fr&rl=1", "en", "ja", "fr", "?order=activity&lang=en&rl=fr"],
] as const)("an address-given screen language is pinned by the reading choice: %s -> %s", (search, target, usual, ui, expected) => {
  expect(readingLangSearch(search, target, usual, ui)).toBe(expected);
});

it("only an enabled override supersedes original-reading preferences on screens", () => {
  vi.stubEnv("ENABLED_LANGS", "ja,en");
  const profile = { readLangs: ["ja", "en"] as Lang[] };
  for (const path of ["/", "/?lang=", "/?lang=fr", "/?lang=xx"]) {
    expect(screenReadLangsFor(new Request(`http://x${path}`), profile)).toEqual(profile.readLangs);
  }
  for (const lang of ["ja", "en"]) expect(screenReadLangsFor(new Request(`http://x/?lang=${lang}`), profile)).toEqual([]);
  expect(screenReadLangsFor(new Request("http://x/?lang=en"))).toEqual([]);
});

it("removing a guest override restores the locale without the query, including cookie precedence", () => {
  vi.stubEnv("ENABLED_LANGS", "ja,en,fr");
  setTestLocale("fr");
  const guest = readingLanguageChoice(new Request("http://x/?lang=fr", { headers: { "accept-language": "en-US" } }));
  expect(guest).toEqual({ current: "fr", usual: "en", enabled: ["ja", "en", "fr"], ui: "fr" });
  expect(readingLanguageChoice(new Request("http://x/", { headers: { "accept-language": "en-US" } })).ui).toBeNull();
  expect(readingLanguageChoice(new Request("http://x/?lang=fr", { headers: { cookie: "PARAGLIDE_LOCALE=ja", "accept-language": "en" } })).usual).toBe("ja");
});

it("the menu names the language read, draws no label, and holds only enabled language links with language attributes and a single current choice", async () => {
  const html = await renderInRouter(() => createElement(ReadingLangMenu, {
    choice: { enabled: ["ja", "en"], current: "en", usual: "en" }, originalLang: "fr",
  }), "/a/ja?order=activity&page=2&lang=fr&rl=1");
  expect(html.match(/hreflang=/gi)).toHaveLength(2);
  expect(html).toContain('lang="ja"'); expect(html).toContain('lang="en"');
  expect(html).not.toContain('lang="fr"');
  expect(html.match(/aria-current="page"/g)).toHaveLength(1);
  expect(html).toContain('href="/a/ja?order=activity"');
  expect(html).toContain('href="/a/ja?order=activity&amp;lang=ja&amp;rl=1"');
  // The summary is the name and a chevron; the label is in the accessible name only.
  expect(html).toMatch(/<summary[^>]*aria-label="[^"]*: English"[^>]*>English<svg/);
});

it("a language whose translation has not arrived is muted and named for screen readers; the original is marked", async () => {
  const html = await renderInRouter(() => createElement(ReadingLangMenu, {
    choice: { enabled: ["ja", "en", "fr"], current: "en", usual: "en" }, originalLang: "ja", translating: new Set<Lang>(["fr"]), text: "Japanese, translated",
  }), "/t/5");
  expect(html.match(/data-translation-pending/g)).toHaveLength(1);
  expect(html).toMatch(/hrefLang="fr"[^>]*data-translation-pending[^>]*>Français<span class="sr-only">/);
  // The link to the original goes through the "(original)" message, not the bare name.
  expect(html).not.toMatch(/hrefLang="ja"[^>]*>日本語</);
  expect(html).toContain(">Japanese, translated<");
});

it("keeps language queries when URLSearchParams has no size property", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(URLSearchParams.prototype, "size")!;
  Reflect.deleteProperty(URLSearchParams.prototype, "size");
  try {
    const html = await renderInRouter(() => createElement(ReadingLangMenu, {
      choice: { enabled: ["ja", "en"], current: "en", usual: "en" }, originalLang: "ja", entryId: 5,
    }), "/t/5?orig=5&orig=9&page=2");
    expect(languageSearch(html, "en")).toBe("?lang=en&rl=1&orig=9");
    expect(languageSearch(html, "ja")).toBe("?lang=ja&rl=1&orig=9");
  } finally {
    Object.defineProperty(URLSearchParams.prototype, "size", descriptor);
  }
});

it("with one enabled language there is nothing to choose, so the name is plain text", async () => {
  const html = await renderInRouter(() => createElement(ReadingLangMenu, { choice: { enabled: ["en"], current: "en", usual: "en" } }), "/");
  expect(html).not.toContain("<details");
  expect(html).toContain("English");
});

describe("the reading-only mark", () => {
  const enabled = ["ja", "en", "fr"] as const;
  const request = (path: string, headers: Record<string, string> = {}) => new Request(`http://x${path}`, { headers });
  it("a shared ?lang= link sets the language of the screen; the address made by pressing a reading language does not", () => {
    expect(negotiateUiLocale(request("/?lang=fr", { "accept-language": "ja" }), enabled)).toEqual({ locale: "fr", source: "query" });
    expect(negotiateUiLocale(request("/?lang=fr&rl=1", { "accept-language": "ja" }), enabled)).toEqual({ locale: "ja", source: "accept-language" });
    expect(negotiateUiLocale(request("/?lang=fr&rl=1"), enabled).source).toBe("default");
    // A mark that names an enabled language keeps the screen in it (the reader got there by an address); an unknown or disabled one is only a mark.
    expect(negotiateUiLocale(request("/?lang=en&rl=fr", { "accept-language": "ja" }), enabled)).toEqual({ locale: "fr", source: "query" });
    expect(negotiateUiLocale(request("/?rl=fr", { "accept-language": "ja" }), enabled)).toEqual({ locale: "fr", source: "query" });
    expect(negotiateUiLocale(request("/?lang=fr&rl=de", { "accept-language": "ja" }), enabled)).toEqual({ locale: "ja", source: "accept-language" });
    expect(negotiateUiLocale(request("/?lang=en&rl=fr", { cookie: "PARAGLIDE_LOCALE=ja" }), enabled).locale).toBe("ja");
    // The cookie still wins over both.
    expect(negotiateUiLocale(request("/?lang=fr", { cookie: "PARAGLIDE_LOCALE=en" }), enabled).locale).toBe("en");
  });
  it("links that carry the reading language copy the mark", () => {
    expect(carriedLang("fr", "?lang=fr")).toBe("fr");
    expect(carriedLang("fr", "?lang=fr&rl=1")).toBe("fr&rl=1");
    expect(carriedLang("de", "?lang=de&rl=fr")).toBe("de&rl=fr");
    expect(carriedLang("de", "?lang=de&rl=%26x")).toBe("de&rl=1");
    expect(carriedLang(null, "?rl=1")).toBeNull();
    const params = new URLSearchParams();
    setCarriedLang(params, "fr&rl=1");
    expect(params.toString()).toBe("lang=fr&rl=1");
    expect(replyLocationAt(5, 9, 2, { lang: "fr&rl=1" })).toBe("/t/5?page=2&lang=fr&rl=1#c-9");
    expect(replyLocationAt(5, 9, 1, { lang: "de&rl=fr" })).toBe("/t/5?lang=de&rl=fr#c-9");
    expect(replyLocationAt(5, 9, 1, { lang: "fr" })).toBe("/t/5?lang=fr#c-9");
    expect(replyLocationAt(5, 9, 1)).toBe("/t/5#c-9");
  });
});

describe("screen overrides without changes to machine reads or preferences", () => {
  let h: RouteHarness;
  const ids: Record<string, number> = {};
  beforeAll(async () => {
    h = await setupRouteHarness();
    await h.signIn("reading_reader", { homeArea: "ja", readLangs: ["ja", "en"] });
    await h.db.update(profiles).set({ displayLang: "en" }).where(eq(profiles.userId, h.ids.reading_reader));
    for (const lang of ["ja", "en", "fr"] as const) {
      const result = await createTopic(h.db, h.ids.reading_reader, { lang, title: `${lang} source title`, body: `${lang} source body` });
      if (!result.ok) throw new Error(result.error);
      ids[lang] = result.id;
      const [row] = await h.db.select({ sourceHash: entries.sourceHash }).from(entries).where(eq(entries.id, result.id));
      for (const target of ["ja", "en", "fr"] as const) if (target !== lang) {
        await h.db.insert(translations).values([
          { entryId: result.id, field: "title", lang: target, kind: "primary", text: `${target} translated ${lang} title`, sourceHash: row.sourceHash, engine: "fake" },
          { entryId: result.id, field: "body", lang: target, kind: "primary", text: `${target} translated ${lang} body`, sourceHash: row.sourceHash, engine: "fake" },
        ]);
      }
    }
    const reply = await createReply(h.db, h.ids.reading_reader, ids.ja, { lang: "en", body: "en reply source" });
    if (!reply.ok) throw new Error(reply.error);
    ids.reply = reply.id;
    const [row] = await h.db.select({ sourceHash: entries.sourceHash }).from(entries).where(eq(entries.id, reply.id));
    await h.db.insert(translations).values({ entryId: reply.id, field: "body", lang: "ja", kind: "primary", text: "ja translated reply", sourceHash: row.sourceHash, engine: "fake" });
  });
  afterAll(() => h.restore());
  const home = async (path = "/") => {
    const data = await (await import("~/routes/home")).loader(h.args(h.request(path, { as: "reading_reader" })));
    if (data.layout !== "unified") throw new Error("Expected unified layout");
    return data;
  };
  const topic = async (lang: string, search = "") => {
    const data = await (await import("~/routes/topic")).loader(h.args(h.request(`/t/${ids[lang]}${search}`, { as: "reading_reader" }), { id: String(ids[lang]) }));
    if (data.topic.placeholder) throw new Error("Expected a readable article");
    return { ...data, topic: data.topic };
  };

  it("shows list reading menus only to members on home, language and village pages", async () => {
    vi.stubEnv("PUBLIC_READING", "1");
    vi.stubEnv("VILLAGES", "1");
    await (await import("~/lib/villages.server")).ensureLanguageVillages(h.db);
    const pages = [
      { mod: await import("~/routes/home"), path: "/", params: {} },
      { mod: await import("~/routes/area"), path: "/a/ja", params: { lang: "ja" } },
      { mod: await import("~/routes/village"), path: "/v/ja", params: { slug: "ja" } },
    ];
    for (const { mod, path, params } of pages) {
      for (const as of [undefined, "reading_reader"]) {
        const loaderData = await mod.loader(h.args(h.request(`${path}?lang=fr`, { as }), params as Record<string, string>));
        const html = await renderInRouter(() => createElement(mod.default as never, { loaderData } as never), path);
        expect(html.includes("reading-lang-menu"), `${as ?? "guest"}: ${path}`).toBe(as !== undefined);
      }
    }
  });

  it("keeps source titles by default and translates other originals when a language is explicitly chosen", async () => {
    const usual = await home();
    expect(usual.topics.find(t => t.id === ids.ja)?.title.text).toBe("ja source title");
    expect(usual.topics.find(t => t.id === ids.fr)?.title.text).toBe("en translated fr title");
    for (const target of ["en", "fr"] as const) {
      const chosen = await home(`/?lang=${target}`);
      expect(chosen.readingLanguage).toMatchObject({ usual: "en", current: target });
      expect(chosen.topics.map(t => t.id)).toEqual(usual.topics.map(t => t.id));
      for (const source of ["ja", "en", "fr"]) expect(chosen.topics.find(t => t.id === ids[source])?.title.text)
        .toBe(source === target ? `${source} source title` : `${target} translated ${source} title`);
    }
    expect((await home("/?lang=xx")).topics.map(t => t.title)).toEqual(usual.topics.map(t => t.title));
  });

  it("keeps area membership and filters, applies the override on articles and still permits original selection", async () => {
    const area = await import("~/routes/area");
    const normal = await area.loader(h.args(h.request("/a/ja?order=insightful&long=1", { as: "reading_reader" }), { lang: "ja" }));
    const chosen = await area.loader(h.args(h.request("/a/ja?order=insightful&long=1&lang=fr", { as: "reading_reader" }), { lang: "ja" }));
    expect(chosen.topics.map(t => t.id)).toEqual(normal.topics.map(t => t.id));
    expect(chosen).toMatchObject({ order: "insightful", filter: "long" });
    expect(chosen.topics[0].title.text).toBe("fr translated ja title");
    expect((await topic("ja")).topic.display?.shown).toBe("original");
    expect((await topic("ja", "?lang=en")).topic.display).toMatchObject({ shown: "translation", translation: { lang: "en" } });
    expect((await topic("en", "?lang=en")).topic.display?.shown).toBe("original");
    expect((await topic("ja", `?lang=fr&orig=${ids.ja}`)).topic.display?.shown).toBe("original");
  });

  it("an article menu explicitly translates into the usual language and can return to the original without changing preferences", async () => {
    const current = await topic("ja");
    const html = await renderInRouter(() => createElement(ReadingLangMenu, {
      choice: current.readingLanguage, originalLang: "ja", entryId: ids.ja,
    }), `/t/${ids.ja}?orig=${ids.ja}&orig=999&old=${ids.ja}&page=2`);
    const english = languageSearch(html, "en"), japanese = languageSearch(html, "ja");
    const params = new URLSearchParams(english);
    expect(params.get("lang")).toBe("en");
    expect(params.get("rl")).toBe("1");
    expect(params.has("page")).toBe(false);
    expect(params.getAll("orig")).toEqual(["999"]);
    expect(params.getAll("old")).toEqual([]);
    expect(params.getAll("tr")).toEqual([]);
    expect((await topic("ja", english)).topic.display).toMatchObject({ shown: "translation", translation: { lang: "en" } });
    expect((await topic("ja", japanese)).topic.display?.shown).toBe("original");
    const [profile] = await h.db.select({ readLangs: profiles.readLangs, displayLang: profiles.displayLang }).from(profiles).where(eq(profiles.userId, h.ids.reading_reader));
    expect(profile).toEqual({ readLangs: ["ja", "en"], displayLang: "en" });
  });

  it("returning to a usual-language original restores reply preferences and stops carrying an override", async () => {
    await h.db.update(profiles).set({ displayLang: "ja" }).where(eq(profiles.userId, h.ids.reading_reader));
    setTestLocale("ja");
    try {
      const current = await topic("ja", "?lang=en&rl=1");
      const html = await renderInRouter(() => createElement(ReadingLangMenu, {
        choice: current.readingLanguage, originalLang: "ja", entryId: ids.ja,
      }), `/t/${ids.ja}?lang=en&rl=1&orig=${ids.ja}&tr=${ids.ja}&old=${ids.ja}&orig=999`);
      const search = languageSearch(html, "ja");
      expect(search).toBe("?orig=999");
      const restored = await topic("ja", search);
      expect(restored.topic.display?.shown).toBe("original");
      expect(restored.replies.find(reply => reply.id === ids.reply)).toMatchObject({ display: { shown: "original" } });
      expect(restored.langParam).toBeNull();
      const [profile] = await h.db.select({ readLangs: profiles.readLangs, displayLang: profiles.displayLang }).from(profiles).where(eq(profiles.userId, h.ids.reading_reader));
      expect(profile).toEqual({ readLangs: ["ja", "en"], displayLang: "ja" });
    } finally {
      await h.db.update(profiles).set({ displayLang: "en" }).where(eq(profiles.userId, h.ids.reading_reader));
    }
  });

  it("the author of an article sees which languages its translation has not reached; other readers do not", async () => {
    vi.stubEnv("ENABLED_LANGS", "ja,en,fr");
    await h.signIn("reading_other", { homeArea: "en", readLangs: ["en"] });
    const made = await createTopic(h.db, h.ids.reading_reader, { lang: "ja", title: "ja pending title", body: "ja pending body" });
    if (!made.ok) throw new Error(made.error);
    const load = async (as?: string) => (await import("~/routes/topic")).loader(h.args(h.request(`/t/${made.id}`, as ? { as } : undefined), { id: String(made.id) }));
    expect((await load("reading_reader")).translating).toEqual(["en", "fr"]);
    expect((await load("reading_other")).translating).toEqual([]);
    vi.stubEnv("PUBLIC_READING", "1");
    expect((await load()).translating).toEqual([]);
    const [row] = await h.db.select({ sourceHash: entries.sourceHash }).from(entries).where(eq(entries.id, made.id));
    await h.db.insert(translations).values({ entryId: made.id, field: "body", lang: "en", kind: "primary", text: "en translated body", sourceHash: row.sourceHash, engine: "fake" });
    expect((await load("reading_reader")).translating).toEqual(["fr"]);
  });

  it("links that carry the page's reading language keep the reading-only mark", async () => {
    const plain = await home("/?lang=fr");
    expect(plain.langParam).toBe("fr");
    const chosen = await home("/?lang=fr&rl=1");
    expect(chosen.langParam).toBe("fr&rl=1");
    expect(chosen.readingLanguage.current).toBe("fr");
    expect((await home("/")).langParam).toBeNull();
  });

  it("leaves Markdown originals, translations and saved preferences unchanged", async () => {
    const before = await h.db.select().from(profiles).where(eq(profiles.userId, h.ids.reading_reader));
    const mdBefore = await (await getMd(h, "/home.md?lang=en", { as: "reading_reader" })).text();
    expect(mdBefore).toContain('title: "ja source title"');
    expect(mdBefore).toContain('text: "en translated ja title"');
    await home("/?lang=fr"); await topic("ja", "?lang=en");
    expect(await (await getMd(h, "/home.md?lang=en", { as: "reading_reader" })).text()).toBe(mdBefore);
    expect(await h.db.select().from(profiles).where(eq(profiles.userId, h.ids.reading_reader))).toEqual(before);
  });

});
