import { withShellLabels } from "./helpers/render-in-router";
import { shellLabels } from "~/lib/shell-labels.server";
import fs from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createStaticHandler, createStaticRouter, StaticRouterProvider, useLoaderData, type StaticHandlerContext } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { SiteFooter } from "~/components/site-footer";
import { LANGS, parseEnabledLangs } from "~/lib/languages";
import { PRINCIPLES_LANGS, PRINCIPLES_LANG_LABELS } from "~/lib/principles-languages";
import { parsePrinciples, principlesFor, renderPrinciples, SECTION_ALIASES, SECTION_COUNT, stripLeadingComments } from "~/lib/principles.server";
import { sourceUrl } from "~/lib/source-url";
import { assertStartupConfig } from "~/lib/startup-checks.server";
import { setTestLocale } from "./stubs/paraglide-runtime";
import { expectedPrinciplesStatus, readPrinciplesSource } from "./helpers/principles-source";
import { m } from "~/paraglide/messages.js";
import { messageMarkup } from "./helpers/message-markup";

// The public principles page reads its canonical editions directly from the app.
// Real messages verify the navigation and links independently of the edition text.
vi.mock("~/paraglide/messages.js", async () => ({ m: (await import("./helpers/messages-json")).jsonMessages() }));
afterEach(() => {
  setTestLocale("en");
  vi.unstubAllEnvs();
});

const root = process.cwd();
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");
const copy = (lang: "ja" | "en") => read(`app/content/principles/${lang}.md`);

const callLoader = async (path: string, init?: RequestInit) => (await (await import("~/routes/principles")).loader({ request: new Request(`http://localhost:5173${path}`, init), params: {}, context: {} } as never));
const callMd = async (path: string, init?: RequestInit) => (await (await import("~/routes/principles-md")).loader({ request: new Request(`http://localhost:5173${path}`, init), params: {}, context: {} } as never)) as Response;

// The page, rendered with its own route and loader in a static router (no root layout, no session).
async function renderPage(path: string): Promise<string> {
  const route = await import("~/routes/principles");
  const Component = () => createElement(route.default as never, { loaderData: useLoaderData() });
  const routes = withShellLabels([{ path: "/principles", Component, loader: route.loader as never }]);
  const handler = createStaticHandler(routes);
  const context = (await handler.query(new Request(`http://localhost:5173${path}`))) as StaticHandlerContext;
  // hydrate: false leaves out the router's own hydration script, so that the page itself can be checked for scripts.
  return renderToStaticMarkup(createElement(StaticRouterProvider, { router: createStaticRouter(routes, context), context, hydrate: false }));
}

// The text a reader sees: tags out, entities back.
const textOf = (html: string) =>
  html
    .replace(/<\/(?:p|li|h\d|ul|ol|section|div|article|main)>/g, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");

describe("the canonical editions and their structure", () => {
  it.each(PRINCIPLES_LANGS)("inserts operator information into the %s edition without publishing its markers", lang => {
    const document = principlesFor(lang).document;
    expect(document.markdown).toBe(readPrinciplesSource(lang).markdown);
    expect(document.markdown).not.toMatch(/\{\{principles-/);
    expect(document.sections[6].markdown.split("\n").filter(line => line.startsWith("- "))).toHaveLength(2);
  });


  it("strips all leading comments, including multiline notes, while preserving the published text", () => {
    const body = "# Title\n\nIntroduction.\n<!-- a comment after the title -->\n";
    expect(stripLeadingComments(` \n<!-- first note -->\n\n<!-- second\nmultiline note -->\n${body}`)).toBe(body);
    expect(stripLeadingComments(`<!-- first -->\r\n<!-- second\r\nnote -->\r\n${body}`)).toBe(body);
    expect(stripLeadingComments(body)).toBe(body);
  });

  it("has the same shape in both languages: sections 1 to 7 with the ids s1 to s7, rules for section 3 and objections for section 7", () => {
    const ja = parsePrinciples(copy("ja"), "ja");
    const en = parsePrinciples(readPrinciplesSource("en").markdown, "en");
    expect(SECTION_COUNT).toBe(7);
    for (const doc of [ja, en]) {
      expect(doc.sections.map((s) => s.id)).toEqual(["s1", "s2", "s3", "s4", "s5", "s6", "s7"]);
      expect(doc.sections.map((s) => s.alias)).toEqual([null, null, "rules", null, null, null, "objections"]);
      for (const s of doc.sections) expect(s.markdown).toMatch(new RegExp(`^## ${s.number}\\. `));
    }
    expect(SECTION_ALIASES).toEqual({ 3: "rules", 7: "objections" });
  });

  it("refuses a text whose sections are not numbered 1 to 7 in order, so that a broken edit fails here and not for a reader", () => {
    const text = copy("ja");
    expect(() => parsePrinciples(text.replace("## 4. ", "## 5. "), "ja")).toThrow(/numbered 1 to 7/);
    expect(() => parsePrinciples(text.replace(/^## 7\. .*$/m, ""), "ja")).toThrow(/numbered 1 to 7/);
    expect(() => parsePrinciples(text.replace(/^# /m, ""), "ja")).toThrow(/title/);
  });

  it("no startup check reads the page text or looks for the unfilled marks", () => {
    for (const file of ["app/lib/startup-checks.server.ts", "app/lib/startup.server.ts", "app/lib/source-url.ts"]) {
      expect(read(file), file).not.toMatch(/principles/i);
    }
  });
});

describe("the page: /principles", () => {
  it("keeps every ID unique when the introduction and sections are rendered separately", async () => {
    for (const lang of PRINCIPLES_LANGS) {
      const html = await renderPage(`/principles?lang=${lang}`);
      const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]);
      expect(ids.length, lang).toBeGreaterThan(0);
      expect(new Set(ids).size, lang).toBe(ids.length);
    }
  });

  it("lists the editions one can join in on a line and the others in a fold, with only the current edition unlinked", async () => {
    vi.stubEnv("ENABLED_LANGS", "ja,en");
    const rows = [["ja", "en"], ["ar", "bn", "de", "es", "fr", "hi", "id", "ko", "pt", "ru", "th", "ur", "vi", "zh-Hans", "zh-Hant"]];
    for (const shown of PRINCIPLES_LANGS) {
      const html = await renderPage(`/principles?lang=${shown}`);
      const nav = html.match(/<nav\b[^>]*aria-label="Read in another language"[^>]*>([\s\S]*?)<\/nav>/)?.[1];
      expect(nav, shown).toBeDefined();
      const lists = [...nav!.matchAll(/<ul[^>]*>([\s\S]*?)<\/ul>/g)];
      expect(lists).toHaveLength(2);
      expect(nav).toContain(messageMarkup(m.principles_langs_more({ count: 15 })));
      expect(lists.map(list => [...list[1].matchAll(/<(?:a|span)\b[^>]*lang="([^"]+)"/g)].map(item => item[1]))).toEqual(rows);
      for (const lang of PRINCIPLES_LANGS) {
        expect(nav).toContain(PRINCIPLES_LANG_LABELS[lang]);
        if (lang === shown) {
          expect(nav).toMatch(new RegExp(`<span[^>]*lang="${lang}"[^>]*aria-current="page"`));
          expect(nav).not.toContain(`href="/principles?lang=${lang}"`);
        } else {
          const link = nav!.match(new RegExp(`<a\\b[^>]*\\blang="${lang}"[^>]*>`))?.[0];
          expect(link).toContain(`href="/principles?lang=${lang}"`);
          expect(link).toMatch(new RegExp(`href[lL]ang="${lang}"`));
        }
      }
      expect(nav).toContain("日本語 (original)");
    }
    vi.stubEnv("ENABLED_LANGS", "en");
    expect((await callLoader("/principles")).languages).toEqual({
      open: ["en"], readOnly: ["ja", "ar", "bn", "de", "es", "fr", "hi", "id", "ko", "pt", "ru", "th", "ur", "vi", "zh-Hans", "zh-Hant"],
    });
    vi.stubEnv("ENABLED_LANGS", "ja,en,fr,zh-Hans,zh-Hant");
    expect((await callLoader("/principles")).languages).toEqual({
      open: ["ja", "en", "fr", "zh-Hans", "zh-Hant"], readOnly: ["ar", "bn", "de", "es", "hi", "id", "ko", "pt", "ru", "th", "ur", "vi"],
    });
  });

  it("opens without logging in: no session is read, and a request with a cookie gets the same page", async () => {
    const plain = await callLoader("/principles");
    const withCookie = await callLoader("/principles", { headers: { cookie: "better-auth.session_token=anything" } });
    expect(plain).toEqual(withCookie);
    expect(plain).not.toBeInstanceOf(Response);
    for (const file of ["app/routes/principles.tsx", "app/routes/principles-md.ts", "app/lib/principles.server.ts"]) {
      expect(read(file), file).not.toMatch(/auth\/session|requireMember|getSessionUser|getDb|db\/client|members\.server/);
    }
  });

  it("is outside the member layout in the route table (the login page and the footer are the only things around it)", async () => {
    const { default: routes } = await import("../app/routes");
    const top = (routes as Array<{ path?: string; file: string; children?: unknown[] }>).filter((r) => r.path !== undefined);
    expect(top.map((r) => r.path)).toEqual(expect.arrayContaining(["principles", "principles.md", "principles.txt"]));
  });

  it("shows the Japanese original: the text, the sections with their ids and names, no drafting note, no label, and the language navigation", async () => {
    setTestLocale("ja");
    const html = await renderPage("/principles");
    const text = textOf(html);
    expect(html).toContain("<h1");
    for (const id of ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "rules", "objections"]) expect(html, id).toContain(`id="${id}"`);
    expect(html).toContain('lang="ja"');
    const source = readPrinciplesSource("ja");
    expect(text).toContain(source.title);
    for (const heading of source.headings) expect(text).toContain(heading);
    for (const comment of source.comments) expect(html).not.toContain(comment);
    expect(text).not.toContain("（原稿");
    expect(text).not.toContain("Unverified machine translation");
    expect(html).not.toContain(">日本語の原文を読む<");
    expect(text).not.toContain("source:");
    // The original has no translation note box; other editions are available in the navigation.
    expect(html).not.toContain('role="note"');
    expect(html).toContain('href="/principles?lang=en"');
  });

  it("shows the English text and its review notice, with a link to the original", async () => {
    const html = await renderPage("/principles?lang=en");
    const text = textOf(html);
    expect(html).toContain('lang="en"');
    const source = readPrinciplesSource("en");
    expect(text).toContain(source.title);
    for (const heading of source.headings) expect(text).toContain(heading);
    for (const comment of source.comments) expect(html).not.toContain(comment);
    expect(text).not.toContain("(Draft,");
    if (expectedPrinciplesStatus("en") === "unverified") expect(text).toContain("Unverified machine translation");
    else expect(text).not.toContain("Unverified machine translation");
    expect(html).not.toContain('role="note"');
    expect(text).not.toContain("This page is not available in your language yet");
    expect(html).toContain('href="/principles?lang=ja"');
    for (const id of ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "rules", "objections"]) expect(html, id).toContain(`id="${id}"`);
    // The supplied notice stays in English even with a Japanese interface.
    setTestLocale("ja");
    const japaneseUi = textOf(await renderPage("/principles?lang=en"));
    if (expectedPrinciplesStatus("en") === "unverified") expect(japaneseUi).toContain("Unverified machine translation");
    else expect(japaneseUi).not.toContain("Unverified machine translation");
  });

  it("shows each language's own text and follows the screen language when no query is supplied", async () => {
    for (const lang of LANGS) {
      setTestLocale(lang);
      const loaded = await callLoader("/principles");
      expect(loaded.shown, lang).toBe(lang);
      const html = await renderPage("/principles");
      expect(html, lang).toContain(`lang="${lang}"`);
      const source = readPrinciplesSource(lang);
      expect(textOf(html), lang).toContain(source.title);
      for (const heading of source.headings) expect(textOf(html), lang).toContain(heading);
      for (const comment of source.comments) expect(html, lang).not.toContain(comment);
      expect(html).not.toContain("This page is not available in your language yet");
    }
    setTestLocale("fr");
    expect(textOf(await renderPage("/principles?lang=ja"))).toContain(readPrinciplesSource("ja").title);
  });

  it("is rendered through the safe Markdown pipeline: no script, no raw HTML from the text, links and images follow the post rules", async () => {
    for (const lang of ["ja", "en"] as const) {
      const html = await renderPage(`/principles?lang=${lang}`);
      expect(html).not.toMatch(/<script|onerror=|javascript:/i);
    }
  });

  it("HTML in a text is not rendered as HTML: a script, an image with an event handler and a link with a javascript: URL in a fixture come out as text or nothing, and the real texts are not taken from the cache of the fixture", async () => {
    const sections = [1, 2, 3, 4, 5, 6, 7].map((n) => `## ${n}. Section ${n}\n\nBody <script>alert(${n})</script> and <img src=x onerror=alert(1)> and [x](javascript:alert(1)).`);
    const fixture = parsePrinciples(`# Title\n\n<script>alert("intro")</script>\n\nIntro text.\n\n${sections.join("\n\n")}\n`, "en");
    const out = (await renderPrinciples(fixture));
    const html = out.introHtml + out.sections.map((s) => s.html).join("");
    expect(html).not.toMatch(/<script|<img|onerror|javascript:/i);
    expect(html).toContain("Intro text.");
    expect(html).toContain("Section 3");
    // The fixture has lang "en" like the real English text: the render cache is per document, not per language.
    const real = (await renderPrinciples(principlesFor("en").document));
    expect(real.sections[0].html).not.toContain("Section 1");
    expect(real).toEqual((await renderPrinciples(parsePrinciples(readPrinciplesSource("en").markdown, "en"))));
  });

  it("has its own document and independent status for every language, without a fallback flag", () => {
    for (const lang of PRINCIPLES_LANGS) {
      const view = principlesFor(lang);
      expect(view).toMatchObject({ status: expectedPrinciplesStatus(lang), document: { lang } });
      expect(view).not.toHaveProperty("notTranslated");
    }
  });
});

describe("principles languages are independent of ENABLED_LANGS", () => {
  it("contains every software language without opening the additional editions as software languages", () => {
    expect(PRINCIPLES_LANGS).toHaveLength(17);
    expect(LANGS).toHaveLength(9);
    for (const lang of LANGS) expect(PRINCIPLES_LANGS).toContain(lang);
    for (const lang of ["es", "pt", "ru", "ar", "hi", "id", "bn", "ur"]) {
      expect(LANGS).not.toContain(lang);
      expect(parseEnabledLangs(lang)).toMatchObject({ ok: false });
    }
  });

  it("serves all seventeen texts when only Japanese and English are enabled", async () => {
    vi.stubEnv("ENABLED_LANGS", "ja,en");
    setTestLocale("ja");
    for (const lang of PRINCIPLES_LANGS) {
      const loaded = await callLoader(`/principles?lang=${lang}`);
      expect(loaded.shown).toBe(lang);
      expect(loaded.status).toBe(expectedPrinciplesStatus(lang));
      const response = await callMd(`/principles.md?lang=${lang}`);
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).toContain(`\nlang: ${lang}\n`);
      expect(text).toContain(`\nstatus: ${expectedPrinciplesStatus(lang)}\n`);
      expect(text).not.toContain("requested_lang:");
    }
  });

  it("keeps all texts available on a single-language site and rejects only unsupported tags", async () => {
    vi.stubEnv("ENABLED_LANGS", "ja");
    for (const lang of PRINCIPLES_LANGS) expect((await callMd(`/principles.md?lang=${lang}`)).status).toBe(200);
    setTestLocale("ja");
    expect((await callLoader("/principles?lang=xx")).shown).toBe("ja");
    const bad = await callMd("/principles.md?lang=xx");
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain(PRINCIPLES_LANGS.join(", "));
  });
});

describe("the page is not indexable", () => {
  it("the HTML has the X-Robots-Tag header and a robots meta, and the alternate link points at the twin of the text on the page", async () => {
    const route = await import("~/routes/principles");
    expect(route.headers()).toEqual({ "X-Robots-Tag": "noindex" });
    const meta = async (path: string) => route.meta({ loaderData: await callLoader(path) } as never) as Array<Record<string, unknown>>;
    for (const path of ["/principles?lang=ja", "/principles?lang=en", "/principles?lang=fr"]) {
      const tags = await meta(path);
      expect(tags, path).toContainEqual({ name: "robots", content: "noindex" });
      expect(tags.find((t) => t.rel === "alternate")?.type, path).toBe("text/markdown");
    }
    // The Japanese original has the default twin; every translation has its own language tag.
    expect((await meta("/principles?lang=ja")).find((t) => t.rel === "alternate")?.href).toBe("/principles.md");
    expect((await meta("/principles?lang=en")).find((t) => t.rel === "alternate")?.href).toBe("/principles.md?lang=en");
    for (const lang of PRINCIPLES_LANGS.filter(lang => lang !== "ja")) expect((await meta(`/principles?lang=${lang}`)).find((t) => t.rel === "alternate")?.href).toBe(`/principles.md?lang=${lang}`);
  });

  it("every twin answer carries X-Robots-Tag: noindex: the original, English, French, and HEAD", async () => {
    for (const path of ["/principles.md", "/principles.md?lang=en", "/principles.md?lang=fr"]) expect((await callMd(path)).headers.get("x-robots-tag"), path).toBe("noindex");
    expect((await callMd("/principles.md", { method: "HEAD" })).headers.get("x-robots-tag")).toBe("noindex");
  });
});

describe("the Markdown twin: /principles.md", () => {
  it("is public, text/plain, shared-cacheable like /llms.txt, and answers HEAD without a body", async () => {
    const res = await callMd("/principles.md");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    // During the trial the page is public but not indexable, like /ai.txt.
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
    const head = await callMd("/principles.md", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect((await callMd("/principles.md", { method: "POST" })).status).toBe(405);
  });

  const split = (text: string) => {
    const lines = text.split("\n");
    expect(lines[0]).toBe("---");
    const end = lines.indexOf("---", 1);
    return { fm: parse(lines.slice(1, end).join("\n")) as Record<string, unknown>, body: lines.slice(end + 1).join("\n") };
  };

  it("is the Japanese original by default: frontmatter type page, id principles, lang, status, canonical; the body is the page text, without the drafting note", async () => {
    const { fm, body } = split(await (await callMd("/principles.md")).text());
    expect(fm).toEqual({ type: "page", id: "principles", lang: "ja", status: "original", canonical: "http://localhost:5173/principles" });
    expect(body.trimEnd()).toBe(readPrinciplesSource("ja").markdown.trimEnd());
    expect(body).not.toContain("（原稿");
    expect(body).not.toContain("source:");
  });

  it("gives each translation its own language, status and original link, without requested_lang", async () => {
    for (const lang of PRINCIPLES_LANGS.filter(lang => lang !== "ja")) {
      const translated = split(await (await callMd(`/principles.md?lang=${lang}`)).text());
      expect(translated.fm).toEqual({ type: "page", id: "principles", lang, status: expectedPrinciplesStatus(lang), canonical: "http://localhost:5173/principles", original: "http://localhost:5173/principles.md" });
      expect(translated.body.trimEnd()).toBe(readPrinciplesSource(lang).markdown.trimEnd());
      for (const comment of readPrinciplesSource(lang).comments) expect(translated.body, lang).not.toContain(comment);
    }
    expect((await callMd("/principles.md?lang=xx")).status).toBe(400);
  });
});

describe("the footer", () => {
  async function footer(source: string | null): Promise<string> {
    const routes = withShellLabels([{ path: "/", Component: () => createElement(SiteFooter, { labels: shellLabels(), sourceUrl: source, previewNotice: null }) }]);
    const handler = createStaticHandler(routes);
    const context = (await handler.query(new Request("http://localhost:5173/"))) as StaticHandlerContext;
    return renderToStaticMarkup(createElement(StaticRouterProvider, { router: createStaticRouter(routes, context), context, hydrate: false }));
  }

  it("links to the principles page, in the screen language", async () => {
    const html = await footer(null);
    expect(html).toContain('href="/principles"');
    expect(html).toContain(">Principles<");
    setTestLocale("ja");
    expect(await footer(null)).toContain(">原則<");
  });

  it("has a Source link to SOURCE_URL when it is set, and nothing when it is empty", async () => {
    const withSource = await footer("https://example.org/tomola");
    expect(withSource).toContain('href="https://example.org/tomola"');
    expect(withSource).toContain('rel="noopener noreferrer"');
    expect(withSource).toContain(`>${m.footer_source()}<`);
    const without = await footer(null);
    expect(without).not.toContain(m.footer_source());
    expect(without).not.toContain("example.org");
  });

  it("is rendered by the root layout, so it is on every page (the login page and the error pages too)", () => {
    const root = read("app/root.tsx");
    expect(root).toContain("<SiteFooter");
    expect(root.indexOf("{children}")).toBeLessThan(root.indexOf("<SiteFooter"));
  });
});

describe("SOURCE_URL", () => {
  it("is null when unset or empty, and the normalized URL when it is an http(s) URL", () => {
    expect(sourceUrl({})).toBeNull();
    expect(sourceUrl({ SOURCE_URL: "" })).toBeNull();
    expect(sourceUrl({ SOURCE_URL: "   " })).toBeNull();
    expect(sourceUrl({ SOURCE_URL: "https://example.org/tomola" })).toBe("https://example.org/tomola");
    // http is for development and tests only (below).
    expect(sourceUrl({ NODE_ENV: "test", SOURCE_URL: " http://example.org/a b " })).toBe("http://example.org/a%20b");
    expect(sourceUrl({ NODE_ENV: "development", SOURCE_URL: "http://localhost:3000/src" })).toBe("http://localhost:3000/src");
  });

  it("must be https in production (an unset NODE_ENV counts as production), and must not carry a user name or a password in any environment; the startup check refuses both", () => {
    for (const env of [{ NODE_ENV: "production" }, {}]) {
      expect(() => sourceUrl({ ...env, SOURCE_URL: "http://example.org/tomola" }), JSON.stringify(env)).toThrow(/https/);
      expect(sourceUrl({ ...env, SOURCE_URL: "https://example.org/tomola" })).toBe("https://example.org/tomola");
    }
    for (const NODE_ENV of ["production", "test", "development"]) {
      for (const bad of ["https://user:secret@example.org/tomola", "https://user@example.org/tomola", "https://:secret@example.org/tomola"]) {
        expect(() => sourceUrl({ NODE_ENV, SOURCE_URL: bad }), `${NODE_ENV} ${bad}`).toThrow(/user name or a password/);
        expect(() => assertStartupConfig({ TOMOLA_OPERATOR_DIR: process.env.TOMOLA_OPERATOR_DIR, NODE_ENV, SMTP_URL: "smtp://127.0.0.1:25", MAIL_FROM: "tomola <no-reply@example.org>", MAIL_DECOY_TO: "test@blackhole.postmarkapp.com", ENABLED_LANGS: "ja,en", SOURCE_URL: bad }, () => undefined), `${NODE_ENV} ${bad}`).toThrow(/SOURCE_URL/);
      }
    }
    expect(() =>
      assertStartupConfig({ TOMOLA_OPERATOR_DIR: process.env.TOMOLA_OPERATOR_DIR, NODE_ENV: "production", SMTP_URL: "smtp://127.0.0.1:25", MAIL_FROM: "tomola <no-reply@example.org>", MAIL_DECOY_TO: "test@blackhole.postmarkapp.com", ENABLED_LANGS: "ja,en", SOURCE_URL: "http://example.org/tomola" }, () => undefined),
    ).toThrow(/SOURCE_URL must be an https/);
  });

  it("refuses anything that is not an http(s) URL, so the link cannot be javascript: or the like; the startup check refuses it too", () => {
    for (const bad of ["javascript:alert(1)", "data:text/html,x", "ftp://example.org/x", "not a url", "//example.org/x", "example.org/x"]) {
      expect(() => sourceUrl({ SOURCE_URL: bad }), bad).toThrow(/SOURCE_URL/);
      expect(() => assertStartupConfig({ TOMOLA_OPERATOR_DIR: process.env.TOMOLA_OPERATOR_DIR, NODE_ENV: "test", SOURCE_URL: bad }, () => undefined), bad).toThrow(/SOURCE_URL/);
    }
    expect(() => assertStartupConfig({ TOMOLA_OPERATOR_DIR: process.env.TOMOLA_OPERATOR_DIR, NODE_ENV: "test", SOURCE_URL: "https://example.org/tomola" }, () => undefined)).not.toThrow();
    expect(() => assertStartupConfig({ TOMOLA_OPERATOR_DIR: process.env.TOMOLA_OPERATOR_DIR, NODE_ENV: "test" }, () => undefined)).not.toThrow();
  });
});
