import { describe, expect, it } from "vitest";
import { renderEntry, renderMarkdown } from "~/lib/markdown.server";
import { frozenMentionKey, sourceTargets, type MentionTarget, type MentionTargets } from "~/lib/mentions-md.server";

const member = { handle: "hana_now", userId: "old-hana", publicId: "hana00000001", prefix: "hana" };

describe("links rendered from saved mention bindings", () => {
  it("links the written name to the immutable member ID in bodies and bounded cards", async () => {
    const mentions: MentionTargets = new Map<string, MentionTarget>([[frozenMentionKey("@hana"), member]]);
    const source = `@hana hello.\n\n${"long paragraph ".repeat(100)}\n\nTAIL`;
    const rendered = (await renderEntry(source, { mentions }));
    const link = '<a class="mention" href="/u/id/hana00000001">@hana</a>';
    expect(rendered.html).toContain(link);
    expect(rendered.cardHtml).toContain(link);
    expect(rendered.cardHtml).not.toContain("TAIL");
  });

  it("keeps full-width and uppercase text as written inside member links", async () => {
    const mentions: MentionTargets = new Map<string, MentionTarget>([[frozenMentionKey("＠ＨＡＮＡ"), { ...member, prefix: "ＨＡＮＡ" }]]);
    expect((await renderMarkdown("＠ＨＡＮＡさん", { mentions }))).toContain('<a class="mention" href="/u/id/hana00000001">＠ＨＡＮＡ</a>さん');
  });

  it("leaves unresolved spellings and targets without a public ID as ordinary text", async () => {
    const mentions: MentionTargets = new Map<string, MentionTarget>([
      [frozenMentionKey("@unknown"), { handle: "", userId: "", prefix: null }],
      [frozenMentionKey("@hana"), { handle: "hana", userId: "hana", prefix: "hana" }],
    ]);
    expect((await renderMarkdown("@unknown @hana", { mentions }))).toBe("<p>@unknown @hana</p>");
  });

  it.each(["bad", "HANA00000001", "hana00000001/else", "hana00000001?x=1", "../else", 'x\" onclick=\"alert(1)'])
    ("does not render a member link from invalid public ID %j", async (publicId) => {
      const mentions: MentionTargets = new Map<string, MentionTarget>([[frozenMentionKey("@hana"), { ...member, publicId }]]);
      expect((await renderMarkdown("@hana", { mentions }))).toBe("<p>@hana</p>");
    });

  it("keeps ordinary Markdown links and sanitization independent of generated member links", async () => {
    const mentions: MentionTargets = new Map<string, MentionTarget>([[frozenMentionKey("@hana"), member]]);
    const rendered = (await renderMarkdown('[@hana](https://example.org/path) [ordinary](/u/id/noncanonical) [unsafe](javascript:alert(1)) <a class="mention" href="/else">raw</a>', { mentions }));
    expect(rendered).toContain('<a href="https://example.org/path">@hana</a>');
    expect(rendered).toContain('<a href="/u/id/noncanonical">ordinary</a>');
    expect(rendered).not.toContain('class="mention"');
    expect(rendered).not.toMatch(/javascript:|onclick/i);
  });

  it("preserves a frozen unresolved spelling during translation rendering", async () => {
    const mentions: MentionTargets = new Map<string, MentionTarget>([
      [frozenMentionKey("@hana"), member],
      [frozenMentionKey("@unknown"), { handle: "", userId: "", prefix: null }],
    ]);
    const translated = (await renderMarkdown("@hana thanks, @unknown and @else", { mentions: (await sourceTargets("@hana @unknown", mentions)) }));
    expect(translated).toContain('<a class="mention" href="/u/id/hana00000001">@hana</a>');
    expect(translated).toContain("@unknown and @else");
    expect(translated.match(/class="mention"/g)).toHaveLength(1);
  });
});
