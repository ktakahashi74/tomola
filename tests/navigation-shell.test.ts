import { createElement } from "react";
import { expect, it, vi } from "vitest";
import { MemberHeader } from "~/components/member-header";
import { GuestHeader } from "~/components/guest-header";
import { TooltipProvider } from "~/components/ui/tooltip";
import { VillageTarget } from "~/components/village-target";
import { m } from "~/paraglide/messages.js";
import { renderInRouter } from "./helpers/render-in-router";
import { NavigationDataContext } from "~/lib/navigation-data";
vi.mock("~/lib/use-villages", () => ({ useVillages: () => true }));
vi.mock("~/paraglide/messages.js", async () => ({ m: (await import("./helpers/messages-json")).jsonMessages() }));
const village = { slug: "shell-joined", name: "Joined shell village", kind: "invite_public", language: null, description: "" };
const navigation = { reader: false, handle: "shell_reader", userId: "shell_reader", hasPasskey: true, passkeyPrompt: false, isOperator: false, isModerator: false, apiDrafts: 0, unreadNotifications: 0, chatUnreadTotal: 3, villages: [{ ...village, unread: 3, chatAvailable: true }] };
const places = (data: typeof navigation) => ({ villages: data.villages as never, followedUnread: false, villagesEnabled: true });
const member = (path: string, data = navigation, followedUnread = false) => renderInRouter(() => createElement(NavigationDataContext.Provider, { value: { ...places(data), followedUnread } }, createElement(TooltipProvider, {}, createElement(MemberHeader, { data } as never))), path);
const drawer = (html: string) => html.match(/<details[^>]*data-navigation-drawer[\s\S]*?<\/details>/)?.[0] ?? "";

it("names the graphic home links from the shell labels and hides their artwork", async () => {
  const labels = { ...(await import("~/lib/shell-labels.server")).shellLabels(), site_name: "Localized site name" };
  for (const header of [() => createElement(GuestHeader), () => createElement(TooltipProvider, {}, createElement(MemberHeader, { data: navigation } as never))]) {
    const html = await renderInRouter(header, "/why", undefined, { labels });
    const logo = html.match(/<a(?=[^>]*href="\/")(?=[^>]*class="logo")[^>]*>[\s\S]*?<\/a>/)?.[0];
    expect(logo).toBeDefined();
    expect(logo).toContain('<span aria-hidden="true"></span>');
    expect(logo).toContain('<span>Localized site name</span>');
    expect(logo).not.toContain("<svg");
  }
});

it.each([["/", "/"], ["/a/ja", "/"], ["/notifications", "/notifications"]])("marks the current place in the header at %s", async (path, destination) => {
  const html = await member(path);
  expect(html.replace(/<details[\s\S]*?<\/details>/, "")).toMatch(new RegExp(`<a(?=[^>]*href="${destination}")(?=[^>]*aria-current="page")[^>]*>`));
});

it("has the same header on every screen: the places drawer, the site name, search, the bell, writing and the member menu", async () => {
  for (const path of ["/", "/t/1", "/villages", "/v/shell-joined", "/following"]) {
    const html = await member(path);
    expect(html).toContain("data-navigation-drawer");
    expect(html).not.toContain("data-village-menu");
    expect(html).toContain('href="/notifications"');
    expect(html).toContain("data-member-menu-trigger");
    // Following is a place, not a mark in the header.
    expect(html.replace(drawer(html), "")).not.toContain('href="/following"');
  }
});

it.each(["/", "/following", "/villages", "/v/shell-joined"])("shows the places in the drawer, without JavaScript, and marks the current one at %s", async path => {
  const panel = drawer(await member(path));
  expect(panel).toContain('href="/following"');
  expect(panel).toContain('href="/v/shell-joined"');
  expect(panel).toContain('href="/villages"');
  const here = path === "/" ? "/" : path === "/following" ? "/following" : path === "/villages" ? "/villages" : path;
  expect(panel).toMatch(new RegExp(`<a(?=[^>]*href="${here}")(?=[^>]*aria-current="page")[^>]*>`));
});

it.each([["/", "/"], ["/a/ja", "/"], ["/villages", "/villages"], ["/v/shell-joined", "/villages"], ["/why", "/why"], ["/principles", "/principles"]])("marks the current guest navigation section at %s", async (path, destination) => {
  const html = await renderInRouter(() => createElement(GuestHeader), path);
  expect(html).toMatch(new RegExp(`<a(?=[^>]*href="${destination}")(?=[^>]*aria-current="page")[^>]*>`));
});

it("leaves the drawer out of the header on a chat screen, where the chat's own head carries it", async () => {
  expect(await member("/v/shell-joined/chat")).not.toContain("data-navigation-drawer");
});

it("tells chat news by a dot and a mention by a number, in one mark that opens the chat, and shows no mark when nothing is new", async () => {
  const quiet = drawer(await member("/", { ...navigation, villages: [{ ...village, chatAvailable: true, unread: 0, mentions: 0 }] } as never));
  expect(quiet).toContain('href="/v/shell-joined"');
  expect(quiet).not.toContain('href="/v/shell-joined/chat"');
  const news = drawer(await member("/", { ...navigation, villages: [{ ...village, chatAvailable: true, unread: 5, mentions: 0 }] } as never));
  expect(news).toMatch(/<a(?=[^>]*href="\/v\/shell-joined\/chat")[^>]*><span[^>]*bg-unread/);
  expect(news).not.toContain(">5<");
  const mentioned = drawer(await member("/", { ...navigation, villages: [{ ...village, chatAvailable: true, unread: 5, mentions: 2 }] } as never));
  expect(mentioned).toMatch(/<a(?=[^>]*href="\/v\/shell-joined\/chat")[^>]*><span[^>]*role="img"[^>]*>(<span[^>]*>2<\/span>)/);
});

it("omits chat entrances when the joined-village data has no chat counts", async () => {
  const html = drawer(await member("/", { ...navigation, villages: [village], chatUnreadTotal: undefined } as never));
  expect(html).toContain('href="/v/shell-joined"');
  expect(html).not.toContain('href="/v/shell-joined/chat"');
});

it("puts a dot on the drawer's mark and on Following when there is something new, and shows no village total", async () => {
  const plain = await member("/", { ...navigation, villages: [{ ...village, chatAvailable: true, unread: 0 }] } as never);
  expect(drawer(plain).split("</summary>")[0]).not.toContain("bg-unread");
  const news = await member("/", { ...navigation, villages: [{ ...village, chatAvailable: true, unread: 4 }] } as never);
  expect(drawer(news).split("</summary>")[0]).toContain("bg-unread");
  const followed = await member("/", navigation, true);
  const followedLink = drawer(followed).match(/<a(?=[^>]*href="\/following")[^>]*>[\s\S]*?<\/a>/)?.[0];
  expect(followedLink).toContain(m.nav_following());
  expect(followedLink).toContain("bg-unread");
  expect(news).not.toContain(m.nav_notifications_unread({ count: 4 }));
});

it.each(["/v/shell-joined", "/v/shell-joined/chat", "/v/SHELL-JOINED"])("opens writing in the joined village at %s", async path => {
  expect(await member(path)).toContain('href="/t/new?village=shell-joined"');
});
it("uses the ordinary writing destination outside a joined village", async () => {
  for (const path of ["/", "/v/not-joined", "/t/1"]) expect(await member(path)).toContain('href="/t/new"');
});

it("labels a selected destination with its actual village type", async () => {
  const html = await renderInRouter(() => createElement(VillageTarget, { posting: { choices: [village], selected: village.slug, explicit: true, changed: false, error: null } } as never));
  expect(html).toContain(m.village_invite_public());
});


it("includes badge counts in the notification and member menu names", async () => {
  const html = await member("/", { ...navigation, unreadNotifications: 112, apiDrafts: 2 });
  expect(html).toContain(`aria-label="${m.nav_notifications()} · ${m.nav_notifications_unread({ count: "99+" })}"`);
  expect(html).toContain(`aria-label="${m.nav_menu()} @shell_reader · ${m.nav_drafts_api_count({ count: 2 })}"`);
});
