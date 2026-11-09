import { eq } from "drizzle-orm";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { entries } from "~/lib/db/schema";
import { createReply, createTopic } from "~/lib/entries.server";
import { fixEntry, hideEntry } from "~/lib/moderation.server";
import { grantModerator } from "~/lib/roles.server";
import Topic, { loader as topicLoader } from "~/routes/topic";
import { loader as notificationsLoader } from "~/routes/notifications";
import Appeal, { loader as appealLoader } from "~/routes/appeal";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";

vi.mock("~/paraglide/messages.js", () => ({ m: new Proxy({}, { get: (_, key) => () => String(key) }) }));
let h: RouteHarness;
let topicId: number;
let replyId: number;
let hideId: number;
let fixId: number;
const operatorEmails = process.env.OPERATOR_EMAILS;
beforeAll(async () => {
  process.env.OPERATOR_EMAILS = "operator@example.com";
  h = await setupRouteHarness();
  for (const name of ["author", "reader", "moriko", "opal"]) await h.signIn(name, name === "opal" ? { email: "operator@example.com" } : {});
  await grantModerator(h.db, h.ids.opal, h.ids.moriko, "ja");
  const topic = await createTopic(h.db, h.ids.author, { lang: "ja", title: "Topic", body: "Body", asksStance: true });
  if (!topic.ok) throw new Error("topic failed");
  topicId = topic.id;
  const reply = await createReply(h.db, h.ids.author, topicId, { lang: "ja", body: "Reply" });
  if (!reply.ok) throw new Error("reply failed");
  replyId = reply.id;
  const hidden = await hideEntry(h.db, { id: h.ids.moriko, scope: { operator: false, langs: ["ja"] } }, { entryId: replyId, reason: "harassment", note: "Reason" });
  if (!hidden.ok) throw new Error("hide failed");
  hideId = hidden.actionId;
  await h.db.update(entries).set({ stanceLockedAt: new Date() }).where(eq(entries.id, topicId));
  const [entry] = await h.db.select({ sourceHash: entries.sourceHash }).from(entries).where(eq(entries.id, topicId));
  const fixed = await fixEntry(h.db, { id: h.ids.moriko, scope: { operator: false, langs: ["ja"] } }, { entryId: topicId, sourceHash: entry.sourceHash!, title: "Topic", body: "Fixed body", note: "Fix" });
  if (!fixed.ok) throw new Error(`fix failed: ${fixed.error}`);
  fixId = fixed.actionId;
});
afterAll(() => {
  h.restore();
  if (operatorEmails === undefined) delete process.env.OPERATOR_EMAILS;
  else process.env.OPERATOR_EMAILS = operatorEmails;
});
const loadTopic = async (as: string) => (await topicLoader(h.args(h.request(`/t/${topicId}`, { as }), { id: String(topicId) })));
function render(Component: unknown, path: string, loaderData: unknown) {
  const router = createMemoryRouter([{ path, element: createElement(Component as never, { loaderData, actionData: undefined, params: {}, matches: [] } as never) }], { initialEntries: [path] });
  return renderToStaticMarkup(createElement(RouterProvider, { router }));
}

describe("affected authors can move between moderation notifications, posts and appeals", () => {
  it("links hide notifications to the hidden reply and fix notifications to the topic", async () => {
    const loaded = await notificationsLoader(h.args(h.request("/notifications", { as: "author" })));
    expect(loaded.items.find((n) => n.actionId === hideId)).toMatchObject({ href: `/t/${topicId}#c-${replyId}` });
    expect(loaded.items.find((n) => n.actionId === fixId)).toMatchObject({ href: `/t/${topicId}` });
  });

  it("gives only the author the hidden action's reason and appeal id", async () => {
    const loaded = await loadTopic("author");
    expect(loaded.replies.find((r) => r.id === replyId)).toMatchObject({ hiddenAction: { id: hideId, reason: "harassment" } });
    const html = render(Topic, `/t/${topicId}`, loaded);
    expect(html).toContain(`href="/appeal/${hideId}"`);
    expect(html).toContain("notification_reason");
    for (const name of ["moriko", "opal", "reader"]) {
      const other = await loadTopic(name);
      expect(JSON.stringify(other)).not.toContain(`"hiddenAction":{"id":${hideId}`);
      expect(render(Topic, `/t/${topicId}`, other)).not.toContain(`href="/appeal/${hideId}"`);
    }
  });

  it("links the appeal back to the hidden reply and notifications", async () => {
    const loaded = await appealLoader(h.args(h.request(`/appeal/${hideId}`, { as: "author" }), { actionId: String(hideId) }));
    const html = render(Appeal, `/appeal/${hideId}`, loaded);
    expect(html).toContain(`href="/t/${topicId}#c-${replyId}"`);
    expect(html).toContain('href="/notifications"');
  });
});
