import { describe, expect, it } from "vitest";
import { quoteSource } from "~/lib/quote-reply";

describe("the line that says where a quotation comes from", () => {
  const reply = { kind: "reply", id: "42", handle: "ben", translated: false };

  it("links a reply on the first page without a page", () => {
    expect(quoteSource(reply, "7")).toMatch(/\]\(\/t\/7#c-42\)$/);
  });

  it("names the page a reply is on, so that the link lands on it", () => {
    expect(quoteSource(reply, "7", 3)).toMatch(/\]\(\/t\/7\?page=3#c-42\)$/);
  });

  it("links the post itself without a page", () => {
    expect(quoteSource({ ...reply, kind: "topic", id: "7" }, "7", 3)).toMatch(/\]\(\/t\/7#p-7\)$/);
  });

  it("gives nothing when the thread or the author is unknown", () => {
    expect(quoteSource(reply, null)).toBeNull();
    expect(quoteSource({ ...reply, handle: "" }, "7")).toBeNull();
  });
});
