import { createElement } from "react";
import { TopicContinuation } from "~/components/topic-continuation";
import { renderInRouter } from "./helpers/render-in-router";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { entries, villageMembers, villages } from "~/lib/db/schema";
import { createTopic } from "~/lib/entries.server";
import { ensureLanguageVillages } from "~/lib/villages.server";
import { loader } from "~/routes/topic";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";
let h: RouteHarness, topic: number, villageId: string, languageTopic: number;
const peers: number[] = [];
beforeAll(async () => {
  h = await setupRouteHarness();
  vi.stubEnv("VILLAGES", "1"); vi.stubEnv("PUBLIC_READING", "1");
  await ensureLanguageVillages(h.db, { ENABLED_LANGS: "en" });
  await h.signIn("continuation_author", { homeArea: "en" });
  const [village] = await h.db.insert(villages).values({ slug: "continuation-village", name: "Continuation village", kind: "open" }).returning();
  villageId = village.id;
  await h.db.insert(villageMembers).values({ villageId, userId: h.ids.continuation_author });
  for (let i = 0; i < 7; i++) {
    const result = await createTopic(h.db, h.ids.continuation_author, { title: `Continuation topic ${i}`, body: "Public reading", lang: "en", village: village.slug }, { now: new Date(`2020-01-0${i === 0 ? 9 : i + 1}T00:00:00Z`) });
    if (!result.ok) throw new Error(result.error);
    if (i === 0) topic = result.id; else peers.push(result.id);
  }
  await h.db.update(entries).set({ hiddenAt: new Date() }).where(eq(entries.id, peers.at(-1)!));
  await h.db.update(entries).set({ deletedAt: new Date() }).where(eq(entries.id, peers.at(-2)!));
  for (let i = 0; i < 2; i++) {
    const result = await createTopic(h.db, h.ids.continuation_author, { title: `Language continuation ${i}`, body: "Language village reading", lang: "en", village: "en" });
    if (!result.ok) throw new Error(result.error);
    if (i === 0) languageTopic = result.id;
  }
});
afterAll(() => { h.restore(); vi.unstubAllEnvs(); });
const read = (as?: string) => loader(h.args(h.request(`/t/${topic}`, { as }), { id: String(topic) }));

it("offers the latest three public village posts to members and public readers without returning the current, hidden or deleted post", async () => {
  for (const as of [undefined, "continuation_author"]) {
    const value = await read(as) as { continuation?: { village: { slug: string }; topics: Array<{ id: number }> } };
    expect(value.continuation?.village.slug).toBe("continuation-village");
    expect(value.continuation?.topics.map(post => post.id)).toEqual(peers.slice(1, 4).reverse());
  }
});

it("reads the article village once for both its byline and continuation", async () => {
  const client = (h.db as unknown as { $client: { query: (...args: unknown[]) => unknown } }).$client;
  const spy = vi.spyOn(client, "query");
  try {
    const value = await read();
    expect(value).toHaveProperty("village.slug", "continuation-village");
    expect(value).toHaveProperty("continuation.village.slug", "continuation-village");
    const statements = spy.mock.calls.map(([query]) => typeof query === "string" ? query : (query as { text: string }).text);
    expect(statements.filter(query => /from "entries" inner join "villages"/.test(query))).toHaveLength(1);
  } finally { spy.mockRestore(); }
});

it("keeps reading exits without an empty recent-post heading or list", async () => {
  const html = await renderInRouter(() => createElement(TopicContinuation, { value: { village: { slug: "continuation-village", name: "Continuation village", description: "", language: null, kind: "open" }, topics: [] }, lang: null }));
  expect(html).not.toContain("<h2");
  expect(html).not.toContain("<ul");
  expect(html).toContain('href="/v/continuation-village"');
  expect(html).toContain('href="/"');
  expect(html).toContain('aria-label="Continuation village"');
});

it("retains public reading exits for an ended public village", async () => {
  await h.db.update(villages).set({ endedAt: new Date() }).where(eq(villages.id, villageId));
  expect(await read()).toHaveProperty("continuation.village.slug", "continuation-village");
});

it("includes a language village at the end of its public article", async () => {
  expect(await loader(h.args(h.request(`/t/${languageTopic}`), { id: String(languageTopic) }))).toHaveProperty("continuation.village.language", "en");
});

it("does not expose continuation metadata for a closed village", async () => {
  await h.db.update(villages).set({ kind: "closed", slug: null }).where(eq(villages.id, villageId));
  const result = await h.outcome(() => read());
  if (result.status === 200) expect(result.value).toHaveProperty("continuation", null);
  else expect(result.status).toBe(404);
  await h.db.update(villages).set({ kind: "open", slug: "continuation-village" }).where(eq(villages.id, villageId));
});

it("does not add village continuation data when villages are disabled", async () => {
  vi.stubEnv("VILLAGES", "");
  expect(await read()).not.toHaveProperty("continuation");
});
