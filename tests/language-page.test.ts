import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import Languages, { loader } from "~/routes/languages";
import { LocaleSwitcher } from "~/components/locale-switcher";
import { loader as markdownLoader } from "~/routes/languages-md";
import { testOperator } from "./helpers/operator";
import { languagePage } from "~/lib/language-page.server";
import { enabledLangs, previewLangs } from "~/lib/enabled-langs.server";
import { LANGS } from "~/lib/languages";
import { PRINCIPLES_LANGS } from "~/lib/principles-languages";
import { llmsTxt } from "~/lib/api/guides.server";
import { renderInRouter } from "./helpers/render-in-router";
import { parseBlocks } from "./helpers/md";
import { setTestLocale } from "./stubs/paraglide-runtime";
import { m } from "~/paraglide/messages.js";

vi.mock("~/paraglide/messages.js", async () => ({ m: (await import("./helpers/messages-json")).jsonMessages() }));
afterEach(() => { vi.unstubAllEnvs(); setTestLocale("en"); });

const tags = (page: ReturnType<typeof languagePage>, id: string) => page.groups.find(group => group.id === id)!.languages.map(lang => lang.tag);
const md = (path = "/languages.md", method = "GET") => markdownLoader({ request: new Request(`http://localhost${path}`, { method }) } as never);

describe("public language availability", () => {
  it("keeps the request menu available when only one interface language is enabled", async () => {
    const html = await renderInRouter(() => createElement(LocaleSwitcher), "/", undefined, { enabledLangs: ["en"] });
    expect(html).toContain('role="combobox"');
  });

  it("moves languages between groups when enabled and preview settings change, using the canonical inventories", () => {
    for (const env of [{ ENABLED_LANGS: "ja,en,ko", PREVIEW_LANGS: "ko" }, { ENABLED_LANGS: "en,fr", PREVIEW_LANGS: "fr" }, { ENABLED_LANGS: "en", PREVIEW_LANGS: "" }]) {
      vi.stubEnv("ENABLED_LANGS", env.ENABLED_LANGS);
      vi.stubEnv("PREVIEW_LANGS", env.PREVIEW_LANGS);
      const page = loader();
      expect(tags(page, "open")).toEqual(enabledLangs().filter(lang => !previewLangs().includes(lang)));
      expect(tags(page, "preview")).toEqual(previewLangs());
      expect(tags(page, "supported")).toEqual(LANGS.filter(lang => !enabledLangs().includes(lang)));
      expect(tags(page, "principles")).toEqual(PRINCIPLES_LANGS.filter(lang => !(LANGS as readonly string[]).includes(lang)));
      expect(new Set(page.groups.flatMap(group => group.languages.map(lang => lang.tag))).size).toBe(PRINCIPLES_LANGS.length);
    }
  });

  it.each(["ja", "en"] as const)("renders autonyms and names in %s, with a localized email draft and no member dependency", async locale => {
    setTestLocale(locale);
    vi.stubEnv("ENABLED_LANGS", "ja,en,ko");
    vi.stubEnv("PREVIEW_LANGS", "ko");
    const page = loader();
    const html = await renderInRouter(() => createElement(Languages, { loaderData: page } as never), "/languages");
    for (const group of page.groups) {
      expect(html).toContain(`id="languages-${group.id}"`);
      for (const lang of group.languages) {
        expect(lang.nativeName).toBeTruthy();
        expect(lang.name).toBe(new Intl.DisplayNames([locale], { type: "language", languageDisplay: "standard" }).of(lang.tag));
        expect(html).toContain(`lang="${lang.tag}"`);
      }
    }
    const mail = new URL(page.mailto);
    expect(mail.pathname).toBe(testOperator.contactEmail);
    expect(mail.searchParams.get("subject")).toBe(m.languages_request_subject());
    expect(mail.searchParams.get("body")).toBe(m.languages_request_body());
    expect(mail.search).not.toContain("+");
    expect(mail.searchParams.get("body")!.trim().split("\n")).toHaveLength(4);
    expect(html).toContain('href="mailto:');
    expect(html).toContain('href="/principles#s2"');
  });

  it("omits empty groups on the screen and serves the same availability as public Markdown without request totals", async () => {
    vi.stubEnv("ENABLED_LANGS", LANGS.join(","));
    vi.stubEnv("PREVIEW_LANGS", "");
    const page = loader();
    const html = await renderInRouter(() => createElement(Languages, { loaderData: page } as never), "/languages");
    expect(html).not.toContain('id="languages-preview"');
    expect(html).not.toContain('id="languages-supported"');
    const response = md();
    expect(response.status).toBe(200);
    expect(response.headers.get("X-Robots-Tag")).toBe("noindex");
    const blocks = parseBlocks(await response.text());
    expect(blocks).toHaveLength(1);
    expect(blocks[0].fm).toMatchObject({ type: "page", id: "languages", lang: "en" });
    expect(Object.keys(blocks[0].fm).some(key => /count|total|popular/.test(key))).toBe(false);
    for (const lang of page.groups.flatMap(group => group.languages)) expect(blocks[0].body).toContain(`- ${lang.nativeName} — ${lang.name}`);
    expect(blocks[0].body).toContain(page.mailto);
    expect(llmsTxt()).toContain("/languages.md");
  });

  it("supports translated Markdown, HEAD and strict language/method validation", async () => {
    expect(parseBlocks(await md("/languages.md?lang=ja").text())[0].fm.lang).toBe("ja");
    expect(md("/languages.md?lang=unknown").status).toBe(400);
    const head = md("/languages.md", "HEAD");
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect(md("/languages.md", "POST").status).toBe(405);
  });
});
