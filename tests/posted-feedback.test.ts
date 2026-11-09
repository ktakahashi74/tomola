import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createReply, createTopic } from "~/lib/entries.server";
import { setFollow } from "~/lib/follows.server";
import { createDraft } from "~/lib/drafts.server";
import { postedLocation, readPostedId } from "~/lib/posted-ui";
import Home, { loader as homeLoader, meta as homeMeta } from "~/routes/home";
import Topic, { loader as topicLoader, meta as topicMeta } from "~/routes/topic";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";

vi.mock("~/paraglide/messages.js", () => ({ m: new Proxy({}, { get: (_, key) => () => String(key) }) }));
let h: RouteHarness;
let topicId: number;
let replyId: number;
beforeAll(async () => {
  h = await setupRouteHarness();
  await h.signIn("author");
  await h.signIn("reader");
  const topic = await createTopic(h.db, h.ids.author, { lang: "ja", body: "Body" });
  if (!topic.ok) throw new Error("topic failed");
  topicId = topic.id;
  const reply = await createReply(h.db, h.ids.author, topicId, { lang: "ja", body: "Reply" });
  if (!reply.ok) throw new Error("reply failed");
  replyId = reply.id;
});
afterAll(() => h.restore());
function render(Component: unknown, path: string, loaderData: unknown) {
  const router = createMemoryRouter([{ path: new URL(path, "http://localhost").pathname, element: createElement(Component as never, { loaderData, actionData: undefined, params: {}, matches: [] } as never) }], { initialEntries: [path] });
  return renderToStaticMarkup(createElement(RouterProvider, { router }));
}
const article = (html: string, id: string) => html.split(`<article id="${id}"`)[1]?.split("</article>")[0] ?? "";

describe("publication feedback", () => {
  it("preserves reply position and rejects invalid feedback ids", () => {
    expect(postedLocation("/t/1?page=2&lang=en#c-105", 105)).toBe("/t/1?page=2&lang=en&posted=105#c-105");
    expect(postedLocation("/t/1?page=2&lang=en#c-105", 105, true)).toBe("/t/1?page=2&lang=en&posted=105&followed=1#c-105");
    expect(postedLocation("/t/1?followed=1#c-105", 105)).toBe("/t/1?posted=105#c-105");
    for (const id of ["", "0", "-1", "NaN", "9007199254740992"]) expect(readPostedId(new URL(`http://localhost/?posted=${id}`))).toBeNull();
  });

  it("shows feedback on the published topic/reply only and keeps Markdown/AI links clean", async () => {
    const homePath = `/?posted=${topicId}#p-${topicId}`;
    const home = await homeLoader(h.args(h.request(homePath, { as: "author" })));
    expect(render(Home, homePath, home)).not.toContain("posted_topic");
    const topicPath = `/t/${topicId}?posted=${topicId}`;
    const topic = await topicLoader(h.args(h.request(topicPath, { as: "author" }), { id: String(topicId) }));
    // The notice after posting a topic is loaded apart from the page's script (it is drawn from a lazy module), so it is checked from the data the page carries and from the notice itself.
    expect(topic.topic).toMatchObject({ posted: true });
    expect(topic.postedNotice).toMatchObject({ first: expect.any(Boolean), langs: expect.any(Array) });
    const { default: Notice } = await import("~/components/posted-topic-notice-content");
    const router = createMemoryRouter([{ path: "/", element: createElement(Notice, { topicId, lang: "ja", place: "Example village", firstPost: true, initial: [{ lang: "en", state: "pending" }], editHref: `/t/${topicId}/edit` }) }]);
    const notice = renderToStaticMarkup(createElement(RouterProvider, { router }));
    expect(notice).toContain("posted_topic_public");
    expect(notice).toContain("posted_first");
    expect(notice).toContain(`href="/t/${topicId}/edit"`);
    expect(JSON.stringify(home.aiOpen)).not.toContain("posted");
    expect(JSON.stringify(homeMeta({ location: { search: `?posted=${topicId}` } } as never))).not.toContain("posted");
    const replyPath = `/t/${topicId}?lang=en&posted=${replyId}#c-${replyId}`;
    const own = await topicLoader(h.args(h.request(replyPath, { as: "author" }), { id: String(topicId) }));
    const html = render(Topic, replyPath, own);
    // An existing follower gets the ordinary confirmation on their own posted reply.
    const postedIds = own.replies.filter(reply => "posted" in reply && reply.posted).map(reply => reply.id);
    expect(postedIds).toEqual([replyId]);
    expect(own.topic).toMatchObject({ posted: false });
    expect(article(html, `p-${topicId}`)).not.toContain("posted_reply");
    expect(own.postedFollowed).toBe(false);
    expect(article(html, `c-${replyId}`)).toContain("posted_reply");
    const { default: PostedLineContent } = await import("~/components/posted-line-content");
    const line = renderToStaticMarkup(createElement(PostedLineContent, { kind: "reply-followed" }));
    expect(line).toContain("posted_reply_followed");
    expect(JSON.stringify(own.aiOpen)).not.toContain("posted");
    expect(JSON.stringify(topicMeta({ loaderData: own, location: { search: `?lang=en&posted=${replyId}` } } as never))).not.toContain("posted");
    const other = await topicLoader(h.args(h.request(replyPath, { as: "reader" }), { id: String(topicId) }));
    expect(render(Topic, replyPath, other)).not.toContain("posted_reply");
  });

  it.each(["reply", "draft"] as const)("carries only a newly created follow through %s publication", async kind => {
    for (const prior of [null, "following", "unfollowed"] as const) {
      const who = `feedback_${kind}_${prior ?? "new"}`;
      await h.signIn(who);
      if (prior) await setFollow(h.db, h.ids[who], topicId, prior === "following");
      let path = `/t/${topicId}?lang=en`;
      let form: Record<string, string> = { body: "A feedback reply", lang: "ja" };
      let params = { id: String(topicId) };
      if (kind === "draft") {
        const draft = await createDraft(h.db, h.ids[who], { kind: "reply", threadId: topicId, body: form.body, lang: "ja" });
        if (!draft.ok) throw new Error(draft.error);
        path = `/drafts/${draft.id}`;
        params = { id: String(draft.id) };
        form = { ...form, intent: "publish", version: "1" };
      }
      const { action } = kind === "draft" ? await import("~/routes/draft") : await import("~/routes/topic");
      const out = await h.outcome(async () => action(await h.signedArgs(h.request(path, { as: who, form }), params)));
      expect(out.status).toBe(302);
      const url = new URL(out.location!, "http://localhost");
      expect(url.searchParams.get("followed")).toBe(prior === null ? "1" : null);
      const loaded = await topicLoader(h.args(h.request(url.pathname + url.search, { as: who }), { id: String(topicId) }));
      expect(loaded.postedFollowed).toBe(prior === null);
      const other = await topicLoader(h.args(h.request(url.pathname + url.search, { as: "reader" }), { id: String(topicId) }));
      expect(other.postedFollowed).toBe(false);
      expect(loaded.replies.filter(reply => reply.placeholder === null && reply.posted).map(reply => reply.id)).toEqual([readPostedId(url)]);
      expect(JSON.stringify(loaded.aiOpen)).not.toContain("followed");
    }
  });

  it("carries the created id from new-topic, reply and both draft publication routes", async () => {
    const created = [];
    for (const path of ["/t/new", `/t/${topicId}?lang=en`]) {
      const mod = path === "/t/new" ? await import("~/routes/topic-new") : await import("~/routes/topic");
      const out = await h.outcome(async () => mod.action(await h.signedArgs(h.request(path, { as: "author", form: { body: "Published" } }), path.startsWith("/t/") && path !== "/t/new" ? { id: String(topicId) } : {})));
      expect(out.status).toBe(302);
      const url = new URL(out.location!, "http://localhost");
      const id = readPostedId(url);
      expect(id).toBeGreaterThan(0);
      created.push(id);
      if (path.includes("lang=en")) { expect(url.searchParams.get("lang")).toBe("en"); expect(url.hash).toBe(`#c-${id}`); }
    }
    const { action } = await import("~/routes/draft");
    for (const kind of ["topic", "reply"] as const) {
      const draft = await createDraft(h.db, h.ids.author, { kind, lang: "ja", body: "Draft body", ...(kind === "reply" ? { threadId: topicId } : {}) });
      if (!draft.ok) throw new Error("draft failed");
      const out = await h.outcome(async () => action(await h.signedArgs(h.request(`/drafts/${draft.id}`, { as: "author", form: { intent: "publish", version: "1", body: "Published draft", lang: "ja" } }), { id: String(draft.id) })));
      expect(out.status).toBe(302);
      expect(readPostedId(new URL(out.location!, "http://localhost"))).toBeGreaterThan(0);
    }
    expect(new Set(created).size).toBe(2);
  });
});
