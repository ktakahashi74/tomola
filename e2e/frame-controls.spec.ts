import { expect, test } from "@playwright/test";
import { enMessages as m, openUserMenu, openPlaces, closePlaces, useMember, waitForClientRoute, chooseEditorMode, openPostSettings } from "./helpers";

test("new-post tools keep undo, redo and an accessible image picker, with frontmatter help under writing tips", async ({ page }) => {
  await useMember(page, "frame_controls@example.com", "/t/new"); await waitForClientRoute(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await chooseEditorMode(page, m.editor_mode_rich);
  const editor = page.locator('[contenteditable="true"]'); await expect(editor).toBeVisible();
  await editor.fill("Native source kept through the compact toolbar.");
  const toolbar = page.getByRole("toolbar", { name: m.editor_toolbar, exact: true });
  // On this narrow screen undo and redo are behind "…".
  await page.getByRole("button", { name: m.editor_more, exact: true }).click();
  for (const label of [m.editor_undo, m.editor_redo, m.media_insert]) await expect(toolbar.getByRole("button", { name: label, exact: true })).toBeAttached();
  const image = toolbar.getByRole("button", { name: m.media_insert, exact: true }); await expect(image.locator("svg")).toHaveCount(1);
  const choosing = page.waitForEvent("filechooser"); await image.click(); await (await choosing).setFiles([]);
  await chooseEditorMode(page, m.editor_mode_markdown);
  await expect(page.getByRole("textbox", { name: m.field_body, exact: true })).toHaveValue("Native source kept through the compact toolbar.\n");
  await page.locator("[data-writing-tips] > summary").click();
  // Writing help covers Markdown and math, and links to the connection page.
  await expect(page.locator("[data-writing-tips]").getByText(m.writing_math_help, { exact: true })).toBeVisible();
  const connect = page.locator("[data-writing-tips]").getByRole("link", { name: m.footer_connect, exact: true });
  await expect(connect).toHaveAttribute("href", "/connect");
  await expect(connect).toHaveAttribute("target", "_blank");
  await openPostSettings(page);
  await expect(page.getByText(m.village_public_reach, { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: new RegExp(`^${m.field_village}\\b`) })).toHaveAccessibleDescription(m.village_public_reach);
});

test("navigation keeps its destinations with one footer and no duplicate mobile menu entries", async ({ page, browser }) => {
  await useMember(page, "frame_navigation@example.com", "/"); await waitForClientRoute(page);
  await page.setViewportSize({ width: 390, height: 844 });
  // Following is a place in the drawer, not an entry of the header row or of the member menu.
  await expect((await openPlaces(page)).getByRole("link", { name: m.nav_following, exact: true })).toHaveAttribute("href", "/following");
  await closePlaces(page);
  const menu = await openUserMenu(page);
  await expect(menu.getByRole("menuitem", { name: m.nav_following, exact: true })).toBeHidden();
  await expect(menu.getByRole("menuitem", { name: m.villages_title, exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(menu).not.toBeVisible();
  await expect((await openPlaces(page)).getByRole("link", { name: m.nav_all_villages, exact: true })).toHaveAttribute("href", "/villages");
  for (const label of [m.nav_glossary, m.nav_moderation_log, m.footer_principles, m.footer_why]) await expect(page.locator("footer").getByRole("link", { name: label, exact: true })).toBeVisible();
  const guest = await browser.newPage({ viewport: { width: 390, height: 844 } });
  try {
    await guest.goto("/"); await expect(guest.locator("header").getByRole("combobox", { name: m.language_select, exact: true })).toBeVisible();
    await expect(guest.locator("header").getByText(m.language_select, { exact: true })).toHaveCount(0);
    for (const label of [m.footer_principles, m.footer_why]) await expect(guest.locator("footer").getByRole("link", { name: label, exact: true })).toBeVisible();
  } finally { await guest.close(); }
});

test("passkey guidance stays on home and settings and can still be deferred", async ({ page }) => {
  await useMember(page, "frame_passkey@example.com", "/"); await waitForClientRoute(page);
  await expect(page.getByText(m.passkey_prompt, { exact: true })).toBeVisible();
  await page.goto("/settings"); await expect(page.getByText(m.passkey_prompt, { exact: true })).toBeVisible();
  for (const path of ["/t/new", "/notifications", "/settings/tokens"]) {
    await page.goto(path); await waitForClientRoute(page); await expect(page.getByText(m.passkey_prompt, { exact: true })).toHaveCount(0);
  }
  await page.goto("/u/frame_passkey"); await page.getByRole("link", { name: /Passkey prompt scope/ }).click();
  await expect(page.getByText(m.passkey_prompt, { exact: true })).toHaveCount(0);
  await page.goto("/settings"); await waitForClientRoute(page);
  await page.getByRole("button", { name: m.passkey_prompt_later, exact: true }).click();
  await expect(page.getByText(m.passkey_prompt, { exact: true })).toHaveCount(0);
  await page.goto("/"); await expect(page.getByText(m.passkey_prompt, { exact: true })).toHaveCount(0);
});

test("opening a notification without scripts marks it read and preserves the bulk action", async ({ page, browser }) => {
  await useMember(page, "frame_notice_reader@example.com", "/notifications");
  const context = await browser.newContext({ javaScriptEnabled: false, locale: "en-US", storageState: await page.context().storageState() });
  try {
    const native = await context.newPage(); await native.goto("/notifications");
    const item = native.locator('li[id^="n-"]').filter({ hasText: "frame reader" });
    await expect(item.getByText(m.notification_unread, { exact: true })).toBeVisible();
    await expect(native.getByRole("button", { name: m.notifications_mark_all, exact: true })).toBeVisible();
    await expect(item.locator('input[name="intent"][value="read"]')).toHaveCount(0);
    const link = item.getByRole("link");
    await expect(link).toHaveAttribute("href", /^\/notifications\/\d+\/open$/);
    const opened = context.waitForEvent("page");
    await link.click({ modifiers: ["ControlOrMeta"] });
    const tab = await opened; await expect(tab).toHaveURL(/\/t\/\d+#c-\d+$/); await tab.close();
    await native.goto("/notifications"); await expect(item.getByText(m.notification_unread, { exact: true })).toHaveCount(0);
  } finally { await context.close(); }
});
