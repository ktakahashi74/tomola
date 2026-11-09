import { expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { test } from "./editor-fixture";
import { formatMessage, captureScreenshot, enMessages as m, state, useMember, waitForClientRoute } from "./helpers";
async function evidence(page: Page, label: string) {
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await captureScreenshot(page, { path: `${label}-${width}.png`, fullPage: true, animations: "disabled" }, "village-chat-own");
  }
}
test("deletes an own message from settings after leaving and removes it from the remaining member's live chat", async ({ page, browser }) => {
  const slug = "own-chat-browser";
  const context = await browser.newContext({ locale: "en-US" }), peer = await context.newPage();
  try {
    await useMember(peer, "co_reader@example.com", `/v/${slug}`);
    await useMember(page, "co_author@example.com", `/v/${slug}`); await waitForClientRoute(page);
    await expect(page.getByRole("button", { name: m.village_leave, exact: true })).toBeVisible();
    await page.getByRole("link", { name: m.village_chat_title, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/v/${slug}/chat$`)); await waitForClientRoute(page);
    await peer.goto(`/v/${slug}/chat`); await waitForClientRoute(peer);
    const body = "A message I can delete after leaving";
    await page.getByLabel(m.village_chat_body, { exact: true }).fill(body);
    await page.getByRole("button", { name: m.village_chat_send, exact: true }).click();
    await expect(page.getByLabel(m.village_chat_body, { exact: true })).toHaveValue("");
    const received = peer.locator("[data-chat-message]").filter({ hasText: body });
    await expect(received).toBeVisible(); const id = await received.getAttribute("data-chat-message");
    const bulkIds: string[] = [];
    for (const extra of ["First own bulk deletion", "Second own bulk deletion"]) {
      await page.getByLabel(m.village_chat_body, { exact: true }).fill(extra);
      await page.getByRole("button", { name: m.village_chat_send, exact: true }).click();
      await expect(page.getByLabel(m.village_chat_body, { exact: true })).toHaveValue("");
      const message = peer.locator("[data-chat-message]").filter({ hasText: extra });
      await expect(message).toBeVisible(); bulkIds.push((await message.getAttribute("data-chat-message"))!);
    }
    await page.goto(`/v/${slug}`); await waitForClientRoute(page);
    await page.getByRole("button", { name: m.village_leave, exact: true }).click();
    await expect(page.getByRole("button", { name: m.village_join, exact: true })).toBeVisible();
    await page.goto("/settings#settings-export"); await waitForClientRoute(page);
    await page.getByRole("link", { name: m.village_chat_own_title, exact: true }).click();
    await expect(page).toHaveURL(/\/settings\/chat$/);
    const own = page.locator(`[data-own-chat="${id}"]`);
    await expect(own).toContainText(body);
    await expect(own.getByRole("link", { name: m.notification_open, exact: true })).toHaveCount(0);
    const exported = await (await page.request.get("/settings/export")).json();
    expect(exported.chat_messages.some((row: { id: string; body: string }) => row.id === id && row.body === body)).toBe(true);
    await evidence(page, "departed-messages");
    await own.getByRole("button", { name: m.village_chat_delete, exact: true }).click();
    await expect(own).toHaveCount(0);
    await expect(peer.locator(`[data-chat-message="${id}"]`)).toHaveCount(0);
    for (const bulkId of bulkIds) await expect(page.locator(`[data-own-chat="${bulkId}"]`)).toBeVisible();
    await page.getByRole("checkbox").check();
    await page.getByRole("button", { name: m.village_chat_own_delete_all, exact: true }).click();
    for (const bulkId of bulkIds) {
      await expect(page.locator(`[data-own-chat="${bulkId}"]`)).toHaveCount(0);
      await expect(peer.locator(`[data-chat-message="${bulkId}"]`)).toHaveCount(0);
    }
    expect((await (await page.request.get("/settings/export")).json()).chat_messages).toEqual([]);
  } finally { await context.close(); }
});
test("shows public topic cards in a live message and opens the public reply form", async ({ page, browser }) => {
  await useMember(page, "co_author@example.com");
  const title = "A public topic linked from chat";
  const { linkedTopicIds } = JSON.parse(fs.readFileSync(path.join(state().dir, "chat-own.json"), "utf8")) as { linkedTopicIds: number[] };
  const topicUrls = linkedTopicIds.map(id => new URL(`/t/${id}`, state().baseURL).href);
  const context = await browser.newContext({ locale: "en-US" }), peer = await context.newPage(), slug = "linked-chat-browser";
  try {
    await useMember(peer, "co_reader@example.com", `/v/${slug}`);
    await page.goto(`/v/${slug}`); await waitForClientRoute(page);
    await expect(page.getByRole("button", { name: m.village_leave, exact: true })).toBeVisible();
    await page.getByRole("link", { name: m.village_chat_title, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/v/${slug}/chat$`)); await waitForClientRoute(page);
    await peer.goto(`/v/${slug}/chat`); await waitForClientRoute(peer);
    await page.getByLabel(m.village_chat_body, { exact: true }).fill(topicUrls.map(url => `${url}#reply`).join(" "));
    await page.getByRole("button", { name: m.village_chat_send, exact: true }).click();
    await expect(page.getByLabel(m.village_chat_body, { exact: true })).toHaveValue("");
    const card = peer.locator("[data-chat-topics]");
    await expect(card.getByRole("link", { name: title, exact: true })).toBeVisible();
    await expect(card.getByRole("link", { name: `${title} 3`, exact: true })).toBeVisible();
    await expect(card.getByRole("link", { name: `${title} 4`, exact: true })).toHaveCount(0);
    await expect(card.getByRole("link", { name: m.village_chat_topic_reply, exact: true })).toHaveCount(3);
    await peer.reload(); await waitForClientRoute(peer);
    await expect(card.getByRole("link", { name: title, exact: true })).toBeVisible();
    await expect(card.getByRole("link", { name: `${title} 4`, exact: true })).toHaveCount(0);
    await expect(card).toContainText(formatMessage(m.home_replies, { count: 0 }));
    await evidence(peer, "topic-card");
    await card.getByRole("link", { name: m.village_chat_topic_reply, exact: true }).first().click();
    await expect(peer).toHaveURL(/\/t\/\d+#reply$/);
    await expect(peer.locator("#reply").getByRole("heading", { name: m.reply_write_title, exact: true })).toBeVisible();
    await expect(peer.locator('main a[href*="/chat"]')).toHaveCount(0);
  } finally { await context.close(); }
});
