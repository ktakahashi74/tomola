import { createElement } from "react";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { entries, handleHolds, profiles } from "~/lib/db/schema";
import { createReply, createTopic } from "~/lib/entries.server";
import { changeHandle } from "~/lib/profiles.server";
import { setStance } from "~/lib/stances.server";
import MemberPage, * as memberRoute from "~/routes/member-page";
import TopicNew, { loader as newLoader, action as newAction } from "~/routes/topic-new";
import { loader as topicLoader, action as topicAction } from "~/routes/topic";
import { renderInRouter } from "./helpers/render-in-router";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";

vi.mock("~/paraglide/messages.js", async () => ({ m: (await import("./helpers/messages-json")).jsonMessages() }));

let h: RouteHarness;
let introId: number;
let plainId: number;
let questionId: number;
let replyId: number;
let signedId: number;
let signedQuestionId: number;
let foreignId: number;
const now = new Date("2026-10-05T00:00:00Z");
const must = <T extends { ok: boolean }>(result: T): Extract<T, { ok: true }> => {
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result as Extract<T, { ok: true }>;
};
const unwrap = <T = Record<string, unknown>>(value: unknown): T => ((value as { data?: unknown })?.data ?? value) as T;
type PageData = {
  handle: string; own: boolean; page: number; hasNext: boolean;
  intro: null | { id: number; lang: string; title: string | null; headline: string | null; html: string; display: unknown };
  topics: Array<{ id: number; lang: string; title: { text: string }; createdAtISO: string }>;
};
const pagePath = (handle = "author_member") => `/u/${handle}`;
const load = (as: string | undefined, handle = "author_member", suffix = "") =>
  h.outcome(async () => (await memberRoute.loader(h.args(h.request(`${pagePath(handle)}${suffix}`, { as }), { handle }))));
const pageData = async (as = "reader_member", handle = "author_member", suffix = "") => {
  const outcome = await load(as, handle, suffix);
  expect(outcome.status).toBe(200);
  return unwrap<PageData>(outcome.value);
};
const renderPage = (loaderData: PageData, path = pagePath()) => renderInRouter(() => createElement(MemberPage, { loaderData, actionData: undefined, params: {}, matches: [] } as never), path);
const selected = async (handle = "signed_member") => (await h.db.select({ id: profiles.introEntryId }).from(profiles).where(eq(profiles.userId, h.ids[handle])))[0].id;
const selectIntro = (id: number, intent: "intro-set" | "intro-unset", as = "signed_member", headers?: Record<string, string>) =>
  h.outcome(() => topicAction(h.args(h.request(`/t/${id}`, { as, form: { intent }, headers }), { id: String(id) })));

beforeAll(async () => {
  h = await setupRouteHarness();
  await h.signIn("author_member", { homeArea: "ja", readLangs: ["ja", "de"] });
  await h.signIn("reader_member", { homeArea: "en", readLangs: ["en"] });
  await h.signIn("signed_member");
  await h.signIn("renamed_member");
  await h.signIn("expired_member");
  await h.signIn("onboarding_member", { profile: false });
  introId = must(await createTopic(h.db, h.ids.author_member, { lang: "ja", body: "Introduction secret-free body." }, { asIntroduction: true })).id;
  plainId = must(await createTopic(h.db, h.ids.author_member, { lang: "ja", title: "Plain topic", body: "Plain body." })).id;
  questionId = must(await createTopic(h.db, h.ids.author_member, { lang: "ja", title: "A question", body: "Question body.", asksStance: true })).id;
  replyId = must(await createReply(h.db, h.ids.signed_member, plainId, { lang: "ja", body: "Reply body." })).id;
  signedId = must(await createTopic(h.db, h.ids.signed_member, { lang: "ja", title: "Signed member's topic", body: "Signed body." })).id;
  signedQuestionId = must(await createTopic(h.db, h.ids.signed_member, { lang: "ja", title: "Signed member's question", body: "Choose.", asksStance: true })).id;
  foreignId = must(await createTopic(h.db, h.ids.reader_member, { lang: "en", title: "Another writer", body: "Foreign body." })).id;
  await h.db.update(profiles).set({ signPosts: true }).where(eq(profiles.userId, h.ids.signed_member));
  expect(await changeHandle(h.db, h.ids.renamed_member, "renamed_current", { now })).toMatchObject({ ok: true });
  expect(await changeHandle(h.db, h.ids.expired_member, "expired_current", { now })).toMatchObject({ ok: true });
  await h.db.update(handleHolds).set({ heldUntil: new Date(Date.now() - 1) }).where(eq(handleHolds.handleKey, "expired_member"));
});
afterAll(() => h?.restore());

describe("member-page read boundaries", () => {
  it("requires completed membership and sends anonymous visitors to login", async () => {
    const anonymous = await load(undefined);
    expect(anonymous.status).toBe(302);
    const destination = new URL(anonymous.location!, "http://localhost");
    expect(destination.pathname).toBe("/login");
    expect(destination.searchParams.get("next")).toBe(pagePath());
    expect(await load("onboarding_member")).toMatchObject({ status: 302, location: "/onboarding" });
  });

  it("sets private cache headers, redirects an active old hold, and rejects unknown, expired and Markdown paths", async () => {
    expect(new Headers(memberRoute.headers()).get("Cache-Control")).toContain("private");
    expect(await load("reader_member", "renamed_member")).toMatchObject({ status: 302, location: "/u/renamed_current" });
    for (const handle of ["missing_member", "expired_member", "author_member.md", "author_member.txt"]) {
      expect((await load("reader_member", handle)).status, handle).toBe(404);
    }
  });

  it("returns and renders only the introduction and topic rows, retaining original language without member preferences or statistics", async () => {
    for (const as of ["reader_member", "author_member"]) {
      const loaded = await pageData(as);
      expect(Object.keys(loaded).sort()).toEqual(["avatarUrl", "handle", "hasDisplayName", "hasNext", "hasUploadedAvatar", "intro", "name", "nameLatin", "own", "page", "personal", "reported", "topics"]);
      expect(loaded).toMatchObject({ name: null, hasDisplayName: false, reported: false });
      expect(loaded.own).toBe(as === "author_member");
      expect(loaded.intro?.id).toBe(introId);
      expect(Object.keys(loaded.intro!).sort()).toEqual(["display", "headline", "html", "id", "lang", "title"]);
      for (const topic of loaded.topics) {
        expect(Object.keys(topic).sort()).toEqual(["createdAtISO", "id", "lang", "title"]);
        expect(topic.lang).toBe("ja");
      }
      const serialized = JSON.stringify(loaded);
      for (const field of ["homeArea", "readLangs", "displayLang", "insightful", "reactions", "replyCount", "asksStance", "stanceLocked", "stanceTag", "distribution", "lastActivity", "email", "publicId", "userId"]) {
        expect(serialized, field).not.toContain(`"${field}`);
      }
      for (const id of Object.values(h.ids)) expect(serialized).not.toContain(id);
      const html = await renderPage(loaded);
      expect(html).toMatch(/<span\b[^>]*lang="ja"[^>]*>日本語<\/span>/);
      expect(html).toContain("Introduction secret-free body.");
      expect(html).toContain(`href="/t/${plainId}"`);
      expect(html).not.toMatch(/aria-pressed|data-position|name="position"|\/stance(?:\?|"|<)|\/vote/);
      expect(html).not.toContain("Main language");
      expect(html).not.toContain("Languages you read");
      expect(html).not.toContain("Insightful");
    }
  });

  it("keeps the owner's complete member-page HTML identical before and after the owner chooses a stance", async () => {
    const before = await renderPage(await pageData("author_member"));
    expect(await setStance(h.db, h.ids.author_member, { questionId: signedQuestionId, position: "agree", expectedVersion: 0 })).toMatchObject({ ok: true });
    expect(await renderPage(await pageData("author_member"))).toBe(before);
  });

  it("omits hidden and deleted introductions for their owner as well as other members", async () => {
    for (const field of ["hiddenAt", "deletedAt"] as const) {
      await h.db.update(entries).set({ [field]: now }).where(eq(entries.id, introId));
      for (const as of ["author_member", "reader_member"]) {
        const loaded = await pageData(as);
        expect(loaded.intro).toBeNull();
        expect(loaded.topics.map(topic => topic.id)).not.toContain(introId);
        expect(await renderPage(loaded)).not.toContain("Introduction secret-free body.");
      }
      await h.db.update(entries).set({ [field]: null }).where(eq(entries.id, introId));
    }
  });

  it("paginates 20 newest topics without moving a topic when it receives a reply", async () => {
    for (let index = 0; index < 19; index++) must(await createTopic(h.db, h.ids.author_member, { lang: "ja", title: `Paging ${index}`, body: "Paging body." }, { now: new Date(now.getTime() + index + 1) }));
    const first = await pageData();
    const second = await pageData("reader_member", "author_member", "?page=2");
    expect(first.topics).toHaveLength(20);
    expect(first.hasNext).toBe(true);
    expect(second.hasNext).toBe(false);
    expect(new Set([...first.topics, ...second.topics].map(topic => topic.id)).size).toBe(first.topics.length + second.topics.length);
    must(await createReply(h.db, h.ids.reader_member, plainId, { lang: "en", body: "A late reply." }, { now: new Date(now.getTime() + 50_000) }));
    expect((await pageData()).topics.map(topic => topic.id)).toEqual(first.topics.map(topic => topic.id));
  });
});

describe("introduction selection and posting routes", () => {
  it("defaults the new-topic introduction checkbox from ?intro=1 while question defaults take precedence", async () => {
    for (const [query, intro, question] of [["", false, false], ["?intro=1", true, false], ["?intro=1&asks_stance=1", false, true]] as const) {
      const loaderData = await newLoader(h.args(h.request(`/t/new${query}`, { as: "author_member" })));
      const html = await renderInRouter(() => createElement(TopicNew, { loaderData, params: {}, matches: [] } as never), `/t/new${query}`);
      const checkbox = html.match(/<input\b[^>]*name="intro"[^>]*>/)?.[0];
      if (new URLSearchParams(query).get("intro") === "1") {
        expect(checkbox).toBeDefined();
        expect(checkbox!.includes('checked=""')).toBe(intro);
      } else {
        expect(checkbox).toBeUndefined();
      }
      const stance = html.match(/<input\b[^>]*name="asksStance"[^>]*>/)?.[0];
      expect(stance).toContain('type="checkbox"');
      expect(stance).toContain('value="1"');
      expect(stance!.includes('checked=""')).toBe(question);
    }
  });

  it("publishes an introduction and rejects a simultaneous question request without saving a post", async () => {
    const conflict = await h.outcome(() => newAction(h.args(h.request("/t/new", { as: "reader_member", form: { intro: "1", asksStance: "1", title: "Conflict", body: "Choose.", lang: "en" } }))));
    expect(conflict.status).toBe(400);
    expect(await selected("reader_member")).toBeNull();
    const posted = await h.outcome(() => newAction(h.args(h.request("/t/new?intro=1", { as: "reader_member", form: { intro: "1", title: "Reader intro", body: "Reader introduction.", lang: "en" } }))));
    expect(posted.status).toBe(302);
    const id = Number(new URL(posted.location!, "http://localhost").pathname.split("/").at(-1));
    expect(await selected("reader_member")).toBe(id);
  });

  it("sets and unsets an introduction without signing even when the member signs posts", async () => {
    expect([200, 302]).toContain((await selectIntro(signedId, "intro-set")).status);
    expect(await selected()).toBe(signedId);
    const own = await topicLoader(h.args(h.request(`/t/${signedId}`, { as: "signed_member" }), { id: String(signedId) }));
    const other = await topicLoader(h.args(h.request(`/t/${signedId}`, { as: "reader_member" }), { id: String(signedId) }));
    expect(own).toHaveProperty("introSelected", true);
    expect(other).toHaveProperty("introSelected", false);
    expect([200, 302]).toContain((await selectIntro(signedId, "intro-unset")).status);
    expect(await selected()).toBeNull();
  });

  it("rejects another member's topic, a reply and a question as introduction targets", async () => {
    for (const id of [foreignId, replyId, signedQuestionId]) {
      expect([400, 403, 404]).toContain((await selectIntro(id, "intro-set")).status);
      expect(await selected()).toBeNull();
    }
    expect([400, 403, 404]).toContain((await selectIntro(signedId, "intro-set", "reader_member")).status);
    expect(await selected()).toBeNull();
  });

  it("requires same-origin and writing permission for introduction selection", async () => {
    expect((await selectIntro(signedId, "intro-set", "signed_member", { origin: "https://elsewhere.example" })).status).toBe(403);
    expect(await selected()).toBeNull();
    await h.db.update(profiles).set({ suspendedUntil: new Date("2031-01-01T00:00:00Z") }).where(eq(profiles.userId, h.ids.signed_member));
    expect(await selectIntro(signedId, "intro-set")).toMatchObject({ status: 302, location: "/suspended" });
    expect(await selected()).toBeNull();
  });
});
