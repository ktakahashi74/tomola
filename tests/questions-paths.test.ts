import { quietLogger as quiet } from "./helpers/logger";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { entryEmbeddings, jobs, translations } from "~/lib/db/schema";
import { createReply, createTopic } from "~/lib/entries.server";
import { buildMemberExport, buildObservationExport } from "~/lib/exports.server";
import { createEmbeddingHandlers } from "~/lib/jobs/embedding-jobs.server";
import { runDueJobs, type JobHandlers } from "~/lib/jobs/queue.server";
import { createTranslationHandlers } from "~/lib/jobs/translation-jobs.server";
import { createFakeEmbeddingEngine, FAKE_EMBEDDING_MODEL } from "~/lib/llm/engines/fake-embedding.server";
import { createFakeEngine } from "~/lib/llm/engines/fake.server";
import { buildChangesMarkdown } from "~/lib/md/changes.server";
import { buildManifest } from "~/lib/md/manifest.server";
import { listNotifications } from "~/lib/notifications.server";
import { searchEntries } from "~/lib/search.server";
import { getMd, parseThreadBlocks } from "./helpers/md";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";

// Questions are posts with kind=topic plus additional attributes, so they use the existing topic paths: translation jobs, Markdown, change feeds, manifests, search, reply notifications, and member/observation exports.
// Verify here that questions appear in each path just like ordinary topics.

const embeddingEngine = createFakeEmbeddingEngine();
const handlers: JobHandlers = {
  ...createEmbeddingHandlers({ llm: { env: {}, embeddingEngine } }),
  ...createTranslationHandlers({ llm: { env: {}, engines: { primary: createFakeEngine(), secondary: null, judge: null } } }),
};

let h: RouteHarness;
let hana: string;
let john: string;
let somchai: string;
let question: number;
let plain: number;
let reply: number;
const QUESTION_TITLE = "凍結されたAIの開発は、いったん止めるべきである";

beforeAll(async () => {
  h = await setupRouteHarness();
  hana = await h.signIn("hana", { homeArea: "ja", readLangs: ["ja"] });
  john = await h.signIn("john", { homeArea: "en", readLangs: ["en"] });
  somchai = await h.signIn("somchai", { homeArea: "th", readLangs: ["th", "en"] });
  const q = await createTopic(h.db, hana, { lang: "ja", title: QUESTION_TITLE, body: "ここでの「止める」とは、新しい訓練を始めないことを指す。", asksStance: true }, { now: new Date("2026-10-01T00:00:00Z") });
  const p = await createTopic(h.db, hana, { lang: "ja", title: "ふつうの話題", body: "本文です。" }, { now: new Date("2026-10-01T00:10:00Z") });
  if (!q.ok || !p.ok) throw new Error("topic failed");
  [question, plain] = [q.id, p.id];
  const r = await createReply(h.db, john, question, { lang: "en", body: "I disagree, and here is why.", stanceTag: "disagree" }, { now: new Date("2026-10-01T00:20:00Z") });
  if (!r.ok) throw new Error("reply failed");
  reply = r.id;
});
afterAll(() => h.restore());

describe("a question goes through the paths of an ordinary topic", () => {
  it("queues the same translation and embedding jobs as an ordinary topic, and the translations are shown", async () => {
    const queued = async (entryId: number) => (await h.db.select({ kind: jobs.kind, payload: jobs.payload }).from(jobs)).filter((j) => (j.payload as { entryId?: number } | null)?.entryId === entryId);
    const forQuestion = await queued(question);
    const forPlain = await queued(plain);
    expect(forQuestion.filter((j) => j.kind === "translate_entry")).toHaveLength(8);
    expect(forQuestion.map((j) => j.kind).sort()).toEqual(forPlain.map((j) => j.kind).sort());
    await runDueJobs(h.db, handlers, { now: new Date(), logger: quiet, limit: 1000 });
    const done = await h.db.select({ lang: translations.lang, field: translations.field, kind: translations.kind }).from(translations).where(eq(translations.entryId, question));
    expect(done.filter((t) => t.kind === "primary" && t.lang === "en").map((t) => t.field).sort()).toEqual(["body", "title"]);
    // For an English reader, the title and body default to their translations.
    const { loader } = await import("~/routes/topic");
    const page = (await loader(h.args(h.request(`/t/${question}`, { as: "john" }), { id: String(question) }))) as unknown as {
      topic: { placeholder: null; display: { shown: string; translation: { kind: string; lang: string; title: { text: string } | null } | null } };
    };
    expect(page.topic.display.shown).toBe("translation");
    expect(page.topic.display.translation).toMatchObject({ kind: "primary", lang: "en" });
    expect(page.topic.display.translation?.title?.text).toBeTruthy();
    // Embeddings are also created.
    expect((await h.db.select().from(entryEmbeddings).where(eq(entryEmbeddings.entryId, question))).length).toBe(1);
  });

  it("is in the Markdown twin of the thread, with its translation after it when ?lang= is given", async () => {
    const res = await getMd(h, `/t/${question}.md?lang=en`, { as: "john" });
    expect(res.status).toBe(200);
    const blocks = parseThreadBlocks(await res.text());
    expect(blocks.map((b) => [b.fm.type, b.fm.id ?? b.fm.translation_of])).toEqual([
      ["post", `p-${question}`],
      ["translation", `p-${question}`],
      ["comment", `c-${reply}`],
      ["index", undefined],
      ["index", undefined],
    ]);
    expect(blocks[0].fm).toMatchObject({ title: QUESTION_TITLE, asks_stance: true, lang: "ja", author: "@hana" });
    expect(blocks[1].fm).toMatchObject({ lang: "en", status: "machine" });
    expect(blocks[2].fm).toMatchObject({ stance_tag: "disagree", author: "@john" });
  });

  it("is in the lists of the Markdown twins and the pages: latest, home and the area of its language", async () => {
    for (const path of ["/latest.md", "/home.md", "/a/ja.md"]) {
      const res = await getMd(h, path, { as: "hana" });
      expect(res.status, path).toBe(200);
      const text = await res.text();
      expect(text, path).toContain(`p-${question}`);
      expect(text, path).toContain(QUESTION_TITLE);
    }
    const { loader } = await import("~/routes/latest");
    const latest = (await loader(h.args(h.request("/latest", { as: "hana" })))) as unknown as { topics: Array<{ id: number; asksStance: boolean }> };
    expect(latest.topics.find((t) => t.id === question)).toMatchObject({ asksStance: true });
  });

  it("is in the change feed as created, and in the manifest with a content hash", async () => {
    const feed = await buildChangesMarkdown(h.db, { since: new Date("2026-10-01T00:00:00Z"), k: null });
    expect(feed).toContain(`p-${question}`);
    expect(feed).toContain(QUESTION_TITLE);
    const manifest = await buildManifest(h.db, { after: 0, k: null });
    const entry = manifest.topics.find((t) => t.id === `p-${question}`)!;
    expect(entry).toMatchObject({ md: `http://localhost:5173/t/${question}.md`, canonical: `http://localhost:5173/t/${question}` });
    expect(entry.content_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is found by the semantic search, like any topic", async () => {
    const hits = await searchEntries(h.db, QUESTION_TITLE, { readLangs: ["ja"], displayLang: "ja", llm: { env: {}, embeddingEngine } });
    expect(hits.map((x) => x.id)).toContain(question);
    // Replies appear with the thread title.
    const asked = await searchEntries(h.db, "I disagree, and here is why.", { readLangs: ["en"], displayLang: "en", llm: { env: {}, embeddingEngine } });
    expect(asked.map((x) => x.id)).toContain(reply);
  });

  it("notifies the author of the question of a reply, and a reply to a reply notifies its writer", async () => {
    const notices = await listNotifications(h.db, hana);
    expect(notices.items.map((n) => ({ entryId: n.entryId, kind: n.kind, topicTitle: n.topicTitle, actorHandle: n.actorHandle }))).toEqual([
      { entryId: reply, kind: "reply_to_topic", topicTitle: QUESTION_TITLE, actorHandle: "john" },
    ]);
    const nested = await createReply(h.db, somchai, question, { lang: "en", body: "Replying to john.", parentId: reply, stanceTag: "objection" });
    if (!nested.ok) throw new Error("reply failed");
    expect((await listNotifications(h.db, john)).items.map((n) => n.entryId)).toEqual([nested.id]);
    expect((await listNotifications(h.db, hana)).items.map((n) => n.entryId as number).sort((a, b) => a - b)).toEqual([reply, nested.id]);
  });

  it("is in the member's own export and in the observation export as an ordinary topic and reply (no title or body in the observation)", async () => {
    const own = await buildMemberExport(h.db, hana);
    const mine = (own as unknown as { entries: Array<{ id: number; kind: string; title: string | null }> }).entries;
    expect(mine.find((e) => e.id === question)).toMatchObject({ kind: "topic", title: QUESTION_TITLE });
    const johns = (await buildMemberExport(h.db, john)) as unknown as { entries: Array<{ id: number }> };
    expect(johns.entries.map((e) => e.id)).toContain(reply);
    expect(johns.entries.map((e) => e.id)).not.toContain(question);
    const observed = await buildObservationExport(h.db, { model: FAKE_EMBEDDING_MODEL, salt: Buffer.from("0".repeat(64), "hex") });
    const entry = observed.entries.find((e) => e.id === question);
    expect(entry).toMatchObject({ kind: "topic", status: "visible", lang: "ja" });
    expect(observed.entries.find((e) => e.id === reply)).toMatchObject({ kind: "reply", status: "visible", thread_id: question });
    const text = JSON.stringify(observed);
    expect(text).not.toContain(QUESTION_TITLE);
    expect(text).not.toContain("I disagree");
  });

  it("keeps a question's translation current when its title is edited before it is locked (as for any topic)", async () => {
    const { editEntry } = await import("~/lib/entries.server");
    expect(await editEntry(h.db, hana, question, { title: `${QUESTION_TITLE}（改）`, body: "ここでの「止める」とは、新しい訓練を始めないことを指す。" }, { kind: "topic", now: new Date("2026-10-01T01:00:00Z") })).toMatchObject({ ok: true, changed: true });
    const queued = (await h.db.select({ kind: jobs.kind, payload: jobs.payload, status: jobs.status }).from(jobs)).filter((j) => j.status === "queued" && (j.payload as { entryId?: number } | null)?.entryId === question);
    expect(queued.filter((j) => j.kind === "translate_entry").length).toBeGreaterThan(0);
    const stale = await h.db.select({ id: translations.id }).from(translations).where(and(eq(translations.entryId, question), eq(translations.kind, "primary")));
    expect(stale.length).toBeGreaterThan(0);
  });
});
