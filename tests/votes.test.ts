import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { entries, profiles, user, votes } from "~/lib/db/schema";
import { createReply, createTopic } from "~/lib/entries.server";
import { changeHomeArea } from "~/lib/profiles.server";
import { loadReactions, setVote } from "~/lib/votes.server";
import { addMember, createTestDb } from "./helpers/db";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";

async function world() {
  const db = await createTestDb();
  await addMember(db, "author", "hana", { homeArea: "ja" });
  await addMember(db, "ja2", "jiro", { homeArea: "ja" });
  await addMember(db, "en1", "john", { homeArea: "en", readLangs: ["en"] });
  await addMember(db, "th1", "somchai", { homeArea: "th", readLangs: ["th"] });
  await addMember(db, "fr1", "marie", { homeArea: "fr", readLangs: ["fr"] });
  await addMember(db, "ot1", "kim", { homeArea: "other", readLangs: ["en"] });
  const topic = await createTopic(db, "author", { lang: "ja", title: "話題", body: "本文" });
  if (!topic.ok) throw new Error("topic failed");
  return { db, topicId: topic.id };
}

describe("setVote", () => {
  it("adds and removes a vote idempotently and stores the voter's home area at that time", async () => {
    const { db, topicId } = await world();
    expect(await setVote(db, "en1", topicId, true)).toEqual({ ok: true, voted: true, changed: true });
    expect(await setVote(db, "en1", topicId, true)).toEqual({ ok: true, voted: true, changed: false });
    const rows = await db.select().from(votes);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ entryId: topicId, voterId: "en1", voterArea: "en" });
    expect(await setVote(db, "en1", topicId, false)).toEqual({ ok: true, voted: false, changed: true });
    expect(await setVote(db, "en1", topicId, false)).toEqual({ ok: true, voted: false, changed: false });
    expect(await db.select().from(votes)).toHaveLength(0);
  });

  it("does not let members vote on their own posts, deleted posts or posts that do not exist", async () => {
    const { db, topicId } = await world();
    const reply = await createReply(db, "en1", topicId, { lang: "en", body: "reply" });
    if (!reply.ok) throw new Error("reply failed");
    expect(await setVote(db, "author", topicId, true)).toEqual({ ok: false, error: "own_entry" });
    expect(await setVote(db, "en1", reply.id, true)).toEqual({ ok: false, error: "own_entry" });
    expect(await setVote(db, "author", reply.id, true)).toMatchObject({ ok: true });
    expect(await setVote(db, "en1", 987654, true)).toEqual({ ok: false, error: "not_found" });
    await db.update(entries).set({ deletedAt: new Date() }).where(eq(entries.id, reply.id));
    expect(await setVote(db, "ja2", reply.id, true)).toEqual({ ok: false, error: "not_found" });
    expect(await setVote(db, "nobody", topicId, true)).toEqual({ ok: false, error: "no_profile" });
    // Replies under deleted topics cannot receive votes either.
    const live = await createReply(db, "en1", topicId, { lang: "en", body: "another" });
    if (!live.ok) throw new Error("reply failed");
    await db.update(entries).set({ deletedAt: new Date() }).where(eq(entries.id, topicId));
    expect(await setVote(db, "ja2", live.id, true)).toEqual({ ok: false, error: "not_found" });
    expect(await setVote(db, "ja2", topicId, true)).toEqual({ ok: false, error: "not_found" });
    expect(await db.select().from(votes).where(eq(votes.voterId, "author"))).toHaveLength(1);
  });

  it("keeps voter_area when the member changes home area afterwards; a new vote uses the area at that time", async () => {
    const { db, topicId } = await world();
    await setVote(db, "en1", topicId, true);
    await db.update(profiles).set({ homeArea: "de" }).where(eq(profiles.userId, "en1"));
    // Repeating "付ける" for an existing vote does not rewrite its area.
    await setVote(db, "en1", topicId, true);
    expect((await db.select().from(votes).where(eq(votes.voterId, "en1")))[0].voterArea).toBe("en");
    expect((await loadReactions(db, [{ id: topicId }], null)).get(topicId)?.insightful).toEqual({ total: 1, langs: 1 });
    // Removing and re-adding uses the current area.
    await setVote(db, "en1", topicId, false);
    await setVote(db, "en1", topicId, true);
    expect((await db.select().from(votes).where(eq(votes.voterId, "en1")))[0].voterArea).toBe("de");
  });
});

describe("loadReactions", () => {
  const target = (id: number) => ({ id });

  it("gives the total and the number of languages, and nothing per language", async () => {
    const { db, topicId } = await world();
    for (const voter of ["th1", "ja2", "en1", "ot1", "fr1"]) await setVote(db, voter, topicId, true);
    expect((await loadReactions(db, [target(topicId)], "en1")).get(topicId)).toEqual({ insightful: { total: 5, langs: 5 }, mine: true });
    // removing one press lowers both numbers (the Thai member was the only one from that language)
    await setVote(db, "th1", topicId, false);
    await addMember(db, "ja3", "jun", { homeArea: "ja" });
    await setVote(db, "ja3", topicId, true);
    // two members from the same language count twice in the total and once in the languages
    const r = (await loadReactions(db, [target(topicId)], "en1")).get(topicId)!;
    expect(r.insightful).toEqual({ total: 5, langs: 4 });
    // the shape has no place for a per-language count: the reaction has two fields and the count has two
    expect(Object.keys(r).sort()).toEqual(["insightful", "mine"]);
    expect(Object.keys(r.insightful).sort()).toEqual(["langs", "total"]);
    expect(r.mine).toBe(true);
    expect((await loadReactions(db, [target(topicId)], "th1")).get(topicId)?.mine).toBe(false);
    expect((await loadReactions(db, [target(topicId)], null)).get(topicId)?.mine).toBe(false);
    expect((await loadReactions(db, [], "en1")).size).toBe(0);
  });

  it("gives 0 and 0 for a post nobody pressed, and counts each post on its own", async () => {
    const { db, topicId } = await world();
    const reply = await createReply(db, "en1", topicId, { lang: "en", body: "reply" });
    if (!reply.ok) throw new Error("reply failed");
    await setVote(db, "th1", reply.id, true);
    await setVote(db, "ja2", reply.id, true);
    const got = await loadReactions(db, [target(topicId), target(reply.id)], null);
    expect(got.get(topicId)).toEqual({ insightful: { total: 0, langs: 0 }, mine: false });
    expect(got.get(reply.id)).toEqual({ insightful: { total: 2, langs: 2 }, mine: false });
  });

  it("counts the language a member had when pressing it, so a later change of home area moves nothing", async () => {
    const { db, topicId } = await world();
    await setVote(db, "en1", topicId, true);
    await setVote(db, "th1", topicId, true);
    await changeHomeArea(db, "en1", "th");
    expect((await loadReactions(db, [target(topicId)], null)).get(topicId)?.insightful).toEqual({ total: 2, langs: 2 });
    // pressing it again does not rewrite the stored area either
    await setVote(db, "en1", topicId, true);
    expect((await db.select().from(votes).where(eq(votes.voterId, "en1")))[0].voterArea).toBe("en");
    expect((await loadReactions(db, [target(topicId)], null)).get(topicId)?.insightful).toEqual({ total: 2, langs: 2 });
  });

  it("does not count members under exclude_reactions, in the total or in the languages, but still shows them their own press", async () => {
    const { db, topicId } = await world();
    for (const voter of ["th1", "ja2", "en1"]) await setVote(db, voter, topicId, true);
    await db.update(profiles).set({ reactionsExcludedAt: new Date() }).where(eq(profiles.userId, "th1"));
    expect((await loadReactions(db, [target(topicId)], "ja2")).get(topicId)?.insightful).toEqual({ total: 2, langs: 2 });
    // the excluded member's own view still shows that they pressed it (the exclusion changes the counts, not their screen)
    expect((await loadReactions(db, [target(topicId)], "th1")).get(topicId)).toEqual({ insightful: { total: 2, langs: 2 }, mine: true });
    // taking the exclusion off brings them back
    await db.update(profiles).set({ reactionsExcludedAt: null }).where(eq(profiles.userId, "th1"));
    expect((await loadReactions(db, [target(topicId)], "ja2")).get(topicId)?.insightful).toEqual({ total: 3, langs: 3 });
  });

  it("does not count a cross-area number any more: only the total and the number of languages exist", async () => {
    const { db, topicId } = await world();
    await createReply(db, "en1", topicId, { lang: "en", body: "reply" });
    await setVote(db, "th1", topicId, true);
    const r = (await loadReactions(db, [target(topicId)], null)).get(topicId)!;
    expect(r).not.toHaveProperty("crossArea");
    expect(r).not.toHaveProperty("votes");
    expect(r.insightful).toEqual({ total: 1, langs: 1 });
  });
});

describe("POST /vote", () => {
  let h: RouteHarness;
  let topicId: number;
  let replyId: number;
  beforeAll(async () => {
    h = await setupRouteHarness();
    await h.signIn("hana", { homeArea: "ja" });
    await h.signIn("somchai", { homeArea: "th", readLangs: ["th", "ja"] });
    await h.signIn("john", { homeArea: "en", readLangs: ["en", "ja"] });
    const topic = await createTopic(h.db, h.ids.hana, { lang: "ja", title: "話題", body: "本文" });
    if (!topic.ok) throw new Error("topic failed");
    topicId = topic.id;
    const reply = await createReply(h.db, h.ids.somchai, topicId, { lang: "th", body: "ตอบ" });
    if (!reply.ok) throw new Error("reply failed");
    replyId = reply.id;
  });
  afterAll(() => h.restore());

  const vote = (who: string | undefined, form: Record<string, string>, headers: Record<string, string> = {}) =>
    import("~/routes/vote").then(({ action }) => h.outcome(() => action(h.args(h.request("/vote", { as: who, form, headers })))));

  it("requires a login and a same-origin request, and rejects bad input", async () => {
    expect(await vote(undefined, { entryId: String(topicId), on: "1" })).toMatchObject({ status: 302, location: "/login" });
    expect((await vote("somchai", { entryId: String(topicId), on: "1" }, { origin: "https://evil.example" })).status).toBe(403);
    expect((await vote("somchai", { entryId: String(topicId), on: "1" }, { origin: "null" })).status).toBe(403);
    expect((await h.db.select().from(votes)).length).toBe(0);
    const bad: Array<Record<string, string>> = [{ on: "1" }, { entryId: "abc", on: "1" }, { entryId: "0", on: "1" }, { entryId: "1e2", on: "1" }, { entryId: String(topicId) }, { entryId: String(topicId), on: "2" }];
    for (const form of bad) {
      expect((await vote("somchai", form)).status, JSON.stringify(form)).toBe(400);
    }
    expect((await vote("somchai", { entryId: "999999", on: "1" })).status).toBe(404);
    expect((await vote("hana", { entryId: String(topicId), on: "1" })).status).toBe(403);
  });

  it("answers a fetcher with data (the post's new Insightful state) and a plain form post with a redirect back (sanitized)", async () => {
    // the answer is data with Cache-Control: private, no-store (it carries the member's own press state)
    const body = (outcome: { value?: unknown }) => (outcome.value as { data: Record<string, unknown> }).data;
    const asData = await vote("somchai", { entryId: String(topicId), on: "1" });
    expect(asData.status).toBe(200);
    expect(body(asData)).toEqual({ ok: true, entryId: topicId, voted: true, reactions: { insightful: { total: 1, langs: 1 }, mine: true }, at: expect.any(String) });
    expect((asData.value as { init?: { headers?: Record<string, string> } }).init?.headers).toEqual({ "Cache-Control": "private, no-store" });
    // the time of the answer is a real ISO time, taken after the numbers were read
    expect(Number.isNaN(Date.parse(body(asData).at as string))).toBe(false);
    // a second member's press from another language raises both numbers, and the answer says nothing per language
    const second = await vote("john", { entryId: String(topicId), on: "1" });
    expect(body(second)).toMatchObject({ voted: true, reactions: { insightful: { total: 2, langs: 2 }, mine: true } });
    expect(Object.keys(body(second).reactions as Record<string, unknown>).sort()).toEqual(["insightful", "mine"]);
    const removed = await vote("somchai", { entryId: String(topicId), on: "0" });
    expect(body(removed)).toMatchObject({ voted: false, reactions: { insightful: { total: 1, langs: 1 }, mine: false } });
    await vote("john", { entryId: String(topicId), on: "0" });
    await vote("somchai", { entryId: String(topicId), on: "1" });
    // Browser navigation uses Sec-Fetch-Dest: document, or Accept: text/html for older clients.
    const html = { "sec-fetch-dest": "document", accept: "text/html,application/xhtml+xml" };
    const back = await vote("somchai", { entryId: String(topicId), on: "0", returnTo: `/t/${topicId}?lang=th#p-${topicId}` }, html);
    expect(back).toMatchObject({ status: 302, location: `/t/${topicId}?lang=th#p-${topicId}` });
    // Paths that normalize to "//evil.example…" must not leave the site either.
    for (const returnTo of ["//evil.example/x", "https://evil.example", "/\\evil.example", "", "/.//evil.example/x", "/%2e//evil.example", "/a/..//evil.example"]) {
      expect((await vote("somchai", { entryId: String(topicId), on: "1", returnTo }, html)).location, returnTo).toBe("/");
    }
    await vote("somchai", { entryId: String(topicId), on: "0" });
  });

  it("decides between a redirect and data by the kind of request, not by Accept alone", async () => {
    const form = { entryId: String(topicId), on: "1", returnTo: `/t/${topicId}` };
    // Fetch requests are data requests when Sec-Fetch-Dest is empty, even if Accept contains text/html.
    expect((await vote("somchai", form, { "sec-fetch-dest": "empty", accept: "text/html" })).status).toBe(200);
    // For clients without Sec-Fetch-Dest, use Accept.
    expect((await vote("somchai", form, { accept: "text/html" })).status).toBe(302);
    expect((await vote("somchai", form, { accept: "*/*" })).status).toBe(200);
    expect((await vote("somchai", form, { "sec-fetch-dest": "document", accept: "*/*" })).status).toBe(302);
    await vote("somchai", { entryId: String(topicId), on: "0" });
  });

  it("shows the Insightful total and the number of languages on the thread page and in the list, with my own press and no button on my own posts", async () => {
    await vote("somchai", { entryId: String(topicId), on: "1" });
    await vote("john", { entryId: String(topicId), on: "1" });
    await vote("hana", { entryId: String(replyId), on: "1" });
    const { loader } = await import("~/routes/topic");
    type Reactions = { insightful: { total: number; langs: number }; mine: boolean };
    type Thread = { topic: { own: boolean; reactions: Reactions }; replies: Array<{ own: boolean; reactions: Reactions }> };
    const asJohn = (await loader(h.args(h.request(`/t/${topicId}`, { as: "john" }), { id: String(topicId) }))) as unknown as Thread;
    expect(asJohn.topic.reactions).toEqual({ insightful: { total: 2, langs: 2 }, mine: true });
    expect(asJohn.topic.own).toBe(false);
    expect(asJohn.replies[0].reactions).toEqual({ insightful: { total: 1, langs: 1 }, mine: false });
    const asHana = (await loader(h.args(h.request(`/t/${topicId}`, { as: "hana" }), { id: String(topicId) }))) as unknown as Thread;
    expect(asHana.topic.own).toBe(true);
    expect(asHana.topic.reactions.mine).toBe(false);
    expect(asHana.replies[0]).toMatchObject({ own: false });
    // the list shows the same two numbers for the topic (and no state of the viewer)
    const { loader: latest } = await import("~/routes/latest");
    const list = (await latest(h.args(h.request("/latest", { as: "john" })))) as unknown as { topics: Array<{ id: number; insightful: { total: number; langs: number } }> };
    const item = list.topics.find((t) => t.id === topicId)!;
    expect(item.insightful).toEqual({ total: 2, langs: 2 });
    // The list exposes aggregate counts without anyone's individual press state.
    expect(item).not.toHaveProperty("mine");
    expect(item).not.toHaveProperty("reactions");
    expect(Object.keys(item.insightful).sort()).toEqual(["langs", "total"]);
    expect(Object.keys(asJohn.topic.reactions).sort()).toEqual(["insightful", "mine"]);
  });
});
