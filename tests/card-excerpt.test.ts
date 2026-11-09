import { quietLogger as quiet } from "./helpers/logger";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { CARD_MAX_BLOCKS, CARD_MAX_CHARS, CARD_MAX_CODE_LINES, CARD_MAX_ROWS, CARD_MAX_TABLE_ROWS } from "~/lib/card-excerpt.server";
import { entries, translations } from "~/lib/db/schema";
import { createReply, createTopic, editEntry } from "~/lib/entries.server";
import { createTranslationReport, resolveReportWithHumanTranslation } from "~/lib/translation-reports.server";
import { runDueJobs } from "~/lib/jobs/queue.server";
import { createTranslationHandlers } from "~/lib/jobs/translation-jobs.server";
import { createFakeEngine } from "~/lib/llm/engines/fake.server";
import { renderEntry, renderEntryOrPlain, renderMarkdown, RENDER_VERSION, tryRenderEntry } from "~/lib/markdown.server";
import { addMember, createTestDb } from "./helpers/db";

const opts = { idPrefix: "p-1-", lang: "en" };
const card = async (md: string) => (await renderEntry(md, opts)).cardHtml;
const para = (n: number) => Array.from({ length: n }, (_, i) => `paragraph ${i + 1}`).join("\n\n");
const graphemes = (s: string) => [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(s)].length;
const textOf = (html: string) => html.replace(/<[^>]*>/g, "");

// A small checker for "closed HTML": every start tag has its end tag, in the right order (the parser would build the same tree).
const VOID = new Set(["br", "img", "hr", "input", "meta", "link", "wbr"]);
function expectBalanced(html: string): void {
  const stack: string[] = [];
  for (const m of html.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g)) {
    const [, closing, name, rest] = m;
    const tag = name.toLowerCase();
    if (VOID.has(tag) || rest.trimEnd().endsWith("/")) continue;
    if (closing) expect(stack.pop(), `unexpected </${tag}> in ${html}`).toBe(tag);
    else stack.push(tag);
  }
  expect(stack, `unclosed tags in ${html}`).toEqual([]);
}

describe("the card version of a rendered post", () => {
  it("a short body is not cut: cardHtml is null and html is the same as renderMarkdown makes", async () => {
    const md = "Hello **world**, $x^2$.\n\nSecond paragraph.";
    const out = (await renderEntry(md, opts));
    expect(out.cardHtml).toBeNull();
    expect(out.html).toBe((await renderMarkdown(md, opts)));
  });

  it("the full html of renderEntry is what renderMarkdown makes, for every kind of block", async () => {
    const md = "# T\n\ntext[^1] $a$\n\n$$\nb\n$$\n\n- x\n- y\n\n|a|b|\n|-|-|\n|1|2|\n\n```js\ncode\n```\n\n> q\n\n![x](https://cdn.example.net/a.png)\n\n[^1]: note";
    expect((await renderEntry(md, opts)).html).toBe((await renderMarkdown(md, opts)));
  });

  it("a long body is cut at a block boundary: the blocks that fit, and none of the rest", async () => {
    const p = "a".repeat(250);
    const out = (await card(`${p}\n\n${p}\n\nTHIRD${p}`));
    expect(out).toBe(`<p>${p}</p>\n<p>${p}</p>`);
    expect(out).not.toContain("THIRD");
  });

  it("stops after CARD_MAX_BLOCKS blocks, and keeps exactly that many when there are more", async () => {
    expect((await card(para(CARD_MAX_BLOCKS)))).toBeNull();
    const out = (await card(para(CARD_MAX_BLOCKS + 1)))!;
    expect(out.match(/<p>/g)).toHaveLength(CARD_MAX_BLOCKS);
    expect(out).toContain(`paragraph ${CARD_MAX_BLOCKS}`);
    expect(out).not.toContain(`paragraph ${CARD_MAX_BLOCKS + 1}`);
  });

  it("the character limit: a body of exactly CARD_MAX_CHARS characters is whole, one more is cut", async () => {
    const exact = "x".repeat(CARD_MAX_CHARS);
    expect((await card(exact))).toBeNull();
    const over = (await card(exact + "y"))!;
    // the only block is cut inside, at the limit, with an ellipsis
    expect(textOf(over)).toBe(`${exact}…`);
  });

  it("does not send a whole oversized inline-code block when no atomic content fits the card", async () => {
    const out = (await card(`\`${"x".repeat(5000)}TAIL-MUST-NOT-BE-SENT\``))!;
    expect(out).toBe("<p>…</p>");
    expect(out).not.toContain("TAIL-MUST-NOT-BE-SENT");
    expectBalanced(out);
  });

  it("the boundary is at the block level: two blocks that add up to the limit are kept, one more character drops the second", async () => {
    const a = "a".repeat(300);
    expect((await card(`${a}\n\n${"b".repeat(300)}`))).toBeNull();
    expect((await card(`${a}\n\n${"b".repeat(301)}`))).toBe(`<p>${a}</p>`);
  });

  it("when the first paragraph alone is too long it is cut at a grapheme boundary with an ellipsis", async () => {
    // each of these emoji is several code points and one grapheme: cutting by code unit or code point would split them
    const family = "👨‍👩‍👧‍👦";
    const out = (await card(family.repeat(CARD_MAX_CHARS + 5) + "\n\nsecond"))!;
    expect(out.endsWith("…</p>")).toBe(true);
    expect(graphemes(textOf(out))).toBe(CARD_MAX_CHARS + 1);
    expect(textOf(out).slice(0, -1)).toBe(family.repeat(CARD_MAX_CHARS));
    expect(out).not.toContain("second");
    expectBalanced(out);
  });

  it("Japanese text is counted by characters and cut with an ellipsis", async () => {
    const out = (await card("あ".repeat(900)))!;
    expect(textOf(out)).toBe("あ".repeat(CARD_MAX_CHARS) + "…");
    // a body of 600 Japanese characters is whole
    expect((await card("あ".repeat(CARD_MAX_CHARS)))).toBeNull();
  });

  it("the cut keeps the markup it is inside of closed (a link and bold text around the cut)", async () => {
    const out = (await card(`start [**${"w".repeat(700)}**](https://example.org/x) tail`))!;
    expectBalanced(out);
    expect(out).toContain('<a href="https://example.org/x"><strong>');
    expect(out).toContain("…</strong></a>");
    expect(out).not.toContain("tail");
  });

  it("an inline formula is never cut in the middle: it stays whole or is dropped", async () => {
    const filler = "x".repeat(CARD_MAX_CHARS - 2);
    const out = (await card(`${filler} $a^2+b^2=c^2$ after`))!;
    expect(out).not.toContain("katex");
    expect(out).not.toContain("a^2");
    expectBalanced(out);
    // a formula that fits is rendered by KaTeX in the card too
    const fits = (await card(`short $a^2$ ${"y".repeat(CARD_MAX_CHARS)}`))!;
    expect(fits).toContain('class="katex"');
    expectBalanced(fits);
  });

  it("a table, a code block and a display formula that do not fit are dropped whole, not cut", async () => {
    const p = "p".repeat(400);
    const table = `|h1|h2|\n|-|-|\n|${"c".repeat(100)}|${"d".repeat(100)}|`;
    const out = (await card(`${p}\n\n${table}`))!;
    expect(out).toBe(`<p>${p}</p>`);
    const code = (await card(`${p}\n\n\`\`\`\n${"k".repeat(300)}\n\`\`\``))!;
    expect(code).toBe(`<p>${p}</p>`);
    const math = (await card(`${p}\n\n$$\n${"z+".repeat(100)}z\n$$`))!;
    expect(math).toBe(`<p>${p}</p>`);
  });

  it("a table or code block that fits whole is kept whole, with its KaTeX rendered", async () => {
    const out = (await card(`intro\n\n|a|b|\n|-|-|\n|1|2|\n\n\`\`\`\nx = 1\n\`\`\`\n\n$$\ne=mc^2\n$$\n\n${"t".repeat(600)}`))!;
    expect(out).toContain("<table>");
    expect(out).toContain("<pre><code>x = 1\n</code></pre>");
    expect(out).toContain("katex-display");
    expect(out).not.toContain("ttt");
    expectBalanced(out);
  });

  it("a first block that is a long code block is cut by lines, and the cut is marked", async () => {
    const lines = Array.from({ length: CARD_MAX_ROWS + 20 }, (_, i) => `line ${i + 1}`);
    const out = (await card(`\`\`\`js\n${lines.join("\n")}\n\`\`\`\n\nafter`))!;
    expect(out).toContain(`line ${CARD_MAX_CODE_LINES}\n…`);
    expect(out).not.toContain(`line ${CARD_MAX_CODE_LINES + 1}`);
    expect(out).toContain('class="language-js"');
    expect(out).not.toContain("after");
    expectBalanced(out);
  });

  it("a first block that is a long table keeps its header and the first rows, and the cut is marked", async () => {
    const rows = Array.from({ length: 30 }, (_, i) => `|r${i + 1}|v|`);
    const out = (await card(`|h1|h2|\n|-|-|\n${rows.join("\n")}`))!;
    expect(out).toContain("<th>h1</th>");
    expect(out.match(/<td>r\d+<\/td>/g)).toHaveLength(CARD_MAX_TABLE_ROWS);
    expect(out).not.toContain("r5<");
    expect(out.endsWith("<p>…</p>")).toBe(true);
    expectBalanced(out);
  });

  it("a long list of short items is cut by rows (characters alone would let it through)", async () => {
    const items = Array.from({ length: 40 }, (_, i) => `- item ${i + 1}`).join("\n");
    const out = (await card(items))!;
    expect(out.match(/<li>/g)).toHaveLength(CARD_MAX_ROWS);
    expect(out).toContain(`item ${CARD_MAX_ROWS}…</li>`);
    expect(out).not.toContain(`item ${CARD_MAX_ROWS + 1}`);
    expectBalanced(out);
    // a short list is whole
    expect((await card(items.split("\n").slice(0, CARD_MAX_ROWS).join("\n")))).toBeNull();
  });

  it("a display formula as the first block stays whole, even when it is long", async () => {
    const out = (await card(`$$\n${"z+".repeat(400)}z\n$$\n\nafter`))!;
    expect(out).toContain("katex-display");
    expect(out).not.toContain("after");
    expectBalanced(out);
  });

  it("the footnotes section is dropped from the card and a mark that is left is a plain mark without a link", async () => {
    const out = (await renderEntry("Short text[^1] and more[^note].\n\n[^1]: first note\n\n[^note]: second note", opts));
    expect(out.html).toContain('id="p-1-footnote-label"');
    expect(out.cardHtml).not.toBeNull();
    expect(out.cardHtml).not.toContain("footnote");
    expect(out.cardHtml).not.toContain("first note");
    expect(out.cardHtml).not.toContain("href=");
    expect(out.cardHtml).not.toContain("aria-describedby");
    expect(out.cardHtml).toContain("<sup><span>1</span></sup>");
    expectBalanced(out.cardHtml!);
  });

  it("the card version is sanitized like the full one (no script, no event handler, no javascript: link, no external image)", async () => {
    const long = `start <script>alert(1)</script><img src=x onerror=alert(1)> [x](javascript:alert(1)) ![e](https://cdn.example.net/a.png) ${"w".repeat(700)}`;
    const out = (await card(long))!;
    expect(out).not.toMatch(/<script|onerror|javascript:|<img/i);
    expect(out).toContain('href="https://cdn.example.net/a.png"');
    expectBalanced(out);
  });

  it("the card version of every cut is closed HTML, whatever the markup", async () => {
    const pieces = ["**bold**", "*em*", "`code`", "[link](https://example.org)", "$x$", "~~del~~", "![i](/assets/a.png)", "line  \nbreak"];
    for (let i = 0; i < pieces.length; i++) {
      const md = `> quote ${pieces[i]} ${"q".repeat(650)}\n\n- ${pieces[i]} ${pieces[(i + 1) % pieces.length]} ${"l".repeat(650)}`;
      const out = (await card(md));
      expect(out, md).not.toBeNull();
      expectBalanced(out!);
    }
  });

  it("an emoji and combining marks at the cut are not split", async () => {
    const out = (await card("é".repeat(CARD_MAX_CHARS + 10)))!;
    // 600 graphemes of "é" (two code points each) and the ellipsis
    expect(textOf(out)).toBe("é".repeat(CARD_MAX_CHARS) + "…");
  });

  it("a body that cannot be rendered is shown as escaped plain text, and its card is the beginning of that", async () => {
    // tryRenderEntry is null for an output that is too large; renderEntryOrPlain then gives the escaped source
    const huge = "$x^2$ ".repeat(3000);
    expect((await tryRenderEntry(huge, opts))).toBeNull();
    const plain = (await renderEntryOrPlain(huge, opts));
    expect(plain.html.startsWith('<pre class="whitespace-pre-wrap">')).toBe(true);
    expect(plain.cardHtml).not.toBeNull();
    expect(plain.cardHtml!.length).toBeLessThan(2_000);
    const short = (await renderEntryOrPlain("<b>short</b>", opts));
    expect(short.cardHtml).toBeNull();
  });
});

describe("the card version is stored with the full one, for topics and their translations only", () => {
  const longBody = `${"長い本文。".repeat(200)}\n\n続きの段落。`;


  it("a topic stores html, card_html and the same html_version; a reply has no card_html", async () => {
    const db = await createTestDb();
    await addMember(db, "u1", "hana");
    const topic = await createTopic(db, "u1", { lang: "ja", title: "", body: longBody });
    if (!topic.ok) throw new Error("topic failed");
    const reply = await createReply(db, "u1", topic.id, { lang: "ja", body: longBody });
    if (!reply.ok) throw new Error("reply failed");
    const short = await createTopic(db, "u1", { lang: "ja", title: "", body: "短い" });
    if (!short.ok) throw new Error("topic failed");
    const get = async (id: number) => (await db.select().from(entries).where(eq(entries.id, id)))[0];
    const t = await get(topic.id);
    expect(t.htmlVersion).toBe(RENDER_VERSION);
    expect(t.cardHtml).not.toBeNull();
    expect(t.cardHtml!.length).toBeLessThan(t.html!.length);
    expect(t.html).toContain("続きの段落");
    expect(t.cardHtml).not.toContain("続きの段落");
    const r = await get(reply.id);
    expect(r.html).toContain("続きの段落");
    expect(r.cardHtml).toBeNull();
    expect((await get(short.id)).cardHtml).toBeNull();
  });

  it("an edit stores the new card version (and none when the edit makes the body short)", async () => {
    const db = await createTestDb();
    await addMember(db, "u1", "hana");
    const topic = await createTopic(db, "u1", { lang: "ja", title: "題", body: longBody });
    if (!topic.ok) throw new Error("topic failed");
    const get = async () => (await db.select().from(entries).where(eq(entries.id, topic.id)))[0];
    expect((await get()).cardHtml).not.toBeNull();
    expect((await editEntry(db, "u1", topic.id, { title: "題", body: "短くした" })).ok).toBe(true);
    const after = await get();
    expect(after.cardHtml).toBeNull();
    expect(after.html).toContain("短くした");
    expect(after.htmlVersion).toBe(RENDER_VERSION);
    expect((await editEntry(db, "u1", topic.id, { title: "題", body: longBody })).ok).toBe(true);
    expect((await get()).cardHtml).not.toBeNull();
  });

  it("the translate job stores the card version of the translation of a topic body (cut by its own length), and none for a reply or a title", async () => {
    const db = await createTestDb();
    await addMember(db, "u1", "hana");
    const topic = await createTopic(db, "u1", { lang: "ja", title: "題", body: longBody });
    if (!topic.ok) throw new Error("topic failed");
    const reply = await createReply(db, "u1", topic.id, { lang: "ja", body: longBody });
    if (!reply.ok) throw new Error("reply failed");
    const handlers = createTranslationHandlers({ llm: { engines: { primary: createFakeEngine(), secondary: null, judge: null }, env: {} } });
    await runDueJobs(db, handlers, { now: new Date("2026-10-05T00:00:00Z"), logger: quiet, limit: 500 });
    const row = (entryId: number, field: string) =>
      db
        .select()
        .from(translations)
        .where(and(eq(translations.entryId, entryId), eq(translations.field, field), eq(translations.lang, "en"), eq(translations.kind, "primary")))
        .then((rows) => rows[0]);
    const body = await row(topic.id, "body");
    expect(body.htmlVersion).toBe(RENDER_VERSION);
    expect(body.cardHtml).not.toBeNull();
    expect(body.html).toContain("続きの段落");
    expect(body.cardHtml).not.toContain("続きの段落");
    expect((await row(topic.id, "title")).cardHtml).toBeNull();
    expect((await row(reply.id, "body")).cardHtml).toBeNull();
  });

  it("the cut of a translation follows the length of the translation: a short original with a long human translation is cut in the translation only", async () => {
    const db = await createTestDb();
    await addMember(db, "u1", "hana");
    await addMember(db, "u2", "taro");
    const topic = await createTopic(db, "u1", { lang: "ja", title: "題", body: "短い本文" });
    if (!topic.ok) throw new Error("topic failed");
    expect((await createTranslationReport(db, "u2", { entryId: topic.id, lang: "fr", field: "body", excerpt: "x", note: "" })).ok).toBe(true);
    const longHuman = `${"Un long texte. ".repeat(80)}\n\nDernier paragraphe.`;
    expect((await resolveReportWithHumanTranslation(db, "u1", 1, longHuman)).ok).toBe(true);
    const [human] = await db
      .select()
      .from(translations)
      .where(and(eq(translations.entryId, topic.id), eq(translations.lang, "fr"), eq(translations.field, "body"), eq(translations.kind, "human")));
    expect(human.htmlVersion).toBe(RENDER_VERSION);
    expect(human.cardHtml).not.toBeNull();
    expect(human.html).toContain("Dernier paragraphe");
    expect(human.cardHtml).not.toContain("Dernier paragraphe");
    expect((await db.select().from(entries).where(eq(entries.id, topic.id)))[0].cardHtml).toBeNull();
  });
});
