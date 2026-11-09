import fs from "node:fs";
import path from "node:path";
import { expect, type BrowserContext, type Page } from "@playwright/test";
import { test } from "./editor-fixture";
import { useMember, formatMessage, messagePattern, clientHeaders, enMessages as en, openUserMenu, state, titleField, waitForClientRoute, waitForFormReady } from "./helpers";

test.describe.configure({ mode: "serial" });
let readerContext: BrowserContext, writerContext: BrowserContext;
let reader: Page, writer: Page;
let topicPath: string;
const marker = (page: Page) => page.locator("[data-new-replies]");
const fixture = () => JSON.parse(fs.readFileSync(path.join(state().dir, "discussion-return.json"), "utf8")) as { topicId: number; firstId: number; lastId: number };
const format = (message: Parameters<typeof formatMessage>[0], count: number) => formatMessage(message, { count });
async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}
async function postReply(page: Page, body: string) {
  await page.goto(topicPath);
  await waitForClientRoute(page);
  await waitForFormReady(page.locator("#reply form"));
  await page.getByLabel(en.field_body, { exact: true }).fill(body);
  await page.getByRole("button", { name: en.submit_reply, exact: true }).click();
  await expect(page.getByText(body, { exact: true }).and(page.getByRole("paragraph"))).toBeVisible();
  return Number(new URL(page.url()).hash.slice(3));
}
test.beforeAll(async ({ browser }) => {
  readerContext = await browser.newContext({ extraHTTPHeaders: clientHeaders("10.42.0.1"), viewport: { width: 390, height: 844 } });
  writerContext = await browser.newContext({ extraHTTPHeaders: clientHeaders("10.42.0.2") });
  reader = await readerContext.newPage(); writer = await writerContext.newPage();
  await useMember(reader, "discussion_reader@example.com");
  await useMember(writer, "discussion_writer@example.com");
});
test.afterAll(async () => { await readerContext?.close(); await writerContext?.close(); });

for (const javaScriptEnabled of [true]) {
  test(`reply targets cross pages and work with JavaScript ${javaScriptEnabled}`, async ({ browser }) => {
    const f = fixture();
    const context = await browser.newContext({ javaScriptEnabled, storageState: await readerContext.storageState(), extraHTTPHeaders: clientHeaders("10.42.0.3"), viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    try {
      await page.goto(`/t/${f.topicId}?page=2`);
      if (javaScriptEnabled) await waitForClientRoute(page);
      const parentLine = page.locator(`[data-reply-branch="${f.firstId}"] > p`).getByRole("link", { name: messagePattern(en.reply_parent_link, { handle: /[a-z0-9_]+/ }), exact: true });
      await expect(parentLine).toHaveAttribute("href", `/t/${f.topicId}#c-${f.firstId}`);
      expect(await parentLine.locator("..").innerText()).toBe(formatMessage(en.reply_parent_link, { handle: "discussion_fixture" }));
      await parentLine.click();
      await expect(page).toHaveURL(new RegExp(`#c-${f.firstId}$`));
      await page.locator(`#c-${f.firstId}`).getByRole("link", { name: en.reply_to_button, exact: true }).click();
      await expect(page.getByText(formatMessage(en.reply_target_note, { handle: "discussion_fixture" }), { exact: true })).toBeVisible();
      await expect(page.locator('#reply input[name="parentId"]')).toHaveValue(String(f.firstId));
      await page.getByRole("link", { name: en.reply_target_clear, exact: true }).click();
      await expect(page.locator('#reply input[name="parentId"]')).toHaveValue("");
      if (javaScriptEnabled) await waitForFormReady(page.locator("#reply form"));
      const clearedBody = `Cleared target, JS ${javaScriptEnabled}.`;
      await page.getByLabel(en.field_body, { exact: true }).fill(`---\ntype: reply\nreply_to: c-${f.firstId}\n---\n${clearedBody}`);
      await page.getByRole("button", { name: en.submit_reply, exact: true }).click();
      await expect(page.getByText(clearedBody, { exact: true })).toBeVisible();
      await expect(page.locator("article").filter({ has: page.getByText(clearedBody, { exact: true }) }).getByRole("link", { name: messagePattern(en.reply_parent_link, { handle: /[a-z0-9_]+/ }), exact: true })).toHaveCount(0);
      await page.goto(`/t/${f.topicId}`);
      await waitForClientRoute(page);
      await page.locator(`#c-${f.firstId}`).getByRole("link", { name: en.reply_to_button, exact: true }).click();
      await expect(page.locator('#reply input[name="parentId"]')).toHaveValue(String(f.firstId));
      if (javaScriptEnabled) await waitForFormReady(page.locator("#reply form"));
      const body = `Reply from the selected form, JS ${javaScriptEnabled}.`;
      await page.getByLabel(en.field_body, { exact: true }).fill(body);
      await page.getByRole("button", { name: en.submit_reply, exact: true }).click();
      await expect(page.getByText(body, { exact: true })).toBeVisible();
      const created = page.locator("article").filter({ has: page.getByText(body, { exact: true }) });
      await expect(created.getByRole("link", { name: messagePattern(en.reply_parent_link, { handle: /[a-z0-9_]+/ }), exact: true })).toHaveAttribute("href", `/t/${f.topicId}#c-${f.firstId}`);
      await noOverflow(page);
      if (!javaScriptEnabled) await expect(marker(page)).toHaveCount(0);
    } finally { await context.close(); }
  });
}

test("home and language rows open the topic to manage following", async ({ browser }) => {
  await writer.goto("/t/new");
  await waitForClientRoute(writer);
  await waitForFormReady(writer.locator("form", { has: titleField(writer) }));
  await titleField(writer).fill("Discussion return browser topic");
  await writer.getByLabel(en.field_body, { exact: true }).fill("A discussion to revisit.");
  await writer.getByRole("button", { name: en.submit_post, exact: true }).click();
  await expect(writer.getByRole("heading", { name: "Discussion return browser topic", exact: true })).toBeVisible();
  topicPath = new URL(writer.url()).pathname;
  const id = Number(topicPath.split("/").at(-1));
  await reader.goto("/");
  await waitForClientRoute(reader);
  const row = reader.locator(`#q-${id}`);
  await expect(row.getByRole("button", { name: en.follow_button, exact: true })).toHaveCount(0);
  await row.locator(":scope > a").click();
  await Promise.all([reader.waitForResponse(r => /\/follow(?:\.data)?$/.test(new URL(r.url()).pathname) && r.request().method() === "POST"), reader.getByRole("button", { name: en.follow_button, exact: true }).click()]);
  await expect(reader.getByRole("button", { name: en.follow_unfollow, exact: true })).toBeVisible();
  await noOverflow(reader);
  const context = await browser.newContext({ javaScriptEnabled: true, storageState: await readerContext.storageState(), extraHTTPHeaders: clientHeaders("10.42.0.4"), viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  try {
    await page.goto("/a/en");
    await waitForClientRoute(page);
    await page.locator(`#q-${id}`).locator(":scope > a").click();
    await page.getByRole("button", { name: en.follow_unfollow, exact: true }).click();
    await expect(page.getByRole("button", { name: en.follow_button, exact: true })).toBeVisible();
    await page.getByRole("button", { name: en.follow_button, exact: true }).click();
    await expect(page.getByRole("button", { name: en.follow_unfollow, exact: true })).toBeVisible();
    await noOverflow(page);
  } finally { await context.close(); }
});

test("three new replies start at the first unread reply in notifications and following rows, with a browser-only marker", async () => {
  await reader.goto(topicPath);
  await waitForClientRoute(reader);
  await expect.poll(() => reader.evaluate(() => localStorage.getItem("tomola.seen-replies"))).not.toBeNull();
  await expect(marker(reader)).toHaveCount(0);
  const first = await postReply(writer, "First new reply.");
  const second = await postReply(writer, "Second new reply.");
  const third = await postReply(writer, "Third new reply.");
  const href = `${topicPath}#c-${first}`;
  await reader.goto("/following");
  await waitForClientRoute(reader);
  const badge = reader.getByRole("link", { name: format(en.following_new_replies, 3), exact: true });
  await expect(badge).toHaveAttribute("href", href);
  await noOverflow(reader);
  await reader.goto("/notifications");
  await waitForClientRoute(reader);
  const notices = reader.getByRole("link", { name: messagePattern(en.notification_followed_thread, { title: "Discussion return browser topic", count: 3, handle: "discussion_writer" }), exact: true });
  await expect(notices).toHaveCount(1);
  await expect(notices).toHaveAttribute("href", /^\/notifications\/\d+\/open$/);
  const requests: string[] = [];
  reader.on("request", request => requests.push(JSON.stringify({ url: request.url(), headers: request.headers(), body: request.postData() })));
  await notices.click();
  await expect(reader).toHaveURL(new RegExp(`${href}$`));
  await expect(marker(reader)).toContainText(format(en.page_new_replies, 3));
  await expect(marker(reader).getByRole("link", { name: en.first_new_reply, exact: true })).toHaveAttribute("href", `#c-${first}`);
  await expect.poll(() => reader.locator("[data-new-reply]").evaluateAll(nodes => nodes.map(node => node.id))).toEqual([`c-${first}`, `c-${second}`, `c-${third}`]);
  // The first new reply is brought into view (a short page cannot scroll it to the top, so only the screen is the measure).
  await expect.poll(() => reader.locator(`#c-${first}`).evaluate(node => { const top = node.getBoundingClientRect().top; return top >= 0 && top < innerHeight - 100; })).toBe(true);
  await noOverflow(reader);
  expect(requests.join("\n")).not.toContain("tomola.seen-replies");
  // Both mutations and same-page query navigation revalidate the loader.
  await reader.locator(`#c-${first}`).getByRole("button", { name: en.insightful_give, exact: true }).click();
  await expect(reader.locator(`#c-${first}`).getByRole("button", { name: en.insightful_give, exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(marker(reader)).toContainText(format(en.page_new_replies, 3));
  await expect(marker(reader).getByRole("link", { name: en.first_new_reply, exact: true })).toHaveAttribute("href", `#c-${first}`);
  await expect.poll(() => reader.locator("[data-new-reply]").evaluateAll(nodes => nodes.map(node => node.id))).toEqual([`c-${first}`, `c-${second}`, `c-${third}`]);
  await reader.locator(`#c-${first}`).getByRole("link", { name: en.reply_to_button, exact: true }).click();
  await expect(reader.locator('#reply input[name="parentId"]')).toHaveValue(String(first));
  await expect(marker(reader)).toContainText(format(en.page_new_replies, 3));
  await expect(marker(reader).getByRole("link", { name: en.first_new_reply, exact: true })).toHaveAttribute("href", `#c-${first}`);
  await expect.poll(() => reader.locator("[data-new-reply]").evaluateAll(nodes => nodes.map(node => node.id))).toEqual([`c-${first}`, `c-${second}`, `c-${third}`]);
  await reader.reload();
  await expect(marker(reader)).toHaveCount(0);
  await reader.goto("/following");
  await waitForClientRoute(reader);
  await expect(reader.getByRole("link", { name: format(en.following_new_replies, 3), exact: true })).toHaveCount(0);
  await postReply(reader, "My own new reply.");
  await expect(marker(reader)).toHaveCount(0);
  await reader.reload();
  await expect(marker(reader)).toHaveCount(0);
});

test("pasted targets use the same parent line and the member menu links to stances", async () => {
  const f = fixture();
  await reader.goto(`/t/${f.topicId}`);
  await waitForClientRoute(reader);
  await waitForFormReady(reader.locator("#reply form"));
  await reader.getByLabel(en.field_body, { exact: true }).fill(`---\ntype: reply\nreply_to: c-${f.firstId}\n---\nA pasted reply target.`);
  await reader.getByRole("button", { name: en.submit_reply, exact: true }).click();
  await expect(reader.getByText("A pasted reply target.", { exact: true })).toBeVisible();
  const created = reader.locator("article").filter({ has: reader.getByText("A pasted reply target.", { exact: true }) });
  await expect(created.getByRole("link", { name: messagePattern(en.reply_parent_link, { handle: /[a-z0-9_]+/ }), exact: true })).toHaveAttribute("href", `/t/${f.topicId}#c-${f.firstId}`);
  const menu = await openUserMenu(reader);
  await menu.getByRole("menuitem", { name: en.nav_stances, exact: true }).click();
  await expect(reader).toHaveURL(/\/settings\/stances$/);
});
