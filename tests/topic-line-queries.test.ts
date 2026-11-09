import { eq } from "drizzle-orm";
import { expect, it, vi } from "vitest";
import { entries, translations } from "~/lib/db/schema";
import { createTopic } from "~/lib/entries.server";
import { loadTitleDisplays } from "~/lib/entry-display.server";
import { addMember, createTestDb } from "./helpers/db";

it("batches body eligibility for thirty titled topics without selecting their translated text or HTML", async () => {
  const db = await createTestDb();
  await addMember(db, "writer", "writer");
  const topics: { id: number; lang: "ja"; title: string | null; sourceHash: string | null }[] = [];
  for (let i = 0; i < 30; i++) {
    const result = await createTopic(db, "writer", { lang: "ja", title: `題 ${i}`, body: "長い本文。" });
    if (!result.ok) throw new Error("topic failed");
    const [source] = await db.select().from(entries).where(eq(entries.id, result.id));
    topics.push({ ...source, lang: "ja" as const });
    await db.insert(translations).values({ entryId: source.id, field: "body", lang: "en", kind: "primary", sourceHash: source.sourceHash, text: "Long body ".repeat(10_000), html: "<p>Long body</p>", cardHtml: "<p>Beginning</p>" });
  }
  const client = (db as unknown as { $client: { query: (...args: unknown[]) => unknown } }).$client;
  const measure = async (size: number) => {
    const spy = vi.spyOn(client, "query");
    try {
      const shown = await loadTitleDisplays(db, topics.slice(0, size), { readLangs: ["en"], displayLang: "en" });
      expect([...shown.values()].every(line => !line.pending)).toBe(true);
      // The driver may receive (text, params) or (config, params); older versions put the params in config.values.
      return spy.mock.calls.map(([query, params]) => typeof query === "string"
        ? { sql: query, params: (params as unknown[] | undefined) ?? [] }
        : { sql: (query as { text: string }).text, params: (params as unknown[] | undefined) ?? (query as { values?: unknown[] }).values ?? [] });
    } finally {
      spy.mockRestore();
    }
  };
  const one = await measure(1);
  const thirty = await measure(30);
  expect(one).toHaveLength(2);
  expect(thirty).toHaveLength(one.length);
  for (const queries of [one, thirty]) {
    const body = queries.find(query => query.params.includes("body"))!;
    expect(body).toBeDefined();
    const projection = body.sql.split(/\bfrom\b/i)[0];
    for (const column of ["text", "html", "card_html"]) expect(projection).not.toContain(`"${column}"`);
    expect(projection).toContain('"source_hash"');
    expect(projection).toContain('"mention_revision"');
    expect(projection).toContain('"flags"');
    for (const query of queries) expect(query.sql.split(/\bfrom\b/i)[0]).not.toMatch(/"(?:html|card_html)"/);
  }
});

it.each([
  { kind: "primary", flags: [], oldSource: false, oldMentions: false, pending: false },
  { kind: "primary", flags: ["link_mismatch"], oldSource: false, oldMentions: false, pending: true },
  { kind: "primary", flags: ["untranslated"], oldSource: false, oldMentions: false, pending: true },
  { kind: "primary", flags: [], oldSource: true, oldMentions: false, pending: true },
  { kind: "primary", flags: [], oldSource: false, oldMentions: true, pending: true },
  { kind: "secondary", flags: [], oldSource: false, oldMentions: false, pending: true },
  { kind: "human", flags: ["stale"], oldSource: true, oldMentions: true, pending: false },
])("preserves body display eligibility: %j", async ({ kind, flags, oldSource, oldMentions, pending }) => {
  const db = await createTestDb();
  await addMember(db, "writer", "writer");
  const result = await createTopic(db, "writer", { lang: "ja", title: "題", body: "本文" });
  if (!result.ok) throw new Error("topic failed");
  const [source] = await db.select().from(entries).where(eq(entries.id, result.id));
  await db.insert(translations).values({ entryId: source.id, field: "body", lang: "en", kind, flags, text: "Translated body", sourceHash: oldSource ? "old" : source.sourceHash, mentionRevision: oldMentions ? source.mentionRevision + 1 : source.mentionRevision });
  expect((await loadTitleDisplays(db, [{ ...source, lang: "ja" }], { readLangs: ["en"], displayLang: "en" })).get(source.id)?.pending).toBe(pending);
});

it("still reads translated body text for a titleless headline in a mixed list", async () => {
  const db = await createTestDb();
  await addMember(db, "writer", "writer");
  for (const title of ["題", undefined]) {
    const result = await createTopic(db, "writer", { lang: "ja", title, body: "短い投稿の本文。" });
    if (!result.ok) throw new Error("topic failed");
    const [source] = await db.select().from(entries).where(eq(entries.id, result.id));
    await db.insert(translations).values({ entryId: source.id, field: "body", lang: "en", kind: "primary", text: "The translated remark.", sourceHash: source.sourceHash });
  }
  const topics = (await db.select().from(entries)).map(source => ({ ...source, lang: "ja" as const }));
  const shown = await loadTitleDisplays(db, topics, { readLangs: ["en"], displayLang: "en" });
  expect(shown.get(topics.find(topic => topic.title === null)!.id)).toMatchObject({ text: "The translated remark.", fromBody: true, pending: false });
  expect(shown.get(topics.find(topic => topic.title !== null)!.id)).toMatchObject({ text: "題", fromBody: false, pending: false });
});
