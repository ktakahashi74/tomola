import { consentChatMembers } from "./helpers/chat-consent";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createElement } from "react";
import { renderInRouter } from "./helpers/render-in-router";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";
import { chatMessages, chatSequences, entries, profiles, villageMembers, villages } from "~/lib/db/schema";
import OwnChat, { action, loader } from "~/routes/settings-chat";
import { loader as memberLayout } from "~/routes/member-layout";
import Settings, { loader as settings } from "~/routes/settings";
import { loader as chatPage } from "~/routes/village-chat";
import { loader as changes } from "~/routes/village-chat-changes";
import { mutateChat } from "~/lib/village-chat.server";
import { MEMBER_RATE_LIMITS } from "~/lib/rate-limit.server";
import { seedRateLimit } from "./helpers/fixtures";
import { m } from "~/paraglide/messages.js";
import { CHAT_REPORT_RETAIN_DAYS } from "~/lib/chat-access";
vi.mock("~/paraglide/messages.js", async () => ({ m: (await import("./helpers/messages-json")).jsonMessages() }));
let h: RouteHarness;
const enabled = () => { vi.stubEnv("VILLAGES", "1"); vi.stubEnv("VILLAGE_CHAT", "1"); };
beforeAll(async () => {
  h = await setupRouteHarness();
  for (const name of ["co_author", "co_reader", "co_suspended"]) await h.signIn(name, { homeArea: "en" });
  await h.signIn("co_halfway", { profile: false });
  const [village] = await h.db.insert(villages).values({ kind: "open", slug: "own-route", name: "Own route village" }).returning();
  await h.db.insert(villageMembers).values(["co_author", "co_reader", "co_suspended"].map(name => ({ villageId: village.id, userId: h.ids[name] })));
  await consentChatMembers(h.db);
  await h.db.update(profiles).set({ suspendedUntil: new Date("2100-01-01") }).where(eq(profiles.userId, h.ids.co_suspended));
});
afterAll(() => h.restore()); afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
const args = (as?: string, form?: Record<string, string>, headers?: Record<string, string>) => h.args(h.request("/settings/chat", { as, form, headers }));
function render(Component: unknown, path: string, loaderData: unknown) {
  return renderInRouter(() => createElement(Component as never, { loaderData, actionData: undefined, params: {}, matches: [] } as never), path);
}
it("closes both new route methods and the parent before authentication or queries", async () => {
  for (const [v, c] of [["1", ""], ["", "1"], ["", ""]]) {
    vi.stubEnv("VILLAGES", v); vi.stubEnv("VILLAGE_CHAT", c);
    const select = vi.spyOn(h.db, "select");
    for (const as of [undefined, "co_author", "co_halfway"]) for (const run of [
      () => loader(args(as)), () => action(args(as, { intent: "delete", id: "0".repeat(32) })),
      () => memberLayout({ request: h.request("/settings/chat.data", { as }) }),
    ]) expect(await h.outcome(run)).toMatchObject({ status: 404 });
    expect(select).not.toHaveBeenCalled(); select.mockRestore();
  }
});
it("preserves closed settings response and text, adding the own-message entry only when enabled", async () => {
  vi.stubEnv("VILLAGES", "1");
  const before = await settings(h.args(h.request("/settings", { as: "co_author" })));
  expect(before).not.toHaveProperty("chatOwn");
  const beforeHtml = await render(Settings, "/settings", before);
  expect(beforeHtml).toContain(m.settings_export_help().replaceAll("'", "&#x27;")); expect(beforeHtml).not.toContain('href="/settings/chat"');
  enabled();
  const open = await settings(h.args(h.request("/settings", { as: "co_author" })));
  expect(open).toEqual({ ...before, chatOwn: true });
  const html = await render(Settings, "/settings", open);
  expect(html).toContain(m.settings_export_chat_help()); expect(html).toContain('href="/settings/chat"');
});
it("uses member and same-origin gates, permits suspended deletion and forbids a foreign anchor", async () => {
  enabled();
  expect(await h.outcome(() => action(args("co_halfway", { intent: "delete" })))).toMatchObject({ status: 302, location: "/onboarding" });
  expect(await h.outcome(() => action(args(undefined, { intent: "delete" })))).toMatchObject({ status: 302 });
  expect(await h.outcome(() => action(args("co_author", { intent: "delete" }, { origin: "https://elsewhere.example" })))).toMatchObject({ status: 403 });
  const own = await h.db.insert(chatMessages).values({ villageId: (await h.db.select().from(villages).where(eq(villages.slug, "own-route")))[0].id, authorId: h.ids.co_suspended, lang: "en", body: "Suspended own text", createdSeq: 1, changedSeq: 1 }).returning();
  await h.db.insert(chatSequences).values({ villageId: own[0].villageId, seq: 1 });
  expect(await h.outcome(() => action(args("co_author", { intent: "delete", id: own[0].id })))).toMatchObject({ status: 404 });
  expect(await h.outcome(() => action(args("co_suspended", { intent: "delete", id: own[0].id })))).toMatchObject({ status: 302 });
  expect((await h.db.select().from(chatMessages).where(eq(chatMessages.id, own[0].id)))[0].body).toBe("");
});
it("requires bulk confirmation and uses the existing chat-delete rate budget", async () => {
  enabled();
  const own = await mutateChat(h.db, h.ids.co_author, "own-route", "send", { body: "Rate controlled deletion" });
  expect(await h.outcome(() => action(args("co_author", { intent: "delete-village", id: own.id })))).toMatchObject({ status: 400 });
  await seedRateLimit(h.db, `member:chat-delete:${h.ids.co_author}`, MEMBER_RATE_LIMITS["chat-delete"]);
  expect(await h.outcome(() => action(args("co_author", { intent: "delete", id: own.id })))).toMatchObject({ status: 429 });
  expect((await h.db.select().from(chatMessages).where(eq(chatMessages.id, own.id)))[0].deletedAt).toBeNull();
});
it("renders only the author's text, with no external-resource interpretation", async () => {
  enabled();
  const ownText = "Own render text <img src=https://elsewhere.example/private.png>";
  await mutateChat(h.db, h.ids.co_author, "own-route", "send", { body: ownText });
  await mutateChat(h.db, h.ids.co_reader, "own-route", "send", { body: "Other author's render text" });
  const loaded = await loader(args("co_author"));
  const html = await render(OwnChat, "/settings/chat", loaded);
  expect(html).toContain(m.village_chat_own_retention({ days: CHAT_REPORT_RETAIN_DAYS }));
  expect(html).toContain(ownText.replaceAll("<", "&lt;").replaceAll(">", "&gt;"));
  expect(html).not.toContain("Other author&#x27;s render text"); expect(html).not.toContain("Suspended own text");
  expect(html).not.toContain("<img");
  expect(html).toContain('name="confirm"');
});
it("returns localized topic cards in the initial page and change response with the same language override", async () => {
  enabled();
  const [topic] = await h.db.insert(entries).values({ authorId: h.ids.co_author, kind: "topic", lang: "en", title: "Public linked route", body: "Public body" }).returning();
  await mutateChat(h.db, h.ids.co_author, "own-route", "send", { body: `http://localhost:5173/t/${topic.id}#reply` });
  const page = await chatPage(h.args(h.request("/v/own-route/chat?lang=ja", { as: "co_reader" }), { slug: "own-route" }));
  if (page.consentRequired) throw new Error("Chat fixture requires consent");
  const result = await changes(h.args(h.request("/v/own-route/chat/changes?since=0&lang=ja", { as: "co_reader" }), { slug: "own-route" }));
  const polled = await result.json();
  expect(page.linkLang).toBe("ja");
  expect(page.messages.find(row => row.topics?.length)?.topics).toMatchObject([{ id: topic.id, title: "Public linked route", replyHref: `/t/${topic.id}?lang=ja#reply` }]);
  expect(polled.messages.find((row: { topics?: unknown[] }) => row.topics?.length)?.topics).toEqual(page.messages.find(row => row.topics?.length)?.topics);
});
