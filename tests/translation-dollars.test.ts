import { afterEach, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { translateChecked } from "~/lib/llm/translate.server";
import { createFakeEngine } from "~/lib/llm/engines/fake.server";
import { renderMarkdown } from "~/lib/markdown.server";
import { isUsablePrimary } from "~/lib/display";
import { addMember, createTestDb } from "./helpers/db";
import { entries, translations } from "~/lib/db/schema";
import { createTopic } from "~/lib/entries.server";
import { createTranslationHandlers } from "~/lib/jobs/translation-jobs.server";
import { runDueJobs } from "~/lib/jobs/queue.server";
import { extractLinks } from "~/lib/llm/structure.core.server";

afterEach(() => vi.unstubAllEnvs());
function engineReturning(...texts: string[]) {
  let index = 0;
  return { ...createFakeEngine(), translate: vi.fn(async () => ({ text: texts[Math.min(index++, texts.length - 1)], model: "fake-1", promptVersion: "fixture", inputTokens: 1, outputTokens: 1 })) };
}

it.each([
  ["1回あたり5〜10ドルかかる。", "It costs $5 to $10 per run.", String.raw`It costs \$5 to \$10 per run.`],
  ["10ドルと20ドル。", "$10 and $20.", String.raw`\$10 and \$20.`],
  ["価格は5ドルから10ドル。", "The price is $5–$10.", String.raw`The price is \$5–\$10.`],
  ["価格は5ドル。", "The price is $5.", String.raw`The price is \$5.`],
])("escapes introduced currency without retrying or rendering it as math: %s", async (source, raw, escaped) => {
  const engine = engineReturning(raw);
  const result = await translateChecked(engine, { text: source, from: "ja", to: "en" });
  expect(result).toMatchObject({ text: escaped, attempts: 1, flags: [] });
  expect(engine.translate).toHaveBeenCalledTimes(1);
  const html = await renderMarkdown(result.text);
  expect(html).toContain(raw);
  expect(html).not.toContain("katex");
});

it.each([
  ["5ドルのプラン", "The $5 plan"],
  ["5ドルと10ドルのプラン", "The $5 and $10 plans"],
])("checks title currency without escaping the saved plain text: %s", async (source, text) => {
  const engine = engineReturning(text);
  expect(await translateChecked(engine, { text: source, from: "ja", to: "en", field: "title" })).toMatchObject({ text, flags: [], attempts: 1 });
  expect(engine.translate).toHaveBeenCalledTimes(1);
});

it("also preserves raw title currency on an accepted retry", async () => {
  const text = "The $5 and $10 plans";
  const engine = engineReturning("The plans https://example.org/added", text);
  expect(await translateChecked(engine, { text: "5ドルと10ドルのプラン", from: "ja", to: "en", field: "title" })).toMatchObject({ text, flags: [], attempts: 2 });
});

it("preserves inline, fenced and indented code dollars even between currency amounts", async () => {
  for (const [source, raw, escaped] of [
    ["`$HOME` と `$PATH` を使う。費用は10ドルと20ドル。\n\n```sh\necho $HOME $PATH\n```", "Use `$HOME` with $10 and `$PATH` with $20.\n\n```sh\necho $HOME $PATH\n```", "Use `$HOME` with \\$10 and `$PATH` with \\$20.\n\n```sh\necho $HOME $PATH\n```"],
    ["実行例：\n\n    echo $HOME $PATH\n\n費用は10ドルと20ドル。", "Example:\n\n    echo $HOME $PATH\n\nCosts $10 and $20.", "Example:\n\n    echo $HOME $PATH\n\nCosts \\$10 and \\$20."],
  ]) {
    const result = await translateChecked(engineReturning(raw), { text: source, from: "ja", to: "en" });
    expect(result).toMatchObject({ text: escaped, attempts: 1, flags: [] });
  }
});

it("preserves an unclosed code fence behind the fake engine's display prefix", async () => {
  const text = "```sh\necho $HOME $PATH";
  expect(await translateChecked(createFakeEngine(), { text, from: "ja", to: "en" })).toMatchObject({ text: `[en] ${text}`, flags: [], attempts: 1 });
});

it("does not double-escape existing escapes and respects backslash parity", async () => {
  for (const [raw, escaped] of [
    [String.raw`Costs \$5 and \$10.`, String.raw`Costs \$5 and \$10.`],
    [String.raw`Costs \\$5 and \\$10.`, String.raw`Costs \\\$5 and \\\$10.`],
  ]) {
    const result = await translateChecked(engineReturning(raw), { text: "費用は5ドルと10ドル。", from: "ja", to: "en" });
    expect(result).toMatchObject({ text: escaped, flags: [], attempts: 1 });
  }
});

it.each([
  "https://example.org/$5/$10",
  "www.example.org/$5/$10",
  "<https://example.org/$5/$10>",
  "[price](https://example.org/$5/$10)",
])("preserves dollar-bearing link destinations while preventing math: %s", async link => {
  const source = `${link} を参照。`;
  const result = await translateChecked(engineReturning(`See ${link}.`), { text: source, from: "ja", to: "en" });
  expect(result).toMatchObject({ flags: [], attempts: 1 });
  expect(extractLinks(result.text)).toEqual(extractLinks(source));
  const html = await renderMarkdown(result.text);
  expect(html).toContain('example.org/$5/$10"');
  expect(html).not.toContain("katex");
});

it("keeps source math unchanged and still hides changed formulas", async () => {
  const req = { text: "値は $x+1$、価格は5ドル。", from: "ja", to: "en" } as const;
  const faithful = "Value $x+1$, price $5.";
  expect(await translateChecked(engineReturning(faithful), req)).toMatchObject({ text: faithful, flags: [], attempts: 1 });
  const changed = await translateChecked(engineReturning("Value $x+2$, price $5."), req);
  expect(changed).toMatchObject({ text: "Value $x+2$, price $5.", flags: ["quality_mismatch"], attempts: 2 });
  expect(isUsablePrimary({ sourceHash: "h", flags: changed.flags }, "h")).toBe(false);
});

it("leaves plain-text chat currency untouched", async () => {
  const text = "It costs $5 to $10 per run.";
  expect(await translateChecked(engineReturning(text), { text: "1回あたり5〜10ドルかかる。", from: "ja", to: "en", chat: { context: [] } })).toMatchObject({ text, flags: [], attempts: 1 });
});

it("normalizes the accepted retry as well as the first attempt", async () => {
  const engine = engineReturning("Costs $5 to $10.", "# Cost\n\nIt costs $5 to $10.");
  expect(await translateChecked(engine, { text: "# 費用\n\n5〜10ドル。", from: "ja", to: "en" })).toMatchObject({ text: "# Cost\n\nIt costs \\$5 to \\$10.", flags: [], attempts: 2 });
});

it("still detects an exact source copy before normalizing literal dollars", async () => {
  const text = "The project raised $6.6 billion for the next phase of the program.";
  const result = await translateChecked(engineReturning(text), { text, from: "en", to: "fr" });
  expect(result.flags).toContain("untranslated");
  expect(result.attempts).toBe(2);
});

it("saves the normalized translation and renders the saved currency without KaTeX", async () => {
  vi.stubEnv("ENABLED_LANGS", "ja,en");
  const db = await createTestDb();
  await addMember(db, "currency_author", "currency_author");
  const made = await createTopic(db, "currency_author", { lang: "ja", body: "1回あたり5〜10ドルかかる。" });
  if (!made.ok) throw new Error(made.error);
  const engine = engineReturning("It costs $5 to $10 per run.");
  await runDueJobs(db, createTranslationHandlers({ llm: { engines: { primary: engine, secondary: null, judge: null } } }), { limit: 30, logger: { warn() {}, error() {} } });
  const [row] = await db.select().from(translations).where(and(eq(translations.entryId, made.id), eq(translations.lang, "en"), eq(translations.field, "body"), eq(translations.kind, "primary")));
  expect(row).toMatchObject({ text: String.raw`It costs \$5 to \$10 per run.`, flags: [] });
  const [entry] = await db.select().from(entries).where(eq(entries.id, made.id));
  expect(isUsablePrimary(row, entry.sourceHash)).toBe(true);
  expect(await renderMarkdown(row.text)).toBe("<p>It costs $5 to $10 per run.</p>");
});
