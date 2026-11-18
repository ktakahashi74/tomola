import { createElement } from "react";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { m } from "~/paraglide/messages.js";
import { deleteAccount } from "~/lib/account-delete.server";
import { entries, profiles, translations, villages } from "~/lib/db/schema";
import { hasVisibleIntroduction, listIntroductions } from "~/lib/introductions.server";
import { loadMemberPageContent, resolveMemberPage } from "~/lib/member-pages.server";
import { TOPICS_PER_PAGE } from "~/lib/pagination";
import { personalVillage } from "~/lib/personal-villages.server";
import { toTopicItems } from "~/lib/topic-list.server";
import Introductions, * as route from "~/routes/introductions";
import * as memberRoute from "~/routes/member-page";
import { addMember, createTestDb } from "./helpers/db";
import { renderInRouter } from "./helpers/render-in-router";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";

vi.mock("~/paraglide/messages.js", async () => ({ m: (await import("./helpers/messages-json")).jsonMessages() }));

const now = new Date("2026-10-01T00:00:00Z");
const reading = { viewerId: "intro_reader", readLangs: ["en"] as const, displayLang: "en" as const, page: 1 };

it.each(["", "1"])("matches member-page introduction visibility with villages=%s, including suspended authors", async enabled => {
  vi.stubEnv("VILLAGES", enabled);
  const db = await createTestDb();
  const handles = ["reader", "visible", "suspended", "deleted", "hidden", "question", "reply", "foreign", "closed", "unaddressable", "personal", "departed"];
  for (const handle of handles) await addMember(db, `intro_${handle}`, `intro_${handle}`, { homeArea: "en" });
  const [closed, unaddressable] = await db.insert(villages).values([
    { kind: "closed", slug: "intro-closed", name: "Closed" },
    { kind: "open", slug: null, name: "Unaddressable" },
  ]).returning();
  const personal = (await personalVillage(db, "intro_personal"))!;
  const ids = new Map<string, number>();
  for (const handle of handles.filter(handle => handle !== "reader")) {
    const [row] = await db.insert(entries).values({
      authorId: `intro_${handle}`, kind: handle === "reply" ? "reply" : "topic", threadId: handle === "reply" ? ids.get("visible") : null,
      title: handle === "reply" ? null : handle, body: `Introduction ${handle}`, lang: "en",
      asksStance: handle === "question", deletedAt: handle === "deleted" ? now : null, hiddenAt: handle === "hidden" ? now : null,
      villageId: handle === "closed" ? closed.id : handle === "unaddressable" ? unaddressable.id : handle === "personal" ? personal.id : null,
    }).returning();
    ids.set(handle, row.id);
    await db.update(profiles).set({ introEntryId: handle === "foreign" ? ids.get("visible") : row.id }).where(eq(profiles.userId, `intro_${handle}`));
  }
  await db.update(profiles).set({ suspendedUntil: new Date("2035-01-01") }).where(eq(profiles.userId, "intro_suspended"));
  expect(await deleteAccount(db, "intro_departed", { confirmation: "intro_departed", posts: "keep" })).toMatchObject({ ok: true });
  expect(await resolveMemberPage(db, "intro_departed")).toBeNull();
  const listed = (await listIntroductions(db)).topics.map(row => row.id);
  expect(new Set(listed)).toEqual(new Set([ids.get("visible"), ids.get("suspended"), ids.get("personal")]));
  for (const handle of handles.filter(handle => handle !== "departed")) {
    const member = (await resolveMemberPage(db, `intro_${handle}`))!;
    const content = await loadMemberPageContent(db, member, reading);
    expect(await hasVisibleIntroduction(db, member.userId)).toBe(!!content.intro);
    if (content.intro) expect(listed).toContain(content.intro.id);
    else if (handle !== "foreign" && ids.has(handle)) expect(listed).not.toContain(ids.get(handle));
  }
});

it("orders by post creation and id, and paginates with the home page size", async () => {
  const db = await createTestDb();
  const expected: { id: number; stamp: number }[] = [];
  for (let i = 0; i < TOPICS_PER_PAGE + 2; i++) {
    const id = `intro_paging_${i}`;
    await addMember(db, id, id);
    const stamp = now.getTime() + (i % 3) * 1000;
    const [row] = await db.insert(entries).values({ kind: "topic", authorId: id, lang: "en", title: id, body: "Introduction", createdAt: new Date(stamp), lastActivityAt: new Date(now.getTime() + (100 - i) * 1000) }).returning();
    await db.update(profiles).set({ introEntryId: row.id }).where(eq(profiles.userId, id));
    expected.push({ id: row.id, stamp });
  }
  expected.sort((a, b) => b.stamp - a.stamp || b.id - a.id);
  const first = await listIntroductions(db);
  const second = await listIntroductions(db, { page: 2 });
  expect(first).toMatchObject({ page: 1, limit: TOPICS_PER_PAGE, hasNext: true });
  expect(second).toMatchObject({ page: 2, hasNext: false });
  expect(first.topics.map(row => row.id)).toEqual(expected.slice(0, TOPICS_PER_PAGE).map(row => row.id));
  expect(second.topics.map(row => row.id)).toEqual(expected.slice(TOPICS_PER_PAGE).map(row => row.id));
  expect((await listIntroductions(db, { page: 3 })).topics).toEqual([]);
  await expect(listIntroductions(db, { page: 0 })).rejects.toThrow(RangeError);
});

let h: RouteHarness;
beforeAll(async () => {
  h = await setupRouteHarness();
  await h.signIn("intro_route_reader", { homeArea: "en", readLangs: ["en"] });
  await h.signIn("intro_pending", { profile: false });
});
afterAll(() => h?.restore());
const load = (as?: string, query = "") => h.outcome(() => route.loader(h.args(h.request(`/introductions${query}`, { as }))));

it.each(["", "1"])("uses the same membership gate and cache middleware as member pages with public reading=%s", async publicReading => {
  vi.stubEnv("PUBLIC_READING", publicReading);
  for (const as of [undefined, "intro_pending"]) {
    const result = await load(as);
    const member = await h.outcome(() => memberRoute.loader(h.args(h.request("/u/intro_route_reader", { as }), { handle: "intro_route_reader" })));
    expect(result.status).toBe(member.status);
    const destination = new URL(result.location!, "http://localhost");
    expect(destination.pathname).toBe(new URL(member.location!, "http://localhost").pathname);
    if (!as) expect(destination.searchParams.get("next")).toBe("/introductions");
  }
  expect(route.middleware[0]).toBe(memberRoute.middleware[0]);
  expect(route.headers()).toEqual(memberRoute.headers());
  expect((await load("intro_route_reader", "?page=0")).status).toBe(404);
});

it("shows the empty list and writing prompt only until the reader has a visible introduction", async () => {
  const render = async () => {
    const loaded = await route.loader(h.args(h.request("/introductions", { as: "intro_route_reader" })));
    return renderInRouter(() => createElement(Introductions, { loaderData: loaded } as never), "/introductions");
  };
  const empty = await render();
  expect(empty).toContain(m.introductions_empty());
  expect(empty).toContain('href="/t/new?intro=1"');
  const [row] = await h.db.insert(entries).values({ kind: "topic", authorId: h.ids.intro_route_reader, lang: "ja", title: null, body: "読みたい話題", sourceHash: "intro-title-source" }).returning();
  await h.db.update(profiles).set({ introEntryId: row.id }).where(eq(profiles.userId, h.ids.intro_route_reader));
  await h.db.insert(translations).values({ entryId: row.id, field: "body", lang: "en", kind: "primary", text: "A translated introduction", sourceHash: row.sourceHash, mentionRevision: row.mentionRevision, engine: "fake", model: "fake-1" });
  const loaded = await route.loader(h.args(h.request("/introductions", { as: "intro_route_reader" })));
  const homeItems = await toTopicItems(h.db, (await listIntroductions(h.db)).topics, { readLangs: ["en"], displayLang: "en" });
  expect(loaded.topics).toEqual(homeItems);
  const html = await render();
  expect(html).not.toContain("data-introduction-prompt");
  expect(html).toContain(`href="/t/${row.id}"`);
  expect(html).toContain('href="/u/intro_route_reader"');
  expect(html).toContain('data-remark="true"');
  expect(html).toContain("A translated introduction");
  expect(html).not.toContain("<img");
  await h.db.update(entries).set({ hiddenAt: now }).where(eq(entries.id, row.id));
  expect(await render()).toContain("data-introduction-prompt");
});
