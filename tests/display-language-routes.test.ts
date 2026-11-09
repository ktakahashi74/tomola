import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { entries, profiles, rateLimits, translations } from "~/lib/db/schema";
import { createTopic } from "~/lib/entries.server";
import { createEmbeddingHandlers } from "~/lib/jobs/embedding-jobs.server";
import { runDueJobs } from "~/lib/jobs/queue.server";
import { createFakeEmbeddingEngine } from "~/lib/llm/engines/fake-embedding.server";
import { createApiToken } from "~/lib/tokens.server";
import { getMd, parseBlocks } from "./helpers/md";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";
import { setTestLocale } from "./stubs/paraglide-runtime";

let h: RouteHarness;
let topicId: number;
let englishId: number;
let japaneseId: number;
let token: string;

beforeAll(async () => {
  h = await setupRouteHarness();
  await h.signIn("reader", { homeArea: "ja", readLangs: ["ja"] });
  const topic = await createTopic(h.db, h.ids.reader, { lang: "th", title: "Thai source", body: "Thai source body" });
  const english = await createTopic(h.db, h.ids.reader, { lang: "en", title: "English source", body: "English source body" });
  const japanese = await createTopic(h.db, h.ids.reader, { lang: "ja", title: "日本語の題", body: "日本語の原文" });
  if (!topic.ok || !english.ok || !japanese.ok) throw new Error("topic failed");
  [topicId, englishId, japaneseId] = [topic.id, english.id, japanese.id];
  const [row] = await h.db.select({ sourceHash: entries.sourceHash }).from(entries).where(eq(entries.id, topicId));
  await h.db.insert(translations).values([
    { entryId: topicId, field: "body", lang: "en", kind: "primary", text: "English translation", engine: "fake", sourceHash: row.sourceHash },
    { entryId: topicId, field: "title", lang: "en", kind: "primary", text: "English translated title", engine: "fake", sourceHash: row.sourceHash },
    { entryId: topicId, field: "body", lang: "ja", kind: "primary", text: "日本語の訳", engine: "fake", sourceHash: row.sourceHash },
  ]);
  await runDueJobs(h.db, createEmbeddingHandlers({ llm: { env: {}, embeddingEngine: createFakeEmbeddingEngine() } }), { limit: 100, logger: { error: () => {}, warn: () => {} } });
  const issued = await createApiToken(h.db, h.ids.reader, { name: "language fixture", kind: "read" });
  if (!issued.ok) throw new Error(issued.error);
  token = issued.token;
});
beforeEach(async () => {
  setTestLocale("en");
  await h.db.delete(rateLimits);
  await h.db.update(profiles).set({ displayLang: null, uiLocale: "ja" }).where(eq(profiles.userId, h.ids.reader));
});
afterAll(() => { setTestLocale("en"); h.restore(); });

describe("interface language as the default translation language", () => {
  it("uses the current interface language on screen while retaining original-reading exceptions", async () => {
    const { loader } = await import("~/routes/topic");
    const load = async (id: number) => (await loader(h.args(h.request(`/t/${id}`, { as: "reader" }), { id: String(id) }))) as Awaited<Promise<{ displayLang: string; topic: { display: { shown: string; translation: { lang: string } | null } } }>>;
    const foreign = await load(topicId);
    expect(foreign.displayLang).toBe("en");
    expect(foreign.topic.display).toMatchObject({ shown: "translation", translation: { lang: "en" } });
    expect((await load(englishId)).topic.display.shown).toBe("original");
    expect((await load(japaneseId)).topic.display.shown).toBe("original");
  });

  it("uses stored UI locale for token Markdown thread, feeds and search regardless of request or runtime language", async () => {
    await h.db.update(profiles).set({ uiLocale: "en" }).where(eq(profiles.userId, h.ids.reader));
    setTestLocale("th");
    for (const accept of ["ja-JP", "th-TH"]) {
      const headers = { authorization: `Bearer ${token}`, "accept-language": accept };
      const blocks = parseBlocks(await (await getMd(h, `/t/${topicId}.md`, { headers })).text());
      expect(blocks.find(block => block.fm.type === "post")!.body).toBe("Thai source body");
      expect(blocks.find(block => block.fm.type === "translation")).toMatchObject({ fm: { lang: "en", source_version: expect.any(String) }, body: "English translation" });
      for (const path of ["/latest.md", "/home.md", "/a/th.md", "/following.md?all=1"]) {
        const response = path.startsWith("/following.md")
          ? await (await import("~/routes/following-md")).loader(h.args(h.request(path, { headers })))
          : await getMd(h, path, { headers });
        const text = await response.text();
        expect(text, path).toContain("English translated title");
        expect(text, path).toContain("lang=en");
      }
      const search = await getMd(h, "/search.md?q=Thai", { headers });
      expect(await search.text()).toContain("English translation");
    }
  });

  it("keeps explicit preferences and per-page overrides above stored UI, with strict Markdown validation", async () => {
    await h.db.update(profiles).set({ uiLocale: "en", displayLang: "ja" }).where(eq(profiles.userId, h.ids.reader));
    const headers = { authorization: `Bearer ${token}`, "accept-language": "en" };
    const preferred = parseBlocks(await (await getMd(h, `/t/${topicId}.md`, { headers })).text());
    expect(preferred.find(block => block.fm.type === "translation")!.body).toBe("日本語の訳");
    const overridden = parseBlocks(await (await getMd(h, `/t/${topicId}.md?lang=en`, { headers })).text());
    expect(overridden.find(block => block.fm.type === "translation")!.body).toBe("English translation");
    expect((await getMd(h, `/t/${topicId}.md?lang=xx`, { headers })).status).toBe(400);
    expect((await getMd(h, "/search.md?q=Thai&lang=xx", { headers })).status).toBe(400);
  });
});
