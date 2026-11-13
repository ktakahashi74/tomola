import { createElement } from "react";
import { expect, it, vi } from "vitest";
import { SiteNavigation } from "~/components/site-navigation";
import { villageMembers, villages } from "~/lib/db/schema";
import { acceptChatConsent, mutateChat } from "~/lib/village-chat.server";
import { joinedVillageNavigation } from "~/lib/village-navigation.server";
import { setupRouteHarness } from "./helpers/route-harness";
import MemberLayout from "~/routes/member-layout";
import { sideNavigationPath } from "~/lib/navigation";
import { renderInRouter } from "./helpers/render-in-router";
import { m } from "~/paraglide/messages.js";
import { NavigationDataContext } from "~/lib/navigation-data";

vi.mock("~/lib/use-villages", () => ({ useVillages: () => true }));
vi.mock("~/paraglide/messages.js", async () => ({ m: (await import("./helpers/messages-json")).jsonMessages() }));
const joined = { slug: "side-unit", name: "Side unit village", chatAvailable: true, kind: "open", language: null };
const data = { reader: false, userId: "side-unit", handle: "side_unit", hasPasskey: true, passkeyPrompt: false, isOperator: false, isModerator: false, apiDrafts: 0, unreadNotifications: 0, followedUnread: false, villages: [{ ...joined, unread: 102 }] };
const render = (path: string, loaderData: unknown = data) => renderInRouter(() => createElement(MemberLayout, { loaderData } as never), path);

it.each(["/", "/a/en", "/a/zh-Hant", "/villages", "/v/side-unit", "/v/side-unit/chat", "/following", "/notifications", "/following/"])("allows the browsing surface at %s", path => {
  expect(sideNavigationPath(path)).toBe(true);
});
it.each(["/t/1", "/t/new", "/t/1/edit", "/settings", "/settings/chat", "/search", "/drafts", "/u/side_unit", "/villages/new", "/villages/invite/key", "/v/side-unit/chat/changes", "/v/side-unit/settings", "/a/en/extra", "/a/unknown", "/admin"])("keeps other surfaces out of the browsing navigation at %s", path => {
  expect(sideNavigationPath(path)).toBe(false);
});
it("renders navigation from layout data before JavaScript: a village row shows a mark to the chat only for news (a dot) and a number only for mentions", async () => {
  const html = await render("/v/side-unit/chat");
  expect(html).toContain('data-site-navigation="true"');
  expect(html).toContain(`aria-label="${m.nav_side_label()}"`);
  expect(html).toMatch(/<a(?=[^>]*href="\/v\/side-unit")(?=[^>]*aria-current="true")[^>]*>(?:(?!<\/a>)[\s\S])*?Side unit village(?:<\/span>)?<\/a>/);
  expect(html).toMatch(/<a(?=[^>]*href="\/v\/side-unit\/chat")(?![^>]*aria-current)[^>]*><span[^>]*bg-unread/);
  expect(html).not.toContain("99+");
  expect(await render("/")).toContain("site-navigation-header-links");
  const mentioned = await render("/", { ...data, villages: [{ ...joined, unread: 102, mentions: 120 }] });
  expect(mentioned.match(/<nav data-site-navigation[^>]*>[\s\S]*?<\/nav>/)?.[0]).toContain("99+");
  const following = await render("/following/");
  const side = following.match(/<nav data-site-navigation[^>]*>[\s\S]*?<\/nav>/)?.[0];
  expect(side).toMatch(/<a(?=[^>]*href="\/following")(?=[^>]*aria-current="page")[^>]*>/);
  const personal = await render("/u/chat", { ...data, handle: "chat", villages: [{ slug: "@chat", name: "", kind: "personal", language: null }] });
  expect(personal).toMatch(/<a(?=[^>]*href="\/u\/chat")(?=[^>]*aria-current="page")[^>]*>/);
});
it("shows only the village name when nothing is new, and omits the chat mark when chat is unavailable", async () => {
  const quiet = (await render("/", { ...data, villages: [{ ...joined, unread: 0 }] })).match(/<nav data-site-navigation[^>]*>[\s\S]*?<\/nav>/)?.[0];
  expect(quiet).toContain('href="/v/side-unit"');
  expect(quiet).not.toContain('href="/v/side-unit/chat"');
  expect(quiet).not.toContain(m.village_chat_title());
  const { chatAvailable, ...closed } = joined;
  const side = (await render("/", { ...data, villages: [closed] })).match(/<nav data-site-navigation[^>]*>[\s\S]*?<\/nav>/)?.[0];
  expect(side).toBeDefined();
  expect(side).toContain('href="/v/side-unit"');
  expect(side).not.toContain('href="/v/side-unit/chat"');
});
it("keeps the ordinary header without a sidebar for guests, closed villages and article routes", async () => {
  const { villages, ...closed } = data;
  for (const [path, navigation] of [["/", { reader: true }], ["/", closed], ["/t/1", data], ["/t/new", data], ["/settings", data]] as const) {
    const html = await render(path, navigation);
    expect(html).not.toContain("data-site-navigation");
    expect(html).not.toContain("site-navigation-header-links");
  }
});

it("links a village's name to its posts on every screen, and its chat mark to the chat only where chat is available and something is new", async () => {
  const villages = [{ ...joined, unread: 2 }, { ...joined, slug: "no-consent", chatAvailable: false, unread: 2 }];
  for (const path of ["/v/side-unit/chat", "/"]) {
    const side = (await render(path, { ...data, villages })).match(/<nav data-site-navigation[^>]*>[\s\S]*?<\/nav>/)?.[0];
    expect(side).toMatch(/<a(?=[^>]*href="\/v\/side-unit")[^>]*>(?:(?!<\/a>)[\s\S])*?Side unit village(?:<\/span>)?<\/a>/);
    expect(side).toContain('href="/v/side-unit/chat"');
    expect(side).toContain('href="/v/no-consent"');
    expect(side).not.toContain('href="/v/no-consent/chat"');
  }
  const chat = (await render("/v/side-unit/chat", { ...data, villages })).match(/<nav data-site-navigation[^>]*>[\s\S]*?<\/nav>/)?.[0];
  expect(chat).toMatch(/<a(?=[^>]*href="\/v\/side-unit")(?=[^>]*aria-current="true")[^>]*>(?:(?!<\/a>)[\s\S])*?Side unit village(?:<\/span>)?<\/a>/);
  expect(chat).toMatch(/<a(?=[^>]*href="\/v\/side-unit\/chat")(?![^>]*aria-current)[^>]*>/);
  const posts = (await render("/v/side-unit", { ...data, villages })).match(/<nav data-site-navigation[^>]*>[\s\S]*?<\/nav>/)?.[0];
  expect(posts).toMatch(/<a(?=[^>]*href="\/v\/side-unit")(?=[^>]*aria-current="page")[^>]*>(?:(?!<\/a>)[\s\S])*?Side unit village(?:<\/span>)?<\/a>/);
});
it("marks a village-related destination as current rather than the current page", async () => {
  const html = await render("/v/side-unit/chat", { ...data, villages: [{ ...joined, chatAvailable: false }] });
  const side = html.match(/<nav data-site-navigation[^>]*>[\s\S]*?<\/nav>/)?.[0];
  expect(side).toMatch(/<a(?=[^>]*href="\/v\/side-unit")(?=[^>]*aria-current="true")[^>]*>/);
});
it("does not mark home as the current page on a language-specific list", async () => {
  const side = (await render("/a/en")).match(/<nav data-site-navigation[^>]*>[\s\S]*?<\/nav>/)?.[0];
  expect(side).toMatch(/<a(?=[^>]*href="\/")(?=[^>]*aria-current="true")[^>]*>/);
});

it("renders closed-chat server results as village links without unread or chat links", async () => {
  vi.stubEnv("VILLAGES", "1"); vi.stubEnv("VILLAGE_CHAT", "1");
  const h = await setupRouteHarness();
  try {
    const reader = await h.signIn("side_closed_reader"), writer = await h.signIn("side_closed_writer");
    const slug = "side-closed";
    const [village] = await h.db.insert(villages).values({ slug, name: "Closed chat navigation", kind: "open" }).returning();
    await h.db.insert(villageMembers).values([reader, writer].map(userId => ({ villageId: village.id, userId })));
    for (const userId of [reader, writer]) await acceptChatConsent(h.db, userId, slug);
    await mutateChat(h.db, writer, slug, "send", { body: "An unread navigation message" });
    expect((await joinedVillageNavigation(h.db, reader)).find(row => row.slug === slug)).toMatchObject({ unread: 1, chatAvailable: true });
    vi.stubEnv("VILLAGE_CHAT", undefined);
    const closed = await joinedVillageNavigation(h.db, reader);
    for (const path of ["/", `/v/${slug}`, `/v/${slug}/chat`]) {
      const html = await renderInRouter(() => createElement(NavigationDataContext.Provider, { value: { villages: closed, followedUnread: false, villagesEnabled: true } }, createElement(SiteNavigation, { children: null })), path);
      expect(html).toContain('data-site-navigation="true"');
      expect(html).toMatch(/<a(?=[^>]*href="\/v\/side-closed")[^>]*>(?:(?!<\/a>)[\s\S])*?Closed chat navigation(?:<\/span>)?<\/a>/);
      expect(html).not.toContain('/chat"');
      expect(html).not.toContain(m.village_chat_title());
    }
  } finally { h.restore(); vi.unstubAllEnvs(); }
});
