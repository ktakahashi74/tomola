import { quietLogger as quiet } from "./helpers/logger";
import fs from "node:fs";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { type Db } from "~/lib/db/client.server";
import { drafts, entries, entryRevisions, jobs, translationReports, translations } from "~/lib/db/schema";
import { createDraft, getDraft, listDrafts, publishDraft, updateDraft } from "~/lib/drafts.server";
import { createReply, createTopic, editEntry, listTopics } from "~/lib/entries.server";
import { loadEntryDisplays, loadTitleDisplays } from "~/lib/entry-display.server";
import { HEADLINE_CHARS, headlineFromBody } from "~/lib/headline.server";
import { isLongPost } from "~/lib/long-post";
import { runDueJobs } from "~/lib/jobs/queue.server";
import { createTranslationHandlers } from "~/lib/jobs/translation-jobs.server";
import type { Lang } from "~/lib/languages";
import { createFakeEngine } from "~/lib/llm/engines/fake.server";
import { buildMemberExport } from "~/lib/exports.server";
import { requeueTranslations } from "~/lib/translations-requeue.server";
import { createTranslationReport } from "~/lib/translation-reports.server";
import { addMember, createTestDb } from "./helpers/db";

// topics without a title. This file collects the tests of the whole work, one section per area.

// A rejected insert names the constraint (drizzle puts the driver error in `cause`).
async function rejects(run: () => Promise<unknown>, constraint: string) {
  let caught: unknown;
  try {
    await run();
  } catch (error) {
    caught = error;
  }
  expect(caught, `expected ${constraint} to reject`).toBeDefined();
  const cause = (caught as { cause?: { message?: string; constraint?: string } }).cause;
  expect(`${cause?.constraint ?? ""} ${cause?.message ?? ""} ${(caught as Error).message}`).toContain(constraint);
}

describe("CHECK constraints of titleless topics", () => {
  const values = (over: Record<string, unknown> = {}) => ({ kind: "topic", authorId: "u1", lang: "ja", title: "t", body: "b", ...over }) as typeof entries.$inferInsert;

  it("rejects an empty or blank title, a question without a title and a reply with a title, and accepts the valid shapes", async () => {
    const db = await createTestDb();
    await addMember(db, "u1", "hana");
    await rejects(() => db.insert(entries).values(values({ title: "" })), "entries_title_not_blank_check");
    await rejects(() => db.insert(entries).values(values({ title: "   " })), "entries_title_not_blank_check");
    await rejects(() => db.insert(entries).values(values({ title: null, asksStance: true })), "entries_question_title_check");
    const [topic] = await db.insert(entries).values(values({ title: null })).returning({ id: entries.id });
    await rejects(() => db.insert(entries).values(values({ kind: "reply", threadId: topic.id, title: "reply title" })), "entries_reply_title_check");
    // The valid shapes: a titleless topic, a topic with a title, a question with a title, a reply without a title.
    await db.insert(entries).values(values({ title: "A title" }));
    await db.insert(entries).values(values({ title: "A proposition", asksStance: true }));
    await db.insert(entries).values(values({ kind: "reply", threadId: topic.id, title: null }));
  });
});

describe("headlineFromBody", () => {
  const cases: Array<[string, string, string]> = [
    ["a plain sentence", "The morning was cool.", "The morning was cool."],
    ["the first paragraph only, its line breaks are spaces", "\n\n  First line.\nSecond line.\n\nNext paragraph.", "First line. Second line."],
    ["white space and line breaks are collapsed", "  many   spaces\there  ", "many spaces here"],
    ["a heading mark", "## A heading\nbody", "A heading"],
    ["a quote", "> quoted *text*\n> more\n\nafter", "quoted text more"],
    ["stacked quote, bullet and task marks", "> - [ ] do it", "do it"],
    ["bullets", "- first\n- second", "first"],
    ["a numbered list", "1. one\n2. two", "one"],
    ["a numbered list with a parenthesis", "3) three", "three"],
    ["emphasis", "This is **bold**, *italic*, __strong__, _em_ and ~~gone~~.", "This is bold, italic, strong, em and gone."],
    ["nested emphasis", "**bold *and italic* text**", "bold and italic text"],
    ["snake_case and a lone asterisk stay", "use snake_case_name and 5 * 3", "use snake_case_name and 5 * 3"],
    ["a link keeps the text only", "See [the page](https://example.com/a?b=c) now", "See the page now"],
    ["a reference link", "See [the page][1] now\n\n[1]: https://example.com", "See the page now"],
    ["an autolink keeps the address", "Go to <https://example.com/x>", "Go to https://example.com/x"],
    ["a bare address stays", "https://example.com/x is good", "https://example.com/x is good"],
    ["an image alone gives its alt text", "![A cat on a sofa](https://example.com/cat.png)", "A cat on a sofa"],
    ["an image without alt text and no other text gives nothing", "![](https://example.com/cat.png)", ""],
    ["an image without alt text is skipped for the next line", "![](https://example.com/cat.png)\n\nThe caption", "The caption"],
    ["inline code", "Run `pnpm test` now", "Run pnpm test now"],
    ["inline math, a short plain formula", "Let $n$ be a square", "Let n be a square"],
    ["inline math with a command is dropped", "Let $\\frac{a}{b}$ be a ratio", "Let be a ratio"],
    ["currency is not math", "It costs $5 and $10 in total", "It costs $5 and $10 in total"],
    ["display math is dropped when there is text", "$$\nE = mc^2\n$$\n\nThe famous formula.", "The famous formula."],
    ["no raw TeX after a heading", "# Euler\n\n$$e^{i\\pi}+1=0$$", "Euler"],
    ["a code block alone gives its first line", "```ts\nconst a = 1;\nconst b = 2;\n```", "const a = 1;"],
    ["the inside of a code block is not stripped", "```\n# not a heading\n*ptr = 1\n```", "# not a heading"],
    ["a code block after text is not used", "Text first\n\n```\ncode\n```", "Text first"],
    ["a tilde fence", "~~~\ninside\n~~~", "inside"],
    ["a display formula alone gives its first line (nothing else names the post)", "$$\nE = mc^2\n$$", "E = mc^2"],
    ["a thematic break is skipped", "---\nAfter the rule", "After the rule"],
    ["escaped characters", "1\\. not a list \\*star\\*", "1. not a list *star*"],
    ["HTML tags are dropped", "<b>bold</b> and <br> text", "bold and text"],
    ["entities", "Tom &amp; Jerry", "Tom & Jerry"],
    ["a footnote reference", "A claim[^1]\n\n[^1]: A note", "A claim"],
    ["a table row", "| a | b |\n|---|---|\n| 1 | 2 |", "a b"],
    ["a list with a long second item keeps the first only", "- first item\n- second item", "first item"],
    ["a link and an image in one line", "![logo](https://example.com/l.png) [site](https://example.com) **now**", "logo site now"],
    ["a heading with emphasis and a link", "## The [new](https://example.com) *plan*\n\nbody", "The new plan"],
    ["Thai text", "วันนี้อากาศดีมาก ไปเดินเล่นริมแม่น้ำกัน", "วันนี้อากาศดีมาก ไปเดินเล่นริมแม่น้ำกัน"],
    ["emoji with a joiner and a skin tone", "朝の散歩 👩🏽‍🚀 🇯🇵", "朝の散歩 👩🏽‍🚀 🇯🇵"],
    ["Japanese text", "朝のうちは涼しかったのに、昼には暑くなった。", "朝のうちは涼しかったのに、昼には暑くなった。"],
    ["an empty body", "", ""],
    ["only white space", "  \n\t\n", ""],
    ["C0 controls are removed (a bell, an escape, a form feed inside a word)", "a\u0007b\u001bc\u001fd", "abcd"],
    ["DEL and C1 controls are removed", "a\u007fb\u0085c\u009fd", "abcd"],
    ["controls do not leave a double space behind", "one \u0007 two", "one two"],
    ["bidi embeddings, overrides and isolates are removed", "\u202eevil\u202c text \u2066x\u2069 \u202aa\u202b\u202d", "evil text x a"],
    ["only zero width characters is no text", "\u200b\u200c\u200d\u2060\ufeff", ""],
    ["only blank letters and combining marks is no text", "\u3164\u115f\u2800\u0301\u0301", ""],
    ["a zero width first line is skipped for the next block", "\u200b\u200b\n\nSecond block", "Second block"],
    ["a zero width heading is skipped for the paragraph under it", "# \u200b\n\nUnder it", "Under it"],
    ["a first list item with only controls is skipped", "- \u0007\u202e\n- real item", "real item"],
    ["a code block of invisible lines gives the first visible line", "```\n\u200b\n\u202e\nvisible\n```", "visible"],
    ["zero width characters inside the text stay (joiners are part of scripts and emoji)", "a\u200bb \u200d", "a\u200bb \u200d"],
    ["control characters in a formula line", "$$\n\u202eE = mc^2\n$$", "E = mc^2"],
  ];
  it.each(cases)("%s", async (_name, markdown, expected) => {
    expect((await headlineFromBody(markdown))).toBe(expected);
  });

  it("cuts a long sentence at a grapheme boundary and adds an ellipsis, and keeps exactly the maximum as it is", async () => {
    expect(HEADLINE_CHARS).toBe(80);
    const exact = "a".repeat(80);
    expect((await headlineFromBody(exact))).toBe(exact);
    expect((await headlineFromBody(`${exact}b`))).toBe(`${exact}…`);
    expect((await headlineFromBody("あ".repeat(100)))).toBe(`${"あ".repeat(80)}…`);
    expect((await headlineFromBody("abcdef", 3))).toBe("abc…");
    // Trailing white space before the cut is not left in front of the ellipsis.
    expect((await headlineFromBody("ab cdef", 3))).toBe("ab…");
  });

  it("never splits an emoji, a joined emoji or a letter with combining marks", async () => {
    const family = "👨‍👩‍👧‍👦"; // one grapheme, seven code points
    expect((await headlineFromBody(`${family}${family}${family}`, 2))).toBe(`${family}${family}…`);
    const accented = "e\u0301"; // e + combining acute
    expect((await headlineFromBody(`${accented}${accented}${accented}`, 2))).toBe(`${accented}${accented}…`);
    const flag = "🇯🇵";
    expect((await headlineFromBody(`${flag}${flag}${flag}`, 1))).toBe(`${flag}…`);
    expect((await headlineFromBody("😀".repeat(80)))).toBe("😀".repeat(80));
    expect((await headlineFromBody("😀".repeat(81)))).toBe(`${"😀".repeat(80)}…`);
    // Thai: vowel and tone marks stay with their consonant ("สวัสดี" is four clusters: ส, วั, ส, ดี).
    expect((await headlineFromBody("สวัสดี", 3))).toBe("สวัส…");
    expect((await headlineFromBody("สวัสดี", 4))).toBe("สวัสดี");
  });

  it("bounds the length in UTF-16 code units, so that a run of combining marks cannot make a long line", async () => {
    const zalgo = (n: number) => "\u0301".repeat(n);
    // 80 graphemes with 50 marks each would be 4,080 code units: cut at a grapheme boundary within 4 x 80 = 320.
    const spread = (await headlineFromBody(`${"a" + zalgo(50)}`.repeat(80)));
    expect(spread.length).toBeLessThanOrEqual(HEADLINE_CHARS * 4 + 1);
    expect(spread.endsWith("…")).toBe(true);
    expect(spread.startsWith("a\u0301")).toBe(true);
    // The cut is at a grapheme boundary: nothing but whole "a + 50 marks" units, and the ellipsis.
    expect(spread.slice(0, -1).length % 51).toBe(0);
    // One grapheme of 5,000 marks (the first one: nothing to cut before) is cut inside, within the limit, and the text behind it is dropped.
    const one = (await headlineFromBody(`a${zalgo(5000)} and the rest`));
    expect(one.length).toBeLessThanOrEqual(HEADLINE_CHARS * 4 + 1);
    expect(one.startsWith("a\u0301")).toBe(true);
    expect(one.endsWith("…")).toBe(true);
    expect(one).not.toContain("rest");
    // Behind some text, the pathological grapheme is dropped as a whole.
    expect((await headlineFromBody(`ab${"c" + zalgo(5000)} end`))).toBe("ab…");
    // Ordinary text is not touched by the limit: 80 emoji with a joiner (11 code units each, 880 in all) are cut by the units, not by the grapheme count; Thai and Japanese are far below it.
    const family = "👨‍👩‍👧‍👦";
    const families = (await headlineFromBody(family.repeat(80)));
    expect(families.length).toBeLessThanOrEqual(HEADLINE_CHARS * 4 + 1);
    expect(families).toBe(`${family.repeat(Math.floor(320 / family.length))}…`);
    expect((await headlineFromBody("あ".repeat(80)))).toBe("あ".repeat(80));
    // Thai (combining vowels and tone marks) is cut by the 80 graphemes, far below the limit in code units.
    const thai = (await headlineFromBody("วันนี้อากาศดี ".repeat(10)));
    expect(thai.length).toBeLessThan(HEADLINE_CHARS * 4);
    expect([...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(thai.slice(0, -1))].length).toBeGreaterThanOrEqual(79);
  });

  it("copes with a body that is one very long line", async () => {
    const text = (await headlineFromBody("x".repeat(60_000)));
    expect(text).toBe(`${"x".repeat(80)}…`);
    // The cap of the line must not split a surrogate pair into a broken character.
    const emojis = (await headlineFromBody("😀".repeat(30_000), 5));
    expect(emojis).toBe(`${"😀".repeat(5)}…`);
  });
});

// ---- Shared helpers for the sections below ----

const t0 = new Date("2026-10-05T00:00:00Z");


async function translateAll(db: Db) {
  const handlers = createTranslationHandlers({ llm: { engines: { primary: createFakeEngine(), secondary: null, judge: null }, env: {} } });
  await runDueJobs(db, handlers, { now: t0, logger: quiet, limit: 500 });
}

async function member() {
  const db = await createTestDb();
  await addMember(db, "u1", "hana");
  await addMember(db, "u2", "ben");
  return db;
}

async function topicRow(db: Db, id: number) {
  const [row] = await db.select().from(entries).where(eq(entries.id, id));
  return row;
}

async function newTopic(db: Db, input: Record<string, unknown>): Promise<number> {
  const res = await createTopic(db, "u1", { lang: "ja", body: "本文", ...input });
  if (!res.ok) throw new Error(`createTopic failed: ${res.error}`);
  return res.id;
}

const displayInput = (row: { id: number; lang: string; title: string | null; sourceHash: string | null }) => ({ id: row.id, lang: row.lang as Lang, title: row.title, sourceHash: row.sourceHash });

describe("creating a topic without a title", () => {
  it("stores NULL (never an empty string) for a missing, empty or blank title", async () => {
    const db = await member();
    for (const title of [undefined, null, "", "   ", " \t\n "]) {
      const id = await newTopic(db, { title });
      expect((await topicRow(db, id)).title, JSON.stringify(title)).toBeNull();
    }
    const id = await newTopic(db, { title: "  A title  " });
    expect((await topicRow(db, id)).title).toBe("A title");
  });

  it("applies the rules of a title (200 characters, one line, no control characters) only when there is one", async () => {
    const db = await member();
    expect(await createTopic(db, "u1", { lang: "ja", title: "t".repeat(200), body: "b" })).toMatchObject({ ok: true });
    for (const title of ["t".repeat(201), "a\nb", "a\u0007b", "a\u2028b"]) {
      expect(await createTopic(db, "u1", { lang: "ja", title, body: "b" }), JSON.stringify(title)).toEqual({ ok: false, error: "invalid_title" });
    }
    // The body is still required.
    expect(await createTopic(db, "u1", { lang: "ja", body: " " })).toEqual({ ok: false, error: "body_required" });
  });

  it("keeps the title required for a question, and for an alternative framing (which is a question too)", async () => {
    const db = await member();
    for (const title of [undefined, null, "", "  "]) {
      expect(await createTopic(db, "u1", { lang: "ja", title, body: "b", asksStance: true }), JSON.stringify(title)).toEqual({ ok: false, error: "invalid_title" });
    }
    const question = await createTopic(db, "u1", { lang: "ja", title: "AI should vote", body: "b", asksStance: true });
    if (!question.ok) throw new Error("question failed");
    expect(await createTopic(db, "u1", { lang: "ja", body: "b", asksStance: true, altOf: question.id })).toEqual({ ok: false, error: "invalid_title" });
    expect(await createTopic(db, "u1", { lang: "ja", title: "Another framing", body: "b", asksStance: true, altOf: question.id })).toMatchObject({ ok: true });
  });

  it("publishes a draft without a title as a topic without a title, and refuses a question draft without one", async () => {
    const db = await member();
    for (const title of [null, undefined, "", "  "]) {
      const draft = await createDraft(db, "u1", { kind: "topic", lang: "ja", title, body: "短い発言" });
      if (!draft.ok) throw new Error("draft failed");
      const published = await publishDraft(db, "u1", draft.id);
      if (!published.ok) throw new Error(`publish failed: ${published.error}`);
      expect((await topicRow(db, published.id)).title, JSON.stringify(title)).toBeNull();
    }
    const question = await createDraft(db, "u1", { kind: "topic", lang: "ja", title: "", body: "b", asksStance: true });
    if (!question.ok) throw new Error("draft failed");
    expect(await publishDraft(db, "u1", question.id)).toEqual({ ok: false, error: "invalid_title" });
    // The draft is kept, so that the title can be written.
    expect(await db.select().from(drafts).where(eq(drafts.id, question.id))).toHaveLength(1);
  });

  it("stores NULL for a draft whose title is empty or blank (as the API path does), on create and on update, and keeps a title with text as typed", async () => {
    const db = await member();
    const titleOf = async (id: number) => (await db.select().from(drafts).where(eq(drafts.id, id)))[0].title;
    for (const title of [undefined, null, "", "   ", " \t "]) {
      const draft = await createDraft(db, "u1", { kind: "topic", lang: "ja", title, body: "b" });
      if (!draft.ok) throw new Error("draft failed");
      expect(await titleOf(draft.id), JSON.stringify(title)).toBeNull();
      expect(await updateDraft(db, "u1", draft.id, { lang: "ja", title: "A title", body: "b" })).toEqual({ ok: true });
      expect(await titleOf(draft.id)).toBe("A title");
      expect(await updateDraft(db, "u1", draft.id, { lang: "ja", title, body: "b" })).toEqual({ ok: true });
      expect(await titleOf(draft.id), JSON.stringify(title)).toBeNull();
    }
    const typed = await createDraft(db, "u1", { kind: "topic", lang: "ja", title: " A title ", body: "b" });
    if (!typed.ok) throw new Error("draft failed");
    expect(await titleOf(typed.id)).toBe(" A title ");
  });

  it("reads a draft row that holds an empty or blank title (saved before the normalization) as no title: the list, the draft and the member export", async () => {
    const db = await member();
    const ids: number[] = [];
    for (const title of ["", "   "]) {
      const [row] = await db.insert(drafts).values({ authorId: "u1", kind: "topic", lang: "ja", title, body: "本文だけ" }).returning({ id: drafts.id });
      ids.push(row.id);
    }
    expect((await listDrafts(db, "u1")).map((d) => d.title)).toEqual([null, null]);
    for (const id of ids) expect((await getDraft(db, "u1", id))?.title).toBeNull();
    const out = await buildMemberExport(db, "u1");
    expect(out.drafts.map((d) => d.title)).toEqual([null, null]);
    expect(out.drafts.every((d) => !isLongPost({ title: d.title }))).toBe(true);
  });

  it("never gives a reply a title, and the database refuses one", async () => {
    const db = await member();
    const id = await newTopic(db, { title: "T" });
    const reply = await createReply(db, "u2", id, { lang: "ja", body: "r", title: "ignored" });
    if (!reply.ok) throw new Error("reply failed");
    expect((await topicRow(db, reply.id)).title).toBeNull();
  });
});

describe("editing the title of a topic", () => {
  it("adds a title to a topic without one and removes it again; a changed source version translates the changed field only and carries the body translation over", async () => {
    const db = await member();
    const id = await newTopic(db, { body: "短い発言です。" });
    await translateAll(db);
    const bodyRows = () => db.select().from(translations).where(and(eq(translations.entryId, id), eq(translations.field, "body"), eq(translations.lang, "en")));
    const titleRows = () => db.select().from(translations).where(and(eq(translations.entryId, id), eq(translations.field, "title")));
    expect(await bodyRows()).toHaveLength(1);
    // A topic without a title has no row of the field "title".
    expect(await titleRows()).toEqual([]);
    const hash0 = (await topicRow(db, id)).sourceHash;

    expect(await editEntry(db, "u1", id, { title: "新しい題", body: "短い発言です。" })).toMatchObject({ ok: true, changed: true });
    const added = await topicRow(db, id);
    expect(added.title).toBe("新しい題");
    expect(added.sourceHash).not.toBe(hash0);
    // The unchanged body translation moved to the new version; the title is queued.
    expect((await bodyRows())[0].sourceHash).toBe(added.sourceHash);
    await translateAll(db);
    expect((await titleRows()).map((r) => [r.lang, r.text]).sort()).toContainEqual(["en", "[en] 新しい題"]);

    expect(await editEntry(db, "u1", id, { title: "", body: "短い発言です。" })).toMatchObject({ ok: true, changed: true });
    const removed = await topicRow(db, id);
    expect(removed.title).toBeNull();
    expect(removed.sourceHash).toBe(hash0);
    // Both corrections are inside the initial grace window; translations still update.
    const revisions = await db.select().from(entryRevisions).where(eq(entryRevisions.entryId, id)).orderBy(entryRevisions.id);
    expect(revisions).toEqual([]);
  });

  it("does not show the translation of an old title (even a human one) after the title is removed", async () => {
    const db = await member();
    const id = await newTopic(db, { title: "古い題", body: "本文の最初の行。\n\n二行目。" });
    await translateAll(db);
    const before = await topicRow(db, id);
    await db.insert(translations).values({ entryId: id, lang: "en", field: "title", kind: "human", text: "HUMAN OLD TITLE", sourceHash: before.sourceHash, flags: [], createdBy: "u1" });
    expect(await editEntry(db, "u1", id, { title: null, body: "本文の最初の行。\n\n二行目。" })).toMatchObject({ ok: true, changed: true });
    await translateAll(db);
    const row = await topicRow(db, id);
    // The title rows are still in the table (the record of the versions), but nothing shows them.
    const stored = await db.select().from(translations).where(and(eq(translations.entryId, id), eq(translations.field, "title")));
    expect(stored.length).toBeGreaterThan(0);
    const lists = await loadTitleDisplays(db, [displayInput(row)], { readLangs: ["en"], displayLang: "en" });
    expect(lists.get(id)).toMatchObject({ text: "[en] 本文の最初の行。", fromBody: true, kind: "primary", pending: false });
    const displays = await loadEntryDisplays(db, [{ id, kind: "topic", lang: "ja", sourceHash: row.sourceHash }], { readLangs: ["en"], displayLang: "en" });
    expect(displays.get(id)?.translation).toMatchObject({ title: null, headline: expect.stringContaining("[en] 本文の最初の行。") });
  });

  it("closes the open reports on the translation of the title when the title is taken off, and leaves the reports on the body, and the reports of a title that is only changed", async () => {
    const db = await member();
    const id = await newTopic(db, { title: "古い題", body: "本文です。" });
    const changed = await newTopic(db, { title: "別の題", body: "別の本文です。" });
    await translateAll(db);
    const report = (entryId: number, field: "title" | "body") => createTranslationReport(db, "u2", { entryId, lang: "en", field, excerpt: "x", note: "" }, { now: t0 });
    expect(await report(id, "title")).toMatchObject({ ok: true });
    expect(await report(id, "body")).toMatchObject({ ok: true });
    expect(await report(changed, "title")).toMatchObject({ ok: true });
    const state = async (entryId: number) =>
      (await db.select().from(translationReports).where(eq(translationReports.entryId, entryId))).map((r) => [r.field, r.status, r.resolvedBy, r.resolvedAt !== null] as const).sort();

    // Changing the title is not taking it off: the report stays open.
    expect(await editEntry(db, "u1", changed, { title: "さらに別の題", body: "別の本文です。" })).toMatchObject({ ok: true, changed: true });
    expect(await state(changed)).toEqual([["title", "open", null, false]]);

    const now = new Date("2026-10-06T00:00:00Z");
    expect(await editEntry(db, "u1", id, { title: "  ", body: "本文です。" }, { now })).toMatchObject({ ok: true, changed: true });
    // The title report is closed without a person (resolved_by is null), the body report is still open.
    expect(await state(id)).toEqual([
      ["body", "open", null, false],
      ["title", "resolved", null, true],
    ]);
    const [closed] = await db.select().from(translationReports).where(and(eq(translationReports.entryId, id), eq(translationReports.field, "title")));
    expect(closed.resolvedAt).toEqual(now);
  });

  it("refuses to empty the title of a question, even by an edit before a stance locks it", async () => {
    const db = await member();
    const id = await newTopic(db, { title: "AI should vote", asksStance: true });
    for (const title of [undefined, null, "", "  "]) {
      expect(await editEntry(db, "u1", id, { title, body: "本文" }), JSON.stringify(title)).toEqual({ ok: false, error: "invalid_title" });
    }
    expect((await topicRow(db, id)).title).toBe("AI should vote");
    expect(await editEntry(db, "u1", id, { title: "AI should vote!", body: "本文" })).toMatchObject({ ok: true });
  });

  it("edits a topic without a title keeping it without one (no change when nothing differs)", async () => {
    const db = await member();
    const id = await newTopic(db, { body: "同じ" });
    expect(await editEntry(db, "u1", id, { body: "同じ" })).toMatchObject({ ok: true, changed: false });
    expect(await editEntry(db, "u1", id, { title: "  ", body: "同じ" })).toMatchObject({ ok: true, changed: false });
    expect(await editEntry(db, "u1", id, { body: "違う" })).toMatchObject({ ok: true, changed: true });
    expect((await topicRow(db, id)).title).toBeNull();
  });
});

describe("loadTitleDisplays for a topic without a title", () => {
  it("gives the beginning of the body of the original, the beginning of the translated body for a reader who reads a translation, and pending without one", async () => {
    const db = await member();
    const titled = await newTopic(db, { title: "題のある話題", body: "題のある話題の本文" });
    const bare = await newTopic(db, { body: "## 見出し\n\n**短い**発言です。" });
    const rows = [await topicRow(db, titled), await topicRow(db, bare)].map(displayInput);

    const pending = await loadTitleDisplays(db, rows, { readLangs: ["th"], displayLang: "th" });
    expect(pending.get(titled)).toEqual({ text: "題のある話題", lang: "ja", kind: null, engine: null, fallback: false, stale: false, pending: true, fromBody: false });
    expect(pending.get(bare)).toEqual({ text: "見出し", lang: "ja", kind: null, engine: null, fallback: false, stale: false, pending: true, fromBody: true });

    await translateAll(db);
    const th = await loadTitleDisplays(db, rows, { readLangs: ["th"], displayLang: "th" });
    expect(th.get(titled)).toMatchObject({ text: "[th] 題のある話題", lang: "th", kind: "primary", fromBody: false });
    expect(th.get(bare)).toMatchObject({ text: "[th] ## 見出し", lang: "th", kind: "primary", engine: "fake", pending: false, fromBody: true });
    // A reader of the original language gets the original, without pending.
    const ja = await loadTitleDisplays(db, rows, { readLangs: ["ja", "th"], displayLang: "th" });
    expect(ja.get(bare)).toEqual({ text: "見出し", lang: "ja", kind: null, engine: null, fallback: false, stale: false, pending: false, fromBody: true });
    // A reader whose display language is the original one gets the original.
    expect((await loadTitleDisplays(db, rows, { readLangs: ["ja"], displayLang: "ja" })).get(bare)).toMatchObject({ text: "見出し", lang: "ja", pending: false });
  });

  it("uses a body given by the caller and reads only the bodies that are missing", async () => {
    const db = await member();
    const bare = await newTopic(db, { body: "データベースの本文" });
    const row = displayInput(await topicRow(db, bare));
    const given = await loadTitleDisplays(db, [{ ...row, body: "渡された本文" }], { readLangs: ["ja"], displayLang: "ja" });
    expect(given.get(bare)?.text).toBe("渡された本文");
    const read = await loadTitleDisplays(db, [row], { readLangs: ["ja"], displayLang: "ja" });
    expect(read.get(bare)?.text).toBe("データベースの本文");
  });

  it("gives an empty line for a body that has no text, so that a screen can show its own words", async () => {
    const db = await member();
    const bare = await newTopic(db, { body: "![](https://example.com/a.png)" });
    const row = displayInput(await topicRow(db, bare));
    expect((await loadTitleDisplays(db, [row], { readLangs: ["ja"], displayLang: "ja" })).get(bare)).toMatchObject({ text: "", fromBody: true });
  });
});

describe("translation of a topic without a title", () => {
  it("translates the body only: no row of the field title, no request with a title, and a reply receives no other member context", async () => {
    const db = await member();
    const id = await newTopic(db, { body: "短い発言です。" });
    const reply = await createReply(db, "u2", id, { lang: "ja", body: "返信です。" });
    if (!reply.ok) throw new Error("reply failed");
    const base = createFakeEngine();
    const requests: Array<{ text: string; title?: string; context?: string }> = [];
    const engine = { ...base, translate: async (req: Parameters<typeof base.translate>[0]) => (requests.push({ text: req.text, title: req.title, context: req.context }), base.translate(req)) };
    await runDueJobs(db, createTranslationHandlers({ llm: { engines: { primary: engine, secondary: null, judge: null }, env: {} } }), { now: t0, logger: quiet, limit: 500 });
    const rows = await db.select().from(translations).where(eq(translations.entryId, id));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.field === "body")).toBe(true);
    // No request carried a title (the topic has none, and the reply's thread has none), and nothing empty was translated.
    expect(requests.every((r) => r.title === undefined)).toBe(true);
    expect(requests.every((r) => r.text.trim() !== "")).toBe(true);
    expect(requests.some((r) => r.text === "短い発言です。")).toBe(true);
    expect(requests.some((r) => r.text === "返信です。" && r.context === undefined)).toBe(true);
  });

  it("is not queued as a title by the requeue command, which queues only the body", async () => {
    const db = await member();
    const id = await newTopic(db, { body: "短い発言です。" });
    await db.delete(jobs);
    const res = await requeueTranslations(db);
    expect(res.translate).toBeGreaterThan(0);
    await translateAll(db);
    // The body is translated, so there is nothing to queue (a missing title does not keep the entry "undone").
    expect(await requeueTranslations(db)).toMatchObject({ translate: 0 });
    expect((await db.select().from(translations).where(and(eq(translations.entryId, id), eq(translations.field, "title")))).length).toBe(0);
  });

  it("refuses a report of a wrong title translation for a topic without a title (invalid_field), and takes one for the body", async () => {
    const db = await member();
    const id = await newTopic(db, { body: "短い発言です。" });
    await translateAll(db);
    const report = (field: string) => createTranslationReport(db, "u2", { entryId: id, lang: "en", field, excerpt: "x", note: "" }, { now: t0 });
    expect(await report("title")).toEqual({ ok: false, error: "invalid_field" });
    expect(await report("body")).toMatchObject({ ok: true });
    expect(await db.select().from(translationReports)).toHaveLength(1);
    // A topic that has a title can still be reported by its title.
    const titled = await newTopic(db, { title: "題", body: "本文" });
    await translateAll(db);
    expect(await createTranslationReport(db, "u2", { entryId: titled, lang: "en", field: "title", excerpt: "", note: "" }, { now: t0 })).toMatchObject({ ok: true });
  });
});

describe("exports", () => {
  it("keeps the title key as null in the member export, for a topic without a title and for a draft without one", async () => {
    const db = await member();
    const bare = await newTopic(db, { body: "短い発言です。" });
    const titled = await newTopic(db, { title: "題", body: "本文" });
    await createDraft(db, "u1", { kind: "topic", lang: "ja", body: "下書き" });
    const out = await buildMemberExport(db, "u1");
    const byId = new Map(out.entries.map((e) => [e.id, e]));
    expect(byId.get(bare)).toHaveProperty("title", null);
    expect(byId.get(titled)).toHaveProperty("title", "題");
    expect(out.drafts[0]).toHaveProperty("title", null);
    expect(JSON.parse(JSON.stringify(out)).entries.find((e: { id: number }) => e.id === bare)).toHaveProperty("title", null);
  });
});

describe("source scan", () => {
  // A title that is missing must stay missing (null) until a screen decides what to show. The pattern catches a variable, a property or a name that ends in "title"
  // (title, .title, topicTitle, threadTitle), either `??` or `||`, and an empty string in any quotes.
  const EMPTY_TITLE = /[tT]itle\s*(\?\?|\|\|)\s*(""|''|``)/;

  it("catches the shapes of turning a title into an empty string", () => {
    for (const line of [
      'a.title ?? ""',
      "a.title ?? ''",
      "a.title ?? ``",
      'title ?? ""',
      'title||""',
      'row.title || ""',
      "topic.title  ??  ''",
      'topicTitle ?? ""',
      'const t = (entry.threadTitle || "")',
      'Title ?? ""',
    ]) {
      expect(EMPTY_TITLE.test(line), line).toBe(true);
    }
    for (const line of ['title ?? "x"', "a.title ?? null", "title || m.headline_empty()", 'a.title !== ""', "a.title ?? undefined"]) {
      expect(EMPTY_TITLE.test(line), line).toBe(false);
    }
  });

  it("has no place in app/ that turns the title of a topic into an empty string, other than the allowed ones", () => {
    const allowed = new Map([
      ["app/lib/md/history.server.ts", "compares missing and present titles only in sentence diffs"],
      ["app/routes/entry-history.tsx", "compares missing and present titles only in sentence diffs"],
      ["app/components/signed-form.tsx", "renders missing titles as blank in the approval comparison only"],
      // The questions (alternative framings) always have a title, so the two files that read them only to make the types fit are allowed.
      ["app/lib/objections.server.ts", "reads questions, which always have a title"],
      ["app/lib/md/manifest.server.ts", "reads questions, which always have a title"],
      // The hash of a missing title is the hash of an empty one on purpose: a topic without a title has the hash of its body, so that taking the title off restores the old version.
      ["app/lib/source-hash.server.ts", "a missing title hashes as an empty one"],
      // Only the estimate of the tokens of an embedding input; the title is optional there and nothing is sent for a missing one.
      ["app/lib/llm/engines/gemini-embedding.server.ts", "estimates the tokens of the input"],
      // The title attribute of an image in the body (Markdown's optional image title), not the title of a topic.
      ["app/components/rich-text-editor.client.tsx", "reads the optional title attribute of an image"],
      // The writing form's title field is put back to the starting text of its owner; a stored title is not changed.
      ["app/components/draft-keeper-content.tsx", "restores the title field of the form to its starting text"],
    ]);
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== "paraglide") walk(full);
        } else if (/\.(ts|tsx)$/.test(entry.name)) {
          const rel = path.relative(process.cwd(), full);
          if (EMPTY_TITLE.test(fs.readFileSync(full, "utf8")) && !allowed.has(rel)) found.push(rel);
        }
      }
    };
    walk(path.join(process.cwd(), "app"));
    expect(found).toEqual([]);
    // Every allowed file still has such a place (an entry that no longer applies is removed from the list).
    for (const rel of allowed.keys()) expect(EMPTY_TITLE.test(fs.readFileSync(path.join(process.cwd(), rel), "utf8")), rel).toBe(true);
  });
});

describe("long posts (a topic with a title)", () => {
  it("isLongPost is true for a topic that has a title only", () => {
    expect(isLongPost({ kind: "topic", title: "A title" })).toBe(true);
    expect(isLongPost({ title: "A title" })).toBe(true);
    expect(isLongPost({ kind: "topic", title: null })).toBe(false);
    expect(isLongPost({ kind: "reply", title: null })).toBe(false);
    expect(isLongPost({ kind: "reply", title: "never stored" })).toBe(false);
  });

  it("listTopics with titledOnly lists the topics with a title, and nothing else changes without it", async () => {
    const db = await member();
    const bare = await newTopic(db, { body: "短い発言です。" });
    const titled = await newTopic(db, { title: "題", body: "本文" });
    const question = await newTopic(db, { title: "命題", body: "本文", asksStance: true });
    const all = await listTopics(db, { kind: "all" });
    expect(all.topics.map((t) => t.id).sort()).toEqual([bare, titled, question].sort());
    const long = await listTopics(db, { kind: "all" }, { titledOnly: true });
    expect(long.topics.map((t) => t.id).sort()).toEqual([titled, question].sort());
    expect(long.topics.every((t) => isLongPost({ title: t.title }))).toBe(true);
    // The same set as the predicate says, over the stored rows.
    const rows = await db.select({ id: entries.id, kind: entries.kind, title: entries.title }).from(entries);
    expect(rows.filter(isLongPost).map((r) => r.id).sort()).toEqual(long.topics.map((t) => t.id).sort());
  });
});
