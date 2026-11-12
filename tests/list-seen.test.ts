import { afterEach, expect, it, vi } from "vitest";
import { rememberMemberViewingPosts, rememberViewingPosts, SEEN_POSTS_KEY, type PostsView } from "~/lib/list-seen";
import { tracksNewPosts } from "~/lib/tracks-new-posts";

const storage = () => {
  const data = new Map<string, string>();
  return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
};
const post = (id: number, day: number) => ({ id, createdAt: `2026-10-${String(day).padStart(2, "0")}T00:00:00.000Z` });
afterEach(() => vi.unstubAllGlobals());

it("uses one account exchange per viewing, including overlapping revalidation", async () => {
  let resolve!: (response: Response) => void;
  const request = vi.fn(() => new Promise<Response>(done => { resolve = done; }));
  vi.stubGlobal("fetch", request);
  const view: PostsView = {};
  const a = rememberMemberViewingPosts("/", [post(3, 13), post(1, 11)], view);
  const b = rememberMemberViewingPosts("/", [post(3, 13), post(2, 12), post(1, 11)], view);
  resolve(Response.json({ previous: post(1, 11).createdAt }));
  expect(await a).toEqual({ newIds: [3], boundaryAfter: 3 });
  expect(await b).toEqual({ newIds: [3, 2], boundaryAfter: 2 });
  expect(await rememberMemberViewingPosts("/", [post(3, 13), post(1, 11)], view)).toEqual(await a);
  expect(request).toHaveBeenCalledTimes(1);
  const [url, options] = request.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe("/list-seen");
  expect(options.method).toBe("POST");
  expect(Object.fromEntries(options.body as URLSearchParams)).toEqual({ scope: "/", seenAt: post(3, 13).createdAt });
});

it("marks no first account visit, empty list, or failed synchronization and never retries within the visit", async () => {
  const request = vi.fn();
  vi.stubGlobal("fetch", request);
  expect(await rememberMemberViewingPosts("/", [], {})).toEqual({ newIds: [], boundaryAfter: null });
  expect(request).not.toHaveBeenCalled();
  for (const response of [Response.json({ previous: null }), Response.json({ previous: "invalid" }), Response.json({ previous: 1 }), new Response("Unavailable", { status: 503 })]) {
    request.mockResolvedValue(response);
    const view: PostsView = {};
    expect(await rememberMemberViewingPosts("/", [post(2, 12)], view)).toEqual({ newIds: [], boundaryAfter: null });
    expect(await rememberMemberViewingPosts("/", [post(3, 13)], view)).toEqual({ newIds: [], boundaryAfter: null });
  }
  request.mockRejectedValue(new Error("Offline"));
  expect(await rememberMemberViewingPosts("/", [post(2, 12)], {})).toEqual({ newIds: [], boundaryAfter: null });
  expect(request).toHaveBeenCalledTimes(5);
});

it("marks nothing on a first visit, then the posts created after the newest one that was seen", () => {
  const store = storage();
  expect(rememberViewingPosts(store, "/", [post(2, 12), post(1, 11)], {})).toEqual({ newIds: [], boundaryAfter: null });
  expect(rememberViewingPosts(store, "/", [post(4, 14), post(3, 13), post(2, 12), post(1, 11)], {})).toEqual({ newIds: [4, 3], boundaryAfter: 3 });
  expect(rememberViewingPosts(store, "/", [post(4, 14), post(3, 13), post(2, 12)], {})).toEqual({ newIds: [], boundaryAfter: null });
});

it("keeps one viewing's marks through revalidation, and keeps lists apart", () => {
  const store = storage();
  rememberViewingPosts(store, "/", [post(1, 11)], {});
  const view: PostsView = {};
  expect(rememberViewingPosts(store, "/", [post(3, 13), post(2, 12), post(1, 11)], view).newIds).toEqual([3, 2]);
  expect(rememberViewingPosts(store, "/", [post(3, 13), post(2, 12), post(1, 11)], view).newIds).toEqual([3, 2]);
  expect(rememberViewingPosts(store, "/a/ja", [post(3, 13)], {}).newIds).toEqual([]);
});

it("puts no line when every post shown is new, and never lowers the remembered time", () => {
  const store = storage();
  rememberViewingPosts(store, "/", [post(5, 15)], {});
  expect(rememberViewingPosts(store, "/", [post(7, 17), post(6, 16)], {})).toEqual({ newIds: [7, 6], boundaryAfter: null });
  rememberViewingPosts(store, "/", [post(1, 11)], {});
  expect(rememberViewingPosts(store, "/", [post(7, 17)], {}).newIds).toEqual([]);
});

it("treats corrupt or blocked storage as a first visit and keeps at most 50 lists", () => {
  for (const value of ["broken", "{}", "null", '[[1,2],["/","bad"]]']) {
    const store = storage(); store.setItem(SEEN_POSTS_KEY, value);
    expect(rememberViewingPosts(store, "/", [post(1, 11)], {}).newIds).toEqual([]);
  }
  expect(rememberViewingPosts({ getItem: () => { throw new Error("blocked"); }, setItem: () => {} }, "/", [post(1, 11)], {}).newIds).toEqual([]);
  expect(rememberViewingPosts({ getItem: () => null, setItem: () => { throw new Error("full"); } }, "/", [post(1, 11)], {}).newIds).toEqual([]);
  const store = storage();
  for (let n = 0; n < 60; n++) rememberViewingPosts(store, `/v/${n}`, [post(1, 11)], {});
  expect(JSON.parse(store.getItem(SEEN_POSTS_KEY)!)).toHaveLength(50);
});

it("marks and records only the first page of the newest-first list with no filter", () => {
  expect(tracksNewPosts({ page: 1, order: "created", filtered: false })).toBe(true);
  expect(tracksNewPosts({ page: 2, order: "created", filtered: false })).toBe(false);
  expect(tracksNewPosts({ page: 1, order: "activity", filtered: false })).toBe(false);
  expect(tracksNewPosts({ page: 1, order: "insightful", filtered: false })).toBe(false);
  expect(tracksNewPosts({ page: 1, order: "created", filtered: true })).toBe(false);
});
