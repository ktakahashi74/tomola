import { createElement } from "react";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { m } from "~/paraglide/messages.js";
import { messageMarkup } from "./helpers/message-markup";
import { createReply, createTopic } from "~/lib/entries.server";
import { setFollow } from "~/lib/follows.server";
import { setVillageFollow } from "~/lib/village-follows.server";
import { TOPICS_PER_PAGE } from "~/lib/pagination";
import type { TopicItem } from "~/lib/topic-list.server";
import { parseBlocks } from "./helpers/md";
import { renderInRouter } from "./helpers/render-in-router";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";

vi.mock("~/paraglide/messages.js", async () => ({ m: (await import("./helpers/messages-json")).jsonMessages() }));

let h: RouteHarness;
let longId: number;
let remarkId: number;

beforeAll(async () => {
  h = await setupRouteHarness();
  for (const handle of ["anna", "ben", "cara"]) await h.signIn(handle, { homeArea: "ja", readLangs: ["ja"] });
  const long = await createTopic(h.db, h.ids.anna, { lang: "ja", title: "Followed long post", body: `\`${"x".repeat(5000)}ATOMTAIL\`` }, { now: new Date("2030-01-01T01:39:00Z") });
  if (!long.ok) throw new Error("topic failed");
  longId = long.id;
  await setFollow(h.db, h.ids.ben, long.id, true);
  for (let i = 0; i < TOPICS_PER_PAGE; i++) {
    const topic = await createTopic(h.db, h.ids.anna, { lang: "ja", title: i === 0 ? null : `Followed post ${i}`, body: "A short body." }, { now: new Date(Date.UTC(2030, 0, 1, 0, i)) });
    if (!topic.ok) throw new Error("topic failed");
    await setFollow(h.db, h.ids.ben, topic.id, true);
    if (i === 0) remarkId = topic.id;
  }
  const reply = await createReply(h.db, h.ids.anna, remarkId, { lang: "ja", body: "A recent reply moves the oldest remark first." }, { now: new Date("2030-01-01T02:00:00Z") });
  if (!reply.ok) throw new Error("reply failed");
});
afterAll(() => h.restore());

const load = async (page: number, as = "ben", query = "&all=1") => {
  const { loader } = await import("~/routes/following");
  return await loader(h.args(h.request(`/following?page=${page}${query}`, { as }))) as unknown as { topics: TopicItem[]; hasNext: boolean; aiOpen: { mdPath: string } };
};

it("uses shared rows with no card actions and keeps follow lists private", async () => {
  const data = await load(1);
  const row = data.topics.find(t => t.id === longId)!;
  expect(row.title.text).toBe("Followed long post");
  expect(row).not.toHaveProperty("body");
  expect(row).not.toHaveProperty("followState");
  const { default: Following } = await import("~/routes/following");
  const html = await renderInRouter(() => createElement(Following as never, { loaderData: data, actionData: undefined, params: {}, matches: [] } as never), "/following");
  expect(html).toContain(`<li id="q-${longId}"`);
  expect(html).not.toMatch(/action="\/(?:follow|vote)"|<article|ATOMTAIL/);
  expect((await load(1, "cara")).topics).toEqual([]);
});

it("ignores unsupported order and long filters in both twins and carries only the supported query to the Markdown alternate", async () => {
  const { loader } = await import("~/routes/following-md");
  const { meta } = await import("~/routes/following");
  for (const query of ["&order=created&long=1", "&order=invalid&long=1"]) {
    for (const page of [1, 2]) {
      const screen = await load(page, "ben", `${query}&all=1`);
      const normal = await load(page);
      expect(screen.topics.map(t => t.id)).toEqual(normal.topics.map(t => t.id));
      if (page === 1) expect(screen.topics[0].id).toBe(remarkId);
      const response = await loader(h.args(h.request(`/following.md?page=${page}&all=1${query}`, { as: "ben" }))) as Response;
      expect(response.status).toBe(200);
      const [index, footer] = parseBlocks(await response.text());
      expect((parse(index.body) as Array<{ id: string }>).map(t => t.id)).toEqual(screen.topics.map(t => `p-${t.id}`));
      expect(index.fm.order).toBe("activity");
      expect(index.fm).not.toHaveProperty("titled_only");
      expect(index.fm.canonical).not.toMatch(/order=|long=/);
      if (page === 1) {
        expect(footer.fm.next).toMatch(/page=2/);
        expect(new URL(String(footer.fm.next)).searchParams.get("all")).toBe("1");
      }
      expect(String(footer.fm.next)).not.toMatch(/order=|long=/);
    }
  }
  const metadata = meta({ location: { search: "?order=created&long=1&asks=1&lang=ja&page=2" } } as never);
  expect(metadata).toContainEqual(expect.objectContaining({ rel: "alternate", href: "/following.md?lang=ja&asks=1&page=2" }));
  const all = meta({ location: { search: "?all=1&asks=1&lang=en&page=2" } } as never);
  expect(all).toContainEqual(expect.objectContaining({ rel: "alternate", href: "/following.md?lang=en&asks=1&all=1&page=2" }));
});

it("pages the screen and its Markdown twin thirty at a time in the same activity order", async () => {
  const { loader } = await import("~/routes/following-md");
  for (const page of [1, 2]) {
    const screen = await load(page);
    expect(screen.topics).toHaveLength(page === 1 ? TOPICS_PER_PAGE : 1);
    expect(screen.hasNext).toBe(page === 1);
    const response = await loader(h.args(h.request(`/following.md?page=${page}&all=1`, { as: "ben" }))) as Response;
    const [index] = parseBlocks(await response.text());
    const topics = parse(index.body) as Array<{ id: string }>;
    expect(topics.map(t => t.id)).toEqual(screen.topics.map(t => `p-${t.id}`));
    expect(index.fm.order).toBe("activity");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  }
});

it("shows the new-reply indicator next to the total in a following row", async () => {
  const data = await load(1);
  const row = data.topics.find(t => t.id === remarkId)!;
  expect(row.newReplies).toMatchObject({ count: 1, href: expect.stringMatching(new RegExp(`^/t/${remarkId}#c-`)) });
  const { default: Following } = await import("~/routes/following");
  const html = await renderInRouter(() => createElement(Following as never, { loaderData: data, actionData: undefined, params: {}, matches: [] } as never), "/following");
  const block = html.split(`<li id="q-${remarkId}"`)[1]?.split("</li>")[0] ?? "";
  expect(block).toContain(`href="${row.newReplies!.href}"`);
  const total = messageMarkup(m.home_replies({ count: row.replyCount }));
  const fresh = messageMarkup(m.following_new_replies({ count: 1 }));
  expect(block).toContain(total);
  expect(block).toContain(fresh);
  expect(block.indexOf(fresh)).toBeGreaterThan(block.indexOf(total));
});

it("ignores old village-page values in the screen, alternate and AI twin", async () => {
  vi.stubEnv("VILLAGES", "1");
  try {
    expect(await setVillageFollow(h.db, h.ids.ben, "@anna", true)).toEqual({ ok: true });
    const { loader } = await import("~/routes/following-md");
    const { meta } = await import("~/routes/following");
    for (const value of ["1", "2", "bad", "-1"]) {
      const query = `?all=1&vpage=${value}`;
      const alternate = meta({ location: { search: query } } as never).find(tag => "rel" in tag && tag.rel === "alternate") as { href: string };
      const screen = await load(1, "ben", `&all=1&vpage=${value}`);
      expect(screen).not.toHaveProperty("followedVillages");
      expect(screen.topics.map(t => t.id)).toEqual((await load(1)).topics.map(t => t.id));
      for (const url of [`/following.md${query}`, alternate.href, screen.aiOpen.mdPath]) {
        const response = await loader(h.args(h.request(url, { as: "ben" }))) as Response;
        expect(response.status).toBe(200);
        const blocks = parseBlocks(await response.text());
        expect(blocks).toHaveLength(2);
        expect((parse(blocks[0].body) as Array<{ id: string; slug?: string }>).map(row => row.id)).toEqual(screen.topics.map(t => `p-${t.id}`));
      }
      for (const url of [alternate.href, screen.aiOpen.mdPath]) {
        const params = new URL(url, "http://fixture.invalid").searchParams;
        expect(params.get("vpage")).toBeNull();
        expect(params.get("all")).toBe("1");
      }
    }
  } finally { vi.unstubAllEnvs(); }
});
