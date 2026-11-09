import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { enMessages as m, openUserMenu, state, useMember, waitForClientRoute } from "./helpers";

for (const width of [1280, 390]) {
  test(`places drawer dismisses, restores focus and closes on navigation at width ${width}`, async ({ page }) => {
    const { touchId } = JSON.parse(fs.readFileSync(path.join(state().dir, "navigation-disclosure.json"), "utf8"));
    await useMember(page, "nav_dismiss@example.com", width >= 1280 ? `/t/${touchId}` : "/"); await waitForClientRoute(page);
    await page.setViewportSize({ width, height: 844 });
    const menu = page.locator("[data-navigation-drawer]");
    const trigger = menu.locator("summary");
    await trigger.click();
    await expect(menu.getByRole("link").first()).toBeFocused();
    await trigger.click();
    await expect(menu).not.toHaveAttribute("open");
    await trigger.click();
    await expect(menu).toHaveAttribute("open");
    await page.keyboard.press("Escape");
    await expect(menu).not.toHaveAttribute("open");
    await expect(trigger).toBeFocused();
    await trigger.click();
    await expect(menu.getByRole("link").first()).toBeFocused();
    await page.mouse.move(4, 200);
    await page.mouse.down();
    try {
      // Dismiss before a click can be emitted, without focusing the trigger.
      await expect(menu).not.toHaveAttribute("open");
      await expect(trigger).not.toBeFocused();
    } finally { await page.mouse.up(); }
    if (width >= 1280) {
      await trigger.click();
      // Articles have no sidebar or self-link in this menu. Exercise the same-page
      // anchor without navigation: dismissal must come from the click handler.
      await menu.getByRole("link", { name: m.nav_all_villages, exact: true }).evaluate(link => {
        link.setAttribute("href", location.pathname);
        link.addEventListener("click", event => event.preventDefault(), { once: true });
      });
      await menu.getByRole("link", { name: m.nav_all_villages, exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`/t/${touchId}(?:\\?sl=[\\w-]+)?$`));
      await expect(menu).not.toHaveAttribute("open");
    }
    await trigger.click();
    await menu.getByRole("link", { name: m.nav_all_villages, exact: true }).click();
    await expect(page).toHaveURL(/\/villages$/);
    await waitForClientRoute(page);
    await expect(menu).not.toHaveAttribute("open");
    if (width < 1280) {
      await trigger.click();
      // A same-page destination must close too.
      await menu.getByRole("link", { name: m.nav_all_villages, exact: true }).click();
      await waitForClientRoute(page);
      await expect(menu).not.toHaveAttribute("open");
    } else {
      await expect(menu).not.toBeVisible();
      await expect(page.locator("[data-site-navigation]")).toBeVisible();
    }
    const member = await openUserMenu(page);
    await page.keyboard.press("Escape");
    await expect(member).not.toBeVisible();
    await expect(page.locator("[data-member-menu-trigger]")).toBeFocused();
    await openUserMenu(page);
    await page.mouse.click(4, 200);
    await expect(member).not.toBeVisible();
  });
}

test("touch taps dismiss over plain text and preserve summary, internal links and outside actions", async ({ page, browser }) => {
  const { touchId } = JSON.parse(fs.readFileSync(path.join(state().dir, "navigation-disclosure.json"), "utf8"));
  await useMember(page, "nav_touch_menu@example.com");
  const context = await browser.newContext({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 }, storageState: await page.context().storageState() });
  try {
    const touch = await context.newPage(); await touch.goto(`/t/${touchId}`); await waitForClientRoute(touch);
    const menu = touch.locator("[data-navigation-drawer]");
    const trigger = menu.locator("summary");
    await trigger.tap(); await expect(menu).toHaveAttribute("open");
    await trigger.tap(); await expect(menu).not.toHaveAttribute("open");
    await trigger.tap();
    await expect(menu.getByRole("link").first()).toBeFocused();
    // The open panel can cover the start of a short article now that the head is compact: tap the paragraph's right end, which is outside the panel.
    const plainText = touch.getByText("Text outside village navigation.", { exact: true });
    const box = (await plainText.boundingBox())!;
    await plainText.tap({ position: { x: box.width - 12, y: Math.min(10, box.height / 2) } });
    await expect(menu).not.toHaveAttribute("open");
    await expect(trigger).not.toBeFocused();
    await trigger.tap();
    const memberTrigger = touch.locator("[data-member-menu-trigger]");
    await memberTrigger.tap();
    await expect(menu).not.toHaveAttribute("open");
    await expect(touch.locator("[data-member-menu][data-open]")).toBeVisible();
    await expect(trigger).not.toBeFocused();
    await memberTrigger.tap();
    await expect(touch.locator("[data-member-menu][data-open]")).toHaveCount(0);
    await trigger.tap();
    await menu.locator('a[href="/following"]').tap();
    await expect(touch).toHaveURL(/\/following$/); await waitForClientRoute(touch); await expect(menu).not.toHaveAttribute("open");
    await trigger.tap();
    await menu.getByRole("link", { name: m.nav_all_villages, exact: true }).tap();
    await expect(touch).toHaveURL(/\/villages$/); await waitForClientRoute(touch); await expect(menu).not.toHaveAttribute("open");
  } finally { await context.close(); }
});
