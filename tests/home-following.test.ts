import { afterEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { DELETED_MEMBER_EMAIL, DELETED_MEMBER_ID } from "~/lib/deleted-member";
import { entries, listSeen, notifications, profiles, user, villageFollows, villages } from "~/lib/db/schema";
import { buildMemberExport } from "~/lib/exports.server";
import { setMemberFollow } from "~/lib/member-follows.server";
import { personalVillage } from "~/lib/personal-villages.server";
import { createApiToken } from "~/lib/tokens.server";
import { setVillageFollow } from "~/lib/village-follows.server";
import { action as setHome, headers, loader as loadHome } from "~/routes/home";
import { action as delegate } from "~/routes/open-in-ai-link";
import { getMd } from "./helpers/md";
import { setupRouteHarness } from "./helpers/route-harness";
import { action as see } from "~/routes/list-seen";

afterEach(() => vi.unstubAllEnvs());

it("combines own, village and author topics and preserves access boundaries across browser and Markdown", async () => {
  vi.stubEnv("PUBLIC_READING", "1");
  vi.stubEnv("VILLAGES", "1");
  vi.stubEnv("ENABLED_LANGS", "en,ja");
  const h = await setupRouteHarness();
  try {
    const reader = await h.signIn("quartz_reader", { homeArea: "other" });
    const organization = await h.signIn("quartz_org", { homeArea: "other" });
    const writer = await h.signIn("quartz_writer", { homeArea: "other" });
    await h.db.insert(user).values({ id: DELETED_MEMBER_ID, email: DELETED_MEMBER_EMAIL, name: "" });
    const home = async (query = "", as = "quartz_reader") => loadHome(h.args(h.request(`/${query}`, { as })));
    const add = async (title: string, authorId: string, villageId: string, state: { hiddenAt?: Date; deletedAt?: Date } = {}) => {
      const [row] = await h.db.insert(entries).values({ kind: "topic", lang: "en", authorId, villageId, title, body: title, ...state }).returning({ id: entries.id });
      return row.id;
    };
    const [shared, ended, closed] = await h.db.insert(villages).values([
      { kind: "open", slug: "quartz-organization", name: "Quartz" },
      { kind: "open", slug: "quartz-ended", endedAt: new Date() },
      { kind: "closed", slug: "quartz-closed" },
    ]).returning();
    const own = await add("Own public topic", reader, (await personalVillage(h.db, reader))!.id);
    const both = await add("Both sources", organization, shared.id);
    const person = await add("Author only", organization, (await personalVillage(h.db, organization))!.id);
    const place = await add("Village only", writer, shared.id);
    await add("Unrelated author", writer, (await personalVillage(h.db, writer))!.id);
    const excluded = [await add("Departed author", DELETED_MEMBER_ID, shared.id)];
    for (const author of [reader, organization, writer]) {
      excluded.push(await add("Ended-place topic", author, ended.id), await add("Closed-place topic", author, closed.id));
      excluded.push(await add("Hidden topic", author, shared.id, { hiddenAt: new Date() }), await add("Deleted topic", author, shared.id, { deletedAt: new Date() }));
    }
    await h.db.insert(entries).values({ kind: "reply", lang: "en", authorId: organization, threadId: own, body: "Organization reply" });
    await h.db.insert(villageFollows).values([ended, closed].map(v => ({ userId: reader, villageId: v.id })));
    const follow = (on: boolean) => setVillageFollow(h.db, reader, shared.slug!, on);
    const followAuthor = (on: boolean) => setMemberFollow(h.db, reader, organization, on);
    expect(await setMemberFollow(h.db, reader, reader, true)).toEqual({ ok: false, error: "not_found" });
    expect(await setMemberFollow(h.db, reader, DELETED_MEMBER_ID, true)).toEqual({ ok: false, error: "not_found" });
    expect(await setMemberFollow(h.db, reader, "missing-author", true)).toEqual({ ok: false, error: "not_found" });
    await follow(true);
    await followAuthor(true);
    const bodies = async (query: string) => (await home(query)).topics.map(t => t.id);
    for (const order of ["created", "activity", "insightful"]) {
      const ids = await bodies(`?scope=following&order=${order}`);
      expect(ids.sort((a, b) => a - b)).toEqual([own, both, person, place]);
    }
    await follow(false);
    expect(await bodies("?scope=following")).toEqual([person, both, own]);
    await followAuthor(false);
    expect(await bodies("?scope=following")).toEqual([own]);
    await follow(true);
    expect(await bodies("?scope=following")).toEqual([place, both, own]);
    await followAuthor(true);
    expect(await h.db.select().from(notifications)).toEqual([]);
    const exported = await buildMemberExport(h.db, reader);
    expect(exported.version).toBe(18);
    expect(exported.member_follows).toEqual([{ handle: "quartz_org", created_at: expect.any(String) }]);
    expect(exported.village_follows).toEqual(expect.arrayContaining([{ village: "quartz-organization", created_at: expect.any(String) }]));
    expect(exported.village_follows.some(row => row.village === "quartz-closed" || row.village.startsWith("@"))).toBe(false);
    expect((await buildMemberExport(h.db, organization)).member_follows).toEqual([]);


    expect((await home()).scope).toBe("all");
    expect((await home("?follow=1")).scope).toBe("following");
    expect((await home("?scope=all&follow=1")).scope).toBe("all");
    expect((await home()).scope).toBe("all");
    expect(await h.outcome(() => home("?scope=wrong"))).toMatchObject({ status: 400 });
    const form = { intent: "home-scope", scope: "following" };
    const save = (path = "/", headers?: Record<string, string>) => h.outcome(() => setHome(h.args(h.request(path, { as: "quartz_reader", form, headers }))));
    expect(await save("/", { origin: "https://other.example" })).toMatchObject({ status: 403 });
    await h.db.update(profiles).set({ suspendedUntil: new Date(Date.now() + 60_000) }).where(eq(profiles.userId, reader));
    expect(await save("/?scope=all&follow=1&order=activity&asks=1&long=1&lang=en&page=3&list_after=old")).toMatchObject({ status: 303, location: "/?order=activity&asks=1&long=1&lang=en" });
    expect(await home()).toMatchObject({ scope: "following", aiOpen: { mdPath: expect.stringContaining("scope=following") } });
    expect(await home("?scope=all")).toMatchObject({ scope: "all", aiOpen: { mdPath: expect.not.stringContaining("scope=") } });
    expect((await home()).scope).toBe("following");
    expect((await home("", "quartz_org")).scope).toBe("all");
    expect(await loadHome(h.args(h.request("/?scope=following")))).toMatchObject({ scope: "all", followingAvailable: false });
    expect(new Headers(headers()).get("Cache-Control")).toContain("private");

    for (const path of ["/home.md?scope=following", "/home.txt?follow=1"]) {
      expect((await getMd(h, path)).status).toBe(401);
      const response = await getMd(h, path, { as: "quartz_reader" });
      expect(response.status).toBe(200);
      expect(response.headers.get("Cache-Control")).toContain("private");
      const markdown = await response.text();
      for (const id of [own, both, person, place]) expect(markdown).toMatch(new RegExp(`p-${id}["'\\s]`));
      for (const id of excluded) expect(markdown).not.toMatch(new RegExp(`p-${id}["'\\s]`));
      expect(markdown).not.toContain("Organization reply");
    }
    expect(await (await getMd(h, "/home.md", { as: "quartz_reader" })).text()).toContain("Unrelated author");
    const token = await createApiToken(h.db, reader, { name: "Fixture reader", kind: "read" });
    if (!token.ok) throw new Error(token.error);
    expect(await (await getMd(h, "/home.md?scope=following", { headers: { authorization: `Bearer ${token.token}` } })).text()).toContain("Author only");
    const issued = await delegate(h.args(h.request("/open-in-ai-link", { as: "quartz_reader", form: { path: "/home.md?scope=following" } })));
    const { url } = await issued.json() as { url: string };
    const delegated = new URL(url);
    expect(delegated.searchParams.has("k")).toBe(true);
    const response = await getMd(h, url);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toContain("private");
    delegated.searchParams.set("scope", "all");
    expect((await getMd(h, delegated.href)).status).toBe(401);

    const watermark = (scope: string, seenAt: string) => see(h.args(h.request("/list-seen", { as: "quartz_reader", form: { scope, seenAt } })));
    await watermark("/", "2026-01-01T00:00:00.000Z");
    await watermark("/?scope=following", "2026-01-02T00:00:00.000Z");
    const seen = () => h.db.select().from(listSeen).where(eq(listSeen.userId, reader)).orderBy(listSeen.scope);
    const before = await seen();
    expect(before.map(row => [row.scope, row.seenAt.toISOString()])).toEqual([
      ["/", "2026-01-01T00:00:00.000Z"], ["/?scope=following", "2026-01-02T00:00:00.000Z"],
    ]);
    await getMd(h, "/home.md?scope=following", { as: "quartz_reader" });
    expect(await seen()).toEqual(before);

    vi.stubEnv("VILLAGES", "0");
    for (const query of ["", "?scope=following", "?follow=1"]) expect(await home(query)).toMatchObject({ scope: "all", followingAvailable: false });
    expect(await save()).toMatchObject({ status: 404 });
    expect((await getMd(h, "/home.md?scope=following", { as: "quartz_reader" })).status).toBe(404);
    expect((await getMd(h, "/home.txt?follow=1", { as: "quartz_reader" })).status).toBe(404);
    vi.stubEnv("VILLAGES", "1");
    expect((await home()).scope).toBe("following");
    expect((await home("?scope=following&asks=1")).topics).toEqual([]);
    expect((await home("?scope=following&long=1")).topics.map(t => t.id)).toContain(person);
  } finally {
    h.restore();
  }
});
