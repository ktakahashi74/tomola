import { describe, expect, it } from "vitest";
import { firstBlockPlainText, markdownToPlainText, MAX_SOURCE_CHARS, plainExcerpt, truncateGraphemes } from "~/lib/plain-text.server";

describe("markdownToPlainText", () => {
  const cases: Array<[string, string, string]> = [
    ["heading marks", "## Question\n\nWhat is it?", "Question What is it?"],
    ["setext heading", "Title\n=====\n\nbody", "Title body"],
    ["emphasis, strong, strikethrough", "a *b* **c** ~~d~~ e", "a b c d e"],
    ["no spaces are added inside Japanese text around emphasis", "これは**重要**です。", "これは重要です。"],
    ["link text, not the URL", "see [the survey](https://example.org/s) now", "see the survey now"],
    ["image alt text", "![a diagram](https://example.org/a.png) shows it", "a diagram shows it"],
    ["reference links and definitions", "[text][r] here\n\n[r]: https://example.org/r", "text here"],
    ["bare URL keeps its text", "see https://example.org/x", "see https://example.org/x"],
    ["inline code keeps its text without the backticks", "use `exact_match` here", "use exact_match here"],
    ["fenced code keeps its text without the fences", "before\n\n```py\nprint(1)\n```\n\nafter", "before print(1) after"],
    ["tilde fence and unclosed fence", "~~~\na\n~~~\n\n```\nnever closed", "a never closed"],
    ["display math is dropped", "before\n\n$$\nE = mc^2\n$$\n\nafter", "before after"],
    ["a simple inline formula keeps its source without the dollars", "with $n$ samples", "with n samples"],
    ["an inline formula with a command or a brace is dropped", "when $\\frac{a}{b}$ and $x_{i}$ shrink", "when and shrink"],
    ["escaped dollars are text", "it costs \\$5", "it costs $5"],
    ["block quote and list marks", "> quoted\n\n- one\n- two\n\n1. three", "quoted one two three"],
    ["task list", "- [x] done\n- [ ] todo", "done todo"],
    ["table cells are separated", "| a | b |\n| - | - |\n| c | d |", "a b c d"],
    ["footnote reference and definition are dropped", "text[^1] more\n\n[^1]: the note", "text more"],
    ["inline HTML tags are dropped without a space, their text stays", "a <b>bold</b> word and <i>これは</i>です", "a bold word and これはです"],
    ["<br> and the tags of blocks become a space", "one<br>two<br/>three<p>four</p>five", "one two three four five"],
    ["a line-level HTML tag between Japanese words is a space too", "最初の行<br>次の行", "最初の行 次の行"],
    ["HTML block is dropped", "<div>\nhidden\n</div>\n\nshown", "shown"],
    ["currency is text, not math", "It costs $5 and $10 in total.", "It costs $5 and $10 in total."],
    ["currency next to real math", "From $5 to $10, then $x$ and $20.", "From $5 to $10, then x and $20."],
    ["a lone dollar is text", "pay $5 now", "pay $5 now"],
    ["math with inner spaces is still math when it does not start or end with one", "so $a + b$ holds", "so a + b holds"],
    ["thematic break", "a\n\n---\n\nb", "a b"],
    ["hard line break and CRLF", "a  \r\nb\r\n\r\nc", "a b c"],
    ["empty and whitespace", "  \n\n ", ""],
  ];
  it.each(cases)("%s", async (_name, md, expected) => {
    expect((await markdownToPlainText(md))).toBe(expected);
  });

  it("leaves no Markdown or math markup in a mixed post", async () => {
    const md = "## Question\n\nDoes **reward hacking** appear when $\\frac{a}{b}$ shrinks, with $n$ samples?\n\n$$\nE = mc^2\n$$\n\nSee [the survey](https://example.org/s).\n\n> quoted *text*[^1]\n\n[^1]: a note";
    const text = (await markdownToPlainText(md));
    expect(text).toBe("Question Does reward hacking appear when shrinks, with n samples? See the survey. quoted text");
    expect(text).not.toMatch(/[#*$\[\]\\>`]|\]\(|https?:/);
  });

  it("does not parse more than the first 4000 characters, and does not cut a surrogate pair", async () => {
    const long = `${"word ".repeat(10_000)}END`;
    expect((await markdownToPlainText(long))).not.toContain("END");
    expect((await markdownToPlainText(long)).length).toBeLessThanOrEqual(MAX_SOURCE_CHARS);
    const emoji = `${"a".repeat(MAX_SOURCE_CHARS - 1)}😀 tail`;
    const text = (await markdownToPlainText(emoji));
    expect(text).toBe("a".repeat(MAX_SOURCE_CHARS - 1));
    expect(text).not.toMatch(/[\ud800-\udfff]/);
  });
});

describe("plainExcerpt", () => {
  it("cuts the plain text to the limit with an ellipsis, and leaves a text that fits as it is", async () => {
    expect((await plainExcerpt("## " + "あ".repeat(10), 5))).toBe("あああああ…");
    expect((await plainExcerpt("short", 200))).toBe("short");
    expect((await plainExcerpt("x".repeat(200), 200))).toBe("x".repeat(200));
    expect((await plainExcerpt("x".repeat(201), 200))).toBe(`${"x".repeat(200)}…`);
  });

  it("counts grapheme clusters, so an emoji, a flag or a combining mark is never cut in the middle", async () => {
    const family = "👨‍👩‍👧"; // one grapheme, 8 UTF-16 units
    const flag = "🇯🇵";
    const accented = "e\u0301"; // e + combining acute: one grapheme
    expect((await plainExcerpt(family.repeat(3), 3))).toBe(family.repeat(3));
    expect((await plainExcerpt(family.repeat(4), 3))).toBe(`${family.repeat(3)}…`);
    expect((await plainExcerpt(flag.repeat(5), 2))).toBe(`${flag.repeat(2)}…`);
    expect((await plainExcerpt(accented.repeat(5), 4))).toBe(`${accented.repeat(4)}…`);
    expect((await plainExcerpt(`**${"😀".repeat(3)}**`, 3))).toBe("😀😀😀");
    // no lone surrogate or lone combining mark at the cut
    const cut = (await plainExcerpt(`${family}${accented}${flag}`.repeat(10), 7));
    expect(cut).not.toMatch(/[\ud800-\udbff]…$/);
    expect(cut.endsWith("…")).toBe(true);
  });
});

describe("firstBlockPlainText and truncateGraphemes (the headline of a topic without a title)", () => {
  it("gives the first block that has text, with the same rules as markdownToPlainText", async () => {
    expect((await firstBlockPlainText("## Question\n\nWhat is it?"))).toBe("Question");
    expect((await firstBlockPlainText("![](a.png)\n\nThe [caption](https://example.org) $5 and $10"))).toBe("The caption $5 and $10");
    expect((await firstBlockPlainText("- one\n- two"))).toBe("one");
    expect((await firstBlockPlainText("> quoted\n> still\n\nafter"))).toBe("quoted still");
    expect((await firstBlockPlainText("```\n\n  # code\nmore\n```"))).toBe("# code");
    expect((await firstBlockPlainText("![](a.png)"))).toBe("");
    expect((await firstBlockPlainText(""))).toBe("");
  });

  it("falls back to the first line of a display formula only when nothing else has text", async () => {
    expect((await firstBlockPlainText("$$\nx^2 + y^2\n$$"))).toBe("x^2 + y^2");
    expect((await firstBlockPlainText("$$\nx^2\n$$\n\nText"))).toBe("Text");
  });

  it("cuts by grapheme clusters, and drops the white space before the ellipsis only when asked", () => {
    expect(truncateGraphemes("ab cdef", 3)).toBe("ab …");
    expect(truncateGraphemes("ab cdef", 3, { trimEnd: true })).toBe("ab…");
    expect(truncateGraphemes("abc", 3)).toBe("abc");
    expect(truncateGraphemes("สวัสดี", 3)).toBe("สวัส…");
  });
});
