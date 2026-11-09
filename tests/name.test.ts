import { createElement } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { initializeSiteMarkdown } from "~/lib/markdown-startup.server";
import { NAME_LANGS, isNameLang, nameFor } from "~/lib/name.server";
import { PRINCIPLES_LANGS } from "~/lib/principles-languages";
import { whyFor } from "~/lib/why.server";
import { readNameSource } from "./helpers/name-source";
import { renderInRouter } from "./helpers/render-in-router";
import { setTestLocale } from "./stubs/paraglide-runtime";

vi.mock("~/paraglide/messages.js", async () => ({ m: (await import("./helpers/messages-json")).jsonMessages() }));
beforeAll(() => initializeSiteMarkdown());
afterEach(() => setTestLocale("en"));

const args = (path: string, init?: RequestInit) => ({ request: new Request(`http://localhost:5173${path}`, init), params: {}, context: {} }) as never;
const htmlLoader = async (path: string) => (await import("~/routes/name")).loader(args(path));
const markdownLoader = async (path: string, init?: RequestInit) => (await import("~/routes/name-md")).loader(args(path, init)) as Promise<Response>;

describe("the separate name page", () => {
  it("has all seventeen editions", () => {
    expect([...NAME_LANGS].sort()).toEqual([...PRINCIPLES_LANGS].sort());
    expect(NAME_LANGS).toHaveLength(17);
  });

  it.each(NAME_LANGS)("serves the heading and signature in %s without leaving the name section in why", async lang => {
    const source = readNameSource(lang);
    const doc = nameFor(lang, "en");
    const shown = await htmlLoader(`/name?lang=${lang}`);
    expect(shown).toMatchObject({ shown: lang, title: source.title });
    expect(shown.bodyHtml).toContain("<p");
    expect(doc.markdown).toMatch(/^# /);
    expect(doc.markdown.trimEnd().split("\n").at(-1)).toBe(source.signature);
    expect(doc.markdown).not.toContain("<!-- source:");
    const response = await markdownLoader(`/name.md?lang=${lang}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/plain");
    expect(response.headers.get("X-Robots-Tag")).toBe("noindex");
    const text = await response.text();
    expect(text).toContain(`lang: ${lang}`);
    expect(text).toContain("canonical: http://localhost:5173/name\n");
    expect(text).toContain(`# ${source.title}\n`);
    expect(text).toContain(source.signature);
    const why = whyFor(lang, "en").markdown;
    expect(why).not.toContain(`## ${source.title}`);
    expect(why.trimEnd().split("\n").at(-1)).toBe(source.signature);
  });

  it.each(NAME_LANGS.filter(lang => lang !== "ja"))("keeps the same translation disclosure as why in %s", async lang => {
    const disclosure = whyFor(lang, "en").markdown.split(/\r?\n\r?\n/)[1];
    expect(disclosure).toBeTruthy();
    expect(nameFor(lang, "en").markdown.split(/\r?\n\r?\n/)[1]).toBe(disclosure);
    const shown = await htmlLoader(`/name?lang=${lang}`);
    expect(shown.bodyHtml.split("</p>")[0]).toBe(whyFor(lang, "en").bodyHtml.split("</p>")[0]);
    const text = await (await markdownLoader(`/name.md?lang=${lang}`)).text();
    expect(text).toContain(`\n\n${disclosure}\n\n`);
  });

  it("uses the asked language, the screen language, then English", async () => {
    setTestLocale("ja");
    expect((await htmlLoader("/name")).shown).toBe("ja");
    expect((await htmlLoader("/name?lang=xx")).shown).toBe("ja");
    expect((await htmlLoader("/name?lang=fr")).shown).toBe("fr");
    expect(nameFor(null, "xx").lang).toBe("en");
    for (const invalid of ["xx", "constructor", "__proto__", "toString", ""]) {
      expect(isNameLang(invalid)).toBe(false);
      expect((await markdownLoader(`/name.md?lang=${invalid}`)).status).toBe(400);
    }
  });

  it("defaults both Markdown extensions to Japanese and allows HEAD only alongside GET", async () => {
    for (const extension of ["md", "txt"]) {
      const text = await (await markdownLoader(`/name.${extension}`)).text();
      expect(text).toContain("id: name\n");
      expect(text).toContain("lang: ja\n");
      expect(text).not.toContain("original:");
      const translated = await (await markdownLoader(`/name.${extension}?lang=en`)).text();
      expect(translated).toContain("original: http://localhost:5173/name.md\n");
      const head = await markdownLoader(`/name.${extension}`, { method: "HEAD" });
      expect(head.status).toBe(200);
      expect(await head.text()).toBe("");
      expect((await markdownLoader(`/name.${extension}`, { method: "POST" })).status).toBe(405);
    }
  });

  it("keeps the public document layout, language links, RTL direction and Markdown alternate", async () => {
    const route = await import("~/routes/name");
    const loaderData = await htmlLoader("/name?lang=ar");
    const html = await renderInRouter(() => createElement(route.default, { loaderData } as never), "/name?lang=ar");
    expect(html).toContain('<article lang="ar" dir="rtl"');
    expect(html).toContain('href="/name?lang=ja"');
    expect(html).toContain('href="/name?lang=en"');
    expect(html).not.toContain(">undefined<");
    expect(route.headers()).toMatchObject({ "X-Robots-Tag": "noindex" });
    const meta = route.meta({ loaderData } as never);
    expect(meta).toContainEqual({ title: readNameSource("ar").title });
    expect(meta).toContainEqual({ name: "robots", content: "noindex" });
    expect(meta).toContainEqual({ tagName: "link", rel: "alternate", type: "text/markdown", href: "/name.md?lang=ar" });
    for (const tag of ["header", "footer"]) {
      for (const markup of html.matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "g"))) {
        expect(markup[1]).not.toMatch(/href="\/name(?:[?"/])/);
      }
    }
  });
});
