import { draftScreenForm } from "./helpers/draft-form";
import { and, asc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAppeal, decideAppeal } from "~/lib/appeals.server";
import { drafts, entries, entryRevisions, rateLimits } from "~/lib/db/schema";
import { createDraft, getDraft } from "~/lib/drafts.server";
import { createReply, createTopic, editEntry, getEditableEntry, getEntryViews, getThread, listTopics, replyLocation, softDeleteEntry } from "~/lib/entries.server";
import { deleteEntry, hideEntry, unhideEntry, type Actor } from "~/lib/moderation.server";
import { listObjectionRefs, listObjections, loadObjectionPanel } from "~/lib/objections.server";
import type { StanceTag } from "~/lib/stances";
import { createApiToken } from "~/lib/tokens.server";
import { getModScope, getViewer, grantModerator } from "~/lib/roles.server";
import { addMember, createTestDb } from "./helpers/db";
import { BASE, setupRouteHarness, type RouteHarness } from "./helpers/route-harness";

// Questions, topics asking for stances: attributes, reading-side locks, reply tags, alternatives, and objections panels. Stance registration is covered separately.
// setStance sets stance_locked_at on the first non-author stance; the author's own stance alone does not lock. Test locking by writing the column directly.
// Moderator typo corrections to locked questions, the fix_entry moderation action, are covered by tests/moderator-fix.test.ts.

const t = (minutes: number) => new Date(Date.UTC(2026, 9, 5, 0, minutes));
const OP: Actor = { id: "", scope: { operator: true, langs: [] } };

let h: RouteHarness;
let hana: string;
let taro: string;
let mary: string;
let seq = 0;

beforeAll(async () => {
  h = await setupRouteHarness();
  hana = await h.signIn("hana", { homeArea: "ja", readLangs: ["ja", "en"] });
  taro = await h.signIn("taro", { homeArea: "en", readLangs: ["ja", "en"] });
  mary = await h.signIn("mary", { homeArea: "en", readLangs: ["en"] });
  OP.id = mary;
});
afterAll(() => h.restore());

const post = async (as: string, authorId: string, input: { title?: string; asksStance?: boolean; altOf?: number | null; lang?: string }, now?: Date) => {
  const res = await createTopic(h.db, authorId, { lang: input.lang ?? "ja", title: input.title ?? `題${++seq}`, body: "本文。", ...input }, { now });
  if (!res.ok) throw new Error(`topic failed: ${res.error}`);
  void as;
  return res.id;
};
const question = (title?: string, now?: Date) => post("hana", hana, { title, asksStance: true }, now);
const reply = async (authorId: string, threadId: number, input: { stanceTag?: StanceTag | null; body?: string } = {}, now?: Date) => {
  const res = await createReply(h.db, authorId, threadId, { lang: "ja", body: input.body ?? "返信。", stanceTag: input.stanceTag }, { now });
  if (!res.ok) throw new Error(`reply failed: ${res.error}`);
  return res.id;
};
const row = async (id: number) => (await h.db.select().from(entries).where(eq(entries.id, id)))[0];
const lock = (id: number, at = t(1)) => h.db.update(entries).set({ stanceLockedAt: at }).where(eq(entries.id, id));
const revisions = (id: number) => h.db.select().from(entryRevisions).where(eq(entryRevisions.entryId, id)).orderBy(asc(entryRevisions.id));

// Load the UI route lazily through a static import path.
const routes = {
  "topic-new": () => import("~/routes/topic-new"),
  topic: () => import("~/routes/topic"),
  "topic-edit": () => import("~/routes/topic-edit"),
  "reply-edit": () => import("~/routes/reply-edit"),
  "topic-objections": () => import("~/routes/topic-objections"),
  draft: () => import("~/routes/draft"),
  home: () => import("~/routes/home"),
  latest: () => import("~/routes/latest"),
  area: () => import("~/routes/area"),
};
type RouteName = keyof typeof routes;
type Module = { action?: (a: never) => unknown; loader?: (a: never) => unknown };
async function submit(route: RouteName, as: string, path: string, form: Record<string, string>, params: Record<string, string> = {}) {
  const mod = (await routes[route]()) as Module;
  if (route === "draft") form = await draftScreenForm(h.db, h.ids[as], Number(params.id), form);
  return h.outcome(async () => mod.action!(await h.signedArgs(h.request(path, { as, form }), params)));
}
async function load<T = Record<string, unknown>>(route: RouteName, as: string, path: string, params: Record<string, string> = {}) {
  const mod = (await routes[route]()) as Module;
  return (await mod.loader!(await h.signedArgs(h.request(path, { as }), params))) as T;
}
const idFrom = (location: string | null) => Number(/\/t\/(\d+)/.exec(location ?? "")![1]);

describe("asks_stance is set when the topic is created, on every way of creating one", () => {
  it("on the new-topic form: the checkbox makes a question, no checkbox makes an ordinary topic", async () => {
    const q = await submit("topic-new", "hana", "/t/new", { title: "AI は止めるべきか", body: "条件は本文に。", lang: "ja", aiAssistance: "none", asksStance: "1" });
    expect(q).toMatchObject({ status: 302 });
    expect(await row(idFrom(q.location))).toMatchObject({ kind: "topic", asksStance: true, altOf: null, via: "web", stanceLockedAt: null });
    const plain = await submit("topic-new", "hana", "/t/new", { title: "ふつうの話題", body: "本文。", lang: "ja", aiAssistance: "none" });
    expect(await row(idFrom(plain.location))).toMatchObject({ asksStance: false });
  });

  it("with a frontmatter pasted into the body (asks_stance: true), and the checkbox is read as well", async () => {
    const pasted = await submit("topic-new", "hana", "/t/new", { title: "貼り付け", body: "---\nasks_stance: true\nlang: ja\n---\n本文。", lang: "", aiAssistance: "" });
    expect(await row(idFrom(pasted.location))).toMatchObject({ asksStance: true, body: "本文。" });
    // A non-boolean asks_stance in front matter is a form error.
    const bad = await submit("topic-new", "hana", "/t/new", { title: "貼り付け", body: "---\nasks_stance: yes please\nlang: ja\n---\n本文。", lang: "", aiAssistance: "" });
    expect(bad.status).toBe(400);
    expect((bad.value as { data?: { error?: string } }).data).toEqual({ error: "frontmatter_invalid", values: { title: "貼り付け", body: "---\nasks_stance: yes please\nlang: ja\n---\n本文。", lang: "", asksStance: false, intro: false } });
  });

  it("through the form's draft button and the draft screen: the checkbox can be changed while it is a draft, and publishing makes the question", async () => {
    const saved = await submit("topic-new", "hana", "/t/new", { title: "下書きの問い", body: "本文。", lang: "ja", aiAssistance: "none", asksStance: "1", intent: "draft" });
    const draftId = Number(/\/drafts\/(\d+)/.exec(saved.location ?? "")![1]);
    expect(await getDraft(h.db, hana, draftId)).toMatchObject({ kind: "topic", asksStance: true, altOf: null });
    const params = { id: String(draftId) };
    // Clear it and save.
    await submit("draft", "hana", `/drafts/${draftId}`, { intent: "save", title: "下書きの問い", body: "本文。", lang: "ja", aiAssistance: "none" }, params);
    expect((await getDraft(h.db, hana, draftId))?.asksStance).toBe(false);
    // Set it and publish.
    const published = await submit("draft", "hana", `/drafts/${draftId}`, { intent: "publish", title: "下書きの問い", body: "本文。", lang: "ja", aiAssistance: "none", asksStance: "1" }, params);
    expect(published).toMatchObject({ status: 302 });
    expect(await row(idFrom(published.location))).toMatchObject({ kind: "topic", asksStance: true, via: "web" });
    expect(await getDraft(h.db, hana, draftId)).toBeNull();
  });

  it("through the API: asks_stance: true in the frontmatter of POST /api/drafts, published in the browser; a stance key is ignored", async () => {
    const token = await createApiToken(h.db, hana, { name: "claude", kind: "draft" });
    if (!token.ok) throw new Error("token failed");
    await h.db.delete(rateLimits);
    const { action } = await import("~/routes/api.drafts");
    const res = (await action({
      request: new Request(`${BASE}/api/drafts`, {
        method: "POST",
        headers: { authorization: `Bearer ${token.token}`, "content-type": "text/markdown" },
        body: "---\ntype: topic\ntitle: AI の問い\nlang: ja\nasks_stance: true\nstance: agree\n---\n本文。",
      }),
      params: {},
      context: {},
    } as never)) as Response;
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: number };
    expect(await getDraft(h.db, hana, id)).toMatchObject({ asksStance: true, via: "api", altOf: null });
    const published = await submit("draft", "hana", `/drafts/${id}`, { intent: "publish", title: "AI の問い", body: "本文。", lang: "ja", aiAssistance: "none", asksStance: "1" }, { id: String(id) });
    expect(await row(idFrom(published.location))).toMatchObject({ asksStance: true, via: "api" });
  });

  it("cannot be added to or removed from a topic by an edit", async () => {
    const plain = await post("hana", hana, { title: "ふつう" });
    const q = await question("問い");
    expect(await editEntry(h.db, hana, plain, { title: "ふつう", body: "本文。", asksStance: true }, { kind: "topic" })).toEqual({ ok: false, error: "invalid_asks_stance" });
    expect(await editEntry(h.db, hana, q, { title: "問い", body: "本文。", asksStance: false }, { kind: "topic" })).toEqual({ ok: false, error: "invalid_asks_stance" });
    // The edit form has no such field; editing the title and body keeps it a question.
    expect((await submit("topic-edit", "hana", `/t/${q}/edit`, { title: "問いを直す", body: "本文。" }, { id: String(q) })).status).toBe(302);
    expect(await row(q)).toMatchObject({ title: "問いを直す", asksStance: true });
  });

  it("makes the ordinary lists show the badge flag, and ?asks=1 keeps only the questions (and the Markdown lists carry it)", async () => {
    const q = await question("一覧の問い");
    const p = await post("hana", hana, { title: "一覧のふつうの話題" });
    const all = await listTopics(h.db, { kind: "all" });
    expect(all.topics.find((x) => x.id === q)?.asksStance).toBe(true);
    expect(all.topics.find((x) => x.id === p)?.asksStance).toBe(false);
    const only = await listTopics(h.db, { kind: "all" }, { asksOnly: true, limit: 100 });
    expect(only.topics.length).toBeGreaterThan(0);
    expect(only.topics.every((x) => x.asksStance)).toBe(true);
    expect(only.topics.some((x) => x.id === q)).toBe(true);
    expect(only.topics.some((x) => x.id === p)).toBe(false);
    for (const [route, path] of [["latest", "/latest?asks=1"], ["home", "/?asks=1"], ["area", "/a/ja?asks=1"]] as const) {
      // /latest keeps `asksOnly`; the cards of the home and of a language list say it with filter: "asks".
      const data = await load<{ asksOnly?: boolean; filter?: string; topics?: Array<{ id: number; asksStance: boolean }>; cards?: Array<{ id: number; asksStance: boolean }> }>(route, "hana", path, route === "area" ? { lang: "ja" } : {});
      expect(data.asksOnly ?? data.filter === "asks", route).toBe(true);
      const items = [...(data.topics ?? []), ...(data.topics ?? [])];
      expect(items.length, route).toBeGreaterThan(0);
      expect(items.every((x) => x.asksStance), route).toBe(true);
      expect(items.some((x) => x.id === p), route).toBe(false);
    }
    const unfiltered = await load<{ asksOnly: boolean; topics: Array<{ id: number }> }>("latest", "hana", "/latest");
    expect(unfiltered.asksOnly).toBe(false);
    expect(unfiltered.topics.some((x) => x.id === p)).toBe(true);
  });
});

describe("the questions-only lists keep ?asks=1 in the Markdown links", () => {
  type Page = { aiOpen: { mdPath: string; mdUrl: string } };
  it("puts asks=1 and the page into Open in AI (the path and the signed URL) of /latest, / and /a/:lang", async () => {
    for (const [route, path, params, md] of [
      ["latest", "/latest?asks=1&page=2&lang=en", {}, "/latest.md"],
      ["home", "/?asks=1&page=2&lang=en", {}, "/home.md"],
      ["area", "/a/ja?asks=1&page=2&lang=en", { lang: "ja" }, "/a/ja.md"],
    ] as const) {
      const data = await load<Page>(route, "hana", path, params);
      const local = new URL(data.aiOpen.mdPath, BASE);
      expect(local.pathname, route).toBe(md);
      expect(local.searchParams.get("asks"), route).toBe("1");
      expect(local.searchParams.get("page"), route).toBe("2");
      expect(local.searchParams.get("lang"), route).toBe("en");
      expect(local.searchParams.get("k"), route).toBeNull();
      const signed = new URL(data.aiOpen.mdUrl);
      expect(signed.pathname, route).toBe(md);
      expect([signed.searchParams.get("asks"), signed.searchParams.get("page"), signed.searchParams.get("lang")], route).toEqual(["1", "2", "en"]);
      expect(signed.searchParams.get("k"), route).toBeNull();
      // Do not add asks to an unfiltered list.
      const plain = await load<Page>(route, "hana", path.replace("asks=1&", ""), params);
      expect(new URL(plain.aiOpen.mdPath, BASE).searchParams.has("asks"), route).toBe(false);
    }
  });

  it("puts asks=1 into the <link rel=alternate> of the lists, with a valid ?lang= only", async () => {
    const href = async (route: "latest" | "home" | "area", search: string, loaderData?: unknown) => {
      const mod = (await routes[route]()) as unknown as { meta: (a: never) => Array<{ rel?: string; href?: string }> };
      return mod.meta({ location: { search }, loaderData } as never).find((x) => x.rel === "alternate")?.href;
    };
    expect(await href("latest", "?asks=1")).toBe("/latest.md?asks=1");
    expect(await href("latest", "?lang=fr&asks=1&page=3")).toBe("/latest.md?lang=fr&asks=1&page=3");
    expect(await href("latest", "?lang=xx&asks=0")).toBe("/latest.md");
    expect(await href("home", "?asks=1&lang=en")).toBe("/home.md?lang=en&asks=1");
    // The order and the long-posts filter are carried too (only valid values).
    expect(await href("home", "?order=activity&long=1")).toBe("/home.md?long=1&order=activity");
    expect(await href("home", "?order=nonsense&long=0")).toBe("/home.md");
    expect(await href("home", "")).toBe("/home.md");
    expect(await href("area", "?asks=1", { lang: "ja" })).toBe("/a/ja.md?asks=1");
  });

  it("the Markdown list that the link points at is the filtered one, and its next link keeps asks=1", async () => {
    // Create 31 questions to span two pages.
    await h.db.insert(entries).values(Array.from({ length: 31 }, (_, i) => ({ kind: "topic", authorId: hana, lang: "ja", title: `絞り込みの問い ${i}`, body: "b", sourceHash: "x", asksStance: true, createdAt: t(1000 + i), updatedAt: t(1000 + i), lastActivityAt: t(1000 + i) })));
    const { getMd, parseBlocks } = await import("./helpers/md");
    const page1 = await (await getMd(h, "/latest.md?asks=1", { as: "hana" })).text();
    const footer = parseBlocks(page1).at(-1)!.fm as { next: string };
    expect(new URL(footer.next).searchParams.get("asks")).toBe("1");
    const page2 = await (await getMd(h, `/latest.md?asks=1&page=2`, { as: "hana" })).text();
    expect(page2).not.toContain("ふつうの話題");
  });
});

describe("the lock: once stance_locked_at is set, the author cannot edit the title and body", () => {
  it("lets the author edit a question before it is locked", async () => {
    const q = await question("固定前");
    const found = await getEditableEntry(h.db, hana, q, { kind: "topic" });
    expect(found).toMatchObject({ ok: true, entry: { asksStance: true, locked: false, mode: "author", threadAsksStance: true } });
    expect(await editEntry(h.db, hana, q, { title: "固定前の改訂", body: "直した。" }, { kind: "topic", now: t(5) })).toEqual({ ok: true, id: q, threadId: q, changed: true });
    expect(await row(q)).toMatchObject({ title: "固定前の改訂", body: "直した。" });
    expect(await revisions(q)).toHaveLength(1);
  });

  it("refuses the title and the body once it is locked: locked, nothing changes, no revision", async () => {
    const q = await question("固定される問い");
    await lock(q);
    const before = await row(q);
    const found = await getEditableEntry(h.db, hana, q, { kind: "topic" });
    expect(found).toMatchObject({ ok: true, entry: { id: q, locked: true, mode: "author-locked" } });
    for (const input of [{ title: "別の題", body: before.body }, { title: before.title, body: "別の本文" }, { title: "別の題", body: "別の本文" }]) {
      expect(await editEntry(h.db, hana, q, input, { kind: "topic", now: t(9) })).toEqual({ ok: false, error: "locked" });
    }
    expect(await row(q)).toEqual(before);
    expect(await revisions(q)).toHaveLength(0);
    // An unchanged submission still returns changed: false.
    expect(await editEntry(h.db, hana, q, { title: before.title, body: before.body }, { kind: "topic", now: t(9) })).toEqual({ ok: true, id: q, threadId: q, changed: false });
    // UI: show guidance instead of the form when the loader returns locked; submitted requests return to that guidance.
    expect(await load<{ locked: boolean; asksStance: boolean }>("topic-edit", "hana", `/t/${q}/edit`, { id: String(q) })).toMatchObject({ locked: true, asksStance: true });
    expect(await submit("topic-edit", "hana", `/t/${q}/edit`, { title: "別の題", body: "別の本文" }, { id: String(q) })).toMatchObject({ status: 302, location: `/t/${q}/edit` });
    expect(await row(q)).toEqual(before);
  });

  it("lets nobody but the author edit: another member, a real moderator and a real operator get forbidden from editEntry (and from everything before the lock); after the lock a real moderator and operator get the typo fix, another member does not", async () => {
    const q = await question("著者だけ");
    // Use actual roles: a moderator for the question's source language ja in roles, and an operator listed in OPERATOR_EMAILS. A roleless member does not test role checks.
    const moderator = await h.signIn("mod-ja-author-only", { homeArea: "ja", readLangs: ["ja"] });
    const operator = await h.signIn("operator-author-only", { homeArea: "en", readLangs: ["ja", "en"] });
    expect((await grantModerator(h.db, mary, moderator, "ja")).ok).toBe(true);
    const savedOperators = process.env.OPERATOR_EMAILS;
    process.env.OPERATOR_EMAILS = "operator-author-only@example.com";
    try {
      expect(await getModScope(h.db, { id: moderator, email: "mod-ja-author-only@example.com" })).toEqual({ operator: false, langs: ["ja"] });
      expect(await getModScope(h.db, { id: operator, email: "operator-author-only@example.com" })).toMatchObject({ operator: true });
      const viewerOf = (id: string, email: string) => getViewer(h.db, { id, email });
      for (const before of [false, true]) {
        if (before) await lock(q);
        for (const who of [taro, mary, moderator, operator]) {
          // Author editing through editEntry is author-only; without viewer, the entry point is also author-only.
          expect(await getEditableEntry(h.db, who, q, { kind: "topic" }), String(before)).toEqual({ ok: false, error: "forbidden" });
          expect(await editEntry(h.db, who, q, { title: "x", body: "y" }, { kind: "topic" }), String(before)).toEqual({ ok: false, error: "forbidden" });
        }
        // With viewer: no one has this entry point before locking; afterward, only the assigned moderator and operator can correct typos.
        const asViewer = async (who: string, email: string) => getEditableEntry(h.db, who, q, { kind: "topic", viewer: await viewerOf(who, email) });
        const asTaro = await asViewer(taro, "taro@example.com");
        const asMary = await asViewer(mary, "mary@example.com");
        expect(asTaro, String(before)).toEqual({ ok: false, error: "forbidden" });
        expect(asMary, String(before)).toEqual({ ok: false, error: "forbidden" });
        for (const [who, email] of [[moderator, "mod-ja-author-only@example.com"], [operator, "operator-author-only@example.com"]] as const) {
          const found = await asViewer(who, email);
          if (before) expect(found).toMatchObject({ ok: true, entry: { id: q, locked: true, mode: "moderator-fix" } });
          else expect(found).toEqual({ ok: false, error: "forbidden" });
        }
        // UI: ordinary members get 403 in both states. Moderators and operators get 403 before locking; afterward, they see the typo-correction form, whose submission requires an explanation.
        expect((await submit("topic-edit", "taro", `/t/${q}/edit`, { title: "x", body: "y" }, { id: String(q) })).status, `taro ${before}`).toBe(403);
        for (const as of ["mod-ja-author-only", "operator-author-only"]) {
          if (before) expect(await load<{ fix: boolean }>("topic-edit", as, `/t/${q}/edit`, { id: String(q) }), as).toMatchObject({ fix: true, locked: false });
          else expect((await submit("topic-edit", as, `/t/${q}/edit`, { title: "x", body: "y" }, { id: String(q) })).status, `${as} ${before}`).toBe(403);
        }
      }
      expect((await submit("topic-edit", "mod-ja-author-only", `/t/${q}/edit`, { title: "x", body: "y" }, { id: String(q) })).status).toBe(400);
      expect((await row(q)).title).toBe("著者だけ");
    } finally {
      if (savedOperators === undefined) delete process.env.OPERATOR_EMAILS;
      else process.env.OPERATOR_EMAILS = savedOperators;
    }
  });

  it("gives the lock to the author only, as a boolean; the time is never in the data of the page", async () => {
    const q = await question("固定の状態");
    const at = new Date("2026-10-04T08:09:10.123Z");
    await lock(q, at);
    type Page = { question: { locked: boolean }; topic: Record<string, unknown> };
    const asAuthor = await load<Page>("topic", "hana", `/t/${q}`, { id: String(q) });
    const asOther = await load<Page>("topic", "taro", `/t/${q}`, { id: String(q) });
    expect(asAuthor.question.locked).toBe(true);
    expect(asOther.question.locked).toBe(false);
    for (const page of [asAuthor, asOther]) {
      const text = JSON.stringify(page);
      expect(text).not.toContain("2026-10-04T08:09:10");
      expect(text.toLowerCase()).not.toContain("lockedat");
      expect(text).not.toContain("stance_locked");
    }
    const thread = await getThread(h.db, q, { viewer: await getViewer(h.db, { id: taro, email: "taro@example.com" }) });
    expect(thread?.topic.stanceLocked).toBe(false);
    expect(Object.values(thread!.topic).some((v) => v instanceof Date && v.getTime() === at.getTime())).toBe(false);
    // Locking does not change changed_at or updated_at.
    const [fresh] = await h.db.select({ changedAt: entries.changedAt, updatedAt: entries.updatedAt }).from(entries).where(eq(entries.id, q));
    expect(fresh.changedAt.getTime()).not.toBe(at.getTime());
    expect(fresh.updatedAt.getTime()).not.toBe(at.getTime());
  });

  it("stays when it is hidden and shown again, and when it is deleted by moderation and restored by an appeal: the author reads it the same", async () => {
    const q = await question("固定は続く");
    await lock(q);
    const readsLocked = async (step: string) => {
      expect(await getEditableEntry(h.db, hana, q, { kind: "topic" }), step).toMatchObject({ ok: true, entry: { mode: "author-locked", locked: true } });
      expect(await editEntry(h.db, hana, q, { title: "別の題", body: "別の本文" }, { kind: "topic", now: t(9) }), step).toEqual({ ok: false, error: "locked" });
      expect((await row(q)).stanceLockedAt, step).toEqual(t(1));
    };
    // Hide and unhide.
    expect((await hideEntry(h.db, { ...OP, id: mary }, { entryId: q, reason: "spam", note: "n" }, { now: t(20) })).ok).toBe(true);
    await readsLocked("hidden");
    expect((await unhideEntry(h.db, { ...OP, id: mary }, { entryId: q, reason: "other" }, { now: t(21) })).ok).toBe(true);
    await readsLocked("shown again");
    // Operator deletion, after which the question is nonexistent even at the edit entry point, and restoration through an appeal.
    const del = await deleteEntry(h.db, { ...OP, id: mary }, { entryId: q, reason: "spam", note: "n" }, { now: t(22) });
    if (!del.ok) throw new Error("delete failed");
    expect(await getEditableEntry(h.db, hana, q, { kind: "topic" })).toEqual({ ok: false, error: "not_found" });
    expect((await row(q)).stanceLockedAt).toEqual(t(1));
    const appeal = await createAppeal(h.db, hana, del.actionId, "戻してください", { now: t(23) });
    if (!appeal.ok) throw new Error("appeal failed");
    expect(await decideAppeal(h.db, { ...OP, id: taro }, appeal.id, { decision: "overturned", note: "戻す" }, { now: t(24) })).toMatchObject({ ok: true, reversed: true });
    expect((await row(q)).deletedAt).toBeNull();
    await readsLocked("restored");
  });
});

describe("reply marks (stance_tag)", () => {
  it("are put on replies to a question, and read back as the reply's own mark", async () => {
    const q = await question("印の問い");
    const a = await reply(taro, q, { stanceTag: "agree" });
    const none = await reply(mary, q);
    expect((await row(a)).stanceTag).toBe("agree");
    expect((await row(none)).stanceTag).toBeNull();
    const thread = await getThread(h.db, q);
    expect(thread?.replies.map((r) => r.stanceTag)).toEqual(["agree", null]);
    // Topics have no reply tag.
    expect(thread?.topic.stanceTag).toBeNull();
  });

  it("through the reply form: the select, and a pasted frontmatter whose stance_tag the select overrides", async () => {
    const q = await question("返信の画面");
    const params = { id: String(q) };
    const base = { lang: "ja", aiAssistance: "none" };
    const pick = await submit("topic", "taro", `/t/${q}`, { ...base, body: "賛成の理由。", stanceTag: "agree" }, params);
    expect(pick.status).toBe(302);
    const pasted = await submit("topic", "taro", `/t/${q}`, { lang: "", aiAssistance: "", body: "---\nstance_tag: objection\n---\n貼り付けた印。", stanceTag: "" }, params);
    const override = await submit("topic", "taro", `/t/${q}`, { lang: "", aiAssistance: "", body: "---\nstance_tag: objection\n---\n選んだ印が勝つ。", stanceTag: "neither" }, params);
    expect([pick, pasted, override].every((o) => o.status === 302)).toBe(true);
    const rows = await h.db.select({ body: entries.body, tag: entries.stanceTag }).from(entries).where(and(eq(entries.threadId, q), eq(entries.kind, "reply"))).orderBy(asc(entries.id));
    expect(rows).toEqual([
      { body: "賛成の理由。", tag: "agree" },
      { body: "貼り付けた印。", tag: "objection" },
      { body: "選んだ印が勝つ。", tag: "neither" },
    ]);
    // A reply to a non-question topic cannot have a tag; the UI returns a form error.
    const plain = await post("hana", hana, { title: "印のない話題" });
    const refused = await submit("topic", "taro", `/t/${plain}`, { ...base, body: "x", stanceTag: "agree" }, { id: String(plain) });
    expect(refused.status).toBe(400);
    expect((refused.value as { data?: { error?: string } }).data).toMatchObject({ error: "invalid_stance_tag" });
    // Pasting stance_tag front matter into the topic form is a type mismatch.
    const mismatch = await submit("topic-new", "hana", "/t/new", { title: "t", body: "---\nstance_tag: agree\n---\nb", lang: "", aiAssistance: "" });
    expect(mismatch.status).toBe(400);
    expect((mismatch.value as { data?: { error?: string } }).data).toEqual({ error: "frontmatter_type_mismatch", values: { title: "t", body: "---\nstance_tag: agree\n---\nb", lang: "", asksStance: false, intro: false } });
  });

  it("can be changed and removed by the writer, and only by the writer", async () => {
    const q = await question("印を直す");
    const r = await reply(taro, q, { stanceTag: "agree" });
    expect(await editEntry(h.db, taro, r, { body: "返信。", stanceTag: "disagree" }, { kind: "reply", now: t(11) })).toMatchObject({ ok: true, changed: true });
    expect((await row(r)).stanceTag).toBe("disagree");
    expect(await editEntry(h.db, taro, r, { body: "返信。", stanceTag: null }, { kind: "reply", now: t(12) })).toMatchObject({ ok: true, changed: true });
    expect((await row(r)).stanceTag).toBeNull();
    // undefined, meaning not submitted, leaves it unchanged. Resubmitting the same value also changes nothing.
    await editEntry(h.db, taro, r, { body: "返信。", stanceTag: "neither" }, { kind: "reply", now: t(13) });
    expect(await editEntry(h.db, taro, r, { body: "返信。" }, { kind: "reply", now: t(14) })).toMatchObject({ changed: false });
    expect((await row(r)).stanceTag).toBe("neither");
    expect(await editEntry(h.db, taro, r, { body: "返信。", stanceTag: "neither" }, { kind: "reply", now: t(15) })).toMatchObject({ changed: false });
    expect(await editEntry(h.db, taro, r, { body: "返信。", stanceTag: null }, { kind: "reply", now: t(15) })).toMatchObject({ changed: true });
    expect((await row(r)).stanceTag).toBeNull();
    expect(await editEntry(h.db, taro, r, { body: "返信。", stanceTag: null }, { kind: "reply", now: t(15) })).toMatchObject({ changed: false });
    expect(await editEntry(h.db, hana, r, { body: "返信。", stanceTag: "agree" }, { kind: "reply" })).toEqual({ ok: false, error: "forbidden" });
    // Reply-edit UI: replies to questions show the tag selector with the current tag.
    await editEntry(h.db, taro, r, { body: "返信。", stanceTag: "objection" }, { kind: "reply", now: t(16) });
    expect(await load("reply-edit", "taro", `/c/${r}/edit`, { id: String(r) })).toMatchObject({ stanceTag: "objection", threadAsksStance: true });
    const edited = await submit("reply-edit", "taro", `/c/${r}/edit`, { body: "返信。", stanceTag: "" }, { id: String(r) });
    expect(edited.status).toBe(302);
    expect((await row(r)).stanceTag).toBeNull();
  });

  it("when only the mark changes: no revision, no edited_at, the same source hash, and the reply still moves in the change feed (changed_at)", async () => {
    const q = await question("印だけの変更");
    const r = await reply(taro, q, { stanceTag: "agree" }, t(20));
    const before = await row(r);
    expect(before.changedAt.getTime()).toBe(t(20).getTime());
    expect(await editEntry(h.db, taro, r, { body: before.body, stanceTag: "disagree" }, { kind: "reply", now: t(30) })).toEqual({ ok: true, id: r, threadId: q, changed: true });
    const after = await row(r);
    expect(after).toMatchObject({ stanceTag: "disagree", editedAt: null, sourceHash: before.sourceHash, body: before.body });
    expect(after.updatedAt).toEqual(before.updatedAt);
    expect(await revisions(r)).toHaveLength(0);
    expect(after.metaChangedAt).toEqual(t(30));
    expect(after.changedAt).toEqual(t(30));
    // Time never moves backward: meta_changed_at stays advanced even if a test passes an earlier timestamp.
    await editEntry(h.db, taro, r, { body: before.body, stanceTag: "neither" }, { kind: "reply", now: t(25) });
    expect((await row(r)).metaChangedAt).toEqual(t(30));
    // A simultaneous body change is an ordinary edit with a revision and edited_at.
    await editEntry(h.db, taro, r, { body: "本文も直した。", stanceTag: "agree" }, { kind: "reply", now: t(60) });
    const full = await row(r);
    expect(full).toMatchObject({ stanceTag: "agree", body: "本文も直した。", editedAt: t(60) });
    expect(await revisions(r)).toHaveLength(1);
  });

  it("filter the replies of a thread: only the replies with that mark that are neither deleted nor hidden, counted and paged on the filtered list", async () => {
    const q = await question("絞り込み");
    const a1 = await reply(taro, q, { stanceTag: "agree" }, t(50));
    const d1 = await reply(taro, q, { stanceTag: "disagree" }, t(51));
    const a2 = await reply(mary, q, { stanceTag: "agree" }, t(52));
    const a3 = await reply(mary, q, { stanceTag: "agree" }, t(53));
    await reply(mary, q, {}, t(54));
    // Deleted and hidden replies are absent from filtered results.
    await softDeleteEntry(h.db, a3);
    await hideEntry(h.db, { ...OP, id: hana }, { entryId: a2, reason: "spam", note: "n" });
    const filtered = await getThread(h.db, q, { stanceTag: "agree" });
    expect(filtered?.replies.map((r) => r.id)).toEqual([a1]);
    expect(filtered).toMatchObject({ replyTotal: 1, pageCount: 1 });
    expect((await getThread(h.db, q, { stanceTag: "disagree" }))?.replies.map((r) => r.id)).toEqual([d1]);
    expect((await getThread(h.db, q, { stanceTag: "objection" }))?.replies).toEqual([]);
    // Without filtering, keep the hidden placeholder but omit the unreferenced deleted reply.
    const all = await getThread(h.db, q);
    expect(all?.replies).toHaveLength(4);
    // UI: ?tag=
    type Page = { stanceTag: string | null; replies: Array<{ id: number; stanceTag?: string | null; placeholder: string | null }> };
    const page = await load<Page>("topic", "hana", `/t/${q}?tag=agree`, { id: String(q) });
    expect(page.stanceTag).toBe("agree");
    expect(page.replies.map((r) => r.id)).toEqual([a1]);
    // An unknown value does not filter.
    const unknown = await load<Page>("topic", "hana", `/t/${q}?tag=nonsense`, { id: String(q) });
    expect(unknown.stanceTag).toBeNull();
    expect(unknown.replies).toHaveLength(4);
  });

  it("are not shown for a hidden reply: the redacted view and the page data carry no mark", async () => {
    const q = await question("非表示の返信の印");
    const r = await reply(taro, q, { stanceTag: "disagree" });
    await hideEntry(h.db, { ...OP, id: mary }, { entryId: r, reason: "spam", note: "n" });
    // An authorized viewer, the author, sees the content and tag; other members see only a placeholder.
    const asAuthor = await getThread(h.db, q, { viewer: await getViewer(h.db, { id: taro, email: "taro@example.com" }) });
    expect(asAuthor?.replies[0]).toMatchObject({ visibility: "hidden", stanceTag: "disagree" });
    const asOther = await getThread(h.db, q, { viewer: await getViewer(h.db, { id: hana, email: "hana@example.com" }) });
    expect(asOther?.replies[0]).toMatchObject({ visibility: "hidden-redacted", stanceTag: null });
    const page = await load("topic", "hana", `/t/${q}`, { id: String(q) });
    // The mark is not in the page data, and the hidden reply is not drawn into the reasons panel (the panel has the three positions as keys, all empty).
    expect(JSON.stringify(page)).not.toContain('"stanceTag":"disagree"');
    expect((page as { question: { reasons: Record<string, unknown[]> } }).question.reasons).toEqual({ agree: [], disagree: [], neither: [] });
    // The same rules apply to getEntryViews for individual entries: deletion yields a placeholder, and nonexistent IDs are omitted.
    const views = await getEntryViews(h.db, [r, q, 987654], await getViewer(h.db, { id: hana, email: "hana@example.com" }));
    expect([...views.keys()].sort((x, y) => x - y)).toEqual([q, r]);
    expect(views.get(r)).toMatchObject({ visibility: "hidden-redacted", stanceTag: null, body: "" });
    expect(views.get(q)).toMatchObject({ visibility: "visible", asksStance: true, kind: "topic" });
    const own = await getEntryViews(h.db, [r], await getViewer(h.db, { id: taro, email: "taro@example.com" }));
    expect(own.get(r)).toMatchObject({ visibility: "hidden", stanceTag: "disagree", body: "返信。" });
  });

  // If a reply draft's target question becomes hidden or deleted, the draft UI omits the tag selector and submits no tag. Saving must not clear the existing tag.
  it("is kept when a draft of a reply is saved while the question is hidden or deleted (the select is not on the screen, so the form sends no mark)", async () => {
    const draftOf = async (q: number, stanceTag: StanceTag | null) => {
      const res = await createDraft(h.db, taro, { kind: "reply", threadId: q, lang: "ja", body: "書きかけの返信。", stanceTag });
      if (!res.ok) throw new Error(`draft failed: ${res.error}`);
      return res.id;
    };
    const versionOf = async (id: number) => {
      const draft = await getDraft(h.db, taro, id);
      if (!draft) throw new Error("draft missing");
      return String(draft.version);
    };
    const save = async (id: number, form: Record<string, string> = {}) => submit("draft", "taro", `/drafts/${id}`, { intent: "save", body: "書き直した返信。", lang: "ja", aiAssistance: "none", version: await versionOf(id), ...form }, { id: String(id) });
    const q = await question("下書きの返信先の問い");
    const id = await draftOf(q, "disagree");
    // When the question is readable, show the selector and save its chosen tag. Choosing "選ばない" clears it.
    expect((await load<{ draft: { threadAsksStance: boolean } }>("draft", "taro", `/drafts/${id}`, { id: String(id) })).draft.threadAsksStance).toBe(true);
    expect((await save(id, { stanceTag: "agree" })).status).toBe(200);
    expect((await getDraft(h.db, taro, id))?.stanceTag).toBe("agree");
    // When hidden, omit the selector. Saving without a tag preserves the existing tag while saving the body.
    await hideEntry(h.db, { ...OP, id: mary }, { entryId: q, reason: "spam", note: "n" });
    const hidden = await getDraft(h.db, taro, id);
    expect(hidden).toMatchObject({ threadTitle: null, threadAsksStance: false, stanceTag: "agree" });
    expect((await save(id)).status).toBe(200);
    expect(await getDraft(h.db, taro, id)).toMatchObject({ stanceTag: "agree", body: "書き直した返信。" });
    // Publishing still fails because the parent is unreadable, and the tag remains.
    expect((await submit("draft", "taro", `/drafts/${id}`, { intent: "publish", body: "書き直した返信。", lang: "ja", aiAssistance: "none", version: await versionOf(id) }, { id: String(id) })).status).toBe(400);
    expect((await getDraft(h.db, taro, id))?.stanceTag).toBe("agree");
    // Deletion behaves the same way.
    const q2 = await question("削除される下書きの返信先");
    const id2 = await draftOf(q2, "objection");
    await softDeleteEntry(h.db, q2);
    expect((await save(id2)).status).toBe(200);
    expect((await getDraft(h.db, taro, id2))?.stanceTag).toBe("objection");
    // When the question is readable, submitting "選ばない" still clears the tag.
    const q3 = await question("印を外す下書きの返信先");
    const id3 = await draftOf(q3, "agree");
    expect((await save(id3, { stanceTag: "" })).status).toBe(200);
    expect((await getDraft(h.db, taro, id3))?.stanceTag).toBeNull();
  });
});

describe("another way of asking, and the objection panel", () => {
  it("is made when the question is created, and cannot be changed afterwards", async () => {
    const q = await question("元の問い");
    const alt = await post("taro", taro, { title: "別の立て方", asksStance: true, altOf: q });
    expect(await row(alt)).toMatchObject({ asksStance: true, altOf: q });
    expect(await editEntry(h.db, taro, alt, { title: "別の立て方", body: "本文。", altOf: null }, { kind: "topic" })).toEqual({ ok: false, error: "invalid_alt_of" });
    expect(await editEntry(h.db, taro, alt, { title: "別の立て方（改）", body: "本文。" }, { kind: "topic" })).toMatchObject({ ok: true, changed: true });
    expect(await row(alt)).toMatchObject({ altOf: q, title: "別の立て方（改）" });
    // Create through the UI at /t/new?asks_stance=1&alt_of=<id>.
    const created = await submit("topic-new", "mary", "/t/new?asks_stance=1&alt_of=" + q, { title: "画面からの別の立て方", body: "本文。", lang: "en", aiAssistance: "none", asksStance: "1", altOf: String(q) });
    expect(await row(idFrom(created.location))).toMatchObject({ asksStance: true, altOf: q });
    // Creation fails if the original question is unreadable.
    const hidden = await question("非表示になる問い");
    await hideEntry(h.db, { ...OP, id: mary }, { entryId: hidden, reason: "spam", note: "n" });
    const refused = await submit("topic-new", "taro", "/t/new", { title: "x", body: "b", lang: "en", aiAssistance: "none", asksStance: "1", altOf: String(hidden) });
    expect(refused.status).toBe(400);
    expect((refused.value as { data?: { error?: string } }).data).toEqual({ error: "invalid_alt_of", values: { title: "x", body: "b", lang: "en", asksStance: true, intro: false } });
  });

  it("opens the new-topic form with the original question and asks_stance on; an unreadable original is dropped with a notice", async () => {
    const q = await question("開く問い");
    type Form = { asksStance: boolean; alt: { id: number; title: string } | null; altNotFound: boolean };
    expect(await load<Form>("topic-new", "taro", `/t/new?asks_stance=1&alt_of=${q}`)).toMatchObject({ asksStance: true, alt: { id: q, title: "開く問い" }, altNotFound: false });
    expect(await load<Form>("topic-new", "taro", "/t/new?asks_stance=1")).toMatchObject({ asksStance: true, alt: null, altNotFound: false });
    expect(await load<Form>("topic-new", "taro", "/t/new")).toMatchObject({ asksStance: false, alt: null, altNotFound: false });
    const plain = await post("hana", hana, { title: "問いでない" });
    const hidden = await question("非表示");
    await hideEntry(h.db, { ...OP, id: mary }, { entryId: hidden, reason: "spam", note: "n" });
    const deleted = await question("削除");
    await softDeleteEntry(h.db, deleted);
    for (const alt of [plain, hidden, deleted, 424242, "abc"]) {
      expect(await load<Form>("topic-new", "taro", `/t/new?asks_stance=1&alt_of=${alt}`), String(alt)).toMatchObject({ asksStance: true, alt: null, altNotFound: true });
    }
    // Even if the original is unreadable, "立場を聞く" follows the link's asks_stance value, defaulting to unset when absent; the guidance matches this.
    expect(await load<Form>("topic-new", "taro", `/t/new?alt_of=${hidden}`)).toMatchObject({ asksStance: false, alt: null, altNotFound: true });
    // An alternative to a readable original opens as a question even without asks_stance.
    expect(await load<Form>("topic-new", "taro", `/t/new?alt_of=${q}`)).toMatchObject({ asksStance: true });
  });

  it("shows, on the original question, one item per writer (the writer's newest), newest first, at most five, and the whole list on its own page", async () => {
    const q = await question("枠の問い");
    // Seven writers: the first creates three items, and the others one each.
    const writers: string[] = [];
    for (let i = 0; i < 7; i++) {
      const id = `w${seq}-${i}`;
      await addMember(h.db, id, `writer${seq}x${i}`);
      writers.push(id);
    }
    seq++;
    const alts: number[] = [];
    // The earliest writer creates another item later; the panel shows only that writer's latest.
    const stamp = (n: number) => t(100 + n);
    for (const [i, w] of writers.entries()) alts.push(await post("x", w, { title: `別の立て方 ${i}`, asksStance: true, altOf: q, lang: "ja" }, stamp(i)));
    const again = await post("x", writers[0], { title: "別の立て方 0 の改訂", asksStance: true, altOf: q, lang: "ja" }, stamp(10));
    const opts = { readLangs: ["ja", "en"] as never, displayLang: "ja" as never };
    const panel = await loadObjectionPanel(h.db, q, opts);
    // One per writer gives seven items. The newest five are writer0's latest revision, then writers 6, 5, 4, and 3.
    expect(panel.alternatives.map((a) => a.id)).toEqual([again, alts[6], alts[5], alts[4], alts[3]]);
    expect(panel.alternatives[0].title.text).toBe("別の立て方 0 の改訂");
    expect(panel.alternatives.every((a) => !!a.authorHandle && a.authorHandle !== "?")).toBe(true);
    // All items: newest first without grouping by writer, eight total.
    const all = await listObjections(h.db, q, { ...opts, page: 1 });
    expect(all.alternatives.map((a) => a.id)).toEqual([again, alts[6], alts[5], alts[4], alts[3], alts[2], alts[1], alts[0]]);
    expect(all.hasNext).toBe(false);
    expect(all.objections).toEqual([]);
    // Both lists omit hidden and deleted items.
    await hideEntry(h.db, { ...OP, id: mary }, { entryId: alts[6], reason: "spam", note: "n" });
    await softDeleteEntry(h.db, again);
    const after = await loadObjectionPanel(h.db, q, opts);
    // After deletion, writer0's latest reverts to the original item.
    expect(after.alternatives.map((a) => a.id)).toEqual([alts[5], alts[4], alts[3], alts[2], alts[1]]);
    expect((await listObjections(h.db, q, { ...opts, page: 1 })).alternatives.map((a) => a.id)).toEqual([alts[5], alts[4], alts[3], alts[2], alts[1], alts[0]]);
  });

  it("pages the whole list by 50 (hasNext) and refuses a page that is not a positive integer", async () => {
    const q = await question("ページの問い");
    await h.db.insert(entries).values(
      Array.from({ length: 52 }, (_, i) => ({ kind: "topic", authorId: hana, lang: "ja", title: `多数 ${i}`, body: "b", sourceHash: "x", asksStance: true, altOf: q, createdAt: t(200 + i), updatedAt: t(200 + i), lastActivityAt: t(200 + i) })),
    );
    const opts = { readLangs: ["ja"] as never, displayLang: "ja" as never };
    const first = await listObjections(h.db, q, { ...opts, page: 1 });
    expect(first.alternatives).toHaveLength(50);
    expect(first.hasNext).toBe(true);
    const second = await listObjections(h.db, q, { ...opts, page: 2 });
    expect(second.alternatives).toHaveLength(2);
    expect(second.hasNext).toBe(false);
    await expect(listObjections(h.db, q, { ...opts, page: 0 })).rejects.toThrow(RangeError);
    // UI: ?page=
    type Page = { alternatives: unknown[]; hasNext: boolean; page: number };
    expect(await load<Page>("topic-objections", "hana", `/t/${q}/objections?page=2`, { id: String(q) })).toMatchObject({ page: 2, hasNext: false });
    expect((await load<Page>("topic-objections", "hana", `/t/${q}/objections`, { id: String(q) })).alternatives).toHaveLength(50);
  });

  it("shows the excerpt of an objection as plain text, 160 characters at most", async () => {
    const q = await question("平文の抜粋の問い");
    const md = await reply(taro, q, { stanceTag: "objection", body: "## 異議\n\n**この問い**は、[前提](https://example.org/p)が広すぎる。\n\n$$x$$\n\n" + "あ".repeat(300) }, t(400));
    const panel = await loadObjectionPanel(h.db, q, { readLangs: ["ja", "en"] as never, displayLang: "ja" as never });
    const excerpt = panel.objections.find((o) => o.id === md)!.excerpt;
    expect(excerpt.startsWith("異議 この問いは、前提が広すぎる。 ")).toBe(true);
    expect(excerpt).not.toMatch(/[#*\[\]$]|https?:/);
    expect([...excerpt]).toHaveLength(161);
    expect(excerpt.endsWith("…")).toBe(true);
  });

  it("shows the replies marked objection the same way: one per writer (the newest), a place that leads to the reply, hidden and deleted left out", async () => {
    const q = await question("異議の返信");
    const a = await reply(taro, q, { stanceTag: "objection", body: "古い異議。" }, t(300));
    const a2 = await reply(taro, q, { stanceTag: "objection", body: "taro の新しい異議。" }, t(310));
    const b = await reply(mary, q, { stanceTag: "objection", body: "mary の異議。" }, t(305));
    const c = await reply(hana, q, { stanceTag: "objection", body: "hana の異議。" }, t(320));
    await reply(hana, q, { stanceTag: "agree", body: "賛成の返信は枠に出ない。" }, t(321));
    const opts = { readLangs: ["ja", "en"] as never, displayLang: "ja" as never };
    const panel = await loadObjectionPanel(h.db, q, opts);
    expect(panel.objections.map((o) => o.id)).toEqual([c, a2, b]);
    expect(panel.objections[0]).toMatchObject({ threadId: q, excerpt: "hana の異議。", authorHandle: "hana", location: `/t/${q}#c-${c}`, lang: "ja" });
    const all = await listObjections(h.db, q, { ...opts, page: 1 });
    expect(all.objections.map((o) => o.id)).toEqual([c, a2, b, a]);
    await hideEntry(h.db, { ...OP, id: mary }, { entryId: c, reason: "spam", note: "n" });
    await softDeleteEntry(h.db, a2);
    expect((await loadObjectionPanel(h.db, q, opts)).objections.map((o) => o.id)).toEqual([b, a]);
    // Use an excerpt for a long objection.
    const long = await reply(mary, q, { stanceTag: "objection", body: `長い。${"あ".repeat(400)}` }, t(330));
    const found = (await loadObjectionPanel(h.db, q, opts)).objections.find((o) => o.id === long)!;
    expect(found.excerpt.length).toBeLessThan(200);
    expect(found.excerpt.endsWith("…")).toBe(true);
  });

  it("works out where the objection replies are in one query, the same places replyLocation gives (a deleted reply counts, the page changes after the 100th)", async () => {
    const q = await question("返信の場所の問い");
    const filler = (n: number, from: number, deletedAt: Date | null = null) =>
      Array.from({ length: n }, (_, i) => ({ kind: "reply", threadId: q, authorId: taro, lang: "ja", body: `埋め ${from + i}`, sourceHash: "x", createdAt: t(2000 + from + i), updatedAt: t(2000 + from + i), deletedAt }));
    // Positions 1-99 include one deleted reply, which still counts; objections at 100 (page 1), 101 (page 2), and, after filler, 205 (page 3).
    await h.db.insert(entries).values([...filler(98, 0), ...filler(1, 98, t(3000))]);
    const a = await reply(taro, q, { stanceTag: "objection", body: "100 番目の異議。" }, t(2099));
    const b = await reply(mary, q, { stanceTag: "objection", body: "101 番目の異議。" }, t(2100));
    await h.db.insert(entries).values(filler(103, 101));
    const c = await reply(hana, q, { stanceTag: "objection", body: "205 番目の異議。" }, t(2204));
    // Hidden objections are absent from the location list but still count toward positions.
    const hiddenOne = await reply(taro, q, { stanceTag: "objection", body: "非表示になる異議。" }, t(2300));
    await hideEntry(h.db, { ...OP, id: mary }, { entryId: hiddenOne, reason: "spam", note: "n" });
    const opts = { readLangs: ["ja", "en"] as never, displayLang: "ja" as never };
    const expected = new Map<number, string>();
    for (const id of [a, b, c]) expected.set(id, await replyLocation(h.db, q, id));
    expect([...expected.values()]).toEqual([`/t/${q}#c-${a}`, `/t/${q}?page=2#c-${b}`, `/t/${q}?page=3#c-${c}`]);
    const all = await listObjections(h.db, q, { ...opts, page: 1 });
    expect(all.objections.map((o) => [o.id, o.location])).toEqual([c, b, a].map((id) => [id, expected.get(id)]));
    // The panel shows each writer's latest item; taro has only the unhidden objection at position 100.
    const panel = await loadObjectionPanel(h.db, q, opts);
    expect(panel.objections.map((o) => [o.id, o.location])).toEqual([c, b, a].map((id) => [id, expected.get(id)]));
    // The page also matches the Markdown list computed with window functions.
    expect((await listObjectionRefs(h.db, q)).map((r) => [r.id, r.page])).toEqual([[c, 3], [b, 2], [a, 1]]);
    // The query count is independent of the number of objections; do not call replyLocation for each reply.
    const counted = (): { db: typeof h.db; count: () => number } => {
      let n = 0;
      const db = new Proxy(h.db, {
        get(target, prop, receiver) {
          const value = Reflect.get(target, prop, receiver);
          return typeof value === "function" && (prop === "select" || prop === "selectDistinctOn" || prop === "execute") ? (...args: unknown[]) => (n++, (value as (...a: unknown[]) => unknown).apply(target, args)) : value;
        },
      });
      return { db, count: () => n };
    };
    const one = await question("異議が1件の問い");
    await reply(taro, one, { stanceTag: "objection", body: "1件。" }, t(2400));
    const few = counted();
    await loadObjectionPanel(few.db, one, opts);
    const many = counted();
    expect((await loadObjectionPanel(many.db, q, opts)).objections).toHaveLength(3);
    expect(few.count()).toBeGreaterThan(0);
    expect(many.count()).toBe(few.count());
    const manyAll = counted();
    await listObjections(manyAll.db, q, { ...opts, page: 1 });
    const fewAll = counted();
    await listObjections(fewAll.db, one, { ...opts, page: 1 });
    expect(manyAll.count()).toBe(fewAll.count());
  });

  it("puts the panel on the page of a visible question (even when empty), and the link to the original on another way of asking", async () => {
    const q = await question("枠が出る問い");
    type Page = { question: { asksStance: boolean; isAlt: boolean; origin: { id: number } | null; objections: { alternatives: unknown[]; objections: unknown[] } | null } };
    const empty = await load<Page>("topic", "hana", `/t/${q}`, { id: String(q) });
    expect(empty.question).toMatchObject({ asksStance: true, isAlt: false, origin: null, objections: { alternatives: [], objections: [] } });
    const alt = await post("taro", taro, { title: "別の立て方のページ", asksStance: true, altOf: q });
    const withAlt = await load<Page>("topic", "hana", `/t/${q}`, { id: String(q) });
    expect(withAlt.question.objections?.alternatives).toHaveLength(1);
    const altPage = await load<Page>("topic", "hana", `/t/${alt}`, { id: String(alt) });
    expect(altPage.question).toMatchObject({ asksStance: true, isAlt: true, origin: { id: q } });
    // If the original question becomes unreadable, replace its link with "読めません".
    await hideEntry(h.db, { ...OP, id: mary }, { entryId: q, reason: "spam", note: "n" });
    const unreadable = await load<Page>("topic", "taro", `/t/${alt}`, { id: String(alt) });
    expect(unreadable.question).toMatchObject({ isAlt: true, origin: null });
    // A hidden question's page, when visible to its author, has no panels.
    const hiddenForAuthor = await load<Page>("topic", "hana", `/t/${q}`, { id: String(q) });
    expect(hiddenForAuthor.question.objections).toBeNull();
    // A non-question topic has no question fields.
    const plain = await post("hana", hana, { title: "ふつうの話題のページ" });
    const plainPage = await load<Page>("topic", "hana", `/t/${plain}`, { id: String(plain) });
    expect(plainPage.question).toMatchObject({ asksStance: false, isAlt: false, objections: null });
  });

  it("serves the full objections page: not found for an ordinary topic and a deleted question, a hidden question only to those who may see it", async () => {
    const q = await question("全部見るページ");
    const params = { id: String(q) };
    expect((await h.outcome(async () => load("topic-objections", "hana", `/t/${q}/objections`, params))).status).toBe(200);
    const plain = await post("hana", hana, { title: "ふつう" });
    expect((await h.outcome(async () => load("topic-objections", "hana", `/t/${plain}/objections`, { id: String(plain) }))).status).toBe(404);
    expect((await h.outcome(async () => load("topic-objections", "hana", `/t/424242/objections`, { id: "424242" }))).status).toBe(404);
    expect((await h.outcome(async () => load("topic-objections", "hana", `/t/abc/objections`, { id: "abc" }))).status).toBe(404);
    await hideEntry(h.db, { ...OP, id: mary }, { entryId: q, reason: "spam", note: "n" });
    expect((await h.outcome(async () => load("topic-objections", "hana", `/t/${q}/objections`, params))).status).toBe(200);
    expect((await h.outcome(async () => load("topic-objections", "taro", `/t/${q}/objections`, params))).status).toBe(404);
    const gone = await question("削除される");
    await softDeleteEntry(h.db, gone);
    expect((await h.outcome(async () => load("topic-objections", "hana", `/t/${gone}/objections`, { id: String(gone) }))).status).toBe(404);
    // Nonmembers are redirected to login.
    const mod = (await routes["topic-objections"]()) as Module;
    expect(await h.outcome(async () => mod.loader!(await h.signedArgs(h.request(`/t/${q}/objections`), params)))).toMatchObject({ status: 302, location: `/login?next=${encodeURIComponent(`/t/${q}/objections`)}` });
  });

  // An alternative draft whose original question becomes hidden or deleted cannot publish and previously had no way to change its target. The UI explains why and offers "元の問いへのリンクを外す" to make it independent.
  describe("a draft of another way of asking whose original question became unreadable", () => {
    const altDraft = async (q: number) => {
      const res = await createDraft(h.db, taro, { kind: "topic", title: "書きかけの別の立て方", body: "本文。", lang: "ja", asksStance: true, altOf: q });
      if (!res.ok) throw new Error(`draft failed: ${res.error}`);
      return res.id;
    };
    const send = (as: string, id: number, form: Record<string, string>, headers?: Record<string, string>) =>
      h.outcome(async () => ((await routes.draft()) as unknown as { action: (a: never) => unknown }).action(await h.signedArgs(h.request(`/drafts/${id}`, { as, form: await draftScreenForm(h.db, h.ids[as], id, form), headers }), { id: String(id) })));
    const form = { title: "書き直した別の立て方", body: "書き直した本文。", lang: "ja", aiAssistance: "none", asksStance: "1" };

    it.each([
      ["hidden", async (q: number): Promise<void> => void (await hideEntry(h.db, { ...OP, id: mary }, { entryId: q, reason: "spam", note: "n" }))],
      ["deleted", async (q: number): Promise<void> => void (await softDeleteEntry(h.db, q))],
    ] as const)("cannot be published (%s), and the link is removed through the draft page, which makes it an ordinary question that can be published", async (_name, close) => {
      const q = await question("読めなくなる元の問い");
      const id = await altDraft(q);
      // While readable, the original link cannot be removed because the target is chosen only at creation. Show the original question's title.
      expect(await getDraft(h.db, taro, id)).toMatchObject({ altOf: q, altTitle: "読めなくなる元の問い" });
      expect(await send("taro", id, { intent: "remove_alt", ...form })).toMatchObject({ status: 400, value: { data: { error: "invalid_alt_of", saved: true, altRemoved: false } } });
      expect((await getDraft(h.db, taro, id))?.altOf).toBe(q);
      await close(q);
      // Once unreadable, UI data omits the title and the UI shows the reason and "リンクを外す". Publishing still fails with invalid_alt_of.
      expect(await getDraft(h.db, taro, id)).toMatchObject({ altOf: q, altTitle: null, asksStance: true });
      expect(await send("taro", id, { intent: "publish", ...form })).toMatchObject({ status: 400, value: { data: { error: "invalid_alt_of" } } });
      expect((await row(q)).metaChangedAt).toBeNull();
      // Other members see it as a nonexistent draft. A draft that is not an alternative has no link to remove.
      expect((await send("hana", id, { intent: "remove_alt", ...form })).status).toBe(404);
      const plain = await createDraft(h.db, taro, { kind: "topic", title: "ふつうの下書き", body: "本文。", lang: "ja" });
      if (!plain.ok) throw new Error("draft failed");
      expect(await send("taro", plain.id, { intent: "remove_alt", ...form })).toMatchObject({ status: 400, value: { data: { error: "invalid_alt_of" } } });
      // Reject cross-origin requests.
      expect((await send("taro", id, { intent: "remove_alt", ...form }, { origin: "https://evil.example" })).status).toBe(403);
      expect((await getDraft(h.db, taro, id))?.altOf).toBe(q);
      // Removing the link also saves the form content and preserves asks_stance.
      const removed = await send("taro", id, { intent: "remove_alt", ...form });
      expect(removed).toMatchObject({ status: 200, value: { data: { error: null, saved: true, altRemoved: true } } });
      expect(await getDraft(h.db, taro, id)).toMatchObject({ altOf: null, altTitle: null, asksStance: true, title: "書き直した別の立て方", body: "書き直した本文。" });
      // It can publish as an independent question, not an alternative; the original question is unchanged.
      const published = await send("taro", id, { intent: "publish", ...form });
      expect(published).toMatchObject({ status: 302 });
      expect(await row(idFrom(published.location))).toMatchObject({ kind: "topic", asksStance: true, altOf: null, authorId: taro, title: "書き直した別の立て方" });
      expect(await getDraft(h.db, taro, id)).toBeNull();
      expect((await row(q)).metaChangedAt).toBeNull();
    });

    it("can be unchecked once the link is removed (the checkbox is back)", async () => {
      const q = await question("消える元の問い");
      const id = await altDraft(q);
      await softDeleteEntry(h.db, q);
      expect((await send("taro", id, { intent: "remove_alt", ...form })).status).toBe(200);
      // asksStance can now be cleared and saved because, no longer being an alternative, "立場を聞く" is editable again.
      expect((await send("taro", id, { intent: "save", ...form, asksStance: "" })).status).toBe(200);
      expect(await getDraft(h.db, taro, id)).toMatchObject({ altOf: null, asksStance: false });
    });
  });
});

describe("the question columns are not touched by what does not concern them", () => {
  it("creating a reply to a question moves last_activity_at as usual and sets no lock", async () => {
    const q = await question("普通の動き", t(400));
    await reply(taro, q, { stanceTag: "agree" }, t(410));
    expect(await row(q)).toMatchObject({ lastActivityAt: t(410), replyCount: 1, stanceLockedAt: null, metaChangedAt: null });
    expect(await row(q)).toMatchObject({ changedAt: t(400) });
  });

  it("keeps the database consistent: a question row never carries a mark, a reply row never asks", async () => {
    const bad = await h.db.execute(sql`select count(*)::int as n from entries where (kind = 'reply' and (asks_stance or alt_of is not null)) or (kind = 'topic' and stance_tag is not null)`);
    expect((bad as unknown as { rows: Array<{ n: number }> }).rows[0].n).toBe(0);
  });
});

// Tests in this file share a database. Use createTestDb when an isolated database is needed.
describe("a fresh database", () => {
  it("has no question, lock or mark", async () => {
    const db = await createTestDb();
    expect((await db.select().from(drafts)).length).toBe(0);
    expect((await listTopics(db, { kind: "all" }, { asksOnly: true })).topics).toEqual([]);
  });
});
