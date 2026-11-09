import { describe, expect, it } from "vitest";
import { renderMarkdown } from "~/lib/markdown.server";
import { readingInfo, readingVersions } from "~/lib/reading.server";
import { renderEntryHtml, renderTranslationHtml, tryRenderTranslationHtml } from "~/lib/entries.server";
import type { EntryDisplay } from "~/lib/entry-display.server";
import { markdownQuote } from "~/lib/quote-reply";

describe("reading metadata", () => {
  it("quotes every selected line including blank lines and normalizes line endings", () => {
    expect(markdownQuote("First\r\n\r\nSecond\rThird")).toBe("> First\n> \n> Second\n> Third");
  });
  it("extracts h2/h3 anchors and escaped inline text, excluding other depths and footnotes", async () => {
    const html = (await renderMarkdown("# Title\n\n## A & **B** <span>text</span>\n\n### `code`\n\n#### Deep\n\ntext[^1]\n\n[^1]: note", { idPrefix: "p-2-" }));
    expect(readingInfo(html, "en").headings).toEqual([
      { id: "p-2-h-2", depth: 2, text: "A & B text" },
      { id: "p-2-h-3", depth: 3, text: "code" },
    ]);
  });

  it("does not read heading prefixes inside quoted attribute values as tags, in linear time", async () => {
    const title = "<h2 ".repeat(60000);
    const hostile = `<p><a href="https://example.com" title="${title}">x</a></p><h2 id="p-1-h-1">Real</h2>`;
    const started = performance.now();
    expect(readingInfo(hostile, "en").headings).toEqual([{ id: "p-1-h-1", depth: 2, text: "Real" }]);
    // Quadratic extraction takes seconds at this size; linear takes a few milliseconds.
    expect(performance.now() - started).toBeLessThan(1000);

    const rendered = (await renderMarkdown(`[x](https://example.com "${"<h2".repeat(16000)}")\n\n## After`, { idPrefix: "p-1-" }));
    const renderedStarted = performance.now();
    expect(readingInfo(rendered, "en").headings.map(heading => heading.text)).toEqual(["After"]);
    expect(performance.now() - renderedStarted).toBeLessThan(1000);
  });

  it("keeps a heading whole when a link title inside it contains a closing heading tag", async () => {
    const html = (await renderMarkdown('## Before [link](https://example.com "</h2><h3 id=\'p-1-h-9\'>") after\n\n### Next', { idPrefix: "p-1-" }));
    const headings = readingInfo(html, "en").headings;
    expect(headings.map(({ id, depth }) => ({ id, depth }))).toEqual([{ id: "p-1-h-1", depth: 2 }, { id: "p-1-h-2", depth: 3 }]);
    expect(headings[0].text).toContain("after");
    expect(headings[1].text).toBe("Next");
  });

  it.each(["ja", "zh-Hans", "zh-Hant", "ko"])("counts %s characters and ignores markup and whitespace", lang => {
    expect(readingInfo(`<p>${"あ".repeat(1000)}</p>`, lang).minutes).toBe(2);
    expect(readingInfo(`<p>${"あ".repeat(1001)}</p>`, lang).minutes).toBe(3);
    expect(readingInfo(`<p>${"😀".repeat(1000)} \n </p>`, lang).minutes).toBe(2);
  });

  it("counts words across block boundaries without breaking words at inline formatting", () => {
    expect(readingInfo(`<p>${"word ".repeat(440)}</p>`, "en").minutes).toBe(2);
    expect(readingInfo(`<p>${"word ".repeat(440)}</p><p><em>fin</em>al</p>`, "en").minutes).toBe(3);
    expect(readingInfo("", "en").minutes).toBe(0);
  });

  it("uses each version's HTML and language for its metadata", async () => {
    const body = (await renderEntryHtml("topic", 5, `## Original\n\n${"あ".repeat(1500)}`, "ja", new Map())).html;
    const translation = (await renderTranslationHtml("topic", 5, "en", `## Translated\n\n${"word ".repeat(1100)}`, new Map())).html;
    const older = (await tryRenderTranslationHtml("topic", 5, "en", "## Earlier\n\nShort.", new Map()))!.html;
    const display: EntryDisplay = {
      shown: "translation", pending: false,
      translation: { lang: "en", kind: "primary", engine: "fake", model: null, fallback: false, stale: false, html: translation, title: null, headline: null, reportNotice: null,
        older: { kind: "human", engine: null, model: null, html: older, title: null, headline: null } },
    };
    const info = readingVersions(body, "ja", display);
    expect(info.original.minutes).toBe(4);
    expect(info.translation?.minutes).toBe(6);
    expect(info.older?.minutes).toBe(1);
    expect([info.original, info.translation!, info.older!].map(version => version.headings[0].id)).toEqual(["p-5-h-1", "p-5-h-1", "p-5-h-1"]);
    expect(info.translation?.headings[0].text).toBe("Translated");
  });
});
