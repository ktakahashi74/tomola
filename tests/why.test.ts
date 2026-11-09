import { withShellLabels } from "./helpers/render-in-router";
import { shellLabels } from "~/lib/shell-labels.server";
import { initializeSiteMarkdown } from "~/lib/markdown-startup.server";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createStaticHandler, createStaticRouter, StaticRouterProvider, useLoaderData, type StaticHandlerContext } from "react-router";
import { beforeAll, afterEach, describe, expect, it, vi } from "vitest";
import { SiteFooter } from "~/components/site-footer";
import { isWhyLang, whyFor, WHY_LANGS } from "~/lib/why.server";
import { m } from "~/paraglide/messages.js";
import { setTestLocale } from "./stubs/paraglide-runtime";

// The "why" page: the initiator's account, outside the principles. The tests check the shape and the routing, not the wording.
vi.mock("~/paraglide/messages.js", async () => ({ m: (await import("./helpers/messages-json")).jsonMessages() }));
beforeAll(() => initializeSiteMarkdown());
afterEach(() => setTestLocale("en"));

const request = (path: string, init?: RequestInit) => ({ request: new Request(`http://localhost:5173${path}`, init), params: {}, context: {} }) as never;
const callLoader = async (path: string) => (await (await import("~/routes/why")).loader(request(path)));
const callMd = async (path: string, init?: RequestInit) => (await (await import("~/routes/why-md")).loader(request(path, init))) as Response;

describe("the texts", () => {
  it("include the Japanese original, and every text has a title and a body", () => {
    expect(WHY_LANGS).toContain("ja");
    for (const lang of WHY_LANGS) {
      const doc = whyFor(lang, "en");
      expect(doc.lang, lang).toBe(lang);
      expect(doc.title.length, lang).toBeGreaterThan(0);
      expect(doc.bodyHtml, lang).toContain("<p");
      expect(doc.markdown, lang).not.toMatch(/^\s*<!--/);
    }
  });

  it("follow the asked language, then the screen language, then English", () => {
    expect(whyFor("fr", "ja").lang).toBe("fr");
    expect(whyFor("xx", "ja").lang).toBe("ja");
    expect(whyFor(null, "de").lang).toBe(isWhyLang("de") ? "de" : "en");
  });
});

describe("/why", () => {
  it("shows the text of ?lang=, and the screen language without it", async () => {
    expect((await callLoader("/why?lang=zh-Hant")).shown).toBe("zh-Hant");
    setTestLocale("ja");
    expect((await callLoader("/why")).shown).toBe("ja");
  });

  it("is not indexable", async () => {
    const { headers, meta } = await import("~/routes/why");
    expect(headers()).toMatchObject({ "X-Robots-Tag": "noindex" });
    for (const lang of ["ja", "en", "ar"]) {
      const loaderData = await callLoader(`/why?lang=${lang}`);
      expect(meta({ loaderData } as never)).toEqual([
        { title: whyFor(lang, "en").title },
        { name: "robots", content: "noindex" },
        { tagName: "link", rel: "alternate", type: "text/markdown", href: lang === "ja" ? "/why.md" : `/why.md?lang=${lang}` },
      ]);
    }
  });

  it("reads right to left in Arabic, and names every language in its own script", async () => {
    const route = await import("~/routes/why");
    const Component = () => createElement(route.default as never, { loaderData: useLoaderData() });
    const routes = withShellLabels([{ path: "/why", Component, loader: route.loader as never }]);
    const handler = createStaticHandler(routes);
    const context = (await handler.query(new Request("http://localhost:5173/why?lang=ar"))) as StaticHandlerContext;
    const html = renderToStaticMarkup(createElement(StaticRouterProvider, { router: createStaticRouter(routes, context), context, hydrate: false }));
    expect(html).toContain('<article lang="ar" dir="rtl"');
    expect(html).toContain(">العربية<");
    expect(html).not.toContain(">undefined<");
  });
});

describe("/why.md", () => {
  it("serves the original by default and a translation with ?lang=, with frontmatter", async () => {
    const original = await (await callMd("/why.md")).text();
    expect(original).toMatch(/^---\n/);
    expect(original).toContain("id: why");
    expect(original).toContain("lang: ja");
    const translated = await (await callMd("/why.md?lang=en")).text();
    expect(translated).toContain("lang: en");
    expect(translated).toContain("canonical: http://localhost:5173/why\n");
    expect(translated).toContain("original: http://localhost:5173/why.md\n");
    expect(original).not.toContain("original:");
    const head = await callMd("/why.txt", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("X-Robots-Tag")).toBe("noindex");
    expect(await head.text()).toBe("");
  });

  it("refuses an unknown language and other methods", async () => {
    for (const invalid of ["xx", "constructor", "__proto__", "toString", ""]) {
      expect((await callMd(`/why.md?lang=${invalid}`)).status).toBe(400);
    }
    expect((await callMd("/why.md", { method: "POST" })).status).toBe(405);
  });
});

describe("the footer", () => {
  it("links to the why page, in the screen language", async () => {
    const routes = withShellLabels([{ path: "/", Component: () => createElement(SiteFooter, { labels: shellLabels(), sourceUrl: null, previewNotice: null }) }]);
    const handler = createStaticHandler(routes);
    const context = (await handler.query(new Request("http://localhost:5173/"))) as StaticHandlerContext;
    const html = renderToStaticMarkup(createElement(StaticRouterProvider, { router: createStaticRouter(routes, context), context, hydrate: false }));
    expect(html).toContain('href="/why"');
    expect(html).toContain(`>${m.footer_why()}<`);
  });
});


describe("the principles page", () => {
  it("links to the why page before the text", async () => {
    const route = await import("~/routes/principles");
    const Component = () => createElement(route.default as never, { loaderData: useLoaderData() });
    const routes = withShellLabels([{ path: "/principles", Component, loader: route.loader as never }]);
    const handler = createStaticHandler(routes);
    const context = (await handler.query(new Request("http://localhost:5173/principles"))) as StaticHandlerContext;
    const html = renderToStaticMarkup(createElement(StaticRouterProvider, { router: createStaticRouter(routes, context), context, hydrate: false }));
    expect(html).toContain('href="/why"');
    expect(html.indexOf('href="/why"')).toBeLessThan(html.indexOf("<h1"));
  });
});
