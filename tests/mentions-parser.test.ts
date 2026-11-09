import { remarkMentions } from "~/lib/mentions-md.core.server";
import { describe, expect, it } from "vitest";
import {
  isMentionQuery,
  mentionCandidates,
  mentionQueryAt,
  tokenPrefixes,
  withoutResolvedMentions,
} from "~/lib/mention-syntax";
import { matchMentions, mentionTokens, splitMentions, type MentionTargets } from "~/lib/mentions-md.server";
import { handleKey } from "~/lib/handles";

// The parser of @mentions: the character rules (mention-syntax.ts) and the rules on the Markdown syntax tree (mentions-md.server.ts).
const targets = (...handles: string[]): MentionTargets =>
  new Map(handles.map((h, i) => [handleKey(h), { handle: h, userId: `u-${h}`, publicId: i.toString(36).padStart(12, "0") }]));

const names = async (md: string, t: MentionTargets) => (await matchMentions(md, t)).map((m) => m.text);

describe("mentionCandidates (character rules)", () => {
  it.each([
    ["@hana", ["hana"]],
    ["hi @hana", ["hana"]],
    ["(@hana)", ["hana"]],
    ["「@hana」", ["hana"]],
    ["こんにちは@hanaさん", ["hana"]],
    ["全角＠hana", ["hana"]],
    ["@hana。", ["hana"]],
    ["@hana.", ["hana"]],
    ["@hana, @ben", ["hana", "ben"]],
    ["@a", []],
    ["@", []],
    ["@ hana", []],
    ["a@b.com", []],
    ["x@hana", []],
    ["x_@hana", []],
    ["a.b+c@hana", []],
    ["@@hana", []],
    ["@hana@ben", ["hana"]],
    ["@はな", []],
    ["@하나", []],
    ["@hana-san", ["hana-san"]],
    ["@hana_b", ["hana_b"]],
    ["です@hana", ["hana"]],
    ["＠ＨＡＮＡさん", ["ＨＡＮＡ"]],
    ["@_hana", []],
  ])("%j gives %j", (text, tokens) => {
    expect(mentionCandidates(text).map((c) => c.token)).toEqual(tokens);
  });

  it("gives the positions of the sigil and the end of the run", () => {
    expect(mentionCandidates("ab @cd ef")).toEqual([{ start: 3, end: 6, token: "cd" }]);
  });

  it("takes at most 30 characters of the run", () => {
    const [c] = mentionCandidates(`@${"a".repeat(40)}`);
    expect(Array.from(c.token)).toHaveLength(30);
  });

  it("rejects non-ASCII handles but allows a sigil after a character outside the BMP", () => {
    expect(mentionCandidates("@𠮷野家")).toEqual([]);
    expect(mentionCandidates("𠮷@hana")).toHaveLength(1);
  });
});

describe("tokenPrefixes", () => {
  it("is longest first, 2 characters or more", () => {
    expect(tokenPrefixes("hana-san")).toEqual(["hana-san", "hana-sa", "hana-s", "hana-", "hana", "han", "ha"]);
    expect(tokenPrefixes("ab")).toEqual(["ab"]);
  });
});

describe("withoutResolvedMentions", () => {
  it("removes the sigil and the run, keeps the rest", () => {
    expect(withoutResolvedMentions("Hello @hana and ＠ben, thanks a@b.com", ["@hana", "@ben"])).toBe("Hello  and , thanks a@b.com");
    expect(withoutResolvedMentions("no names", ["@hana"])).toBe("no names");
  });

  it("keeps unresolved candidates and removes only the resolved handle before Japanese prose", () => {
    const text = "@hanaこの文章は翻訳されるべき重要な日本語の説明内容です";
    expect(withoutResolvedMentions(text)).toBe(text);
    expect(withoutResolvedMentions(text, ["@hana"])).toBe("この文章は翻訳されるべき重要な日本語の説明内容です");
    expect(withoutResolvedMentions("＠ＨＡＮＡさん @unknown", ["@hana"])).toBe("さん @unknown");
  });
});

describe("mentionQueryAt (what is being typed)", () => {
  it.each([
    ["hello @ha", { start: 6, query: "ha" }],
    ["@h", { start: 0, query: "h" }],
    ["日本語＠ＨＡ", { start: 3, query: "ＨＡ" }],
    ["@HA", { start: 0, query: "HA" }],
    ["@はな", null],
    ["@ha.na", null],
    ["hello @", null],
    ["hello @ha ", null],
    ["a@ha", null],
    ["hello", null],
    ["@.ha", null],
  ])("%j", (text, expected) => {
    expect(mentionQueryAt(text)).toEqual(expected);
  });

  it("checks a query for the endpoint", () => {
    expect(isMentionQuery("ha")).toBe(true);
    expect(isMentionQuery("h")).toBe(true);
    expect(isMentionQuery("")).toBe(false);
    expect(isMentionQuery("a b")).toBe(false);
    expect(isMentionQuery("a%")).toBe(false);
    expect(isMentionQuery(".a")).toBe(false);
    expect(isMentionQuery("ha.na")).toBe(false);
    expect(isMentionQuery("はな")).toBe(false);
    expect(isMentionQuery("HA")).toBe(false);
    expect(isMentionQuery("ＨＡ")).toBe(false);
    expect(isMentionQuery("ha-na_b")).toBe(true);
    expect(isMentionQuery("a".repeat(31))).toBe(false);
  });
});

describe("matchMentions on the syntax tree", () => {
  const t = targets("hana", "ben", "akira", "minji", "hanako");

  it("finds a mention at the start of a text, after a space, after Japanese text", async () => {
    expect((await names("@hana hello", t))).toEqual(["@hana"]);
    expect((await names("hello @hana", t))).toEqual(["@hana"]);
    expect((await names("こんにちは@hanaさん", t))).toEqual(["@hana"]);
  });

  it("takes the longest handle that exists", async () => {
    // @hanako is a member: the longer handle wins over "hana".
    expect((await matchMentions("@hanakoさん", t)).map((m) => [m.text, m.handle])).toEqual([["@hanako", "hanako"]]);
    // Without hanako, the shorter member is named.
    expect((await matchMentions("@hanakoさん", targets("hana"))).map((m) => [m.text, m.handle])).toEqual([["@hana", "hana"]]);
  });

  it("names a member before a full stop or a Japanese full stop", async () => {
    expect((await names("thanks @hana.", t))).toEqual(["@hana"]);
    expect((await names("ありがとう@hana。", t))).toEqual(["@hana"]);
  });

  it("stops the handle at a full stop and prefers the longest valid ASCII suffix", async () => {
    expect((await names("@hana.", targets("hana", "hana.")))).toEqual(["@hana"]);
    expect((await names("@hana-sanさん", targets("hana", "hana-san")))).toEqual(["@hana-san"]);
    expect((await names("@hana-sanさん", targets("hana")))).toEqual(["@hana"]);
  });

  it("accepts the full-width sigil, upper case and full-width letters", async () => {
    expect((await matchMentions("＠hana @HANA ＠ＨＡＮＡ", t)).map((m) => m.text)).toEqual(["＠hana"]);
    expect((await matchMentions("＠ＢＥＮ", t))).toMatchObject([{ text: "＠ＢＥＮ", handle: "ben", key: "ben" }]);
  });

  it("keeps the characters of the source", async () => {
    expect((await matchMentions("@HaNa", t))).toMatchObject([{ text: "@HaNa", handle: "hana" }]);
  });

  it("rejects handles in other scripts even when supplied as targets", async () => {
    expect((await names("@はな さん @하나", targets("はな", "하나")))).toEqual([]);
    expect((await names("です@hana", t))).toEqual(["@hana"]);
  });

  it("does not name members that do not exist", async () => {
    expect((await names("@nobody @ben", t))).toEqual(["@ben"]);
    expect((await matchMentions("@ben", new Map()))).toEqual([]);
  });

  it("is not a mention in an e-mail address or in the middle of an ASCII word", async () => {
    expect((await names("write to ben@hana.com or x@ben", t))).toEqual([]);
  });

  it("does not count code, math, HTML, link text, link targets, images, definitions", async () => {
    const md = [
      "`@hana` inline code",
      "",
      "```",
      "@hana in a fence",
      "```",
      "",
      "    @hana in an indented block",
      "",
      "$@hana$ is inline math",
      "",
      "$$\n@hana\n$$",
      "",
      "<!-- @hana --> and an inline <!-- @hana --> comment",
      "",
      "[@hana](https://example.com/@hana) and <https://example.com/@hana> and https://example.com/@hana and hana@example.com",
      "",
      "![@hana](https://example.com/@hana.png) ![ref @hana][img]",
      "",
      "[ref]: https://example.com/@hana",
      "[img]: https://example.com/a.png",
    ].join("\n");
    // The text outside the code has no sigil. (The tags of raw HTML are dropped by the renderer; the text between two tags is ordinary text.)
    expect((await names(md, t))).toEqual([]);
  });

  it("counts headings, tables, lists, emphasis and footnotes", async () => {
    const md = ["# Title @hana", "", "| a | b |", "|---|---|", "| @ben | x |", "", "- item @akira", "", "**bold @minji**", "", "note[^1]", "", "[^1]: footnote @hanako"].join("\n");
    expect((await names(md, t))).toEqual(["@hana", "@ben", "@akira", "@minji", "@hanako"]);
  });

  it("does not count an escaped sigil or a character reference", async () => {
    expect((await names("\\@hana and &#64;ben and &#x40;ben and @akira", t))).toEqual(["@akira"]);
    // An escape before another character does not hide a mention behind it.
    expect((await names("\\*x\\* @hana", t))).toEqual(["@hana"]);
  });

  it("decodes invalid numeric references without throwing or losing later plain mentions", async () => {
    for (const reference of ["&#x110000;", "&#999999999999999999999;", "&#xD800;", "&#0;", "&#x80;"]) {
      expect((await mentionTokens(`${reference} @hana`)), reference).toEqual(["hana"]);
      expect((await names(`${reference} @hana`, t)), reference).toEqual(["@hana"]);
    }
  });

  it("keeps escape alignment through list indentation and multi-code-point named references", async () => {
    expect((await mentionTokens("- text\n  \\@hana"))).toEqual([]);
    expect((await names("- text\n  \\@hana", t))).toEqual([]);
    expect((await mentionTokens("@hana &NotEqualTilde; \\@bob"))).toEqual(["hana"]);
    expect((await names("@hana &NotEqualTilde; \\@ben", t))).toEqual(["@hana"]);
    expect((await names("> text\n> \\@hana\n> @ben", t))).toEqual(["@ben"]);
    expect((await names("- text\n  @hana", t))).toEqual(["@hana"]);
    expect((await names("&NotEqualTilde; @hana", t))).toEqual(["@hana"]);
    expect((await names("&unknownReference; \\@hana @ben", t))).toEqual(["@ben"]);
  });

  it("aligns decoded ampersands before matching plain characters and keeps later escaped sigils excluded", async () => {
    for (const reference of ["&amp;", "&#38;"]) {
      expect((await mentionTokens(`${reference} @hana`))).toEqual(["hana"]);
      expect((await names(`${reference} @hana`, t))).toEqual(["@hana"]);
    }
    expect((await mentionTokens("&amp; \\@hana @ben"))).toEqual(["ben"]);
    expect((await names("&amp; \\@hana @ben", t))).toEqual(["@ben"]);
  });

  it("does not mark a transformed node whose source position or alignment is unknown", () => {
    const file = { data: { mentionTargets: t }, value: "\\@hana" };
    for (const position of [undefined, { start: { offset: 1 }, end: { offset: 3 } }]) {
      const tree = { type: "root", children: [{ type: "paragraph", children: [{ type: "text", value: "@hana", position }] }] };
      remarkMentions()(tree, file);
      expect(tree.children[0].children).toEqual([{ type: "text", value: "@hana", position }]);
    }
  });

  it("finds each member once, in order of appearance", async () => {
    expect((await matchMentions("@ben @hana @ben @Hana", t)).map((m) => m.handle)).toEqual(["ben", "hana"]);
  });

  describe("block quotes", () => {
    it("marks a member that appears only in a quote as quoted", async () => {
      const md = "> @ben wrote this\n\n@hana: I agree";
      expect((await matchMentions(md, t)).map((m) => [m.handle, m.quoted])).toEqual([["ben", true], ["hana", false]]);
    });

    it("a member who also appears outside a quote is not quoted", async () => {
      const md = "> @ben wrote\n\n@ben, I agree\n\n> @ben again";
      expect((await matchMentions(md, t)).map((m) => [m.handle, m.quoted])).toEqual([["ben", false]]);
    });

    it("a nested quote and a quote in a list are quoted", async () => {
      expect((await matchMentions("> > @ben", t))[0].quoted).toBe(true);
      expect((await matchMentions("- > @ben", t))[0].quoted).toBe(true);
    });
  });
});

describe("mentionTokens", () => {
  it("lists the runs, once each, in order, without the code and the links", async () => {
    expect((await mentionTokens("@hanaさん @ben `@code` [@link](u) @hanaさん @BEN"))).toEqual(["hana", "ben"]);
  });

  it("returns nothing for a body without a sigil, and keeps to 50", async () => {
    expect((await mentionTokens("no sigil"))).toEqual([]);
    const many = Array.from({ length: 80 }, (_, i) => `@user${i}`).join(" ");
    expect((await mentionTokens(many))).toHaveLength(50);
  });
});

describe("splitMentions", () => {
  it("cuts a text into plain parts and mentions", () => {
    const t = targets("hana");
    expect(splitMentions("ab @hanaさん cd", t)).toEqual(["ab ", { text: "@hana", handle: "hana", userId: "u-hana", publicId: "000000000000", key: "hana" }, "さん cd"]);
    expect(splitMentions("no mention", t)).toEqual(["no mention"]);
    expect(splitMentions("@nobody", t)).toEqual(["@nobody"]);
  });
});
