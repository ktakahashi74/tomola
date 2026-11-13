import { expect, test } from "@playwright/test";
import { enMessages as m, useMember, waitForClientRoute, waitForHydration, captureScreenshot } from "./helpers";

test("chat replies preserve chronology, cancel cleanly, open old parents, and notify once alongside mentions", async ({ page, browser }) => {
  await useMember(page, "qry_reply_writer@example.com");
  await page.goto("/v/chat-replies/chat?latest=1"); await waitForClientRoute(page);
  await page.getByRole("link", { name: m.village_chat_previous, exact: true }).click();
  const parent = page.locator("[data-chat-message]").filter({ has: page.locator("p", { hasText: /^Reply history 1$/ }) });
  await expect(parent).toHaveCount(1);
  const parentId = await parent.getAttribute("data-chat-message");
  await parent.click();
  await parent.getByRole("button", { name: m.village_chat_reply, exact: true }).click();
  const body = page.getByLabel(m.village_chat_body, { exact: true });
  await expect(body).toBeFocused();
  await expect(page.locator("[data-chat-replying]")).toContainText("Reply history 1");
  await body.fill("Keep this draft");
  await page.getByRole("button", { name: m.village_chat_reply_cancel, exact: true }).click();
  await expect(page.locator("[data-chat-replying]")).toHaveCount(0);
  await expect(body).toHaveValue("Keep this draft");
  await parent.click(); await parent.getByRole("button", { name: m.village_chat_reply, exact: true }).click();
  await body.fill("Private reply marker @qry_reply_reader");
  await page.getByRole("button", { name: m.village_chat_send, exact: true }).click();
  await expect(body).toHaveValue("");
  const reply = page.locator("[data-chat-message]").filter({ has: page.locator("p", { hasText: /^Private reply marker/ }) });
  await expect(reply.locator("[data-chat-reply]")).toContainText("Reply history 1");
  await expect(page.locator("[data-chat-message]").last()).toHaveAttribute("data-chat-message", (await reply.getAttribute("data-chat-message"))!);
  const replyId = await reply.getAttribute("data-chat-message");
  await captureScreenshot(page, { path: "chat-reply-desktop.png", fullPage: false }, "village-chat-replies");
  await reply.locator("[data-chat-reply]").click();
  await expect(page).toHaveURL(new RegExp(`\\?at=${parentId}#chat-${parentId}$`));
  await expect(parent).toBeInViewport();
  await expect(page.locator("[data-chat-message]").filter({ hasText: "Reply history 70" })).toHaveCount(0);

  const context = await browser.newContext({ locale: "en-US", viewport: { width: 390, height: 844 } });
  const reader = await context.newPage();
  try {
    await useMember(reader, "qry_reply_reader@example.com", "/notifications");
    await waitForClientRoute(reader);
    const notice = reader.locator('main a[href^="/notifications/"]').filter({ hasText: "qry_reply_writer" });
    await expect(notice).toHaveCount(1);
    await expect(reader.locator("main")).not.toContainText("Private reply marker");
    await notice.click(); await waitForHydration(reader);
    const received = reader.locator(`[data-chat-message="${replyId}"]`);
    await expect(received).toBeInViewport();
    // Tapping the quote opens its parent; reveal actions from the reply body.
    await received.locator("p").filter({ hasText: /^Private reply marker/ }).click({ position: { x: 4, y: 4 } });
    await received.getByRole("button", { name: m.village_chat_reply, exact: true }).click();
    await expect(reader.locator("[data-chat-replying]")).toContainText("Private reply marker");
    await expect(reader.getByLabel(m.village_chat_body, { exact: true })).toBeFocused();
    await captureScreenshot(reader, { path: "chat-reply-mobile.png", fullPage: false }, "village-chat-replies");
    await reader.getByRole("button", { name: m.village_chat_reply_cancel, exact: true }).click();
    // A later edit updates the referenced line even when its parent is outside the writer's loaded window.
    await page.goto(`/v/chat-replies/chat?at=${replyId}#chat-${replyId}`); await waitForClientRoute(page);
    await reader.goto(`/v/chat-replies/chat?at=${parentId}#chat-${parentId}`); await waitForClientRoute(reader);
    const editable = reader.locator(`[data-chat-message="${parentId}"]`);
    await editable.click(); await editable.locator("summary").filter({ hasText: m.village_chat_edit }).click();
    await editable.locator('textarea[name="body"]').fill("Current parent text");
    await editable.getByRole("button", { name: m.save_changes, exact: true }).click();
    await expect(page.locator(`[data-chat-message="${replyId}"] [data-chat-reply]`)).toContainText("Current parent text");
    await expect(page.locator(`[data-chat-message="${replyId}"] [data-chat-reply]`)).toContainText(m.village_chat_edited);
    await editable.click(); await editable.locator("summary").filter({ hasText: m.village_chat_delete }).click();
    await editable.getByRole("button", { name: m.delete_confirm, exact: true }).click();
    await expect(page.locator(`[data-chat-message="${replyId}"] [data-chat-reply]`)).toHaveText(m.village_chat_reply_unavailable);
    await page.goto(`/v/chat-replies/chat?at=${parentId}`); await waitForClientRoute(page);
    await expect(page.getByRole("status").filter({ hasText: m.village_chat_reply_destination_unavailable })).toBeVisible();
    await expect(page.locator("main")).not.toContainText("Current parent text");
  } finally { await context.close(); }
});
