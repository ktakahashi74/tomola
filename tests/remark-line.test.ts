import { expect, it } from "vitest";
import { remarkLine } from "~/lib/remark-line";

it("names an address by its place and the end of its path, and leaves other text alone", () => {
  expect(remarkLine("https://www.lesswrong.com/posts/abc/a-critical-look-at-lean4-1")).toBe("lesswrong.com › a-critical-look-at-lean4-1");
  expect(remarkLine("https://example.org/")).toBe("example.org");
  expect(remarkLine("https://example.org/%E6%97%A5%E6%9C%AC")).toBe("example.org › 日本");
  expect(remarkLine("はじめまして。https://example.org/x を読んでください。")).toBe("はじめまして。https://example.org/x を読んでください。");
  expect(remarkLine("https://example.org/a と https://example.org/b")).toBe("https://example.org/a と https://example.org/b");
  expect(remarkLine("")).toBe("");
});
