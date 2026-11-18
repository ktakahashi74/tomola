import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createElement } from "react";
import { profiles, rateLimits, villages } from "~/lib/db/schema";
import { deleteAccount } from "~/lib/account-delete.server";
import { searchMembers } from "~/lib/member-search.server";
import { m } from "~/paraglide/messages.js";
import { MAX_QUERY_LENGTH } from "~/lib/search";
import { addMember } from "./helpers/db";
import { getMd } from "./helpers/md";
import { renderInRouter } from "./helpers/render-in-router";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";

let h: RouteHarness;
let route: typeof import("~/routes/search");
beforeAll(async () => {
  h = await setupRouteHarness();
  route = await import("~/routes/search");
  await h.signIn("seeker", { homeArea: "en", readLangs: ["en"] });
  await h.db.insert(villages).values({ kind: "open", slug: "search-village", name: "Search village" });
  const add = async (handle: string, displayName: string | null = null, displayNameLatin: string | null = null) => {
    await addMember(h.db, `member-${handle}`, handle);
    await h.db.update(profiles).set({ displayName, displayNameLatin }).where(eq(profiles.handle, handle));
  };
  await add("rank", "Ranked exact");
  await add("rank_z", "Ranked prefix");
  await add("rank_a");
  await add("aaa_named", "Ranked name");
  await add("zzz_named", null, "Ranked Latin");
  await add("native_name", "小川さくら", "Sakura Ogawa");
  await add("width_name", "Ａｌｐｈａ ｶﾀｶﾅ", "Beta Writer");
  await add("wild_name", "Literal % _ \\ Letters");
  await add("plain_name", "Literal X Y Z Letters");
  await add("snake_case");
  await add("snakexcase");
  for (let i = 0; i < 12; i++) await add(`cap${String(i).padStart(2, "0")}`, "Shared cap name");
});
afterAll(() => h.restore());

const handles = async (query: string) => (await searchMembers(h.db, query)).map(row => row.handle);
const load = async (query: string, suffix = "") => route.loader(h.args(h.request(`/search?q=${encodeURIComponent(query)}${suffix}`, { as: "seeker" })));
const dataOf = (value: Awaited<ReturnType<typeof load>>) => "data" in value ? value.data : value;

describe("member matching", () => {
  it("matches handle prefixes, including @, case and full-width forms, and includes the reader", async () => {
    for (const query of ["rank", "@rank", "ＲＡＮＫ", "＠ＲＡＮＫ"]) {
      expect((await handles(query)).slice(0, 3)).toEqual(["rank", "rank_a", "rank_z"]);
    }
    expect(await handles("seeker")).toEqual(["seeker"]);
    expect(await handles("ank_z")).toEqual([]);
    expect(await handles("@")).toEqual([]);
  });

  it("matches substrings in both name fields with NFKC and case normalization", async () => {
    for (const query of ["川さ", "KURA O", "ｓａｋｕｒａ"]) expect(await handles(query)).toEqual(["native_name"]);
    for (const query of ["alpha", "ＡＬＰＨＡ", "カタカナ", "ｶﾀｶﾅ", "ETA W", "ｅｔａ ｗ"]) expect(await handles(query)).toEqual(["width_name"]);
    expect(await handles("never-matches-a-member")).toEqual([]);
  });

  it("treats percent, underscore and backslash as literal characters in names and handles", async () => {
    for (const query of ["%", "_", "\\", "％", "＿", "＼"]) {
      const found = await handles(query);
      expect(found).toEqual(["wild_name"]);
    }
    expect(await handles("snake_")).toEqual(["snake_case"]);
    expect(await handles("snake%")).toEqual([]);
    expect(await handles("snake\\")).toEqual([]);
  });

  it("orders exact handles, handle prefixes and names, then handles within each group", async () => {
    expect(await handles("rank")).toEqual(["rank", "rank_a", "rank_z", "aaa_named", "zzz_named"]);
    expect(await handles("@rank")).toEqual(["rank", "rank_a", "rank_z"]);
  });

  it("returns at most ten members", async () => {
    expect(await handles("cap")).toEqual(Array.from({ length: 10 }, (_, i) => `cap${String(i).padStart(2, "0")}`));
    expect(await handles("Shared cap")).toEqual(Array.from({ length: 10 }, (_, i) => `cap${String(i).padStart(2, "0")}`));
  });

  it("keeps suspended members, drops departed members and does not match cleared names", async () => {
    await addMember(h.db, "member_departed", "departed_search");
    await h.db.update(profiles).set({ displayName: "Departed Search Name" }).where(eq(profiles.handle, "departed_search"));
    expect(await handles("Departed Search")).toEqual(["departed_search"]);
    await deleteAccount(h.db, "member_departed", { confirmation: "departed_search", posts: "keep" });
    expect(await handles("departed_search")).toEqual([]);
    expect(await handles("Departed Search")).toEqual([]);
    await h.db.update(profiles).set({ suspendedUntil: new Date(Date.now() + 86_400_000) }).where(eq(profiles.handle, "width_name"));
    expect(await handles("Alpha")).toEqual(["width_name"]);
    await h.db.update(profiles).set({ displayName: null, displayNameLatin: null }).where(eq(profiles.handle, "width_name"));
    expect(await handles("Alpha")).toEqual([]);
    expect(await handles("Beta")).toEqual([]);
    expect(await handles("width_name")).toEqual(["width_name"]);
  });
});

describe("member results on the search screen", () => {
  it("renders selected display names and handles above post results, with no avatars", async () => {
    const screen = dataOf(await load("川さ"));
    expect(screen.members).toEqual([{ handle: "native_name", name: "Sakura Ogawa" }]);
    const html = await renderInRouter(() => createElement(route.default, { loaderData: screen } as never), "/search");
    const memberSection = html.slice(html.indexOf('<section aria-labelledby="search-members-heading"'), html.indexOf("</section>") + 10);
    expect(memberSection).toContain('href="/u/native_name"');
    expect(memberSection).toContain("Sakura Ogawa");
    expect(memberSection.replace(/<[^>]*>/g, "")).toContain("Sakura Ogawa @native_name");
    expect(memberSection).not.toContain("<img");
    expect(html).toMatch(/<section aria-labelledby="search-members-heading"[\s\S]*?<\/section><section class="space-y-2">/);
    expect(html).toContain(m.search_no_results());
  });

  it("omits the section without matches and for village-scoped searches", async () => {
    for (const suffix of ["&village=search-village", "&village=@seeker", "&village=missing-village", "&village="]) {
      expect(dataOf(await load("rank", suffix))).toMatchObject({ state: "results", members: [] });
    }
    const screen = dataOf(await load("never-matches-a-member"));
    const html = await renderInRouter(() => createElement(route.default, { loaderData: screen } as never), "/search");
    expect(html).not.toContain("search-members-heading");
  });

  it("validates queries and uses exactly one existing search allowance", async () => {
    const key = `member:search:${h.ids.seeker}`;
    await h.db.delete(rateLimits).where(eq(rateLimits.key, key));
    const screen = dataOf(await load("rank"));
    expect(screen.members).toHaveLength(5);
    const counts = async () => h.db.select().from(rateLimits).where(eq(rateLimits.key, key));
    expect((await counts())[0].count).toBe(1);
    expect(dataOf(await load("x".repeat(MAX_QUERY_LENGTH + 1)))).toMatchObject({ state: "too_long", members: [] });
    expect(dataOf(await load(" "))).toMatchObject({ state: "start", members: [] });
    expect((await counts())[0].count).toBe(1);
  });

  it("keeps member matches out of Markdown and text results", async () => {
    for (const extension of ["md", "txt"]) {
      const response = await getMd(h, `/search.${extension}?q=Ogawa&lang=en`, { as: "seeker" });
      expect(response.status).toBe(200);
      const text = await response.text();
      for (const privateResult of ["native_name", "Sakura Ogawa", "/u/native_name"]) expect(text).not.toContain(privateResult);
    }
  });
});
