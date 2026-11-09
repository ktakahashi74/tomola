
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createStaticHandler, createStaticRouter, StaticRouterProvider, type StaticHandlerContext } from "react-router";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { EntryFields } from "~/components/entry-fields";
import { AI_ASSISTANCE } from "~/lib/ai-assistance";
import { drafts, entries } from "~/lib/db/schema";
import { createDraft, getDraft, publishDraft, updateDraft } from "~/lib/drafts.server";
import { createReply, createTopic, getThread } from "~/lib/entries.server";
import { buildObservationExport, buildMemberExport } from "~/lib/exports.server";
import { createApiToken } from "~/lib/tokens.server";
import { getMd, parseBlocks } from "./helpers/md";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";

// ai_assistance is optional: the screens have no field for it and show no mark; a post written on screen states none (NULL = not stated); frontmatter and the API
// may still set one (none | polish | draft | coauthor); the Markdown twins omit the line when it is absent. The tests use the real messages, to see what a screen would say.
vi.mock("~/paraglide/messages.js", async () => ({ m: (await import("./helpers/messages-json")).jsonMessages() }));

let h: RouteHarness;
let draftToken: string;

beforeAll(async () => {
  h = await setupRouteHarness();
  await h.signIn("hana", { homeArea: "ja", readLangs: ["ja", "en"] });
  const token = await createApiToken(h.db, h.ids.hana, { name: "tool", kind: "draft" });
  if (!token.ok) throw new Error("token failed");
  draftToken = token.token;
});
afterAll(() => h.restore());

const md = (frontmatter: string, body = "Body.") => `---\n${frontmatter}\n---\n${body}`;
const stored = async (title: string) => (await h.db.select().from(entries).where(eq(entries.title, title)))[0];

async function apiDraft(markdown: string): Promise<{ status: number; id: number; error?: string }> {
  const request = new Request("http://localhost:5173/api/drafts", { method: "POST", headers: { authorization: `Bearer ${draftToken}`, "content-type": "text/markdown" }, body: markdown });
  const res = (await (await import("~/routes/api.drafts")).action({ request, params: {}, context: {} } as never)) as Response;
  const json = (await res.json()) as { id?: number; error?: string };
  return { status: res.status, id: json.id ?? 0, error: json.error };
}

describe("the services: ai_assistance is optional", () => {
  it("stores NULL when no value is given, and keeps a value that is given (an explicit none is a value, not the same as none stated)", async () => {
    const a = await createTopic(h.db, h.ids.hana, { lang: "ja", title: "svc none stated", body: "b" });
    const b = await createTopic(h.db, h.ids.hana, { lang: "ja", title: "svc none given", body: "b", aiAssistance: "none" });
    const c = await createTopic(h.db, h.ids.hana, { lang: "ja", title: "svc polish", body: "b", aiAssistance: "polish" });
    const d = await createTopic(h.db, h.ids.hana, { lang: "ja", title: "svc null", body: "b", aiAssistance: null });
    for (const r of [a, b, c, d]) if (!r.ok) throw new Error("topic failed");
    expect((await stored("svc none stated")).aiAssistance).toBeNull();
    expect((await stored("svc none given")).aiAssistance).toBe("none");
    expect((await stored("svc polish")).aiAssistance).toBe("polish");
    expect((await stored("svc null")).aiAssistance).toBeNull();
    if (!a.ok) throw new Error("topic failed");
    const reply = await createReply(h.db, h.ids.hana, a.id, { lang: "ja", body: "r" });
    const replyWith = await createReply(h.db, h.ids.hana, a.id, { lang: "ja", body: "r2", aiAssistance: "coauthor" });
    expect(reply.ok && replyWith.ok).toBe(true);
    const thread = await getThread(h.db, a.id);
    expect(thread?.topic.aiAssistance).toBeNull();
    expect(thread?.replies.map((r) => r.aiAssistance)).toEqual([null, "coauthor"]);
  });

  it("still refuses a value that is not one of the four", async () => {
    expect(await createTopic(h.db, h.ids.hana, { lang: "ja", title: "svc bad", body: "b", aiAssistance: "ghost" })).toMatchObject({ ok: false, error: "invalid_ai" });
    expect(await createDraft(h.db, h.ids.hana, { kind: "topic", lang: "ja", title: "bad", body: "b", aiAssistance: "ghost" })).toMatchObject({ ok: false, error: "invalid_ai" });
    expect([...AI_ASSISTANCE]).toEqual(["none", "polish", "draft", "coauthor"]);
  });

  it("drafts: no value is NULL; saving a draft from the screen leaves the value it has; publishing hands it on", async () => {
    const plain = await createDraft(h.db, h.ids.hana, { kind: "topic", lang: "ja", title: "draft plain", body: "b" });
    const withValue = await createDraft(h.db, h.ids.hana, { kind: "topic", lang: "ja", title: "draft valued", body: "b", aiAssistance: "draft" }, { via: "api" });
    if (!plain.ok || !withValue.ok) throw new Error("draft failed");
    expect((await getDraft(h.db, h.ids.hana, plain.id))?.aiAssistance).toBeNull();
    expect((await getDraft(h.db, h.ids.hana, withValue.id))?.aiAssistance).toBe("draft");
    // The draft screen sends no ai_assistance: both keep what they had.
    expect(await updateDraft(h.db, h.ids.hana, withValue.id, { lang: "ja", title: "draft valued", body: "edited" })).toEqual({ ok: true });
    expect(await updateDraft(h.db, h.ids.hana, plain.id, { lang: "ja", title: "draft plain", body: "edited" })).toEqual({ ok: true });
    expect((await getDraft(h.db, h.ids.hana, withValue.id))?.aiAssistance).toBe("draft");
    expect((await getDraft(h.db, h.ids.hana, plain.id))?.aiAssistance).toBeNull();
    // A value can still be changed or cleared through the service (not through any screen).
    expect(await updateDraft(h.db, h.ids.hana, plain.id, { lang: "ja", title: "draft plain", body: "edited", aiAssistance: "polish" })).toEqual({ ok: true });
    expect((await getDraft(h.db, h.ids.hana, plain.id))?.aiAssistance).toBe("polish");
    expect(await updateDraft(h.db, h.ids.hana, plain.id, { lang: "ja", title: "draft plain", body: "edited", aiAssistance: null })).toEqual({ ok: true });
    expect((await getDraft(h.db, h.ids.hana, plain.id))?.aiAssistance).toBeNull();
    expect((await publishDraft(h.db, h.ids.hana, plain.id)).ok).toBe(true);
    expect((await publishDraft(h.db, h.ids.hana, withValue.id)).ok).toBe(true);
    expect((await stored("draft plain")).aiAssistance).toBeNull();
    expect(await stored("draft valued")).toMatchObject({ aiAssistance: "draft", via: "api" });
  });
});

describe("writing on screen states no ai_assistance", () => {
  const newTopic = async (fields: Record<string, string>) => h.outcome(async () => (await import("~/routes/topic-new")).action(await h.signedArgs(h.request("/t/new", { as: "hana", form: fields }))));
  const replyTo = async (topicId: number, fields: Record<string, string>) =>
    h.outcome(async () => (await import("~/routes/topic")).action(await h.signedArgs(h.request(`/t/${topicId}`, { as: "hana", form: fields }), { id: String(topicId) })));

  it("a new topic and a reply from the forms store NULL, and a posted aiAssistance field is not read", async () => {
    expect((await newTopic({ title: "screen topic", body: "Hello.", lang: "ja" })).status).toBe(302);
    expect((await stored("screen topic")).aiAssistance).toBeNull();
    expect((await newTopic({ title: "screen topic injected", body: "Hello.", lang: "ja", aiAssistance: "coauthor" })).status).toBe(302);
    expect((await stored("screen topic injected")).aiAssistance).toBeNull();
    const topic = await stored("screen topic");
    expect((await replyTo(topic.id, { body: "A reply.", lang: "ja", aiAssistance: "draft" })).status).toBe(302);
    expect((await h.db.select().from(entries).where(eq(entries.body, "A reply.")))[0].aiAssistance).toBeNull();
  });

  it("pasted frontmatter with ai_assistance sets it, and none is a value that differs from not stating one", async () => {
    expect((await newTopic({ title: "", body: md("title: pasted polish\nlang: en\nai_assistance: polish"), lang: "" })).status).toBe(302);
    expect((await stored("pasted polish")).aiAssistance).toBe("polish");
    expect((await newTopic({ title: "", body: md("title: pasted none\nlang: en\nai_assistance: none"), lang: "" })).status).toBe(302);
    expect((await stored("pasted none")).aiAssistance).toBe("none");
    expect((await newTopic({ title: "", body: md("title: pasted absent\nlang: en"), lang: "" })).status).toBe(302);
    expect((await stored("pasted absent")).aiAssistance).toBeNull();
    // A bad value in the frontmatter is still refused, as before.
    const bad = await newTopic({ title: "", body: md("title: pasted bad\nai_assistance: full"), lang: "" });
    expect(bad.status).toBe(400);
    expect(JSON.stringify((bad.value as { data: unknown }).data)).toContain("frontmatter_invalid");
  });

  it("a draft from the screen is NULL, saving it from the draft page keeps an API value, and publishing hands the value on", async () => {
    expect((await newTopic({ intent: "draft", title: "screen draft", body: "Draft.", lang: "ja" })).status).toBe(302);
    const [screenDraft] = await h.db.select().from(drafts).where(eq(drafts.title, "screen draft"));
    expect(screenDraft.aiAssistance).toBeNull();
    const created = await apiDraft(md("type: topic\ntitle: api draft\nlang: en\nai_assistance: coauthor"));
    expect(created.status).toBe(201);
    const page = await import("~/routes/draft");
    const act = (id: number, form: Record<string, string>) => h.outcome(async () => page.action(await h.signedArgs(h.request(`/drafts/${id}`, { as: "hana", form }), { id: String(id) })));
    // Saving from the draft page (which has no such field) leaves the value alone; a posted aiAssistance is not read.
    expect((await act(created.id, { intent: "save", title: "api draft", body: "Edited.", lang: "en", aiAssistance: "none" })).status).toBe(200);
    expect((await getDraft(h.db, h.ids.hana, created.id))?.aiAssistance).toBe("coauthor");
    expect((await act(created.id, { intent: "publish", title: "api draft", body: "Edited.", lang: "en" })).status).toBe(302);
    expect(await stored("api draft")).toMatchObject({ aiAssistance: "coauthor", via: "api", body: "Edited." });
    expect((await act(screenDraft.id, { intent: "publish", version: String(screenDraft.version), title: "screen draft", body: "Draft.", lang: "ja" })).status).toBe(302);
    expect((await stored("screen draft")).aiAssistance).toBeNull();
  });
});

describe("the API drafts", () => {
  it("records the frontmatter value when it is written and nothing (NULL, not none) when it is not; a bad value is invalid_ai", async () => {
    const absent = await apiDraft(md("type: topic\ntitle: api absent"));
    const stated = await apiDraft(md("type: topic\ntitle: api none\nai_assistance: none"));
    const polish = await apiDraft(md("type: topic\ntitle: api polish\nai_assistance: polish"));
    for (const r of [absent, stated, polish]) expect(r.status).toBe(201);
    expect((await getDraft(h.db, h.ids.hana, absent.id))?.aiAssistance).toBeNull();
    expect((await getDraft(h.db, h.ids.hana, stated.id))?.aiAssistance).toBe("none");
    expect((await getDraft(h.db, h.ids.hana, polish.id))?.aiAssistance).toBe("polish");
    expect(await apiDraft(md("type: topic\ntitle: api bad\nai_assistance: full"))).toMatchObject({ status: 400, error: "invalid_ai" });
    // The API still creates drafts only: nothing was published by these requests.
    expect(await h.db.select().from(entries).where(eq(entries.title, "api absent"))).toHaveLength(0);
  });
});

describe("the Markdown twins and the exports", () => {
  it("omits the ai_assistance line of a post without a value, and keeps it for a post with one; endorsed and via stay", async () => {
    const topic = await createTopic(h.db, h.ids.hana, { lang: "ja", title: "md twin", body: "Body." });
    if (!topic.ok) throw new Error("topic failed");
    const reply = await createReply(h.db, h.ids.hana, topic.id, { lang: "ja", body: "Valued reply.", aiAssistance: "polish" });
    const noValue = await createReply(h.db, h.ids.hana, topic.id, { lang: "ja", body: "Plain reply." });
    if (!reply.ok || !noValue.ok) throw new Error("reply failed");
    const res = await getMd(h, `/t/${topic.id}.md`, { as: "hana" });
    const text = await res.text();
    const blocks = parseBlocks(text).filter((b) => b.fm.type === "post" || b.fm.type === "comment");
    expect(blocks).toHaveLength(3);
    const [t, valued, plain] = blocks;
    expect("ai_assistance" in t.fm).toBe(false);
    expect("ai_assistance" in plain.fm).toBe(false);
    expect(valued.fm.ai_assistance).toBe("polish");
    for (const b of blocks) expect(b.fm).toMatchObject({ endorsed: true, via: "web" });
    expect(text.split("\n").filter((line) => line.startsWith("ai_assistance:"))).toEqual(["ai_assistance: polish"]);
  });

  it("the member export and the observation export carry null for a post without a value, in drafts too", async () => {
    await createDraft(h.db, h.ids.hana, { kind: "topic", lang: "ja", title: "export draft", body: "b" });
    const mine = await buildMemberExport(h.db, h.ids.hana);
    expect(mine.entries.find((e) => e.title === "md twin")).toMatchObject({ ai_assistance: null });
    expect(mine.entries.find((e) => e.title === "svc polish")).toMatchObject({ ai_assistance: "polish" });
    expect(mine.drafts.find((d) => d.title === "export draft")).toMatchObject({ ai_assistance: null });
    expect(mine.drafts.find((d) => d.title === "api polish")).toMatchObject({ ai_assistance: "polish" });
    const observation = await buildObservationExport(h.db, { model: null });
    const visible = observation.entries.filter((e) => e.status === "visible") as Array<{ ai_assistance: string | null; via: string }>;
    expect(visible.some((e) => e.ai_assistance === null)).toBe(true);
    expect(visible.some((e) => e.ai_assistance === "polish")).toBe(true);
    expect(visible.every((e) => e.ai_assistance === null || (AI_ASSISTANCE as readonly string[]).includes(e.ai_assistance))).toBe(true);
    // The key stays (null), and the count per via is still there.
    expect(visible.every((e) => "ai_assistance" in e && typeof e.via === "string")).toBe(true);
  });
});

describe("no posting screen has the AI-assistance field or shows the mark", () => {
  async function render(element: () => ReturnType<typeof createElement>): Promise<string> {
    const routes = [{ path: "/", Component: element }];
    const handler = createStaticHandler(routes);
    const context = (await handler.query(new Request("http://localhost/"))) as StaticHandlerContext;
    return renderToStaticMarkup(createElement(StaticRouterProvider, { router: createStaticRouter(routes, context), context }));
  }
  const FORBIDDEN = [/aiAssistance/, /AI assistance/i, /AIの支援/, /AI支援/, /Polishing/, /Co-authoring/, /Drafting/, /推敲/, /共著/];

  it("the shared fields of the new-topic form, the reply form, the draft page and the edit form have no such field, in English and Japanese", async () => {
    const variants = [
      { pasteFrontmatter: "topic" as const, defaultLang: "ja" as const },
      { pasteFrontmatter: "reply" as const, defaultLang: "en" as const },
      { defaultLang: "ja" as const, defaultBody: "A draft body" },
      { fixedLang: "ja" as const, defaultBody: "An edit" },
    ];
    for (const locale of ["en", "ja"] as const) {
      const { setTestLocale } = await import("./stubs/paraglide-runtime");
      setTestLocale(locale);
      for (const props of variants) {
        const out = await render(() => createElement(EntryFields, props));
        expect(out, JSON.stringify(props)).toContain('name="body"');
        for (const pattern of FORBIDDEN) expect(out, `${locale} ${JSON.stringify(props)} ${pattern}`).not.toMatch(pattern);
      }
      setTestLocale("en");
    }
  });
});
