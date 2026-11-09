import { afterEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { entries, entryEmbeddings, jobs, topicListingStats, villages } from "~/lib/db/schema";
import { loadMemberPageContent } from "~/lib/member-pages.server";
import { buildManifest } from "~/lib/md/manifest.server";
import { buildStancesMarkdown } from "~/lib/md/stances.server";
import { buildRelatedMarkdown } from "~/lib/md/related.server";
import { setFollow } from "~/lib/follows.server";
import { findSimilar } from "~/lib/search.server";
import { addChatTopicCards } from "~/lib/village-chat-topics.server";
import { chatParts, type ActiveChatMessage } from "~/lib/village-chat";
import { reconcileMissingTranslations } from "~/lib/jobs/translation-backfill.server";
import { listTopics } from "~/lib/entries.server";
import { RENDER_VERSION } from "~/lib/markdown.server";
import { sourceHash } from "~/lib/source-hash.server";
import { addMember, createTestDb } from "./helpers/db";
import { setupRouteHarness } from "./helpers/route-harness";
import type { Db } from "~/lib/db/client.server";

afterEach(() => vi.unstubAllEnvs());

async function world(existingDb?: Db, owner = "place_owner") {
  const db = existingDb ?? await createTestDb();
  if (owner === "place_owner") await addMember(db, owner, owner);
  const [closed, unaddressable] = await db.insert(villages).values([
    { kind: "closed", slug: "secret-place" }, { kind: "open" },
  ]).returning();
  const make = async (title: string, villageId: string | null, asksStance = true) => (await db.insert(entries).values({
    kind: "topic", authorId: owner, villageId, lang: "ja", title, body: `${title} body`,
    sourceHash: sourceHash(title, `${title} body`, "ja"), html: `<p>${title}</p>`, htmlVersion: RENDER_VERSION, asksStance,
  }).returning())[0];
  const secret = await make("secret-place-title", closed.id);
  const noSlug = await make("unaddressable-place-title", unaddressable.id);
  const publicTopic = await make("Public topic", null);
  const [reply] = await db.insert(entries).values({ kind: "reply", authorId: owner, threadId: secret.id, lang: "ja", body: "secret-place-reply", sourceHash: sourceHash(null, "secret-place-reply", "ja") }).returning();
  return { db, owner, secret, noSlug, publicTopic, reply };
}

it("omits closed and unaddressable topics from member posts and introductions, including the author's own page", async () => {
  const w = await world();
  for (const topic of [w.secret, w.noSlug]) {
    await w.db.update(entries).set({ asksStance: false }).where(eq(entries.id, topic.id));
    const page = await loadMemberPageContent(w.db, { userId: w.owner, handle: w.owner, introEntryId: topic.id }, { viewerId: w.owner, readLangs: ["ja"], displayLang: "ja", page: 1 });
    expect(page.topics.map(row => row.id)).toEqual([w.publicTopic.id]);
    expect(page.intro).toBeNull();
  }
});

it("keeps private topics and alternatives out of manifest identifiers and hashes", async () => {
  const w = await world();
  const before = await buildManifest(w.db, { after: 0, k: null });
  expect(before.topics.map(topic => topic.id)).toEqual([`p-${w.publicTopic.id}`]);
  await w.db.update(entries).set({ altOf: w.publicTopic.id }).where(eq(entries.id, w.secret.id));
  expect((await buildManifest(w.db, { after: 0, k: null })).topics).toEqual(before.topics);
});

it("does not reveal private topics through follows or standalone stance and related twins", async () => {
  const w = await world();
  for (const topic of [w.secret, w.noSlug]) {
    expect(await setFollow(w.db, w.owner, topic.id, true, { viewer: { userId: w.owner, scope: { operator: true, langs: [] } } })).toEqual({ ok: false, error: "not_found" });
    expect(await buildStancesMarkdown(w.db, topic.id, { kind: "member", userId: w.owner })).toBeNull();
    expect(await buildRelatedMarkdown(w.db, topic.id, { page: 1, lang: "ja", k: null })).toBeNull();
  }
});

it("returns 404 for the related-discussion screen of a private topic", async () => {
  const h = await setupRouteHarness();
  try {
    const owner = await h.signIn("related_private");
    const w = await world(h.db, owner);
    const route = await import("~/routes/topic-related");
    for (const topic of [w.secret, w.noSlug]) expect(await h.outcome(() => route.loader(h.args(h.request(`/t/${topic.id}/related`, { as: "related_private" }), { id: String(topic.id) })))).toMatchObject({ status: 404 });
  } finally { h.restore(); }
});

it("filters private roots and their replies before semantic-search limits are applied", async () => {
  const w = await world();
  const vector = [1, ...Array(767).fill(0)];
  await w.db.insert(entryEmbeddings).values([w.secret, w.reply, w.noSlug, w.publicTopic].map(row => ({ entryId: row.id, model: "place-test", dim: 768, embedding: vector, sourceHash: row.sourceHash! })));
  expect((await findSimilar(w.db, vector, "place-test")).map(row => row.id)).toEqual([w.publicTopic.id]);
});

it("uses the same public-place condition for chat topic cards", async () => {
  const w = await world();
  vi.stubEnv("VILLAGES", "1"); vi.stubEnv("VILLAGE_CHAT", "1"); vi.stubEnv("BETTER_AUTH_URL", "https://tomola.example");
  const message: ActiveChatMessage = { id: "private-topic-links", author: "member", own: true, lang: "ja", parts: chatParts([w.secret, w.noSlug, w.publicTopic].map(topic => `https://tomola.example/t/${topic.id}`).join(" ")), createdSeq: 1, changedSeq: 1, createdAt: new Date().toISOString(), edited: false, deleted: false, hidden: false, translation: null };
  const [result] = await addChatTopicCards(w.db, [message], { displayLang: "ja", readLangs: ["ja"] });
  expect(!result.deleted && result.topics?.map(topic => topic.id)).toEqual([w.publicTopic.id]);
});

it("does not queue external translations of replies whose root is private", async () => {
  const w = await world();
  const result = await reconcileMissingTranslations(w.db, { env: { TRANSLATION_BACKFILL_ENABLED: "1", ENABLED_LANGS: "ja,en" } });
  expect(result).toBe(1);
  const queued = await w.db.select().from(jobs);
  expect(queued.length).toBeGreaterThan(0);
  for (const row of queued) expect(row.payload).toMatchObject({ entryId: w.publicTopic.id });
});

it("lists newest topics without requiring derived rows, including deep page boundaries and scopes", async () => {
  const w = await world();
  const newer = await w.db.insert(entries).values([0, 1].map(n => ({ kind: "topic", authorId: w.owner, lang: "ja", title: `Newer ${n}`, body: "Public body", asksStance: true, createdAt: new Date("2030-01-01") }))).returning();
  await w.db.delete(topicListingStats);
  const expected = [newer[1].id, newer[0].id, w.publicTopic.id];
  for (const scope of [{ kind: "all" }, { kind: "langs", langs: ["ja"] }] as const) {
    for (const [index, id] of expected.entries()) expect((await listTopics(w.db, scope, { order: "created", asksOnly: true, page: index + 1, limit: 1 })).topics.map(row => row.id)).toEqual([id]);
    expect((await listTopics(w.db, scope, { order: "created", page: 4, limit: 1 })).topics).toEqual([]);
  }
});
