import { eq } from "drizzle-orm";
import { parse } from "yaml";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { entries, profiles, votes } from "~/lib/db/schema";
import { createReply, createTopic, listTopics } from "~/lib/entries.server";
import { parseOrderParam } from "~/lib/params.server";
import { loadReactions, setVote } from "~/lib/votes.server";
import { addMember, createTestDb } from "./helpers/db";
import { getMd, parseBlocks } from "./helpers/md";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";

let h: RouteHarness;
const ids: number[] = [];
beforeAll(async () => {
  h = await setupRouteHarness();
  for (const [handle, homeArea] of [["writer", "ja"], ["voter_a", "ja"], ["voter_b", "en"], ["excluded", "th"]] as const) {
    await h.signIn(handle, { homeArea });
  }
  for (let i = 0; i < 7; i++) {
    const topic = await createTopic(h.db, h.ids.writer, {
      lang: i === 2 ? "en" : "ja", body: `Fixture body ${i}`,
      ...(i === 4 ? {} : { title: `Fixture ${i}` }), asksStance: i === 3,
    }, { now: new Date(Date.UTC(2030, 0, 1, 0, i === 2 ? 1 : i)) });
    if (!topic.ok) throw new Error(topic.error);
    ids.push(topic.id);
  }
  for (const who of ["voter_a", "voter_b"]) await setVote(h.db, h.ids[who], ids[0], true);
  for (const id of [ids[1], ids[2], ids[5], ids[6]]) await setVote(h.db, h.ids.voter_a, id, true);
  await setVote(h.db, h.ids.excluded, ids[3], true);
  await h.db.update(profiles).set({ reactionsExcludedAt: new Date() }).where(eq(profiles.userId, h.ids.excluded));
  const reply = await createReply(h.db, h.ids.writer, ids[4], { lang: "ja", body: "Popular reply" });
  if (!reply.ok) throw new Error(reply.error);
  for (const who of ["voter_a", "voter_b"]) await setVote(h.db, h.ids[who], reply.id, true);
  await h.db.update(entries).set({ hiddenAt: new Date() }).where(eq(entries.id, ids[5]));
  await h.db.update(entries).set({ deletedAt: new Date() }).where(eq(entries.id, ids[6]));
});
afterAll(() => { h.restore(); vi.unstubAllEnvs(); });
const orderedIds = (rows: { id: number }[]) => rows.map(row => row.id);
const expected = () => [ids[0], ids[2], ids[1], ids[4], ids[3]];

it("orders counted topic reactions across languages, ties by creation/id, and keeps zero counts", async () => {
  const result = await listTopics(h.db, { kind: "all" }, { order: "insightful" });
  expect(orderedIds(result.topics)).toEqual(expected());
  const reactions = await loadReactions(h.db, result.topics, null);
  expect(result.topics.map(topic => reactions.get(topic.id)!.insightful.total)).toEqual([2, 1, 1, 0, 0]);
  expect(reactions.get(ids[0])!.insightful.langs).toBe(2);
  // Excluded marks and marks on replies cannot lift a zero-count topic.
  expect(reactions.get(ids[3])!.insightful.total).toBe(0);
  expect(reactions.get(ids[4])!.insightful.total).toBe(0);
});

it("paginates without losing equal and zero counts", async () => {
  const pages = await Promise.all([1, 2, 3].map(page => listTopics(h.db, { kind: "all" }, { order: "insightful", page, limit: 2 })));
  expect(pages.map(page => page.hasNext)).toEqual([true, true, false]);
  expect(pages.flatMap(page => orderedIds(page.topics))).toEqual(expected());
});

it("keeps the same visibility, source-language and topic filters as the existing orders", async () => {
  for (const opts of [{}, { asksOnly: true }, { titledOnly: true }, { asksOnly: true, titledOnly: true }]) {
    for (const scope of [{ kind: "all" }, { kind: "langs", langs: ["ja"] }, { kind: "langs", langs: ["en"] }] as const) {
      const sorted = await listTopics(h.db, scope, { ...opts, order: "insightful" });
      const created = await listTopics(h.db, scope, { ...opts, order: "created" });
      expect(orderedIds(sorted.topics).sort()).toEqual(orderedIds(created.topics).sort());
    }
  }
  const viewer = { userId: h.ids.writer, scope: { operator: false, langs: [] } };
  const visible = await listTopics(h.db, { kind: "all" }, { order: "insightful", viewer });
  expect(orderedIds(visible.topics)).toContain(ids[5]);
  expect(orderedIds(visible.topics)).not.toContain(ids[6]);
});

it("accepts the new parameter while retaining defaults and rejecting unknown values", () => {
  expect(parseOrderParam("insightful")).toBe("insightful");
  for (const value of [null, ""]) expect(parseOrderParam(value)).toBeNull();
  for (const value of ["INSIGHTFUL", "popular", "newest"]) expect(parseOrderParam(value)).toBe("invalid");
});

it("returns the same public/member ordering, row counts, and Markdown list order", async () => {
  vi.stubEnv("PUBLIC_READING", "1");
  const { loader } = await import("~/routes/home");
  for (const as of [undefined, "voter_a", "voter_b"]) {
    const screen = await loader(h.args(h.request("/?order=insightful", { as }))) as unknown as { topics: { id: number; insightful: { total: number } }[] };
    expect(orderedIds(screen.topics)).toEqual(expected());
    expect(screen.topics.map(topic => topic.insightful.total)).toEqual([2, 1, 1, 0, 0]);
  }
  for (const [path, wanted] of [["/home.md", expected()], ["/latest.md", expected()], ["/a/ja.md", expected().filter(id => id !== ids[2])]] as const) {
    const response = await getMd(h, `${path}?order=insightful`);
    expect(response.status).toBe(200);
    const block = parseBlocks(await response.text())[0];
    expect(block.fm.order).toBe("insightful");
    const items = parse(block.body) as { id: string; insightful: number }[];
    expect(items.map(item => Number(item.id.slice(2)))).toEqual(wanted);
  }
});

it("queries a trial-scale list without stored count columns", async () => {
  const db = await createTestDb();
  await addMember(db, "scale-author", "scale_author");
  for (let i = 0; i < 6; i++) await addMember(db, `scale-voter-${i}`, `scale_voter_${i}`);
  const topics = await db.insert(entries).values(Array.from({ length: 500 }, (_, i) => ({
    kind: "topic" as const, lang: "ja", authorId: "scale-author", title: `Scale ${i}`, body: "Scale fixture",
    createdAt: new Date(Date.UTC(2030, 0, 1, 0, i)),
  }))).returning({ id: entries.id });
  await db.insert(votes).values(topics.flatMap(topic => Array.from({ length: 6 }, (_, i) => ({ entryId: topic.id, voterId: `scale-voter-${i}`, voterArea: "ja" }))));
  const start = performance.now();
  const page = await listTopics(db, { kind: "all" }, { order: "insightful", limit: 20 });
  const elapsed = performance.now() - start;
  expect(page.hasNext).toBe(true);
  expect(orderedIds(page.topics)).toEqual(topics.slice(-20).reverse().map(topic => topic.id));
  console.info(`Insightful trial-scale query: ${elapsed.toFixed(2)} ms (500 topics / 3000 votes)`);
});
