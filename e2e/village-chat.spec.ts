import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { state, captureScreenshot, enMessages as m, formatMessage, useMember, waitForClientRoute } from "./helpers";

test("members receive new, edited and deleted plain messages without reloading", async ({ page, browser }) => {
  await useMember(page, "vchat_live_a@example.com");
  const context = await browser.newContext({ locale: "en-US" }); const other = await context.newPage();
  try {
    await useMember(other, "vchat_live_b@example.com");
    await other.goto("/v/chat-live"); await waitForClientRoute(other);
    await page.goto("/v/chat-live/chat"); await waitForClientRoute(page);
    const body = '<b>Plain chat</b> @vchat_live_b https://example.org/path。かな';
    await page.getByLabel(m.village_chat_body, { exact: true }).fill(body);
    await page.getByRole("button", { name: m.village_chat_send, exact: true }).click();
    await expect(page.getByRole("log").getByRole("paragraph").filter({ hasText: body })).toBeVisible();
    await expect(page.getByLabel(m.village_chat_body, { exact: true })).toHaveValue("");
    await other.reload();
    // The message mentions this member, so the Chat tab and the chat entrance of the side column carry a number (what is addressed to the member); other news is only a dot.
    const addressed = formatMessage(m.village_chat_addressed, { count: 1 });
    await expect(other.locator("main").getByRole("link", { name: `${m.village_chat_title} ${addressed}`, exact: true })).toBeVisible();
    const villageLink = other.locator('[data-site-navigation] a[href="/v/chat-live/chat"]');
    await expect(villageLink).toHaveAccessibleName(`chat-live · ${m.village_chat_title} · ${addressed}`);
    await expect(villageLink).toContainText("1");
    await other.getByRole("navigation", { name: m.nav_side_label, exact: true }).getByRole("link", { name: m.nav_all_villages, exact: true }).click(); await waitForClientRoute(other);
    const joined = other.getByRole("region", { name: m.villages_joined_heading, exact: true });
    await expect(joined.locator('a[href="/v/chat-live/chat"]')).toHaveAccessibleName(`chat-live · ${m.village_chat_title} · ${addressed}`);
    await joined.locator('a[href="/v/chat-live"]').click(); await waitForClientRoute(other);
    await other.goto("/v/chat-live/chat"); await waitForClientRoute(other);
    const received = other.locator("[data-chat-message]").filter({ hasText: "Plain chat" });
    await expect(received).toBeVisible(); await expect(received.locator("b")).toHaveCount(0); await expect(received.locator('a[href="https://example.org/path"]')).toHaveAttribute("rel", "nofollow noopener noreferrer");
    await expect(other.getByText(m.village_chat_unread_start, { exact: true })).toBeVisible();
    const id = await received.getAttribute("data-chat-message");
    await page.getByLabel(m.village_chat_body, { exact: true }).fill("A second realtime message");
    await page.getByRole("button", { name: m.village_chat_send, exact: true }).click();
    await expect(page.getByLabel(m.village_chat_body, { exact: true })).toHaveValue("");
    await expect(other.getByRole("log").getByText("A second realtime message", { exact: true })).toBeVisible();
    const owned = page.locator(`[data-chat-message="${id}"]`);
    await owned.hover(); await owned.locator("summary").filter({ hasText: m.village_chat_edit }).click(); await owned.locator('textarea[name="body"]').fill("Edited live text");
    await owned.getByRole("button", { name: m.save_changes, exact: true }).click();
    await expect(owned.locator("details").first()).not.toHaveAttribute("open", "");
    await expect(other.getByRole("log").getByText("Edited live text", { exact: true })).toBeVisible();
    await expect(other.locator(`[data-chat-message="${id}"]`).getByText(m.village_chat_edited, { exact: true })).toBeVisible();
    for (const width of [1280, 390]) {
      await other.setViewportSize({ width, height: 900 });
      expect(await other.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await captureScreenshot(other, { path: `chat-${width}.png`, fullPage: true, animations: "disabled" }, "village-chat");
    }
    await owned.hover();
    await owned.locator("summary").filter({ hasText: m.village_chat_delete }).click();
    await owned.getByRole("button", { name: m.delete_confirm, exact: true }).click();
    await expect(other.locator(`[data-chat-message="${id}"]`)).toHaveCount(0);
    await other.goto("/v/chat-live"); await expect(other.locator("main").getByRole("link", { name: m.village_chat_title, exact: true })).toBeVisible();
    await other.goto("/villages");
    const quietLink = other.getByRole("region", { name: m.villages_joined_heading, exact: true }).locator('a[href="/v/chat-live"]');
    await expect(quietLink).not.toHaveAttribute("aria-label");
    await expect(quietLink.locator('[aria-hidden="true"]')).toHaveCount(0);
  } finally { await context.close(); }
});

test("outsiders are redirected and leaving revokes live and history-return access", async ({ page, browser }) => {
  await useMember(page, "vchat_access_a@example.com"); await page.goto("/v/chat-access/chat"); await waitForClientRoute(page);
  await page.getByLabel(m.village_chat_body, { exact: true }).fill("Restricted history marker"); await page.getByRole("button", { name: m.village_chat_send, exact: true }).click();
  const context = await browser.newContext({ locale: "en-US" }); const other = await context.newPage();
  try {
    await useMember(other, "vchat_access_out@example.com"); await other.goto("/v/chat-access/chat"); await expect(other).toHaveURL(/\/v\/chat-access$/);
    expect((await other.request.get("/v/chat-access/chat/changes?since=0")).status()).toBe(404);
    expect((await other.request.get("/v/chat-access/chat/events")).status()).toBe(404);
    await useMember(other, "vchat_access_b@example.com"); await other.goto("/v/chat-access/chat"); await waitForClientRoute(other);
    await expect(other.getByRole("log").getByText("Restricted history marker", { exact: true })).toBeVisible();
    const response = await other.request.post("/v/chat-access", { form: { intent: "leave" }, headers: { Origin: new URL(other.url()).origin } }); expect(response.ok()).toBe(true);
    await expect(other).toHaveURL(/\/v\/chat-access$/); await expect(other.getByText("Restricted history marker", { exact: true })).toHaveCount(0);
    await other.goto("/villages"); await other.goBack(); await waitForClientRoute(other);
    await other.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
    await expect(other.getByText("Restricted history marker", { exact: true })).toHaveCount(0);
    await other.goto("/v/chat-access/chat"); await expect(other).toHaveURL(/\/v\/chat-access$/);
  } finally { await context.close(); }
});

test("composition Enter does not send and narrow-screen Enter inserts a newline", async ({ page }) => {
  await useMember(page, "vchat_ime_a@example.com"); await page.goto("/v/chat-ime/chat"); await waitForClientRoute(page);
  const field = page.getByLabel(m.village_chat_body, { exact: true });
  await field.fill("Composition");
  await field.evaluate(element => { element.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true })); element.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", keyCode: 229, bubbles: true })); });
  await expect(page.locator("[data-chat-message]")).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 900 }); await field.press("Enter"); await expect(field).toHaveValue("Composition\n"); await expect(page.locator("[data-chat-message]")).toHaveCount(0);
  await page.setViewportSize({ width: 1280, height: 900 }); await field.press("Shift+Enter"); await expect(field).toHaveValue("Composition\n\n");
  await field.press("Enter"); await expect(page.locator("[data-chat-message]")).toHaveCount(1);
});

test("polling recovers messages when the event transport is unavailable", async ({ page, browser }) => {
  await useMember(page, "vchat_fallback_a@example.com"); await page.goto("/v/chat-fallback/chat"); await waitForClientRoute(page);
  const context = await browser.newContext({ locale: "en-US" }); const other = await context.newPage();
  try {
    await useMember(other, "vchat_fallback_b@example.com");
    await other.route("**/chat/events", route => route.abort());
    await other.goto("/v/chat-fallback/chat"); await waitForClientRoute(other);
    await page.getByLabel(m.village_chat_body, { exact: true }).fill("Fallback message"); await page.getByRole("button", { name: m.village_chat_send, exact: true }).click();
    await expect(other.getByRole("log").getByText("Fallback message", { exact: true })).toBeVisible({ timeout: 25_000 });
    await other.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
    await expect(other.locator("[data-chat-message]")).toHaveCount(1);
  } finally { await context.close(); }
});

test("historical windows keep their range, show a latest link, and reconnect on history restoration", async ({ page, browser }) => {
  const fixture = JSON.parse(fs.readFileSync(path.join(state().dir, "chat-history.json"), "utf8"));
  await useMember(page, "vchat_history_a@example.com"); await page.goto(`/v/chat-history/chat?at=${fixture.at}`); await waitForClientRoute(page);
  const context = await browser.newContext({ locale: "en-US" }); const other = await context.newPage();
  try {
    await useMember(other, "vchat_history_b@example.com"); await other.goto(`/v/chat-history/chat?at=${fixture.at}`); await waitForClientRoute(other);
    await expect(other.locator("[data-chat-message]")).toHaveCount(51);
    await expect(other.locator('a[href="/v/chat-history/chat?latest=1#chat-bottom"]')).toBeVisible();
    const reconnected = other.waitForRequest(request => new URL(request.url()).pathname === "/v/chat-history/chat/events");
    await other.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }))); await reconnected;
    // Keep history assertions independent of pointer positioning while the window restores its scroll anchor.
    await page.getByLabel(m.village_chat_body, { exact: true }).fill("A message after the historical window"); await page.getByLabel(m.village_chat_body, { exact: true }).press("Enter");
    await expect(page.getByLabel(m.village_chat_body, { exact: true })).toHaveValue("");
    await expect(other.locator('a[href="/v/chat-history/chat?latest=1#chat-bottom"]')).toBeVisible();
    await expect(other.getByRole("log").getByText("A message after the historical window", { exact: true })).toHaveCount(0);
    await expect(other.locator("[data-chat-message]")).toHaveCount(51);
    await page.goto(`/v/chat-history/chat?at=${fixture.at}`); await waitForClientRoute(page);
    const owned = page.locator(`[data-chat-message="${fixture.at}"]`); await owned.hover(); await owned.locator("summary").filter({ hasText: m.village_chat_edit }).press("Enter"); await owned.locator("textarea").fill("Edited in the historical window");
    await owned.getByRole("button", { name: m.save_changes, exact: true }).press("Enter"); await expect(owned.locator("details").first()).not.toHaveAttribute("open", "");
    await expect(other.getByRole("log").getByText("Edited in the historical window", { exact: true })).toBeVisible();
    await other.locator('a[href="/v/chat-history/chat?latest=1#chat-bottom"]').click();
    await expect(other.getByRole("log").getByText("A message after the historical window", { exact: true })).toBeVisible();
    await page.goto("/v/chat-history/chat?before=9007199254740991"); await waitForClientRoute(page);
    await expect(page.locator('a[href="/v/chat-history/chat?latest=1#chat-bottom"]')).toHaveCount(0);
    await other.getByLabel(m.village_chat_body, { exact: true }).fill("A temporary later message");
    await other.getByLabel(m.village_chat_body, { exact: true }).press("Enter");
    const later = other.locator("[data-chat-message]").filter({ hasText: "A temporary later message" });
    await expect(later).toBeVisible();
    await expect(page.locator('a[href="/v/chat-history/chat?latest=1#chat-bottom"]')).toBeVisible();
    await expect(page.getByRole("log").getByText("A temporary later message", { exact: true })).toHaveCount(0);
    await later.hover();
    await later.locator("summary").filter({ hasText: m.village_chat_delete }).press("Enter");
    await later.getByRole("button", { name: m.delete_confirm, exact: true }).press("Enter");
    await expect(page.locator('a[href="/v/chat-history/chat?latest=1#chat-bottom"]')).toHaveCount(0);
  } finally { await context.close(); }
});

test("message actions support keyboard and touch while the composer follows the visible viewport", async ({ browser }) => {
  const contexts = [];
  for (const mobile of [false, true]) {
    const context = await browser.newContext({ locale: "en-US", viewport: { width: mobile ? 390 : 1280, height: mobile ? 844 : 900 }, isMobile: mobile, hasTouch: mobile });
    contexts.push(context);
  }
  try {
    const desktop = await contexts[0].newPage();
    await useMember(desktop, "ui_chat_reader@example.com", "/v/chat-layout/chat"); await waitForClientRoute(desktop);
    const ownId = await desktop.locator("[data-chat-message]").filter({ hasText: "Own layout message" }).getAttribute("data-chat-message");
    const own = desktop.locator(`[data-chat-message="${ownId}"]`);
    const actions = own.locator("[data-chat-actions]");
    const composer = desktop.getByLabel(m.village_chat_body, { exact: true });
    await expect(composer).toBeInViewport();
    await expect(actions).toHaveCSS("opacity", "0");
    await own.hover(); await expect(actions).toHaveCSS("opacity", "1");
    await desktop.mouse.move(0, 0);
    // Focus on the message alone (as when a link with its address is followed) does not open its actions over the text; Tab moves into them.
    await own.focus(); await expect(actions).toHaveCSS("opacity", "0");
    await desktop.keyboard.press("Tab");
    await expect(actions).toHaveCSS("opacity", "1");
    await expect(own.locator("summary").filter({ hasText: m.village_chat_edit })).toHaveText(m.village_chat_edit);
    await expect(own.locator("summary").filter({ hasText: m.village_chat_edit })).toBeFocused();
    await desktop.keyboard.press("Enter");
    await own.getByLabel(m.village_chat_edit, { exact: true }).fill("Keyboard edited layout message");
    await own.getByRole("button", { name: m.save_changes, exact: true }).click();
    await expect(own.locator("details").first()).not.toHaveAttribute("open", "");
    const otherMessage = desktop.locator("[data-chat-message]").filter({ hasText: "Layout message 1:" }); await otherMessage.hover();
    const report = otherMessage.getByText(m.chat_reports_flag, { exact: true });
    await expect(report).toBeVisible();
    await report.click();
    await expect(desktop.getByRole("dialog", { name: m.chat_reports_flag, exact: true }).getByLabel(m.flag_note, { exact: true })).toBeVisible();

    const touch = await contexts[1].newPage();
    await useMember(touch, "ui_chat_reader@example.com", "/v/chat-layout/chat"); await waitForClientRoute(touch);
    const touched = touch.locator(`[data-chat-message="${ownId}"]`);
    await touched.getByRole("paragraph").filter({ hasText: "Keyboard edited layout message" }).tap();
    await expect(touched.locator("[data-chat-actions]")).toHaveCSS("opacity", "1");
    await touched.locator("summary").filter({ hasText: m.village_chat_edit }).tap();
    await expect(touched.getByLabel(m.village_chat_edit, { exact: true })).toBeVisible();
    await touched.getByLabel(m.village_chat_edit, { exact: true }).fill("Touch edited layout message");
    await touched.getByRole("button", { name: m.save_changes, exact: true }).tap();
    const field = touch.getByLabel(m.village_chat_body, { exact: true });
    await field.focus();
    // Emulate a keyboard shrinking and panning the visual viewport, independently of the layout viewport.
    await touch.evaluate(() => {
      const viewport = window.visualViewport!;
      Object.defineProperty(viewport, "height", { configurable: true, value: innerHeight * 0.55 });
      Object.defineProperty(viewport, "offsetTop", { configurable: true, value: innerHeight * 0.1 });
      viewport.dispatchEvent(new Event("resize")); viewport.dispatchEvent(new Event("scroll"));
    });
    await expect.poll(() => field.evaluate(element => {
      const rect = element.getBoundingClientRect(), viewport = window.visualViewport!;
      return rect.top >= viewport.offsetTop && rect.bottom <= viewport.offsetTop + viewport.height;
    })).toBe(true);
    await touch.evaluate(() => {
      const viewport = window.visualViewport!;
      Reflect.deleteProperty(viewport, "height"); Reflect.deleteProperty(viewport, "offsetTop");
      viewport.dispatchEvent(new Event("resize"));
    });
    await field.fill("Hello @ui_chat_");
    const suggestion = touch.getByRole("option", { name: "@ui_chat_author", exact: true });
    await expect(suggestion).toBeInViewport();
    await suggestion.tap();
    await expect(field).toHaveValue("Hello @ui_chat_author ");
    await field.fill("A message sent from the fixed composer");
    await touch.getByRole("button", { name: m.village_chat_send, exact: true }).tap();
    await expect(field).toHaveValue("");
    await expect(touch.getByRole("log").getByRole("paragraph").filter({ hasText: "A message sent from the fixed composer" })).toBeVisible();
    const edited = touch.locator("[data-chat-message]").filter({ hasText: "Touch edited layout message" });
    await edited.getByRole("paragraph").filter({ hasText: "Touch edited layout message" }).tap();
    await edited.locator("summary").filter({ hasText: m.village_chat_delete }).tap();
    await edited.getByRole("button", { name: m.delete_confirm, exact: true }).tap();
    await expect(edited).toHaveCount(0);
    await touch.getByRole("link", { name: m.village_posts_tab, exact: true }).click();
    await expect(touch.locator("[data-chat-composer]")).toHaveCount(0);
    expect(await touch.evaluate(() => document.body.style.paddingBottom)).toBe("");
  } finally { for (const context of contexts) await context.close(); }
});


test("without JavaScript chat keeps its village tabs and native read action", async ({ browser }) => {
  for (const width of [1280, 390]) {
    const context = await browser.newContext({ javaScriptEnabled: false, locale: "en-US", viewport: { width, height: width === 390 ? 844 : 900 } });
    try {
      const page = await context.newPage();
      await useMember(page, "ui_chat_footer@example.com", "/v/chat-footer/chat");
      await expect(page.locator("footer")).toHaveCount(0);
      await page.getByRole("button", { name: m.village_chat_mark_read, exact: true }).press("Enter");
      await expect(page.getByRole("log")).toBeVisible();
      await page.getByRole("link", { name: m.village_posts_tab, exact: true }).click();
      await expect(page).toHaveURL(/\/v\/chat-footer$/);
      await expect(page.locator("footer")).toBeVisible();
    } finally { await context.close(); }
  }
});

test("an open message editor remains visible and usable after focus moves outside", async ({ page }) => {
  await useMember(page, "ui_chat_draft@example.com", "/v/chat-draft/chat"); await waitForClientRoute(page);
  const message = page.locator("[data-chat-message]");
  await message.hover(); await message.locator("summary").filter({ hasText: m.village_chat_edit }).click();
  const editor = message.getByLabel(m.village_chat_edit, { exact: true });
  await editor.fill("A draft kept while focus moves away");
  await page.getByLabel(m.village_chat_body, { exact: true }).click();
  const actions = message.locator("[data-chat-actions]");
  await expect(actions).toHaveCSS("opacity", "1");
  await expect(actions).toHaveCSS("pointer-events", "auto");
  await expect(editor).toHaveValue("A draft kept while focus moves away");
  await editor.click();
  await message.getByRole("button", { name: m.save_changes, exact: true }).click();
  await expect(message.getByRole("paragraph").filter({ hasText: "A draft kept while focus moves away" })).toBeVisible();
});
