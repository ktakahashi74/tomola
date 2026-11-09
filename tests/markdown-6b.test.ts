import { describe, expect, it, vi } from "vitest";
import { mediaImage, renderMarkdown, RENDER_VERSION } from "~/lib/markdown.server";

// Use real messages for footnotes (the default test messages are empty, falling back to English).
vi.mock("~/paraglide/messages.js", async () => ({ m: (await import("./helpers/messages-json")).jsonMessages() }));

describe("external images become links", () => {
  it("turns an image from another origin into a link with the alt text, so the reader's browser never fetches it", async () => {
    const html = (await renderMarkdown("![a cat](https://cdn.example.net/cat.png)"));
    expect(html).not.toContain("<img");
    expect(html).toContain('<a href="https://cdn.example.net/cat.png" rel="nofollow noopener noreferrer">a cat</a>');
  });

  it("uses the URL as the text when there is no alt text, and drops the title", async () => {
    const html = (await renderMarkdown('![](http://tracker.example.net/p.gif "hello")'));
    expect(html).not.toContain("<img");
    expect(html).not.toContain("title=");
    expect(html).toContain('<a href="http://tracker.example.net/p.gif" rel="nofollow noopener noreferrer">http://tracker.example.net/p.gif</a>');
  });

  it("does not nest a link in a link: an image inside a link becomes its text", async () => {
    const html = (await renderMarkdown("[![alt text](https://cdn.example.net/x.png)](https://example.org/page)"));
    expect(html).not.toContain("<img");
    expect((html.match(/<a /g) ?? []).length).toBe(1);
    expect(html).toContain('<a href="https://example.org/page">alt text</a>');
  });

  it("turns a reference-style image and a protocol-relative one into links, too", async () => {
    expect((await renderMarkdown("![x][r]\n\n[r]: https://cdn.example.net/r.png"))).toContain('href="https://cdn.example.net/r.png"');
    const html = (await renderMarkdown("![y](//cdn.example.net/y.png)"));
    expect(html).not.toContain("<img");
  });

  it("blocks data: images (the sanitizer drops the src), leaving only the alt text", async () => {
    const html = (await renderMarkdown("![inline](data:image/png;base64,iVBORw0KGgo=)"));
    expect(html).not.toContain("<img");
    expect(html).not.toContain("data:");
    expect(html).toContain("inline");
  });

  it("only renders managed media paths, with dimensions and deferred decoding", async () => {
    const src = `/media/${"a".repeat(64)}-120x80.webp`;
    const html = (await renderMarkdown(`![diagram](${src})`));
    expect(html).toContain(`<img src="${src}" alt="diagram" width="120" height="80" loading="lazy" decoding="async">`);
    vi.stubEnv("BETTER_AUTH_URL", "https://forum.example.org");
    try {
      expect((await renderMarkdown(`![diagram](https://forum.example.org${src})`))).toContain("<img ");
      for (const path of ["/assets/logo.png", "/logout", "/media/bad-120x80.webp", `${src}?extra=1`, `https://other.example${src}`]) {
        expect((await renderMarkdown(`![diagram](${path})`))).not.toContain("<img");
      }
    } finally { vi.unstubAllEnvs(); }
  });

  it("accepts the exact media path at the site's origin", () => {
    const src = `/media/${"a".repeat(64)}-120x80.webp`;
    expect(mediaImage(src, "https://f.example")).toMatchObject({ width: 120, height: 80 });
    expect(mediaImage(`https://f.example${src}`, "https://f.example")).not.toBeNull();
    for (const href of ["/a.png", "a.png", `//f.example${src}`, `https://f.example:8443${src}`, `ftp://f.example${src}`, `${src}#hash`, `${src}?q=1`]) {
      expect(mediaImage(href, "https://f.example")).toBeNull();
    }
  });

  it("renders at most thirty images and leaves subsequent ones as links", async () => {
    const src = `/media/${"a".repeat(64)}-120x80.webp`;
    const html = (await renderMarkdown(Array.from({ length: 32 }, (_, i) => `![figure ${i}](${src})`).join("\n\n")));
    expect((html.match(/<img /g) ?? []).length).toBe(30);
    expect(html).toContain('>figure 30</a>');
    expect(html).toContain('>figure 31</a>');
  });

  it("rejects noncanonical paths, dimensions and absolute URLs without normalizing them into images", async () => {
    const src = `/media/${"a".repeat(64)}-120x80.webp`;
    vi.stubEnv("BETTER_AUTH_URL", "https://forum.example.org");
    try {
      const invalid = [src.replace("/media/", "/MEDIA/"), src.replace(".webp", ".WEBP"), src.replace("/media/", "/media/../media/"), `${src}?x`, `${src}#x`, ...["0x80", "120x0", "2001x80", "120x2001", "99999999999999999999x80", "120x99999999999999999999", "01x80", "1.5x80"].map(d => src.replace("120x80", d))];
      for (const href of invalid.flatMap(href => [href, `https://forum.example.org${href}`])) {
        expect((await renderMarkdown(`![figure](${href})`)), href).not.toContain("<img");
        expect(mediaImage(href, "https://forum.example.org"), href).toBeNull();
      }
      expect((await renderMarkdown(`![figure](${src.replace("120x80", "2000x2000")})`))).toContain("<img");
      expect((await renderMarkdown(`![figure](${src.replace("120x80", "1x1")})`))).toContain("<img");
    } finally { vi.unstubAllEnvs(); }
  });

  it("changes the rendering, so the render version is above 1 and the caches render again", () => {
    expect(RENDER_VERSION).toBeGreaterThanOrEqual(2);
  });
});

describe("the fixed footnote strings follow the language of the text", () => {
  const md = "text[^1] and more[^1]\n\n[^1]: note";
  const label = (html: string) => html.match(/<h2[^>]*id="[^"]*footnote-label"[^>]*>([^<]*)<\/h2>/)?.[1];
  const back = (html: string) => [...html.matchAll(/aria-label="([^"]*)"/g)].map((x) => x[1]);

  it("is English without a language, and for a language that is not a UI language", async () => {
    expect(label((await renderMarkdown(md)))).toBe("Footnotes");
    expect(back((await renderMarkdown(md)))).toEqual(["Back to reference 1", "Back to reference 1-2"]);
    expect(label((await renderMarkdown(md, { lang: "xx" })))).toBe("Footnotes");
  });

  it("uses the message of the text's language, with the reference index in it", async () => {
    expect(label((await renderMarkdown(md, { lang: "ja" })))).toBe("脚注");
    expect(back((await renderMarkdown(md, { lang: "ja" })))).toEqual(["参照 1 に戻る", "参照 1-2 に戻る"]);
    // Different idPrefix values retain the same footnote language.
    expect(label((await renderMarkdown(md, { lang: "ja", idPrefix: "p-1-" })))).toBe("脚注");
    expect(label((await renderMarkdown(md, { lang: "en", idPrefix: "p-1-" })))).toBe("Footnotes");
  });
});
