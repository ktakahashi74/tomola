import { readingActions } from "./helpers";
import { expect, type Page } from "@playwright/test";
import { test } from "./editor-fixture";
import { captureScreenshot, clientHeaders, closePlaces, loginWithMagicLink, openPlaces, titleField, uiMessages, useMember, waitForClientRoute, waitForFormReady, waitForHydration } from "./helpers";

async function makePost(page: Page, scenario: string, titled = true) {
  await useMember(page, `zsave_${scenario}_author@example.com`, "/t/new");
  const m = await uiMessages(page);
  await waitForFormReady(page.locator("form", { has: titleField(page) }));
  const text = `A post to read later ${scenario}`;
  if (titled) await titleField(page).fill(text);
  await page.getByLabel(m.field_body, { exact: true }).fill(text);
  await page.getByRole("button", { name: m.submit_post, exact: true }).click();
  await expect(page).toHaveURL(/\/t\/\d+(?:\?.*)?$/);
  await expect(page.getByRole("heading", { level: 1, name: text })).toBeVisible();
  return { path: new URL(page.url()).pathname, text };
}

for (const [scenario, width] of [["wide", 1440], ["narrow", 390]] as const) {
  test(`saved posts persist across reload and a second login at ${width}px`, async ({ page, browser }) => {
    await page.setViewportSize({ width, height: 900 });
    const { path, text } = await makePost(page, scenario, scenario === "wide");
    await useMember(page, `zsave_${scenario}_reader@example.com`, `${path}?lang=en`);
    await waitForHydration(page);
    expect((await page.request.get(`${path}.data`)).headers()["cache-control"]).toBe("private, no-store");
    const m = await uiMessages(page);
    const add = (await readingActions(page)).getByRole("button", { name: m.saved_add, exact: true });
    await add.focus();
    await expect(add).toBeFocused();
    const savedResponse = page.waitForResponse(response => /\/save(?:\.data)?$/.test(new URL(response.url()).pathname) && response.request().method() === "POST");
    await page.keyboard.press("Enter");
    expect((await savedResponse).headers()["cache-control"]).toContain("no-store");
    await expect(page.getByRole("button", { name: m.saved_remove, exact: true }).first()).toBeEnabled();
    const reload = await page.reload();
    expect(reload?.headers()["cache-control"]).toContain("no-store");
    await expect((await readingActions(page)).getByRole("button", { name: m.saved_remove, exact: true })).toHaveAttribute("aria-pressed", "true");
    const places = await openPlaces(page);
    await places.getByRole("link", { name: m.saved_title, exact: true }).click();
    await expect(page).toHaveURL(/\/saved$/);
    if (width < 1280) await closePlaces(page);
    const row = page.locator("li.topic-row", { hasText: text });
    await expect(row).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
    if (width === 1440 && await page.locator("[data-site-navigation]").count()) {
      await expect(page.locator('[data-site-navigation] a[href="/saved"]')).toHaveAttribute("aria-current", "page");
    } else {
      await expect((await openPlaces(page)).getByRole("link", { name: m.saved_title, exact: true })).toHaveAttribute("aria-current", "page");
      await closePlaces(page);
    }
    await captureScreenshot(page, { path: `saved-${scenario}.png`, fullPage: true }, "read-later");

    // A fresh browser context performs another real login using fake mail,
    // proving persistence beyond the first browser and its server session.
    const second = await browser.newContext({ extraHTTPHeaders: clientHeaders(`10.91.0.${width === 1440 ? 1 : 2}`) });
    try {
      const other = await second.newPage();
      await other.goto("/login?next=%2Fsaved");
      await test.step("log in again after the email response and code screen are ready", async () => {
        await loginWithMagicLink(other, `zsave_${scenario}_reader@example.com`);
      });
      await expect(other.locator("li.topic-row", { hasText: text })).toBeVisible();
    } finally { await second.close(); }

    await row.getByRole("link", { name: text, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${path}(?:\\?.*)?$`));
    await waitForClientRoute(page);
    await (await readingActions(page)).getByRole("button", { name: m.saved_remove, exact: true }).click();
    await expect(page.getByRole("button", { name: m.saved_add, exact: true }).first()).toBeEnabled();
    await page.goto("/saved?lang=en");
    await expect(page.getByText(m.saved_empty, { exact: true })).toBeVisible();
    if (width === 390) {
      const native = await browser.newContext({ javaScriptEnabled: false, viewport: { width, height: 900 }, storageState: await page.context().storageState(), extraHTTPHeaders: clientHeaders("10.91.0.3") });
      try {
        const reader = await native.newPage();
        await reader.goto(`${path}?lang=en`);
        const end = reader.locator("[data-article-end]");
        await end.getByRole("button", { name: m.saved_add, exact: true }).click();
        await expect(end.getByRole("button", { name: m.saved_remove, exact: true })).toHaveAttribute("aria-pressed", "true");
        await reader.goto("/saved?lang=en");
        const saved = reader.locator("li.topic-row", { hasText: text });
        await expect(saved).toBeVisible();
        await saved.getByRole("link", { name: text, exact: true }).click();
        await end.getByRole("button", { name: m.saved_remove, exact: true }).click();
        await expect(end.getByRole("button", { name: m.saved_add, exact: true })).toHaveAttribute("aria-pressed", "false");
        await reader.goto("/saved?lang=en");
        await expect(reader.getByText(m.saved_empty, { exact: true })).toBeVisible();
      } finally { await native.close(); }
    }
    await useMember(page, `zsave_${scenario}_author@example.com`, "/saved");
    await expect(page.getByText(m.saved_empty, { exact: true })).toBeVisible();
  });
}

test("failed save keeps the unsaved state and can be retried", async ({ page }) => {
  const { path } = await makePost(page, "failure");
  await useMember(page, "zsave_failure_reader@example.com", path);
  await waitForHydration(page);
  const m = await uiMessages(page);
  await page.route("**/save.data", route => {
    const body = new URLSearchParams(route.request().postData() ?? "");
    body.set("saved", "invalid");
    return route.continue({ postData: body.toString() });
  });
  await page.getByRole("button", { name: m.saved_add, exact: true }).first().click();
  await expect(page.getByText(m.saved_failed, { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: m.saved_add, exact: true }).first()).toHaveAttribute("aria-pressed", "false");
  await page.unroute("**/save.data");
  await page.getByRole("button", { name: m.saved_add, exact: true }).first().click();
  await expect(page.getByRole("button", { name: m.saved_remove, exact: true }).first()).toBeEnabled();
  await page.goto("/saved");
  await page.getByRole("button", { name: m.saved_remove, exact: true }).first().click();
  await expect(page.getByText(m.saved_empty, { exact: true })).toBeVisible();
});

test("anonymous readers have no save control or saved-list access", async ({ page, browser }) => {
  const { path } = await makePost(page, "public");
  const guest = await browser.newContext();
  try {
    const anonymous = await guest.newPage();
    const response = await anonymous.goto(path);
    expect(response?.status()).toBe(200);
    expect(response?.headers()["cache-control"]).toBe("private");
    expect((await anonymous.request.get(`${path}.data`)).headers()["cache-control"]).toBe("private");
    const m = await uiMessages(anonymous);
    await expect(anonymous.getByRole("button", { name: m.saved_add, exact: true })).toHaveCount(0);
    await expect(anonymous.getByRole("button", { name: m.saved_remove, exact: true })).toHaveCount(0);
    await anonymous.goto("/saved");
    await expect(anonymous).toHaveURL(/\/login\?/);
  } finally { await guest.close(); }
});
