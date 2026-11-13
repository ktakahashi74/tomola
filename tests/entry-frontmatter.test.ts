import { describe, expect, it } from "vitest";
import { ENTRY_KEYS, extractFrontmatter, extractPasted, hasEntryKeys, interpretFrontmatter, MAX_FRONTMATTER_LENGTH, parseMapping, splitFrontmatter } from "~/lib/entry-frontmatter.server";

describe("splitFrontmatter", () => {
  it("cuts the leading --- block, closed by --- or ..., with LF or CRLF and a BOM", () => {
    expect(splitFrontmatter("---\na: 1\n---\nbody")).toEqual({ found: true, raw: "a: 1", body: "body", closed: true });
    expect(splitFrontmatter("---\na: 1\n...\nbody")).toMatchObject({ raw: "a: 1", body: "body" });
    expect(splitFrontmatter("---\r\na: 1\r\nb: 2\r\n---\r\nbody")).toMatchObject({ raw: "a: 1\r\nb: 2", body: "body" });
    expect(splitFrontmatter("﻿---\na: 1\n---\nx")).toMatchObject({ found: true, raw: "a: 1" });
    expect(splitFrontmatter("---  \na: 1\n---  \nx")).toMatchObject({ raw: "a: 1", body: "x" });
    expect(splitFrontmatter("---\n---\nx")).toEqual({ found: true, raw: "", body: "x", closed: true });
    expect(splitFrontmatter("---\na: 1\n---")).toMatchObject({ raw: "a: 1", body: "", closed: true });
  });
  it("finds nothing unless the text starts with a --- line, and reports a block that is not closed", () => {
    for (const text of ["", "body", "\n---\na: 1\n---", "----\na: 1\n---", "--- a\nb\n---", " ---\na: 1\n---", "text\n---\na: 1\n---"]) expect(splitFrontmatter(text).found, JSON.stringify(text)).toBe(false);
    expect(splitFrontmatter("---\na: 1\nbody")).toMatchObject({ found: true, closed: false });
  });
  it("closes at the first fence line, so a later --- stays in the body", () => {
    expect(splitFrontmatter("---\na: 1\n---\nbody\n---\nmore")).toMatchObject({ raw: "a: 1", body: "body\n---\nmore" });
  });
});

describe("parseMapping", () => {
  it("reads a mapping and treats empty and null as an empty mapping", async () => {
    expect((await parseMapping("a: 1\nb: [x, y]"))).toEqual({ ok: true, data: { a: 1, b: ["x", "y"] } });
    expect((await parseMapping(""))).toEqual({ ok: true, data: {} });
    expect((await parseMapping("null"))).toEqual({ ok: true, data: {} });
    expect((await parseMapping("# only a comment"))).toEqual({ ok: true, data: {} });
  });
  it("rejects a non-mapping, bad syntax, duplicate keys, aliases, oversized and absurdly nested input", async () => {
    for (const raw of ["- a\n- b", "text", "42", "true"]) expect((await parseMapping(raw)), raw).toEqual({ ok: false, error: "frontmatter_not_object" });
    for (const raw of ["a: [", "a: 1\na: 2", "a: &x 1\nb: *x", "a: b: c", "\t- x", "a: 'unterminated"]) expect((await parseMapping(raw)), raw).toEqual({ ok: false, error: "invalid_frontmatter" });
    expect((await parseMapping(`a: ${"x".repeat(MAX_FRONTMATTER_LENGTH)}`))).toEqual({ ok: false, error: "invalid_frontmatter" });
    expect((await parseMapping("a: " + "[".repeat(30_000)))).toEqual({ ok: false, error: "invalid_frontmatter" });
  });
  it("does not evaluate tags", async () => {
    expect((await parseMapping("a: !!js/function 'function(){}'"))).toMatchObject({ ok: true, data: { a: "function(){}" } });
  });
});

describe("interpretFrontmatter", () => {
  const ok = (data: Record<string, unknown>) => {
    const res = interpretFrontmatter(data);
    if (!res.ok) throw new Error(res.error);
    return res.declared;
  };
  it("reads type, title, lang, ai_assistance and reply_to, and ignores other keys", () => {
    expect(ok({ type: "topic", title: "T", lang: "ja", ai_assistance: "polish", author: "@x", thread: "p-1" })).toEqual({ kind: "topic", explicitType: "topic", title: "T", lang: "ja", aiAssistance: "polish", replyTo: undefined });
    expect(ok({ type: "reply", reply_to: "c-12" })).toMatchObject({ kind: "reply", replyTo: { kind: "reply", id: 12 } });
    expect(ok({ reply_to: "p-3" })).toMatchObject({ kind: "reply", replyTo: { kind: "topic", id: 3 } });
    expect(ok({})).toEqual({ kind: "topic", explicitType: undefined, replyTo: undefined });
    expect(ok({ lang: "other" })).toMatchObject({ lang: "other" });
  });
  it("accepts the Markdown twin's post and comment, and treats null as absent", () => {
    expect(ok({ type: "post", title: "T", reply_to: null, lang: null, ai_assistance: null }).kind).toBe("topic");
    expect(ok({ type: "comment", reply_to: "c-1" }).kind).toBe("reply");
  });
  it("coerces a scalar title and rejects the rest", () => {
    expect(ok({ title: 2026 }).title).toBe("2026");
    expect(ok({ title: true }).title).toBe("true");
    expect(interpretFrontmatter({ title: { a: 1 } })).toEqual({ ok: false, error: "invalid_title" });
    expect(interpretFrontmatter({ title: ["a"] })).toEqual({ ok: false, error: "invalid_title" });
  });
  it("names each problem", () => {
    const err = (data: Record<string, unknown>) => (interpretFrontmatter(data) as { error: string }).error;
    expect(err({ type: "note" })).toBe("unknown_type");
    expect(err({ type: 1 })).toBe("unknown_type");
    expect(err({ type: "toString" })).toBe("unknown_type");
    expect(err({ type: "topic", reply_to: "p-1" })).toBe("reply_to_on_topic");
    expect(err({ type: "reply" })).toBe("reply_to_required");
    for (const reply_to of ["x-1", "p-", "p-0", "c-01", "p-1.5", 5, ["p-1"], "p-1 ", "P-1", "p-99999999999999999"]) {
      const res = interpretFrontmatter({ reply_to });
      // Allow surrounding whitespace ("p-1 ").
      if (reply_to === "p-1 ") expect(res.ok).toBe(true);
      else expect(res, String(reply_to)).toEqual({ ok: false, error: "reply_to_malformed" });
    }
    expect(err({ lang: "xx" })).toBe("invalid_lang");
    expect(err({ ai_assistance: "all" })).toBe("invalid_ai");
    expect(err({ ai_assistance: 1 })).toBe("invalid_ai");
  });
});

describe("interpretFrontmatter: the question attributes", () => {
  it("reads asks_stance (a YAML boolean only), alt_of (p-<id> only) and stance_tag (the four values only)", () => {
    expect(interpretFrontmatter({ asks_stance: true, alt_of: "p-12" })).toMatchObject({ ok: true, declared: { kind: "topic", asksStance: true, altOf: 12 } });
    expect(interpretFrontmatter({ asks_stance: false })).toMatchObject({ ok: true, declared: { asksStance: false } });
    expect(interpretFrontmatter({ reply_to: "p-1", stance_tag: "objection" })).toMatchObject({ ok: true, declared: { kind: "reply", stanceTag: "objection" } });
    // Allow surrounding whitespace, as with reply_to.
    expect(interpretFrontmatter({ alt_of: " p-3 ", asks_stance: true })).toMatchObject({ ok: true, declared: { altOf: 3 } });
    // null is equivalent to absence.
    expect(interpretFrontmatter({ asks_stance: null, alt_of: null, stance_tag: null })).toEqual({ ok: true, declared: { kind: "topic", explicitType: undefined, replyTo: undefined } });
    const err = (data: Record<string, unknown>) => (interpretFrontmatter(data) as { error: string }).error;
    for (const asks_stance of ["true", "yes", 1, 0, [], {}]) expect(err({ asks_stance }), String(asks_stance)).toBe("invalid_asks_stance");
    for (const alt_of of ["c-1", "p-0", "p-01", "p-1.5", "12", 12, "P-1", ["p-1"], "p-99999999999999999"]) expect(err({ alt_of }), String(alt_of)).toBe("invalid_alt_of");
    for (const stance_tag of ["maybe", "AGREE", "", 1, true, ["agree"]]) expect(err({ reply_to: "p-1", stance_tag }), String(stance_tag)).toBe("invalid_stance_tag");
  });

  it("refuses an attribute that does not fit the kind when the kind is known: a reply that asks or points, a topic with a mark", () => {
    const err = (data: Record<string, unknown>, opts?: { requireReplyTo?: boolean }) => {
      const res = interpretFrontmatter(data, opts);
      return res.ok ? "ok" : res.error;
    };
    expect(err({ type: "comment", reply_to: "p-1", asks_stance: true })).toBe("invalid_asks_stance");
    expect(err({ reply_to: "c-1", alt_of: "p-2" })).toBe("invalid_alt_of");
    expect(err({ type: "post", stance_tag: "agree" })).toBe("invalid_stance_tag");
    // In the API, missing both type and reply_to means topic.
    expect(err({ stance_tag: "agree" })).toBe("invalid_stance_tag");
    // In pasted forms, the form decides the kind, not frontmatter alone. Do not reject here; form validation checks kind mismatches.
    expect(err({ stance_tag: "agree" }, { requireReplyTo: false })).toBe("ok");
    expect(err({ asks_stance: true }, { requireReplyTo: false })).toBe("ok");
    expect(err({ type: "post", stance_tag: "agree" }, { requireReplyTo: false })).toBe("invalid_stance_tag");
    // asks_stance: false on a reply is harmless.
    expect(err({ reply_to: "p-1", asks_stance: false })).toBe("ok");
  });
});

describe("extractFrontmatter", () => {
  it("strict (API): errors for unterminated, unreadable and non-mapping frontmatter", async () => {
    expect((await extractFrontmatter("---\na: 1\nbody", { strict: true }))).toEqual({ ok: false, error: "invalid_frontmatter" });
    expect((await extractFrontmatter("---\na: [\n---\nbody", { strict: true }))).toEqual({ ok: false, error: "invalid_frontmatter" });
    expect((await extractFrontmatter("---\n- a\n---\nbody", { strict: true }))).toEqual({ ok: false, error: "frontmatter_not_object" });
    expect((await extractFrontmatter("plain", { strict: true }))).toEqual({ ok: true, found: false, body: "plain" });
  });
  it("lenient (pasted into a form): keeps unreadable frontmatter as body text, unchanged", async () => {
    for (const text of ["---\na: 1\nbody", "---\na: [\n---\nbody", "---\n- a\n---\nbody", "---\ntext\n---\nbody", "---\n---\n"]) {
      const res = (await extractFrontmatter(text, { strict: false }));
      if (text === "---\n---\n") expect(res).toMatchObject({ ok: true, found: true, data: {} });
      else expect(res, text).toEqual({ ok: true, found: false, body: text });
    }
  });
  it("returns the mapping, the raw text and the body without the frontmatter and leading blank lines", async () => {
    expect((await extractFrontmatter("---\ntitle: T\n---\n\n\nBody\n", { strict: true }))).toEqual({ ok: true, found: true, raw: "title: T", data: { title: "T" }, body: "Body\n" });
  });
});

describe("hasEntryKeys and extractPasted", () => {
  it("knows the post's keys, and only those", () => {
    expect([...ENTRY_KEYS]).toEqual(["type", "title", "lang", "reply_to", "ai_assistance", "asks_stance", "alt_of", "stance_tag", "id", "thread", "content_trust"]);
    for (const key of ENTRY_KEYS) expect(hasEntryKeys({ [key]: 1 }), key).toBe(true);
    for (const data of [{}, { Q: "x", A: "y" }, { Title: "x" }, { name: "x" }, { toString: 1 }, { constructor: 1 }]) expect(hasEntryKeys(data as Record<string, unknown>), JSON.stringify(data)).toBe(false);
  });
  it("treats a mapping with a post key as pasted frontmatter, and everything else as body", async () => {
    expect((await extractPasted("---\ntitle: T\n---\nbody"))).toEqual({ pasted: true, data: { title: "T" }, raw: "title: T", body: "body" });
    for (const text of ["---\nQ: x\nA: y\n---\nbody", "---\n---\nbody", "---\n- a\n---\nbody", "---\ntitle: [\n---\nbody", "plain", "---\ntitle: T\nbody"]) {
      expect((await extractPasted(text)), text).toEqual({ pasted: false });
    }
  });
});
