import { describe, expect, it } from "vitest";
import {
  frozenMentionKey,
  matchMentions,
  mentionSpellings,
  mentionTokens,
  sourceTargets,
  splitMentions,
  type MentionTarget,
  type MentionTargets,
} from "~/lib/mentions-md.server";

const hana = { handle: "hana_now", userId: "old-hana", publicId: "hana00000001", prefix: "hana" };

describe("frozen mention bindings", () => {
  it("keeps every exact spelling while applying the same Markdown exclusions as mentions", async () => {
    const source = [
      "# @hana @HANA ＠ＨＡＮＡ @hana",
      "",
      "> @quoted",
      "",
      "- @listed `@code` \\@escaped &#64;entity [@linked](https://example.org/@url)",
      "",
      "![@image](https://example.org/a.png) $@math$ <!-- @html --> mail@address.org",
      "",
      "note[^1]",
      "",
      "[^1]: @footnote",
    ].join("\n");
    expect((await mentionSpellings(source))).toEqual(["@hana", "@HANA", "＠ＨＡＮＡ", "@quoted", "@listed", "@footnote"]);
    expect(frozenMentionKey("@hana")).toBe("\0@hana");
    expect(frozenMentionKey("@HANA")).not.toBe(frozenMentionKey("@hana"));
    expect((await mentionSpellings("without a sigil"))).toEqual([]);
  });

  it("retains spellings beyond the live lookup limit so unresolved candidates can be frozen", async () => {
    const spellings = Array.from({ length: 80 }, (_, i) => `@user${i}`);
    const source = spellings.join(" ");
    expect((await mentionTokens(source))).toHaveLength(50);
    expect((await mentionSpellings(source))).toEqual(spellings);
  });

  it("keeps the saved member and prefix when a longer current name becomes available", () => {
    const targets: MentionTargets = new Map<string, MentionTarget>([
      [frozenMentionKey("@hanako"), hana],
      ["hanako", { handle: "hanako", userId: "new-hanako", publicId: "hana00000002" }],
      ["hana", { handle: "hana", userId: "new-hana", publicId: "hana00000003" }],
    ]);
    expect(splitMentions("hello @hanako", targets)).toEqual([
      "hello ",
      { text: "@hana", handle: "hana_now", userId: "old-hana", publicId: "hana00000001", key: "hana" },
      "ko",
    ]);
  });

  it("never turns a frozen unresolved spelling into a mention through a live fallback", () => {
    for (const saved of [
      { handle: "", userId: "", prefix: null },
      { handle: "hana", userId: "", prefix: "hana" },
      { handle: "hana", userId: "old-hana", prefix: null },
    ]) {
      const targets: MentionTargets = new Map<string, MentionTarget>([
        [frozenMentionKey("@hana"), saved],
        ["hana", { handle: "hana", userId: "new-hana", publicId: "hana00000002" }],
      ]);
      expect(splitMentions("@hana", targets)).toEqual(["@hana"]);
    }
  });

  it("applies exact bindings separately to spellings with the same normalized handle", async () => {
    const targets: MentionTargets = new Map<string, MentionTarget>([
      [frozenMentionKey("@hana"), hana],
      [frozenMentionKey("@HANA"), { handle: "hana", userId: "new-hana", publicId: "hana00000002", prefix: "HANA" }],
    ]);
    expect((await matchMentions("> @hana\n\n@HANA @hana", targets)).map(({ text, userId, publicId, quoted }) => ({ text, userId, publicId, quoted }))).toEqual([
      { text: "@hana", userId: "old-hana", publicId: "hana00000001", quoted: false },
      { text: "@HANA", userId: "new-hana", publicId: "hana00000002", quoted: false },
    ]);
  });

  it("uses the ordinary lookup only when an exact binding is absent", async () => {
    const targets: MentionTargets = new Map<string, MentionTarget>([
      [frozenMentionKey("@hana"), { handle: "", userId: "", prefix: null }],
      ["hana", { handle: "hana", userId: "new-hana", publicId: "hana00000002" }],
    ]);
    expect((await matchMentions("@hana @HANA", targets))).toMatchObject([{ text: "@HANA", userId: "new-hana", publicId: "hana00000002" }]);
  });

  it("retains unresolved frozen bindings when choosing source targets for a translation", async () => {
    const targets: MentionTargets = new Map<string, MentionTarget>([
      [frozenMentionKey("@hana"), hana],
      [frozenMentionKey("@unknown"), { handle: "", userId: "", prefix: null }],
    ]);
    expect((await sourceTargets("@hana @unknown", targets))).toEqual(targets);
    expect((await sourceTargets("@hana @unknown", targets)).has("hana")).toBe(false);
  });

  it("retains public IDs in ordinary source targets and excludes translation-only members", async () => {
    const targets: MentionTargets = new Map<string, MentionTarget>([
      ["hana", { handle: "hana", userId: "old-hana", publicId: "hana00000001" }],
      ["ben", { handle: "ben", userId: "ben", publicId: "ben000000001" }],
    ]);
    expect((await sourceTargets("@hana", targets))).toEqual(new Map([["hana", { handle: "hana", userId: "old-hana", publicId: "hana00000001" }]]));
  });
});
