import { eq } from "drizzle-orm";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { TranslationReportForm } from "~/components/translation-report-form";
import { reports } from "~/lib/db/schema";
import { createReply, createTopic } from "~/lib/entries.server";
import Topic, { action, loader } from "~/routes/topic";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";

vi.mock("~/paraglide/messages.js", () => ({ m: new Proxy({}, { get: (_, key) => () => String(key) }) }));

let h: RouteHarness;
let topicId: number;
let replyId: number;
let otherReplyId: number;
beforeAll(async () => {
  h = await setupRouteHarness();
  await h.signIn("author");
  await h.signIn("reader");
  const topic = await createTopic(h.db, h.ids.author, { lang: "ja", title: "Topic", body: "Body" });
  if (!topic.ok) throw new Error("topic failed");
  topicId = topic.id;
  const reply = await createReply(h.db, h.ids.author, topicId, { lang: "ja", body: "Reply" });
  const other = await createReply(h.db, h.ids.author, topicId, { lang: "ja", body: "Other reply" });
  if (!reply.ok || !other.ok) throw new Error("reply failed");
  replyId = reply.id;
  otherReplyId = other.id;
});
afterAll(() => h.restore());

const load = async () => (await loader(h.args(h.request(`/t/${topicId}?lang=en`, { as: "reader" }), { id: String(topicId) })));
const post = (form: Record<string, string>) => h.outcome(() => action(h.args(h.request(`/t/${topicId}?lang=en`, { as: "reader", form }), { id: String(topicId) })));
const form = () => ({ intent: "flag", entryId: String(replyId), reason: "spam" });
function render(loaderData: Awaited<ReturnType<typeof loader>>, actionData?: unknown) {
  const router = createMemoryRouter([{ path: "/t/:id", element: createElement(Topic, { loaderData, actionData, params: {}, matches: [] } as never) }], { initialEntries: [`/t/${topicId}?lang=en`] });
  return renderToStaticMarkup(createElement(RouterProvider, { router }));
}
const article = (html: string, id: string) => html.split(`<article id="${id}"`)[1]?.split("</article>")[0] ?? "";

describe("report feedback belongs to the entry that was reported", () => {
  it("returns the reply id, keeps duplicate POSTs at 409, and remembers only the viewer's open reports", async () => {
    const first = await post(form());
    expect(first).toMatchObject({ status: 200, value: { data: { intent: "flag", entryId: replyId, reported: true } } });
    expect(await post(form())).toMatchObject({ status: 409, value: { data: { entryId: replyId, error: "duplicate" } } });
    const loaded = await load();
    expect(loaded.replies.find((r) => r.id === replyId)).toMatchObject({ reported: true });
    expect(loaded.replies.find((r) => r.id === otherReplyId)).toMatchObject({ reported: false });
    const author = await loader(h.args(h.request(`/t/${topicId}`, { as: "author" }), { id: String(topicId) }));
    expect(author.replies.find((r) => r.id === replyId)).toMatchObject({ reported: false });
    await h.db.update(reports).set({ status: "dismissed" }).where(eq(reports.entryId, replyId));
    expect((await load()).replies.find((r) => r.id === replyId)).toMatchObject({ reported: false });
  });

  it("places successful feedback below that reply's controls and replaces its flag form", async () => {
    const loaded = await load();
    const html = render(loaded, { intent: "flag", entryId: replyId, reported: true, error: null });
    const target = article(html, `c-${replyId}`);
    expect(target).toContain('role="status"');
    expect(target).toContain("flag_thanks");
    expect(target).toContain("flag_already_reported");
    expect(target).not.toContain('value="flag"');
    expect(article(html, `c-${otherReplyId}`)).not.toContain("flag_thanks");
    expect(html.split("<article")[0]).not.toContain('role="status"');
  });

  it("returns the entry id for translation errors and gives both report forms anchors without JavaScript", async () => {
    const result = await post({ intent: "report", entryId: String(otherReplyId), lang: "bad" });
    expect(result).toMatchObject({ status: 400, value: { data: { intent: "report", entryId: otherReplyId, reported: false } } });
    const loaded = await load();
    const html = render(loaded, { intent: "report", entryId: otherReplyId, reported: false, error: "invalid_lang" });
    expect(article(html, `c-${otherReplyId}`)).toContain("report_error");
    expect(article(html, `c-${replyId}`)).not.toContain("report_error");
    expect(article(html, `p-${topicId}`)).toContain(`action="/t/${topicId}?lang=en#p-${topicId}"`);
    expect(article(html, `c-${otherReplyId}`)).toContain(`action="/t/${topicId}?lang=en#c-${otherReplyId}"`);
    const router = createMemoryRouter([{ path: "/t/:id", element: createElement(TranslationReportForm, { entryId: otherReplyId, kind: "reply", lang: "en" }) }], { initialEntries: [`/t/${topicId}?lang=en`] });
    expect(renderToStaticMarkup(createElement(RouterProvider, { router }))).toContain(`action="/t/${topicId}?lang=en#c-${otherReplyId}"`);
  });
});
