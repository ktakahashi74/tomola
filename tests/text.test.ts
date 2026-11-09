import { describe, expect, it } from "vitest";
import { readEntryForm } from "~/lib/entry-form.server";
import { normalizeNewlines } from "~/lib/text";

describe("normalizeNewlines", () => {
  it("turns CRLF into LF and leaves everything else alone", () => {
    expect(normalizeNewlines("a\r\nb\r\n\r\nc")).toBe("a\nb\n\nc");
    expect(normalizeNewlines("a\nb")).toBe("a\nb");
    expect(normalizeNewlines("  indented \t\r\n  text  ")).toBe("  indented \t\n  text  ");
    expect(normalizeNewlines("")).toBe("");
  });

  it("keeps a lone CR (it is not a browser form newline)", () => {
    expect(normalizeNewlines("a\rb")).toBe("a\rb");
  });
});

describe("readEntryForm", () => {
  it("normalizes newlines in the title and body of a web form", () => {
    const form = new FormData();
    form.set("title", "line1\r\nline2");
    form.set("body", "one\r\n\r\ntwo\r\n");
    form.set("lang", "ja");
    // The form has no AI-assistance field: a posted aiAssistance is not read.
    form.set("aiAssistance", "draft");
    expect(readEntryForm(form)).toEqual({
      title: "line1\nline2",
      body: "one\n\ntwo\n",
      lang: "ja",
      asksStance: false,
      altOf: null,
      stanceTag: null,
    });
  });

  it("reads the question attributes: the checkbox asksStance=1, the hidden altOf (a non-number stays NaN so the service refuses it) and the chosen stanceTag (empty is none)", () => {
    const form = new FormData();
    form.set("asksStance", "1");
    form.set("altOf", " 12 ");
    form.set("stanceTag", "objection");
    expect(readEntryForm(form)).toMatchObject({ asksStance: true, altOf: 12, stanceTag: "objection" });
    const bad = new FormData();
    bad.set("asksStance", "on");
    bad.set("altOf", "abc");
    bad.set("stanceTag", "");
    const read = readEntryForm(bad);
    expect(read.asksStance).toBe(false);
    expect(Number.isNaN(read.altOf)).toBe(true);
    expect(read.stanceTag).toBeNull();
  });

  it("fills missing fields with empty strings", () => {
    expect(readEntryForm(new FormData())).toEqual({ title: "", body: "", lang: "", asksStance: false, altOf: null, stanceTag: null });
  });
});
