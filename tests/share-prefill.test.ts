import { describe, expect, it } from "vitest";
import { sharePrefill } from "~/lib/share-prefill";

const prefill = (values: Record<string, string>) => sharePrefill(new URLSearchParams(values));

describe("browser-supplied shared text", () => {
  it("creates a short-post body with an empty title and space for the member's note", () => {
    expect(prefill({ url: "https://example.org/a", title: "Example" })).toEqual({ title: "", body: "[Example](https://example.org/a)\n\n" });
  });

  it("escapes Markdown labels, removes invisible controls, and encodes destination parentheses and whitespace", () => {
    expect(prefill({ url: "https://example.org/a(b) c", title: "[A]\u2028\\\u2029B\n\r\u202e\u2066\u200b\u0000" })?.body)
      .toBe("[\\[A\\]\\\\B](https://example.org/a%28b%29%20c)\n\n");
  });

  it("ignores non-HTTP, relative, malformed and over-limit URLs instead of treating them as a post", () => {
    for (const url of ["javascript:alert(1)", "data:text/html,hi", "/t/1", "https://", "https://example.org/\nnext", `https://example.org/${"a".repeat(2000)}`]) {
      expect(prefill({ url, title: "Unsafe", text: "https://safe.example/a" }), url).toBeNull();
    }
    expect(prefill({ title: "Only a title", text: "Only text" })).toBeNull();
  });

  it("extracts only the first URL from Android text and quotes the remaining text line by line", () => {
    expect(prefill({ text: "読んでみて https://example.org/a\n次の文 https://example.net/b" }))
      .toEqual({ title: "", body: "[https://example.org/a](https://example.org/a)\n\n> 読んでみて \n> 次の文 https://example.net/b\n\n" });
  });

  it("keeps quote newlines but removes control and zero-width characters", () => {
    expect(prefill({ url: "https://example.org/a", title: "Example", text: "first\r\nsecond\t\u200d\u202a" })?.body)
      .toBe("[Example](https://example.org/a)\n\n> first\n> second\n\n");
  });

  it("omits duplicate title or URL text and falls back to the URL for an empty title", () => {
    for (const text of ["Example", "https://example.org/a"]) {
      expect(prefill({ url: "https://example.org/a", title: "Example", text })?.body).toBe("[Example](https://example.org/a)\n\n");
    }
    expect(prefill({ url: "https://example.org/a", title: "\u200b\n" })?.body).toBe("[https://example.org/a](https://example.org/a)\n\n");
    expect(prefill({ url: "https://example.org/a", title: "one\ntwo", text: "one\ntwo" })?.body).toBe("[onetwo](https://example.org/a)\n\n");
    const longUrl = `https://example.org/${"a".repeat(1100)}`;
    expect(prefill({ url: longUrl, text: longUrl })?.body).toBe(`[${longUrl}](${longUrl})\n\n`);
    const longTitle = "a".repeat(301);
    expect(prefill({ url: "https://example.org/a", title: longTitle, text: longTitle })?.body).toBe(`[${"a".repeat(300)}](https://example.org/a)\n\n`);
  });

  it("caps title and quote characters without splitting a supplementary character", () => {
    const body = prefill({ url: "https://example.org/a", title: "😀".repeat(301), text: "文".repeat(1001) })!.body;
    expect(body).toBe(`[${"😀".repeat(300)}](https://example.org/a)\n\n> ${"文".repeat(1000)}\n\n`);
  });
});
