import { describe, expect, it } from "vitest";
import { feedAlternate, shareUrl, sharePreviewMeta } from "~/lib/share-meta";
import { ogLocale, previewBudget, previewText } from "~/lib/share-text";
import { rssXml, xmlText, type Feed } from "~/lib/feed-xml";
import { firstMediaImage } from "~/lib/share-preview.server";
import { shareLanguageHint } from "~/lib/share-language";

const graphemes = (text: string) => [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].length;

describe("the description of a shared preview", () => {
  it("gives fewer characters to the scripts that pack more into each", () => {
    expect(previewBudget("ja")).toBe(120);
    expect(previewBudget("zh-Hant")).toBe(120);
    expect(previewBudget("th")).toBe(140);
    expect(previewBudget("en")).toBe(160);
  });

  it("leaves a short text as it is and collapses white space", () => {
    expect(previewText("  one\n\ntwo   three ", "en")).toBe("one two three");
  });

  it("cuts a long text at a word boundary, never inside a word, and marks the cut", () => {
    const words = Array.from({ length: 80 }, (_, i) => `word${i}`).join(" ");
    const cut = previewText(words, "en");
    expect(cut.endsWith("…")).toBe(true);
    expect(graphemes(cut)).toBeLessThanOrEqual(161);
    const kept = cut.slice(0, -1).split(" ");
    expect(kept.every(word => /^word\d+$/.test(word))).toBe(true);
    expect(words.startsWith(kept.join(" "))).toBe(true);
  });

  it.each(["ja", "zh-Hans", "ko", "th", "vi", "fr"] as const)("stays within the budget in %s without leaving a dangling separator", lang => {
    const sample: Record<string, string> = {
      ja: "これは長い日本語の文章で、共有されたときに説明として表示される部分です。".repeat(8),
      "zh-Hans": "这是一段很长的中文文字，用来检查描述在被分享时如何被截断。".repeat(8),
      ko: "이것은 공유될 때 설명으로 표시되는 긴 한국어 문장입니다. ".repeat(8),
      th: "นี่คือข้อความภาษาไทยที่ยาวมากสำหรับการแสดงตัวอย่างเมื่อมีการแชร์ ".repeat(8),
      vi: "Đây là một đoạn văn tiếng Việt dài để kiểm tra việc cắt mô tả khi được chia sẻ. ".repeat(8),
      fr: "Ceci est un long texte français pour vérifier la coupure de la description. ".repeat(8),
    };
    const cut = previewText(sample[lang], lang);
    expect(cut.endsWith("…")).toBe(true);
    expect(graphemes(cut)).toBeLessThanOrEqual(previewBudget(lang) + 1);
    expect(/[\s、，,;:；：\-–—(（[「『"“‘]…$/u.test(cut)).toBe(false);
    expect(sample[lang].startsWith(cut.slice(0, -1))).toBe(true);
  });

  it("cuts one unbroken run at a character", () => {
    const cut = previewText("x".repeat(500), "en");
    expect(graphemes(cut)).toBe(161);
  });

  it("does not split a character made of several code points", () => {
    const text = "👨‍👩‍👧‍👦".repeat(200);
    const cut = previewText(text, "en");
    expect(cut.slice(0, -1)).toBe("👨‍👩‍👧‍👦".repeat(160));
  });

  it("names the Open Graph locale of each language of the site", () => {
    expect(ogLocale("ja")).toBe("ja_JP");
    expect(ogLocale("zh-Hant")).toBe("zh_TW");
    expect(ogLocale("xx")).toBeNull();
  });
});

describe("preview language hints", () => {
  const enabled = ["ja", "en", "fr"];
  it("prioritizes an open explicit language, then an open preview hint, otherwise no hint", () => {
    expect(shareLanguageHint("?lang=ja&sl=en", enabled)).toEqual({ param: "lang", lang: "ja" });
    expect(shareLanguageHint("?lang=de&sl=en", enabled)).toEqual({ param: "sl", lang: "en" });
    expect(shareLanguageHint("?sl=fr", enabled)).toEqual({ param: "sl", lang: "fr" });
    for (const search of ["", "?sl=de", "?sl=EN", "?sl=en%20", "?sl=../../en"]) expect(shareLanguageHint(search, enabled)).toBeNull();
  });
});

describe("the preview tags", () => {
  const matches = [{ id: "root", loaderData: { publicReading: true, siteOrigin: "https://example.test", enabledLangs: ["en", "fr", "ja"] } }];
  const location = { pathname: "/t/5", search: "?lang=fr&page=2" };

  it("gives nothing on a site closed to readers who have not logged in, or without a preview", () => {
    expect(sharePreviewMeta([{ id: "root", loaderData: { publicReading: false, siteOrigin: null } }], location, { type: "website", title: "x", lang: "en" })).toEqual([]);
    expect(sharePreviewMeta(matches, location, null)).toEqual([]);
    expect(feedAlternate([], "/feed.xml", "tomola", location)).toEqual([]);
  });

  it("keeps the preview's language hint and picks the card by whether the post has an image", () => {
    const site = { origin: "https://example.test", langs: ["en", "fr", "ja"] };
    expect(shareUrl(site, location)).toBe("https://example.test/t/5?lang=fr");
    expect(shareUrl(site, { pathname: "/", search: "?lang=zz&order=created" })).toBe("https://example.test/");
    // A language the site has not opened is left out of the address, as the feeds refuse it.
    expect(shareUrl(site, { pathname: "/t/5", search: "?lang=de" })).toBe("https://example.test/t/5");
    expect(shareUrl(site, { pathname: "/t/5", search: "?sl=fr&page=2" })).toBe("https://example.test/t/5?sl=fr");
    expect(shareUrl(site, { pathname: "/t/5", search: "?lang=ja&sl=fr" })).toBe("https://example.test/t/5?lang=ja");
    expect(shareUrl(site, { pathname: "/t/5", search: "?sl=de" })).toBe("https://example.test/t/5");
    expect(shareUrl(site, { pathname: "/v/garden", search: "?sl=fr" })).toBe("https://example.test/v/garden");
    expect(feedAlternate(matches, "/feed.xml", "tomola", { search: "?lang=de" })[0].href).toBe("https://example.test/feed.xml");
    expect(feedAlternate(matches, "/feed.xml", "tomola", { search: "?lang=ja" })[0].href).toBe("https://example.test/feed.xml?lang=ja");
    const plain = sharePreviewMeta(matches, location, { type: "article", title: "T", description: "D", lang: "en", publishedTime: "2026-10-01T00:00:00.000Z" });
    expect(plain).toContainEqual({ property: "og:type", content: "article" });
    expect(plain).toContainEqual({ name: "description", content: "D" });
    expect(plain).toContainEqual({ name: "twitter:card", content: "summary" });
    expect(plain).toContainEqual({ property: "article:published_time", content: "2026-10-01T00:00:00.000Z" });
    expect(plain).toContainEqual({ property: "og:image", content: "https://example.test/icons/share-default.png" });
    expect(plain).toContainEqual({ property: "og:image:width", content: "512" });
    expect(plain).toContainEqual({ property: "og:image:height", content: "512" });
    expect(plain).toContainEqual({ property: "og:image:alt", content: "tomola" });
    const withImage = sharePreviewMeta(matches, location, { type: "article", title: "T", lang: "en", image: { url: "https://example.test/media/a.webp", width: 10, height: 20, alt: "" } });
    expect(withImage).toContainEqual({ name: "twitter:card", content: "summary_large_image" });
    expect(withImage).toContainEqual({ property: "og:image:height", content: "20" });
    // An empty alt text is left out; a description is left out when there is none.
    expect(withImage.some(tag => "name" in tag && tag.name === "twitter:image:alt")).toBe(false);
    expect(withImage.some(tag => "property" in tag && tag.property === "og:description")).toBe(false);
  });
});

describe("the first image of a post", () => {
  const id = "a".repeat(64);
  const path = `/media/${id}-30x20.webp`;
  const origin = "https://example.test";
  it("takes the first image of the site and its alt text", () => {
    expect(firstMediaImage(`text\n\n![A \\[figure\\]\n  here](${path})\n![b](/media/${"b".repeat(64)}-1x1.webp)`, origin)).toEqual({ id, alt: "A [figure] here" });
    expect(firstMediaImage(`![](${origin}${path} "title")`, origin)).toEqual({ id, alt: "" });
  });
  it("takes an image without alt text", () => {
    expect(firstMediaImage(`![](${path})`, origin)).toEqual({ id, alt: "" });
    expect(firstMediaImage(`![ ](<${path}>)`, origin)).toEqual({ id, alt: "" });
  });
  it("skips addresses whose image opener is beyond the bounded lookback", () => {
    for (const prefix of ["![", "[", ""]) {
      expect(firstMediaImage(`${prefix}${"long ".repeat(400)}](${path})`, origin)).toBeNull();
    }
  });
  it("skips a link to an address of the site, and an unclosed or nested bracket", () => {
    expect(firstMediaImage(`[a figure](${path})`, origin)).toBeNull();
    expect(firstMediaImage(`![a] b](${path})`, origin)).toBeNull();
    expect(firstMediaImage(`[a figure](${path})\n\n![b](/media/${"b".repeat(64)}-2x2.webp)`, origin)).toEqual({ id: "b".repeat(64), alt: "b" });
  });
  // The body is a member's, and this runs for every reader on the main thread: the time grows with the length, not with its square.
  it.each([
    ["unclosed image marks", "![".repeat(25_000)],
    ["image marks with addresses", "![a](".repeat(25_000)],
    ["many addresses", `![a](${path}x) `.repeat(3_000)],
    ["many addresses of images", `[x](${path}) `.repeat(3_000)],
    ["unclosed marks before an image", `${"![".repeat(24_000)}![b](${path})`],
  ])("reads %s in a short time", (_name, body) => {
    const started = performance.now();
    firstMediaImage(body, origin);
    expect(performance.now() - started).toBeLessThan(50);
  });
  it("skips images from other places and links that are not images", () => {
    expect(firstMediaImage(`![x](https://elsewhere.test${path})`, origin)).toBeNull();
    expect(firstMediaImage(`![x](https://elsewhere.test/a${path})`, origin)).toBeNull();
    expect(firstMediaImage(`[x](${path})`, origin)).toBeNull();
    expect(firstMediaImage(`![x](/media/short-1x1.webp)`, origin)).toBeNull();
    expect(firstMediaImage("no image", origin)).toBeNull();
  });
});

describe("RSS written by hand", () => {
  it("escapes the five characters and drops what XML 1.0 cannot hold", () => {
    expect(xmlText(`a & b < c > d "e" 'f'`)).toBe("a &amp; b &lt; c &gt; d &quot;e&quot; &apos;f&apos;");
    expect(xmlText("ok\u0000\u0008\u000b\u000c\u001f\ufffe\uffff\u0009\n\r")).toBe("ok\u0009\n\r");
    expect(xmlText("lone \ud800 surrogate and 😀")).toBe("lone  surrogate and 😀");
  });

  it("writes a channel and its items with permanent guids, and never leaves a raw angle bracket from a post", () => {
    const feed: Feed = {
      title: "T & <b>", link: "https://example.test/", description: "D", language: "ja", self: "https://example.test/feed.xml?lang=ja",
      items: [
        { title: "<script>alert(1)</script>", link: "https://example.test/t/2?lang=ja", pubDate: new Date("2026-10-02T00:00:00Z"), description: "]]> & more", creator: "@a", category: "V" },
        { title: "Older", link: "https://example.test/t/1", pubDate: new Date("2026-10-01T00:00:00Z"), description: "", creator: "@b" },
      ],
    };
    const xml = rssXml(feed);
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"')).toBe(true);
    expect(xml).toContain('<guid isPermaLink="true">https://example.test/t/2?lang=ja</guid>');
    expect(xml).toContain("<pubDate>Fri, 02 Oct 2026 00:00:00 GMT</pubDate>");
    expect(xml).toContain("<lastBuildDate>Fri, 02 Oct 2026 00:00:00 GMT</lastBuildDate>");
    expect(xml).toContain("<title>&lt;script&gt;alert(1)&lt;/script&gt;</title>");
    expect(xml).toContain("<description>]]&gt; &amp; more</description>");
    expect(xml).toContain("<language>ja</language>");
    expect(xml).toContain('<atom:link href="https://example.test/feed.xml?lang=ja" rel="self"');
    expect(xml).not.toContain("<script");
    expect(xml.match(/<category>/g)).toHaveLength(1);
  });

  it("writes a channel with no items", () => {
    const xml = rssXml({ title: "T", link: "https://example.test/", description: "D", self: "https://example.test/feed.xml", items: [] });
    expect(xml).not.toContain("<item>");
    expect(xml).not.toContain("lastBuildDate");
    expect(xml).not.toContain("<language>");
  });
});
