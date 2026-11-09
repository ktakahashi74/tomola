import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { enMessages as m, state, useMember, waitForClientRoute } from "./helpers";

// A mark for this run: the village keeps what earlier runs of the same file sent.
const runMark = Math.random().toString(36).slice(2, 8);
const fixture = () => JSON.parse(fs.readFileSync(path.join(state().dir, "ux-nav.json"), "utf8")) as { topic: number; messages: string[] };

test("the places drawer is reachable by keyboard on a narrow screen and shows a number only for a mention", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await useMember(page, "uxnav_count@example.com"); await waitForClientRoute(page);
  const summary = page.locator("[data-navigation-drawer] > summary");
  await summary.focus();
  await page.keyboard.press("Enter");
  const places = page.locator("[data-navigation-drawer] nav");
  await expect(places).toBeVisible();
  await expect(places.getByRole("link").first()).toBeFocused();
  // A chat that names the member shows a number; a chat with only news shows a dot.
  await expect(summary).toHaveAccessibleName(`${m.nav_places} ${m.notification_unread}`);
  await expect(places.locator('a[href="/v/ux-nav-chat/chat"]')).toHaveAccessibleName(/1 mention$/);
  await expect(places.locator('a[href="/v/ux-nav-news/chat"] .bg-unread')).toHaveCount(1);
  await expect(places.locator('a[href="/v/ux-nav-news/chat"]')).not.toContainText(/\d/);
  await page.keyboard.press("Escape");
  await expect(places).not.toBeVisible();
  await expect(summary).toBeFocused();
  // The bell counts the mention (addressed to the member) and the replies to the member's post, never news in a chat.
  await expect(page.getByRole("link", { name: new RegExp(`^${m.nav_notifications}`) }).getByRole("img")).toBeVisible();
});

test("arriving at a message by its address does not open its actions over the text", async ({ page }) => {
  const { messages } = fixture();
  await page.setViewportSize({ width: 390, height: 844 });
  await useMember(page, "uxnav_reader@example.com", `/v/ux-nav-chat/chat?at=${messages[2]}#chat-${messages[2]}`); await waitForClientRoute(page);
  const message = page.locator(`[data-chat-message="${messages[2]}"]`);
  await expect(message).toBeVisible();
  await expect(message.locator("[data-chat-actions]")).toHaveCSS("opacity", "0");
  await expect(message.locator("[data-chat-actions]")).toHaveCSS("pointer-events", "none");
  // A message that names the member has a band and a pale ground.
  await expect(page.locator(`[data-chat-message="${messages[0]}"]`)).toHaveAttribute("data-mentions-me", /.*/);
  await expect(page.locator(`[data-chat-message="${messages[1]}"]`)).not.toHaveAttribute("data-mentions-me");
  // Pressing the message opens its actions below the text on a narrow screen, never over it.
  const text = message.locator("p[dir=auto]");
  await text.click();
  await expect(message.locator("[data-chat-actions]")).toHaveCSS("opacity", "1");
  const box = await text.boundingBox();
  const actions = await message.locator("[data-chat-actions]").boundingBox();
  expect(actions!.y).toBeGreaterThanOrEqual(box!.y + box!.height - 1);
});

// The box of the chat is emptied when a message is sent, so a refusal or a slow answer must never lose what was written.
async function sendWithGate(page: import("@playwright/test").Page, refuse: boolean) {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/chat.data", async route => {
    const request = route.request(); const form = new URLSearchParams(request.postData() ?? "");
    if (request.method() === "POST" && form.get("intent") === "send") {
      await gate;
      // A send that another navigation has cut short has no request left to continue.
      if (refuse) { form.set("body", " "); await route.continue({ postData: form.toString() }).catch(() => undefined); } else await route.continue().catch(() => undefined);
    } else await route.continue();
  });
  return release;
}

test("a sent message is shown at once, lighter, until the server has taken it, and what is typed meanwhile stays", async ({ page }) => {
  await useMember(page, "uxnav_send@example.com", "/v/ux-nav-send/chat"); await waitForClientRoute(page);
  const field = page.getByLabel(m.village_chat_body, { exact: true });
  // No message in this window has a translation, so there is nothing to switch to the original.
  await expect(page.getByRole("button", { name: m.village_chat_originals })).toHaveCount(0);
  const release = await sendWithGate(page, false);
  const text = `An optimistic message ${runMark}`;
  try {
    await field.fill(text);
    await field.press("Enter");
    const pending = page.locator("[data-chat-pending]");
    await expect(pending).toContainText(text);
    await expect(pending).toContainText(m.village_chat_sending);
    await expect(field).toHaveValue("");
    await field.fill("Typed while the first one is on its way");
    release();
    await expect(page.getByRole("log").getByRole("paragraph").filter({ hasText: text })).toBeVisible();
    await expect(pending).toHaveCount(0);
    await expect(field).toHaveValue("Typed while the first one is on its way");
  } finally { release(); await page.unroute("**/chat.data"); }
});

test("a refused message goes back into the box, in front of what was typed meanwhile, and nothing is lost", async ({ page }) => {
  await useMember(page, "uxnav_send@example.com", "/v/ux-nav-send/chat"); await waitForClientRoute(page);
  const field = page.getByLabel(m.village_chat_body, { exact: true });
  const release = await sendWithGate(page, true);
  const text = `A refused one ${runMark}`;
  try {
    await field.fill(text);
    await field.press("Enter");
    await expect(page.locator("[data-chat-pending]")).toContainText(text);
    await expect(field).toHaveValue("");
    await field.fill("Typed meanwhile");
    release();
    await expect(page.getByText(m.village_chat_send_failed, { exact: true })).toBeVisible();
    await expect(page.locator("[data-chat-pending]")).toHaveCount(0);
    await expect(field).toHaveValue(`${text}\nTyped meanwhile`);
  } finally { release(); await page.unroute("**/chat.data"); }
  // Sent again, with the refusal gone, it arrives.
  await field.fill(text);
  await field.press("Enter");
  await expect(page.getByRole("log").getByRole("paragraph").filter({ hasText: text })).toBeVisible();
});

test("a send cut short by another navigation puts the message back into the box", async ({ page }) => {
  await useMember(page, "uxnav_send@example.com", "/v/ux-nav-send/chat"); await waitForClientRoute(page);
  const field = page.getByLabel(m.village_chat_body, { exact: true });
  const release = await sendWithGate(page, false);
  const text = `A cut short one ${runMark}`;
  try {
    await field.fill(text);
    await field.press("Enter");
    await expect(page.locator("[data-chat-pending]")).toContainText(text);
    await expect(field).toHaveValue("");
    // The link to the newest messages (or an edit form) starts a navigation while the answer is still on its way.
    await page.evaluate(() => { void (window as unknown as { __reactRouterDataRouter: { navigate(path: string): Promise<void> } }).__reactRouterDataRouter.navigate(`${location.pathname}?latest=1`); });
    await expect(page.locator("[data-chat-pending]")).toHaveCount(0);
    await expect(field).toHaveValue(text);
  } finally { release(); await page.unroute("**/chat.data"); }
});

test("a send that the server took before another navigation cut it short is not put back, and says nothing of failing", async ({ page }) => {
  await useMember(page, "uxnav_send@example.com", "/v/ux-nav-send/chat"); await waitForClientRoute(page);
  const field = page.getByLabel(m.village_chat_body, { exact: true });
  // The server gets the request at once; only its answer is held back.
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let taken!: () => void;
  const reached = new Promise<void>(resolve => { taken = resolve; });
  await page.route("**/chat.data", async route => {
    const request = route.request();
    if (request.method() === "POST" && new URLSearchParams(request.postData() ?? "").get("intent") === "send") {
      const response = await route.fetch();
      taken();
      await gate;
      await route.fulfill({ response }).catch(() => undefined);
    } else await route.continue();
  });
  const text = `Taken before the cut ${runMark}`;
  try {
    await field.fill(text);
    await field.press("Enter");
    await expect(page.locator("[data-chat-pending]")).toContainText(text);
    await reached;
    await page.evaluate(() => { void (window as unknown as { __reactRouterDataRouter: { navigate(path: string): Promise<void> } }).__reactRouterDataRouter.navigate(`${location.pathname}?latest=1`); });
    await expect(page.locator("[data-chat-pending]")).toHaveCount(0);
    const log = page.getByRole("log").getByRole("paragraph").filter({ hasText: text });
    await expect(log).toHaveCount(1);
    // The check of the list comes a little after the screen has settled.
    await page.waitForTimeout(2500);
    await expect(field).toHaveValue("");
    await expect(page.getByText(m.village_chat_send_unconfirmed, { exact: true })).toHaveCount(0);
    await expect(page.getByText(m.village_chat_send_failed, { exact: true })).toHaveCount(0);
    await expect(log).toHaveCount(1);
  } finally { release(); await page.unroute("**/chat.data"); }
});

test("a press on a link of the page behind the open places drawer only closes the drawer", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await useMember(page, "uxnav_press@example.com", `/t/${fixture().topic}`); await waitForClientRoute(page);
  const drawer = page.locator("[data-navigation-drawer]");
  await drawer.locator(":scope > summary").click();
  await expect(drawer).toHaveAttribute("open", "");
  const before = page.url();
  await page.locator("main article a[href^='/u/']").last().click();
  await expect(drawer).not.toHaveAttribute("open");
  await page.waitForTimeout(500);
  expect(page.url()).toBe(before);
  // With the drawer closed, the same link works.
  await page.locator("main article a[href^='/u/']").last().click();
  await expect(page).toHaveURL(/\/u\//);
});

test("replies to one post are one row while unread: it names the people, shows the newest line, opens at the oldest reply and reads them all", async ({ page }) => {
  const { topic } = fixture();
  await useMember(page, "uxnav_notice@example.com", "/notifications"); await waitForClientRoute(page);
  const row = page.locator("li").filter({ has: page.locator('a[href*="group=thread"]') });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("UX nav grouped replies");
  await expect(row).toContainText("@uxnav_author");
  await expect(row).toContainText("Third reply, the newest, is the excerpt.");
  // The bell is a number of what is addressed to the member; following is a place with its own mark.
  await row.getByRole("link").first().click();
  await expect(page).toHaveURL(new RegExp(`/t/${topic}(?:\\?sl=[\\w-]+)?#c-\\d+$`));
  await expect(page.locator("#replies")).toContainText("First reply to the grouped post.");
  await page.goto("/notifications");
  await expect(page.locator('a[href*="group=thread"]')).toHaveCount(0);
});

test("a village shows the chat tab to members only as a link, and to others as plain words", async ({ page, browser }) => {
  await useMember(page, "uxnav_quiet@example.com", "/v/ux-nav-chat");
  const tabs = page.locator("[data-village-header] nav");
  await expect(tabs.getByRole("link", { name: m.village_chat_title })).toHaveCount(0);
  await expect(tabs).toContainText(m.village_chat_members_only);
  // Only one main action: joining.
  await expect(page.getByRole("button", { name: m.village_join, exact: true })).toBeVisible();
  const guest = await browser.newPage({ locale: "en-US" });
  try {
    await guest.goto("/v/ux-nav-chat");
    await expect(guest.locator("[data-village-header] nav")).toContainText(m.village_chat_members_only);
    await expect(guest.locator("[data-village-header] nav [title]")).toHaveAttribute("title", m.village_chat_login_to_read);
  } finally { await guest.close(); }
});
