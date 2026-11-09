import { hitIpLimit } from "~/lib/rate-limit.server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createStaticHandler, createStaticRouter, StaticRouterProvider, type StaticHandlerContext } from "react-router";
import { createTopic, createReply, softDeleteEntry } from "~/lib/entries.server";
import { entries, rateLimits } from "~/lib/db/schema";
import { createTranslationHandlers } from "~/lib/jobs/translation-jobs.server";
import { runDueJobs } from "~/lib/jobs/queue.server";
import { createFakeEngine } from "~/lib/llm/engines/fake.server";
import { setVote } from "~/lib/votes.server";
import { serveThreadMd, serveListMd, serveAreaMd } from "~/lib/md/twin.server";
import { llmsTxt, aiTxt, helpAiMd } from "~/lib/api/guides.server";
import { assertStartupConfig } from "~/lib/startup-checks.server";
import { readerLoginHref } from "~/lib/public-reading";
import { setTestLocale } from "./stubs/paraglide-runtime";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";
import { m } from "~/paraglide/messages.js";
import { escapeRegex, messageMarkup } from "./helpers/message-markup";
import { parseBlocks } from "./helpers/md";
import { renderInRouter, withShellLabels } from "./helpers/render-in-router";

vi.mock("~/paraglide/messages.js", async () => ({ m: (await import("./helpers/messages-json")).jsonMessages() }));

let h: RouteHarness;
const ids: Record<string, number> = {};
beforeAll(async () => {
  h = await setupRouteHarness();
  await h.signIn("writer", { homeArea: "ja", readLangs: ["ja"] });
  await h.signIn("reader", { homeArea: "en", readLangs: ["en"] });
  await h.signIn("pending", { profile: false });
  for (const [name, asksStance] of [["topic", false], ["question", true], ["hidden", false]] as const) {
    const result = await createTopic(h.db, h.ids.writer, { lang: "ja", title: `Title ${name}`, body: `Body ${name}`, asksStance });
    if (!result.ok) throw new Error(result.error);
    ids[name] = result.id;
  }
  for (const name of ["reason", "objection", "hiddenReply", "deletedReply"]) {
    const result = await createReply(h.db, h.ids.writer, ids.question, { lang: "ja", body: `Body ${name}`, stanceTag: name === "reason" ? "agree" : name === "objection" ? "objection" : null });
    if (!result.ok) throw new Error(result.error);
    ids[name] = result.id;
  }
  await runDueJobs(h.db, createTranslationHandlers({ llm: { engines: { primary: createFakeEngine(), secondary: null, judge: null }, env: {} } }), { now: new Date("2031-01-01"), limit: 1000, logger: { error: () => {}, warn: () => {} } });
  await h.db.update(entries).set({ hiddenAt: new Date() }).where(sql`${entries.id} in (${ids.hidden}, ${ids.hiddenReply})`);
  await softDeleteEntry(h.db, ids.deletedReply);
  await setVote(h.db, h.ids.reader, ids.question, true);
  await setVote(h.db, h.ids.reader, ids.reason, true);
});
afterAll(() => { h.restore(); vi.unstubAllEnvs(); setTestLocale("en"); });

async function pages() {
  return [
    { mod: await import("~/routes/home"), path: "/", params: {} },
    { mod: await import("~/routes/topic"), path: `/t/${ids.question}`, params: { id: String(ids.question) } },
    { mod: await import("~/routes/area"), path: "/a/ja", params: { lang: "ja" } },
    { mod: await import("~/routes/latest"), path: "/latest", params: {} },
    { mod: await import("~/routes/topic-objections"), path: `/t/${ids.question}/objections`, params: { id: String(ids.question) } },
  ].map(page => ({ ...page, params: page.params as Record<string, string> }));
}

describe("public reading configuration and browser boundaries", () => {
  it("omits every forced post version from login destinations while preserving other query values", () => {
    const href = readerLoginHref("/t/42", "?orig=42&orig=7&tr=8&old=9&lang=ja&page=2&q=a%20b");
    const next = new URL(href, "http://tomola.invalid").searchParams.get("next")!;
    const destination = new URL(next, "http://tomola.invalid");
    expect(destination.pathname).toBe("/t/42");
    for (const name of ["orig", "tr", "old"]) expect(destination.searchParams.has(name)).toBe(false);
    expect(readerLoginHref("/t/42", "?orig=42&tr=42&old=42&lang=en&page=1")).toBe(`/login?next=${encodeURIComponent("/t/42?lang=en&page=1")}`);
    expect(destination.searchParams.get("lang")).toBe("ja");
    expect(destination.searchParams.get("page")).toBe("2");
    expect(destination.searchParams.get("q")).toBe("a b");
    expect(readerLoginHref("/t/42", "?lang=ja&q=a%20b")).toBe("/login?next=%2Ft%2F42%3Flang%3Dja%26q%3Da%2520b");
  });

  it("rejects invalid configuration at startup, including development", () => {
    for (const value of ["0", "true", "false", "2"]) expect(() => assertStartupConfig({ TOMOLA_OPERATOR_DIR: process.env.TOMOLA_OPERATOR_DIR, NODE_ENV: "development", PUBLIC_READING: value })).toThrow(/PUBLIC_READING/);
    for (const value of [undefined, "", "1"]) expect(() => assertStartupConfig({ TOMOLA_OPERATOR_DIR: process.env.TOMOLA_OPERATOR_DIR, NODE_ENV: "development", PUBLIC_READING: value })).not.toThrow();
  });

  it("keeps pages and Markdown authenticated by default", async () => {
    vi.stubEnv("PUBLIC_READING", "");
    for (const { mod, path, params } of await pages()) expect(await h.outcome(async () => (await mod.loader(h.args(h.request(path), params)))), path).toMatchObject({ status: 302 });
    expect((await serveThreadMd(h.request(`/t/${ids.topic}.md`), String(ids.topic))).status).toBe(401);
    for (const spec of [{ kind: "home" }, { kind: "latest" }] as const) expect((await serveListMd(h.request(`/${spec.kind}.md`), spec)).status).toBe(401);
    expect((await serveAreaMd(h.request("/a/ja.md"), "ja")).status).toBe(401);
  });

  it("opens exactly the reading pages and emits no member ids or stance state", async () => {
    vi.stubEnv("PUBLIC_READING", "1");
    for (const { mod, path, params } of await pages()) {
      const outcome = await h.outcome(async () => (await mod.loader(h.args(h.request(`${path}?lang=en&peek=${ids.question}&review=${ids.reason}&posted=${ids.question}&write=agree&stance_msg=conflict`), params))));
      expect(outcome.status, path).toBe(200);
      const text = JSON.stringify(outcome.value);
      expect(text).toContain("writer");
      for (const userId of Object.values(h.ids)) expect(text, path).not.toContain(userId);
      expect(text).not.toMatch(/"distribution"|"position"|"version"|"triggerEntryId"|"state"/);
      expect(mod.headers()).toMatchObject({ "Cache-Control": "private", "X-Robots-Tag": "noindex" });
      expect(mod.meta({ loaderData: outcome.value, location: { search: "" }, matches: [{ id: "root", loaderData: { publicReading: true } }] } as never)).toContainEqual({ name: "robots", content: "noindex" });
    }
    const home = await import("~/routes/home");
    const loaded = await home.loader(h.args(h.request("/?lang=en")));
    expect(loaded).toMatchObject({ stanceMessage: null });
    expect(loaded).not.toHaveProperty("composer");
    expect(loaded).not.toHaveProperty("postedId");
    if (loaded.layout !== "unified") throw new Error("expected rows");
    expect(loaded.topics.find(c => c.id === ids.question)).toMatchObject({ canChoose: false, title: { lang: "en", kind: "primary" } });
    expect(loaded.topics.find(c => c.id === ids.question)?.title.text).toContain("[en] Title question");
    expect(loaded.topics.map(c => c.id)).not.toContain(ids.hidden);
    const topic = await import("~/routes/topic");
    const thread = await topic.loader(h.args(h.request(`/t/${ids.question}?peek=1&write=agree&posted=${ids.question}`), { id: String(ids.question) }));
    expect(thread).toMatchObject({ follow: null, operator: false, writeTag: null, question: { stance: null, locked: false, canFix: false } });
    expect(thread.question.reasons?.agree[0].excerpt.text).toContain("Body reason");
    expect(thread.question.objections?.objections[0].excerpt).toContain("Body objection");
    if (thread.topic.placeholder !== null) throw new Error("expected content");
    expect(thread.topic).toMatchObject({ own: false, canEdit: false, posted: false, reported: false, hiddenAction: null, canModerate: false, reviewHref: null });
    expect(thread.replies.find(r => r.id === ids.hiddenReply)).toEqual({ id: ids.hiddenReply, placeholder: "hidden" });
    expect(thread.replies.find(r => r.id === ids.deletedReply)).toBeUndefined();
    const hidden = await topic.loader(h.args(h.request(`/t/${ids.hidden}`), { id: String(ids.hidden) }));
    expect(hidden.topic).toEqual({ id: ids.hidden, placeholder: "hidden" });
    expect(JSON.stringify(hidden)).not.toContain("Body hidden");
  });

  it("renders reader HTML without write controls, member links or stance data", async () => {
    vi.stubEnv("PUBLIC_READING", "1");
    const layout = await import("~/routes/member-layout");
    for (const { mod, path, params } of await pages()) {
      const request = h.request(`${path}?lang=en&peek=1`);
      const loaderData = await mod.loader(h.args(request, params));
      const headerData = await layout.loader(h.args(request));
      const routes = withShellLabels([{ path: "/", element: createElement(layout.default, { loaderData: headerData } as never), children: [{ ...(path === "/" ? { index: true as const } : { path: path.slice(1) }), element: createElement(mod.default as never, { loaderData } as never) }] }]);
      const context = await createStaticHandler(routes).query(request) as StaticHandlerContext;
      const router = createStaticRouter(routes, context);
      const html = renderToStaticMarkup(createElement(StaticRouterProvider, { router, context, hydrate: false }));
      expect(html).toContain("@writer");
      expect(html).toContain(messageMarkup(m.login_title()));
      expect(html).not.toMatch(/href="\/u\/|data-member-menu|data-admin-menu|role="search"|<textarea|action="\/(?:vote|stance|follow)|name="intent"/);
      expect(html).not.toMatch(/href="\/(?:settings|glossary|moderation|following|notifications|t\/new)/);
      for (const id of Object.values(h.ids)) expect(html).not.toContain(id);
      if (!path.endsWith("objections")) {
        // The note that stances are for members is on the question's page only; a list row of a question does not repeat it.
        if (path.startsWith("/t/")) expect(html).toContain(messageMarkup(m.public_reading_stances()));
        else expect(html).not.toContain(messageMarkup(m.public_reading_stances()));
        expect(html).toContain("Insightful 1");
      }
      if (path === `/t/${ids.question}`) expect(html).toContain("Membership is by invitation.");
    }
  });

  it("labels replies with the list count even when a filter has no matching replies", async () => {
    vi.stubEnv("PUBLIC_READING", "1");
    const home = await import("~/routes/home");
    const topic = await import("~/routes/topic");
    const list = await home.loader(h.args(h.request("/")));
    if (list.layout !== "unified") throw new Error("expected rows");
    const count = list.topics.find(row => row.id === ids.question)!.replyCount;
    expect(count).toBe(3);
    for (const query of ["", "?tag=agree", "?tag=disagree"]) {
      const path = `/t/${ids.question}${query}`;
      const loaderData = await topic.loader(h.args(h.request(path), { id: String(ids.question) }));
      expect(loaderData.replyCount).toBe(count);
      const html = await renderInRouter(() => createElement(topic.default, { loaderData } as never), path);
      const section = html.match(/<section id="replies"[^>]*>([\s\S]*?)<\/section>/)![1];
      expect(section).toMatch(new RegExp(`^<h2[^>]*>${escapeRegex(messageMarkup(m.home_replies({ count })))}</h2>`));
    }
    const loaderData = await topic.loader(h.args(h.request(`/t/${ids.topic}`), { id: String(ids.topic) }));
    const empty = await renderInRouter(() => createElement(topic.default, { loaderData } as never), `/t/${ids.topic}`);
    expect(empty.match(/<section id="replies"[^>]*>([\s\S]*?)<\/section>/)![1]).not.toContain("<h2");
  });

  it("shows Why and Principles in the reader header while keeping the member header unchanged", async () => {
    vi.stubEnv("PUBLIC_READING", "1");
    const layout = await import("~/routes/member-layout");
    for (const as of [null, "reader"]) {
      const loaderData = await layout.loader(h.args(h.request("/", as ? { as } : {})));
      const html = await renderInRouter(() => createElement(layout.default, { loaderData } as never));
      const header = html.match(/<header[^>]*>([\s\S]*?)<\/header>/)![1];
      for (const path of ["/why", "/principles"]) {
        if (as) expect(header).not.toContain(`href="${path}"`);
        else expect(header).toContain(`href="${path}"`);
      }
    }
  });

  it("shows only the closed-replies notice to readers on hidden topics", async () => {
    vi.stubEnv("PUBLIC_READING", "1");
    const topic = await import("~/routes/topic");
    const path = `/t/${ids.hidden}`;
    const loaderData = await topic.loader(h.args(h.request(path), { id: String(ids.hidden) }));
    const html = await renderInRouter(() => createElement(topic.default, { loaderData } as never), path);
    const reply = html.match(/<section id="reply"[^>]*>([\s\S]*?)<\/section>/)![1];
    expect(reply).toContain(messageMarkup(m.reply_closed_hidden()));
    expect(reply).not.toContain(messageMarkup(m.public_reading_reply()));
    expect(reply).not.toContain('href="/login');
  });

  it("does not query member-only state for reader pages", async () => {
    vi.stubEnv("PUBLIC_READING", "1");
    const stances = await import("~/lib/stances.server");
    const distribution = await import("~/lib/distribution.server");
    const moderation = await import("~/lib/moderation.server");
    const follows = await import("~/lib/follows.server");
    const spies = [vi.spyOn(stances, "loadOwnStances"), vi.spyOn(stances, "loadReviewTrigger"), vi.spyOn(distribution, "readDistributions"), vi.spyOn(moderation, "loadOwnOpenReportIds"), vi.spyOn(moderation, "latestEntryAction"), vi.spyOn(follows, "getFollowState"), vi.spyOn(follows, "markFollowedThreadRead")];
    try {
      for (const { mod, path, params } of await pages()) await mod.loader(h.args(h.request(`${path}?peek=1&review=${ids.reason}`), params));
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally { spies.forEach(spy => spy.mockRestore()); }
  });

  it("keeps all excluded screens behind login", async () => {
    vi.stubEnv("PUBLIC_READING", "1");
    const routes = ["search", "member-page", "following", "notifications", "settings", "drafts", "glossary", "moderation", "mod", "admin-roles"];
    for (const name of routes) {
      const mod = await import(`../app/routes/${name}.tsx`);
      expect(await h.outcome(async () => (await mod.loader(h.args(h.request(`/${name}`), { handle: "writer" })))), name).toMatchObject({ status: 302 });
    }
  });

  it("keeps POSTs and incomplete registrations authenticated", async () => {
    vi.stubEnv("PUBLIC_READING", "1");
    for (const { mod, path, params } of (await pages()).slice(0, 2)) {
      if (!("action" in mod)) throw new Error("missing action");
      const response = await h.outcome(() => mod.action(h.args(h.request(path, { form: { body: "write" } }), params)));
      expect(response).toMatchObject(path === "/" ? { status: 405 } : { status: 302, location: "/login" });
      expect(await h.outcome(async () => (await mod.loader(h.args(h.request(path, { as: "pending" }), params))))).toMatchObject({ status: 302, location: "/onboarding" });
    }
  });

  it("preserves member loader data when the switch changes", async () => {
    for (const { mod, path, params } of (await pages()).slice(0, 2)) {
      vi.stubEnv("PUBLIC_READING", "");
      const before = await mod.loader(h.args(h.request(path, { as: "reader" }), params));
      vi.stubEnv("PUBLIC_READING", "1");
      const after = await mod.loader(h.args(h.request(path, { as: "reader" }), params));
      const withoutTime = (value: unknown) => { const copy = { ...value as Record<string, unknown> }; delete copy.loadedAt; return copy; };
      expect(withoutTime(after)).toEqual(withoutTime(before));
    }
  });


});

describe("public Markdown authentication", () => {
  it("keeps all-translation reads within the public boundary and marks pending target languages", async () => {
    vi.stubEnv("PUBLIC_READING", "1");
    for (const extension of ["md", "txt"]) {
      const response = await serveThreadMd(h.request(`/t/${ids.question}.${extension}?lang=all`), String(ids.question));
      expect(response.status).toBe(200);
      const text = await response.text();
      const blocks = parseBlocks(text);
      expect(blocks.find(b => b.fm.type === "post")!.fm).toHaveProperty("translations_pending");
      expect(blocks.filter(b => b.fm.type === "translation").length).toBeGreaterThan(1);
      expect(blocks.find(b => b.fm.id === `c-${ids.deletedReply}`)).toBeUndefined();
      for (const id of [ids.hiddenReply]) {
        const placeholder = blocks.find(b => b.fm.id === `c-${id}`)!;
        expect(placeholder.body).toBe("");
        expect(placeholder.fm).not.toHaveProperty("translations_pending");
        expect(blocks.some(b => b.fm.translation_of === `c-${id}`)).toBe(false);
      }
      for (const userId of Object.values(h.ids)) expect(text).not.toContain(userId);
      expect(text).not.toMatch(/Body hiddenReply|Body deletedReply|stance_distribution|stance_total|own_stance/);
    }
    const hidden = await (await serveThreadMd(h.request(`/t/${ids.hidden}.md?lang=all`), String(ids.hidden))).text();
    expect(hidden).toContain("hidden: true");
    expect(hidden).not.toMatch(/Body hidden|type: translation|translations_pending/);
    const stances = await import("~/routes/stances-md");
    expect((await stances.loader(h.args(h.request(`/t/${ids.question}/stances.md?lang=all`), { id: String(ids.question) }))).status).toBe(401);
    vi.stubEnv("PUBLIC_READING", "");
    expect((await serveThreadMd(h.request(`/t/${ids.question}.md?lang=all`), String(ids.question))).status).toBe(401);
  });
  it("opens only the selected twins, including .txt", async () => {
    vi.stubEnv("PUBLIC_READING", "1");
    for (const extension of ["md", "txt"]) {
      const responses = [
        await serveThreadMd(h.request(`/t/${ids.question}.${extension}?lang=en`), String(ids.question)),
        await serveListMd(h.request(`/home.${extension}`), { kind: "home" }),
        await serveListMd(h.request(`/latest.${extension}`), { kind: "latest" }),
        await serveAreaMd(h.request(`/a/ja.${extension}`), "ja"),
      ];
      for (const response of responses) {
        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toBe("private, no-store");
        expect(response.headers.get("x-robots-tag")).toBe("noindex");
        const text = await response.text();
        expect(text).toContain("@writer");
        for (const userId of Object.values(h.ids)) expect(text).not.toContain(userId);
        expect(text).not.toMatch(/stance_distribution|stance_total|own_stance/);
      }
    }
    const hidden = await (await serveThreadMd(h.request(`/t/${ids.hidden}.md`), String(ids.hidden))).text();
    expect(hidden).toContain("hidden: true"); expect(hidden).not.toContain("Body hidden");
  });

  it("never downgrades invalid credentials to a public reader", async () => {
    vi.stubEnv("PUBLIC_READING", "1");
    const requests = [
      h.request("/home.md", { headers: { authorization: "Bearer invalid" } }),
      h.request("/home.md?k=invalid"),
      h.request("/home.md?k="),
      h.request("/home.md", { headers: { cookie: "better-auth.session_token=invalid" } }),
      h.request("/home.md", { headers: { cookie: "__Secure-better-auth.session_token=invalid" } }),
      h.request("/home.md", { headers: { cookie: "better-auth.session_token=" } }),
      h.request("/home.md", { headers: { cookie: "better-auth.session_token = invalid" } }),
    ];
    for (const request of requests) expect((await serveListMd(request, { kind: "home" })).status).toBe(401);
    for (const suffix of [".md", ".txt"]) {
      for (const kind of ["home", "latest"] as const) expect((await serveListMd(h.request(`/${kind}${suffix}`, { headers: { authorization: "Bearer invalid" } }), { kind })).status).toBe(401);
      expect((await serveAreaMd(h.request(`/a/en${suffix}?k=invalid`), "en")).status).toBe(401);
      expect((await serveThreadMd(h.request(`/t/${ids.topic}${suffix}?k=invalid`), String(ids.topic))).status).toBe(401);
    }
    expect((await serveListMd(h.request("/home.md", { headers: { cookie: "PARAGLIDE_LOCALE=ja" } }), { kind: "home" })).status).toBe(200);
  });

  it("does not open protected twins or read APIs", async () => {
    vi.stubEnv("PUBLIC_READING", "1");
    expect((await serveListMd(h.request("/following.md"), { kind: "following" })).status).toBe(401);
    for (const name of ["stances-md", "search-md", "changes-md", "manifest", "glossary-md", "glossary-export"]) {
      const mod = await import(`../app/routes/${name}.ts`);
      const out = await h.outcome(async () => (await mod.loader(h.args(h.request(`/${name}`), { id: String(ids.question) }))));
      expect(out.status, name).toBe(401);
    }
  });

  it("changes only the enabled guides' description of public access", () => {
    vi.stubEnv("PUBLIC_READING", "");
    expect(llmsTxt()).toContain("Without credentials the answer is 401");
    expect(aiTxt()).toContain("Read access: members-only");
    vi.stubEnv("PUBLIC_READING", "1");
    for (const text of [llmsTxt(), aiTxt(), helpAiMd()]) {
      expect(text).toContain("without credentials");
      expect(text).toMatch(/stance.*search.*change/i);
    }
  });
});

describe("public read limits", () => {
  it("counts one shared request once and shares the IP cap with Markdown twins", async () => {
    vi.stubEnv("PUBLIC_READING", "1"); vi.stubEnv("TRUSTED_PROXY_HOPS", "1");
    const layout = await import("~/routes/member-layout");
    const home = await import("~/routes/home");
    const request = h.request("/", { headers: { "x-forwarded-for": "192.0.2.80" } });
    const [header, body] = await Promise.all([(await layout.loader(h.args(request))), (await home.loader(h.args(request)))]);
    expect(header).toEqual({ reader: true });
    expect(body.layout).toBe("unified");
    expect(await h.db.select().from(rateLimits).where(eq(rateLimits.key, "ip:public-read:192.0.2.80"))).toEqual([]);
    // The next hit is number two: parent and child shared exactly one count.
    expect((await hitIpLimit(h.db, request, "public-read"))?.count).toBe(2);
    for (let i = 2; i < 598; i++) await hitIpLimit(h.db, request, "public-read");
    const get = (path: string) => h.request(path, { headers: { "x-forwarded-for": "192.0.2.80" } });
    expect((await serveListMd(get("/home.md"), { kind: "home" })).status).toBe(200);
    expect((await serveAreaMd(get("/a/ja.md"), "ja")).status).toBe(200);
    const refused = await serveThreadMd(get(`/t/${ids.topic}.md`), String(ids.topic));
    expect(refused.status).toBe(429); expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await h.outcome(async () => (await home.loader(h.args(get("/")))))).status).toBe(429);
    expect((await h.outcome(async () => (await home.loader(h.args(h.request("/", { headers: { "x-forwarded-for": "192.0.2.81" } })))))).status).toBe(200);
    vi.stubEnv("TRUSTED_PROXY_HOPS", "");
  });
});
