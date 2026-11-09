import { createElement } from "react";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { villageMembers, villages } from "~/lib/db/schema";
import * as chat from "~/lib/village-chat.server";
import Villages, { loader } from "~/routes/villages";
import { loader as navigation } from "~/routes/navigation-header";
import { loader as villagePage } from "~/routes/village";
import { consentChatMembers } from "./helpers/chat-consent";
import { renderInRouter } from "./helpers/render-in-router";
import { setupRouteHarness, type RouteHarness } from "./helpers/route-harness";
vi.mock("~/paraglide/messages.js", async () => ({ m: (await import("./helpers/messages-json")).jsonMessages() }));
let h: RouteHarness;
beforeAll(async () => {
  h = await setupRouteHarness();
  for (const name of ["directory_reader", "directory_writer"]) await h.signIn(name);
  const rows = await h.db.insert(villages).values([
    { slug: "directory-unread", name: "Unread village", kind: "open" },
    { slug: "directory-quiet", name: "Quiet village", kind: "open" },
  ]).returning();
  await h.db.insert(villageMembers).values(rows.flatMap(village => ["directory_reader", "directory_writer"].map(name => ({ villageId: village.id, userId: h.ids[name] }))));
  await consentChatMembers(h.db);
  const [unconsented] = await h.db.insert(villages).values({ slug: "constructor", name: "Unconsented village", kind: "open" }).returning();
  await h.db.insert(villageMembers).values({ villageId: unconsented.id, userId: h.ids.directory_reader });
  vi.stubEnv("VILLAGES", "1"); vi.stubEnv("VILLAGE_CHAT", "1");
  await chat.mutateChat(h.db, h.ids.directory_writer, "directory-unread", "send", { body: "Unread directory message" });
});
afterAll(() => h.restore());
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
const load = (as?: string) => loader(h.args(h.request("/villages", { as })));

it("shows each joined village's unread count in its accessible link name and hides zero counts", async () => {
  vi.stubEnv("VILLAGES", "1"); vi.stubEnv("VILLAGE_CHAT", "1");
  const counts = vi.spyOn(chat, "chatUnreadCounts");
  const value = await load("directory_reader");
  expect(counts).toHaveBeenCalledOnce();
  const html = await renderInRouter(() => createElement(Villages, { loaderData: value } as never), "/villages");
  // Chat news is a dot on the chat entrance (not a number, and not on the village's name); a quiet village keeps a lighter entrance; no consent, no entrance.
  expect(html).toMatch(/<a[^>]*aria-label="Unread village · Chat · unread"[^>]*href="\/v\/directory-unread\/chat"/);
  expect(html).toMatch(/<a[^>]*aria-label="Quiet village · Chat"[^>]*href="\/v\/directory-quiet\/chat"/);
  expect(html).not.toMatch(/aria-label="Unconsented village ·/);
  expect(html).not.toContain('href="/v/constructor/chat"');
});

it("keeps closed-chat directory data unchanged without asking for unread counts", async () => {
  vi.stubEnv("VILLAGES", "1"); vi.stubEnv("VILLAGE_CHAT", "");
  const counts = vi.spyOn(chat, "chatUnreadCounts");
  const value = await load("directory_reader");
  expect(counts).not.toHaveBeenCalled();
  expect(Object.keys(value).sort()).toEqual(["invites", "member", "villages"]);
  const html = await renderInRouter(() => createElement(Villages, { loaderData: value } as never), "/villages");
  expect(html).not.toContain('/chat"');
});

it("never asks for or exposes member unread counts to public readers", async () => {
  vi.stubEnv("PUBLIC_READING", "1"); vi.stubEnv("VILLAGES", "1"); vi.stubEnv("VILLAGE_CHAT", "1");
  const counts = vi.spyOn(chat, "chatUnreadCounts");
  const value = await load();
  expect(counts).not.toHaveBeenCalled();
  expect(Object.keys(value).sort()).toEqual(["invites", "member", "villages"]);
  const html = await renderInRouter(() => createElement(Villages, { loaderData: value } as never), "/villages");
  expect(html).not.toContain('id="joined-villages"');
  expect(html).not.toContain('/chat"');
});

it("excludes ended villages from navigation and directory unread counts while keeping their page unread", async () => {
  vi.stubEnv("VILLAGES", "1"); vi.stubEnv("VILLAGE_CHAT", "1");
  const reader = "ended_count_reader", writer = "ended_count_writer";
  for (const name of [reader, writer]) await h.signIn(name);
  const rows = await h.db.insert(villages).values([
    { slug: "count-active", name: "Active count", kind: "open" },
    { slug: "count-ended", name: "Ended count", kind: "open" },
  ]).returning();
  await h.db.insert(villageMembers).values(rows.flatMap(village => [reader, writer].map(name => ({ villageId: village.id, userId: h.ids[name] }))));
  for (const village of rows) {
    for (const name of [reader, writer]) await chat.acceptChatConsent(h.db, h.ids[name], village.slug!);
    await chat.mutateChat(h.db, h.ids[writer], village.slug!, "send", { body: "Unread before ending" });
  }
  const header = async () => (await navigation(h.args(h.request("/navigation-header", { as: reader })))).json();
  expect(await header()).toHaveProperty("chatUnreadTotal", 2);
  await h.db.update(villages).set({ endedAt: new Date() }).where(eq(villages.slug, "count-ended"));
  expect(await header()).toHaveProperty("chatUnreadTotal", 1);
  const directory = await load(reader);
  expect(directory.villages.some(village => village.slug === "count-ended")).toBe(false);
  expect(directory).toHaveProperty("chatUnread", { "count-active": 1 });
  const ended = await villagePage(h.args(h.request("/v/count-ended", { as: reader }), { slug: "count-ended" }));
  expect(ended).toMatchObject({ ended: true, chat: { unread: 1 } });
});

it("counts only the village being opened and preserves consent and ended-village rules", async () => {
  vi.stubEnv("VILLAGES", "1"); vi.stubEnv("VILLAGE_CHAT", "1");
  const allCounts = vi.spyOn(chat, "chatUnreadCounts");
  const page = await villagePage(h.args(h.request("/v/directory-unread", { as: "directory_reader" }), { slug: "directory-unread" }));
  expect(page).toHaveProperty("chat.unread", 1);
  expect(allCounts.mock.calls.length).toBe(0);
  const quiet = await villagePage(h.args(h.request("/v/directory-quiet", { as: "directory_reader" }), { slug: "directory-quiet" }));
  expect(quiet).toHaveProperty("chat.unread", 0);
  const unconsented = await villagePage(h.args(h.request("/v/constructor", { as: "directory_reader" }), { slug: "constructor" }));
  expect(unconsented).toHaveProperty("chat.unread", 0);
});
