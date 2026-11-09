import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { enMessages as m, formatMessage, useMember, waitForClientRoute, state } from "./helpers";

const visibleMessage = async (page: import("@playwright/test").Page) => page.locator("[data-chat-message]").evaluateAll(elements => elements.find(element => {
  const rect = element.getBoundingClientRect(); return rect.top >= 100 && rect.bottom < innerHeight - 160;
})?.id ?? null);

test("chat opens at unread, follows the bottom, announces later arrivals and prepends history in place", async ({ page, browser }) => {
  await useMember(page, "chat_flow_scroll_reader@example.com", "/v/chat-flow-scroll/chat"); await waitForClientRoute(page);
  await expect(page).toHaveTitle(`Chat flow scroll · ${m.village_chat_title}`);
  await expect(page.locator("#chat-unread")).toBeInViewport();
  await expect(page.locator('[data-village-header] > nav [aria-current="page"]')).toHaveText(new RegExp(`^${m.village_chat_title}`));
  await expect(page.locator("footer")).toHaveCount(0);
  await page.getByRole("link", { name: m.village_chat_latest, exact: true }).click();
  await expect.poll(async () => (await (await page.request.get("/navigation-header")).json()).chatUnreadTotal).toBe(0);
  await expect(page.locator('[data-site-navigation] a[href$="/chat"] .bg-unread')).toHaveCount(0);
  await page.locator("[data-chat-message]").filter({ hasText: "Flow scroll message 90" }).scrollIntoViewIfNeeded();
  const originalAnchor = await visibleMessage(page);
  await page.getByRole("navigation", { name: m.nav_side_label, exact: true }).locator('a[href="/v/chat-flow-lounge"]').click();
  await expect(page).toHaveURL(/\/v\/chat-flow-lounge$/); await waitForClientRoute(page);
  await page.goBack(); await waitForClientRoute(page);
  await expect(page.locator(`[id="${originalAnchor}"]`)).toBeInViewport();
  await expect(page.locator("[data-village-header] > nav .bg-unread")).toHaveCount(0);
  const otherContext = await browser.newContext({ locale: "en-US" });
  try {
    const writer = await otherContext.newPage();
    await useMember(writer, "chat_flow_scroll_writer@example.com", "/v/chat-flow-scroll/chat?latest=1"); await waitForClientRoute(writer);
    await page.getByRole("link", { name: new RegExp(`^${m.village_chat_latest}`) }).click();
    const send = async (body: string) => {
      await writer.getByLabel(m.village_chat_body, { exact: true }).fill(body);
      await writer.getByRole("button", { name: m.village_chat_send, exact: true }).click();
      await expect(writer.getByLabel(m.village_chat_body, { exact: true })).toHaveValue("");
    };
    await send("A new message while the reader is at the bottom");
    await expect(page.getByRole("log").getByText("A new message while the reader is at the bottom", { exact: true })).toBeInViewport();
    await page.locator("[data-chat-message]").filter({ hasText: "Flow scroll message 90" }).scrollIntoViewIfNeeded();
    const anchor = await visibleMessage(page);
    expect(anchor).not.toBeNull();
    await send("A new message while earlier messages are being read");
    await expect(page.getByRole("link", { name: formatMessage(m.village_chat_new_messages, { count: 1 }), exact: true })).toBeVisible();
    expect(await visibleMessage(page)).toBe(anchor);
    const pending = writer.locator("[data-chat-message]").filter({ hasText: "A new message while earlier messages are being read" });
    await pending.hover(); await pending.locator("summary").filter({ hasText: m.village_chat_delete }).click();
    await pending.getByRole("button", { name: m.delete_confirm, exact: true }).click();
    await expect(page.getByRole("link", { name: m.village_chat_latest, exact: true })).toBeVisible();
    const previousCount = await page.locator("[data-chat-message]").count();
    const firstId = await page.locator("[data-chat-message]").first().getAttribute("id");
    await page.evaluate(() => scrollTo(0, 0));
    await expect(page.locator("[data-chat-message]")).toHaveCount(previousCount + 50);
    await expect(page.locator(`[id="${firstId}"]`)).toBeInViewport();
    await expect(page).toHaveURL(/\/v\/chat-flow-scroll\/chat$/);
    await page.getByLabel(m.village_chat_body, { exact: true }).fill("A reply sent while reading history");
    await page.getByLabel(m.village_chat_body, { exact: true }).press("Enter");
    await expect(page.getByRole("log").getByRole("paragraph").filter({ hasText: "A reply sent while reading history" })).toBeInViewport();
    await page.locator("[data-chat-message]").filter({ hasText: "Flow scroll message 90" }).scrollIntoViewIfNeeded();
    const returnAnchor = await visibleMessage(page);
    await page.getByRole("navigation", { name: m.nav_side_label, exact: true }).locator('a[href="/v/chat-flow-lounge"]').click();
    await expect(page).toHaveURL(/\/v\/chat-flow-lounge$/); await waitForClientRoute(page);
    await page.goBack(); await waitForClientRoute(page);
    await expect(page.locator(`[id="${returnAnchor}"]`)).toBeInViewport();
  } finally { await otherContext.close(); }
});

test("chat uses local days, switches originals, keeps action overlays stable and confirms edits and deletion", async ({ browser }) => {
  const context = await browser.newContext({ locale: "en-US", timezoneId: "Asia/Tokyo", viewport: { width: 1280, height: 900 } });
  try {
    await context.clock.setFixedTime(new Date(JSON.parse(fs.readFileSync(path.join(state().dir, "chat-calendar.json"), "utf8")).now));
    const page = await context.newPage();
    const warnings: string[] = [];
    page.on("console", message => { if (/hydrat|did not match/i.test(message.text())) warnings.push(message.text()); });
    await useMember(page, "chat_flow_tools_reader@example.com", "/v/chat-flow-tools/chat"); await waitForClientRoute(page);
    const first = page.locator("[data-chat-message]").filter({ hasText: "Translated message 1" });
    await expect(first).toBeVisible();
    await expect(page.getByRole("separator").filter({ hasText: m.village_chat_yesterday })).toBeVisible();
    const time = first.locator("time");
    const iso = await time.getAttribute("datetime");
    const local = new Intl.DateTimeFormat("en", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso!));
    await expect(time).toHaveText(local);
    await expect(time).toHaveAttribute("title", new RegExp(String(new Date(iso!).getFullYear())));
    await expect(page.locator('select[name="reason"]')).toHaveCount(0);
    const firstId = await first.getAttribute("data-chat-message");
    const translated = page.locator(`[data-chat-message="${firstId}"]`);
    await page.getByRole("button", { name: m.village_chat_originals, exact: true }).click();
    await expect(translated.getByRole("paragraph").filter({ hasText: "原文の発言 1" })).toBeVisible();
    await translated.hover();
    await translated.getByRole("button", { name: m.village_chat_translation_show, exact: true }).click();
    await expect(translated).toContainText("Translated message 1");
    await expect(page.getByRole("log")).toContainText("原文の発言 2");
    await translated.getByRole("link", { name: m.chat_reports_flag, exact: true }).click();
    await expect(page.locator('select[name="reason"]')).toHaveCount(1);
    await expect(page.getByRole("dialog", { name: m.chat_reports_flag, exact: true }).getByRole("combobox")).toBeFocused();
    await page.getByRole("dialog", { name: m.chat_reports_flag, exact: true }).getByLabel(m.flag_note, { exact: true }).fill("A note for the first message");
    await page.keyboard.press("Escape");
    const second = page.locator("[data-chat-message]").filter({ hasText: "原文の発言 2" });
    await second.hover(); await second.getByRole("link", { name: m.chat_reports_flag, exact: true }).click();
    await expect(page.locator('select[name="reason"]')).toHaveCount(1);
    await expect(page.getByRole("dialog", { name: m.chat_reports_flag, exact: true }).getByLabel(m.flag_note, { exact: true })).toHaveValue("");
    await page.keyboard.press("Escape"); await expect(page.locator('select[name="reason"]')).toHaveCount(0);
    const ownId = await page.locator("[data-chat-message]").filter({ hasText: "Flow tools message 3" }).getAttribute("data-chat-message");
    const own = page.locator(`[data-chat-message="${ownId}"]`);
    const before = await own.evaluate(element => element.getBoundingClientRect().height);
    await own.hover();
    expect(await own.evaluate(element => element.getBoundingClientRect().height)).toBe(before);
    await own.locator("summary").filter({ hasText: m.village_chat_edit }).click();
    const editor = own.getByLabel(m.village_chat_edit, { exact: true });
    await editor.fill("An abandoned draft"); await editor.press("Escape");
    await expect(own.locator("details").first()).not.toHaveAttribute("open", "");
    await own.locator("summary").filter({ hasText: m.village_chat_edit }).click();
    await expect(editor).toHaveValue("Flow tools message 3");
    await editor.fill("Saved with Enter"); await editor.press("Enter");
    await expect(own.getByRole("paragraph").filter({ hasText: "Saved with Enter" })).toBeVisible();
    await own.locator("summary").filter({ hasText: m.village_chat_delete }).click();
    await expect(own).toContainText("Saved with Enter");
    await own.getByRole("link", { name: m.cancel, exact: true }).last().click();
    await expect(own).toContainText("Saved with Enter");
    // The actions sit away from the text and appear while the pointer is on the message (the opened form made it taller, so the pointer has left it).
    await own.hover();
    await own.locator("summary").filter({ hasText: m.village_chat_delete }).click();
    await own.getByRole("button", { name: m.delete_confirm, exact: true }).click();
    await expect(own).toHaveCount(0);
    expect(warnings).toEqual([]);
  } finally { await context.close(); }
});
