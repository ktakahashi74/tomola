import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { entries } from "~/lib/db/schema";
import { createReply, createTopic, getThread, replyLocation, softDeleteEntry } from "~/lib/entries.server";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";

let h: RouteHarness;
beforeAll(async () => {
  h = await setupRouteHarness();
  await h.signIn("branch_author", { homeArea: "en", readLangs: ["en"] });
  await h.signIn("branch_reader", { homeArea: "en", readLangs: ["en"] });
});
afterAll(() => h.restore());
async function topic() {
  const result = await createTopic(h.db, h.ids.branch_author, { lang: "en", title: "Branches", body: "A question", asksStance: true });
  if (!result.ok) throw new Error(result.error);
  return result.id;
}
async function reply(threadId: number, parentId?: number) {
  const result = await createReply(h.db, h.ids.branch_author, threadId, { lang: "en", body: "Branch reply", parentId, stanceTag: "agree" });
  if (!result.ok) throw new Error(result.error);
  return result.id;
}
async function load(id: number, query = "") {
  const { loader } = await import("~/routes/topic");
  return loader(h.args(h.request(`/t/${id}${query}`, { as: "branch_reader" }), { id: String(id) }));
}
it("groups only the screen while retaining chronological getThread order and flat filtered pages", async () => {
  const id = await topic(), a = await reply(id), b = await reply(id), child = await reply(id, a), deep = await reply(id, child);
  expect((await getThread(h.db, id))!.replies.map(r => r.id)).toEqual([a, b, child, deep]);
  const screen = await load(id);
  expect(screen.replies.map(r => r.id)).toEqual([a, b, child, deep]);
  expect(screen.replyBranches!.map(b => b.replyIds)).toEqual([[a, child, deep], [b]]);
  expect(screen.replyBranches![0].suppressParentIds).toEqual([child]);
  expect((await load(id, "?tag=agree")).replyBranches).toBeNull();
  expect((await load(id, "?tag=agree")).replies.map(r => r.id)).toEqual([a, b, child, deep]);
});
it("retains the 100-row boundary, parent destinations and the root link of a continuation", async () => {
  const id = await topic(), root = await reply(id);
  const skipped = await h.db.insert(entries).values(Array.from({ length: 99 }, () => ({ kind: "reply" as const, threadId: id, authorId: h.ids.branch_author, lang: "en" as const, body: "Skipped deleted row", deletedAt: new Date() }))).returning({ id: entries.id });
  const child = await reply(id, root), deep = await reply(id, child);
  const first = await load(id), second = await load(id, "?page=2&lang=en");
  expect(first.replies.map(r => r.id)).toEqual([root]);
  expect(second.replies.map(r => r.id)).toEqual([child, deep]);
  expect(second.replyBranches).toMatchObject([{ rootId: root, replyIds: [child, deep], root: { state: "visible", href: `/t/${id}?lang=en#c-${root}` }, suppressParentIds: [child] }]);
  expect(await replyLocation(h.db, id, child)).toBe(`/t/${id}?page=2#c-${child}`);
  expect(skipped).toHaveLength(99);
  await h.db.update(entries).set({ hiddenAt: new Date() }).where(eq(entries.id, root));
  expect((await load(id, "?page=2")).replyBranches).toMatchObject([{ root: { state: "unavailable" } }]);
  expect(JSON.stringify((await load(id, "?page=2")).replyBranches)).not.toContain("branch_author");
  await softDeleteEntry(h.db, root);
  expect((await load(id, "?page=2")).replyBranches).toMatchObject([{ root: { state: "deleted" }, replyIds: [child, deep] }]);
});
it("does not resurrect deleted roots without placeholders or expose hidden ancestors", async () => {
  const id = await topic(), root = await reply(id), middle = await reply(id, root), leaf = await reply(id, middle);
  await h.db.update(entries).set({ hiddenAt: new Date() }).where(eq(entries.id, root));
  expect((await load(id)).replies.find(r => r.id === root)).toEqual({ id: root, placeholder: "hidden" });
  await softDeleteEntry(h.db, middle);
  await softDeleteEntry(h.db, root);
  const screen = await load(id);
  expect(screen.replies.map(r => r.id)).toEqual([middle, leaf]);
  expect(screen.replyBranches).toMatchObject([{ rootId: root, replyIds: [middle, leaf], root: { state: "deleted" }, suppressParentIds: [] }]);
  expect(JSON.stringify(screen.replyBranches)).not.toContain("branch_author");
  await h.db.update(entries).set({ hiddenAt: new Date() }).where(inArray(entries.id, [leaf]));
  expect((await load(id)).replies.find(r => r.id === leaf)).toEqual({ id: leaf, placeholder: "hidden" });
});
it("opens only query-selected folded replies on the server", async () => {
  const id = await topic(), root = await reply(id);
  const children: number[] = [];
  for (let i = 0; i < 7; i++) children.push(await reply(id, root));
  const target = children.at(-1)!;
  expect((await load(id, `#c-${target}`)).replyBranches![0].open).toBe(false);
  expect((await load(id, `?reply_to=c-${target}`)).replyBranches![0].open).toBe(true);
  expect((await load(id, `?posted=${target}`)).replyBranches![0].open).toBe(true);
  expect((await load(id, `?reply_to=c-${root}`)).replyBranches![0].open).toBe(false);
});

it("keeps every displayed reply when raw parent topology is missing, cross-topic or cyclic", async () => {
  const id = await topic(), other = await topic(), outside = await reply(other);
  const missing = await reply(id), cross = await reply(id), a = await reply(id), b = await reply(id), downstream = await reply(id);
  await h.db.update(entries).set({ parentId: outside }).where(eq(entries.id, cross));
  await h.db.update(entries).set({ parentId: b }).where(eq(entries.id, a));
  await h.db.update(entries).set({ parentId: a }).where(inArray(entries.id, [b, downstream]));
  // A topic in a different thread is absent from this thread's reply-only map.
  await h.db.update(entries).set({ parentId: other }).where(eq(entries.id, missing));
  const screen = await load(id);
  expect(screen.replyBranches!.map(b => b.replyIds)).toEqual([[missing], [cross], [a], [b], [downstream]]);
  expect(screen.replies.map(r => r.id)).toEqual([missing, cross, a, b, downstream]);
});

it("does not rank reply locations for top-level roots already on this page", async () => {
  const id = await topic();
  await reply(id);
  await reply(id);
  const locations = await import("~/lib/reply-locations.server");
  const read = vi.spyOn(locations, "loadReplyLocations");
  try {
    await load(id);
    expect(read).toHaveBeenCalled();
    expect(read.mock.calls.every(args => args[2].length === 0)).toBe(true);
  } finally { read.mockRestore(); }
});
