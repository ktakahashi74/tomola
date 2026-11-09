import { createElement } from "react";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { entries, notifications, villages } from "~/lib/db/schema";
import { createReply, createTopic } from "~/lib/entries.server";
import { setFollow } from "~/lib/follows.server";
import { hasUnreadFollowedThread } from "~/lib/notifications.server";
import { m } from "~/paraglide/messages.js";
import { parseBlocks } from "./helpers/md";
import { messageMarkup } from "./helpers/message-markup";
import { renderInRouter } from "./helpers/render-in-router";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";

vi.mock("~/paraglide/messages.js", async () => ({ m: (await import("./helpers/messages-json")).jsonMessages() }));

let h: RouteHarness;
let quiet: number, fresh: number, question: number;
const screen = async (as = "reader", query = "") => {
  const { loader } = await import("~/routes/following");
  return loader(h.args(h.request(`/following${query}`, { as })));
};
const markdown = async (as = "reader", query = "") => {
  const { loader } = await import("~/routes/following-md");
  const response = await loader(h.args(h.request(`/following.md${query}`, { as }))) as Response;
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  return parseBlocks(await response.text());
};
const ids = (data: Awaited<ReturnType<typeof screen>>) => data.topics.map(t => t.id);
const mdIds = (blocks: Awaited<ReturnType<typeof markdown>>) => {
  const rows = parse(blocks[0].body);
  return Array.isArray(rows) ? rows.map((row: { id: string }) => Number(row.id.slice(2))) : [];
};
const render = async (as: string, query = "") => {
  const { default: Following } = await import("~/routes/following");
  const data = await screen(as, query);
  return renderInRouter(() => createElement(Following, { loaderData: data } as never), `/following${query}`);
};
async function topic(title: string, reader: string, asksStance = false) {
  const result = await createTopic(h.db, h.ids.writer, { title, body: "Followed post fixture.", lang: "en", asksStance });
  if (!result.ok) throw new Error(result.error);
  await setFollow(h.db, h.ids[reader], result.id, true);
  return result.id;
}
async function reply(id: number) {
  const result = await createReply(h.db, h.ids.writer, id, { body: "A new reply.", lang: "en" });
  if (!result.ok) throw new Error(result.error);
}

beforeAll(async () => {
  h = await setupRouteHarness();
  for (const handle of ["writer", "reader", "quiet", "empty"]) await h.signIn(handle, { homeArea: "en" });
  quiet = await topic("Quiet post", "reader");
  await setFollow(h.db, h.ids.quiet, quiet, true);
  fresh = await topic("Fresh post", "reader");
  question = await topic("Fresh question", "reader", true);
  await reply(fresh);
  await reply(question);
});
afterAll(() => h.restore());

it("isolates each member's Markdown follows and refuses anonymous reads", async () => {
  const { loader } = await import("~/routes/following-md");
  const refused = await loader(h.args(h.request("/following.md"))) as Response;
  expect(refused.status).toBe(401);
  expect(mdIds(await markdown("empty", "?all=1"))).toEqual([]);
  expect(mdIds(await markdown("reader", "?all=1"))).toContain(fresh);
  expect(mdIds(await markdown("quiet", "?all=1"))).toEqual([quiet]);
});

it("defaults to unread replies in activity order in both twins without marking anything read", async () => {
  expect(ids(await screen())).toEqual([question, fresh]);
  expect(mdIds(await markdown())).toEqual([question, fresh]);
  expect((await markdown())[0].fm.unread_only).toBe(true);
  expect(await hasUnreadFollowedThread(h.db, h.ids.reader)).toBe(true);
  expect(ids(await screen())).toEqual([question, fresh]);
  expect(ids(await screen("reader", "?all=invalid"))).toEqual([question, fresh]);
});

it("includes quiet posts with all=1 and combines either view with questions only", async () => {
  expect(ids(await screen("reader", "?all=1"))).toEqual([question, fresh, quiet]);
  expect(mdIds(await markdown("reader", "?all=1"))).toEqual([question, fresh, quiet]);
  for (const query of ["?asks=1", "?all=1&asks=1"]) {
    expect(ids(await screen("reader", query))).toEqual([question]);
    expect(mdIds(await markdown("reader", query))).toEqual([question]);
  }
  const all = await markdown("reader", "?all=1");
  expect(all[0].fm.unread_only).toBe(false);
  expect(all[0].fm.canonical).toMatch(/\/following\?all=1$/);
});

it("distinguishes a quiet list from no followed posts and links to all while keeping the question and language filters", async () => {
  const quietHtml = await render("quiet", "?asks=1&lang=en&page=2");
  expect(quietHtml).toContain(messageMarkup(m.following_no_new_replies()));
  expect(quietHtml).not.toContain(messageMarkup(m.following_empty()));
  expect(quietHtml).toContain('href="/following?asks=1&amp;lang=en&amp;all=1"');
  const emptyHtml = await render("empty");
  expect(emptyHtml).toContain(messageMarkup(m.following_empty()));
  expect(await hasUnreadFollowedThread(h.db, h.ids.quiet)).toBe(false);
  expect(ids(await screen("quiet"))).toEqual([]);
  expect(ids(await screen("quiet", "?all=1"))).toEqual([quiet]);
});

it.each(["unfollowed", "hidden", "deleted", "closed", "unaddressable"])("keeps the dot and both default twins empty for an %s post with a leftover unread notice", async state => {
  const reader = `edge_${state}`;
  await h.signIn(reader, { homeArea: "en" });
  const id = await topic(`Excluded ${state}`, reader);
  await reply(id);
  expect(await hasUnreadFollowedThread(h.db, h.ids[reader])).toBe(true);
  expect(ids(await screen(reader))).toEqual([id]);
  if (state === "unfollowed") await setFollow(h.db, h.ids[reader], id, false);
  else if (state === "hidden") await h.db.update(entries).set({ hiddenAt: new Date() }).where(eq(entries.id, id));
  else if (state === "deleted") await h.db.update(entries).set({ deletedAt: new Date() }).where(eq(entries.id, id));
  else {
    const [village] = await h.db.insert(villages).values({ kind: state === "closed" ? "closed" : "open", name: `Unread ${state}` }).returning();
    await h.db.update(entries).set({ villageId: village.id }).where(eq(entries.id, id));
  }
  expect((await h.db.select().from(notifications).where(eq(notifications.userId, h.ids[reader]))).some(row => row.kind === "followed_thread" && row.readAt === null)).toBe(true);
  expect(await hasUnreadFollowedThread(h.db, h.ids[reader])).toBe(false);
  expect(ids(await screen(reader))).toEqual([]);
  expect(mdIds(await markdown(reader))).toEqual([]);
});

it("does not show hidden unread posts to their author in the default list", async () => {
  const reader = "hidden_author";
  await h.signIn(reader, { homeArea: "en" });
  const result = await createTopic(h.db, h.ids[reader], { title: "Hidden own post", body: "Body.", lang: "en" });
  if (!result.ok) throw new Error(result.error);
  // A followed-thread notice can remain from before a role or ownership change.
  await h.db.insert(notifications).values({ userId: h.ids[reader], kind: "followed_thread", threadId: result.id, entryId: result.id });
  await h.db.update(entries).set({ hiddenAt: new Date() }).where(eq(entries.id, result.id));
  expect(await hasUnreadFollowedThread(h.db, h.ids[reader])).toBe(false);
  expect(ids(await screen(reader))).toEqual([]);
  expect(mdIds(await markdown(reader))).toEqual([]);
  expect(ids(await screen(reader, "?all=1"))).toEqual([result.id]);
});
