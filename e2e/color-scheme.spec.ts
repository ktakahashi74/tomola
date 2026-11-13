import { expect, type Page } from "@playwright/test";
import { test } from "./editor-fixture";
import { captureScreenshot, clientHeaders, enMessages as en, state, useMember, waitForClientRoute } from "./helpers";
import { THEME_COLORS, type ColorScheme } from "../app/lib/theme-colors";

async function expectDocumentScheme(page: Page, scheme: ColorScheme | null) {
  const response = await page.request.get(page.url());
  expect(response.ok()).toBe(true);
  const html = (await response.text()).match(/<html\b[^>]*>/)![0];
  if (scheme) {
    expect(html).toContain(`data-color-scheme="${scheme}"`);
    await expect(page.locator("html")).toHaveAttribute("data-color-scheme", scheme);
    await expect(page.locator('meta[name="theme-color"]')).toHaveCount(1);
    await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", THEME_COLORS[scheme]);
    await expect(page.locator('meta[name="theme-color"]')).not.toHaveAttribute("media");
    await expect(page.locator("html")).toHaveCSS("color-scheme", scheme);
  } else {
    expect(html).not.toContain("data-color-scheme");
    await expect(page.locator("html")).not.toHaveAttribute("data-color-scheme");
    await expect(page.locator('meta[name="theme-color"][media]')).toHaveCount(2);
  }
}

test("member appearance persists across pages and devices and returns to matching the device", async ({ browser }) => {
  const context = await browser.newContext({ colorScheme: "light", extraHTTPHeaders: clientHeaders("192.0.2.231") });
  try {
    const page = await context.newPage();
    await context.addCookies([{ name: "PARAGLIDE_LOCALE", value: "en", url: state().baseURL }]);
    await useMember(page, "zpalette_member@example.com", "/settings");
    await waitForClientRoute(page);
    const cookiesBefore = (await context.cookies()).map(cookie => cookie.name).sort();
    const choose = async (value: string) => {
      await page.getByRole("combobox", { name: en.settings_color_scheme, exact: true }).selectOption(value);
      await expect(page.locator("#settings-appearance").getByRole("status")).toHaveText(en.settings_saved);
      await expectDocumentScheme(page, value as ColorScheme || null);
      await waitForClientRoute(page);
    };
    await expectDocumentScheme(page, null);
    await choose("dark");
    for (const width of [1366, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.locator("#settings-appearance").scrollIntoViewIfNeeded();
      await captureScreenshot(page, { path: `settings-dark-${width}.png`, fullPage: true }, "toggle");
    }
    const rootResponse = await page.request.get("/why.data?_routes=root");
    expect(rootResponse.headers()["cache-control"]).toBe("private, no-store");
    await rootResponse.text();
    await page.reload();
    await expectDocumentScheme(page, "dark");
    await page.goto("/");
    await expectDocumentScheme(page, "dark");
    await captureScreenshot(page, { path: "home-dark.png", fullPage: true }, "toggle");

    await page.goto("/t/new");
    await waitForClientRoute(page);
    await page.getByRole("textbox", { name: en.field_title, exact: true }).fill("Appearance account reading fixture");
    await page.getByRole("textbox", { name: en.field_body, exact: true }).fill("A reading page uses the member's saved appearance.\n\n| Item | Value |\n| --- | --- |\n| Paper | Warm |\n\nA formula: $x^2 + y^2 = 1$.");
    await page.getByRole("button", { name: en.submit_post, exact: true }).click();
    await expect(page).toHaveURL(url => /^\/t\/\d+$/.test(url.pathname));
    const articleUrl = page.url();
    await expectDocumentScheme(page, "dark");
    await captureScreenshot(page, { path: "reading-dark.png", fullPage: true }, "toggle");

    const otherDevice = await browser.newContext({ javaScriptEnabled: false, colorScheme: "light", storageState: await context.storageState(), extraHTTPHeaders: clientHeaders("192.0.2.232") });
    try {
      const otherPage = await otherDevice.newPage();
      await otherPage.goto(articleUrl);
      await expectDocumentScheme(otherPage, "dark");
    } finally { await otherDevice.close(); }

    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto("/settings");
    await waitForClientRoute(page);
    await choose("light");
    await captureScreenshot(page, { path: "settings-light-dark-device.png", fullPage: true }, "toggle");
    await page.goto(articleUrl);
    await expectDocumentScheme(page, "light");
    await captureScreenshot(page, { path: "reading-light-dark-device.png", fullPage: true }, "toggle");
    await page.goto("/settings");
    await waitForClientRoute(page);
    await choose("");
    await captureScreenshot(page, { path: "settings-device-dark.png", fullPage: true }, "toggle");
    await page.reload();
    await expectDocumentScheme(page, null);
    expect((await context.cookies()).map(cookie => cookie.name).sort()).toEqual(cookiesBefore);
  } finally { await context.close(); }
});

test("failed appearance saves restore the saved choice and leave the page palette intact", async ({ page }) => {
  await useMember(page, "zpalette_failure@example.com", "/settings");
  await waitForClientRoute(page);
  await page.route("**/settings/save", route => route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ ok: false, error: "invalid_color_scheme" }) }));
  await page.getByRole("combobox", { name: en.settings_color_scheme, exact: true }).selectOption("dark");
  await expect(page.locator("#settings-appearance").getByRole("alert")).toBeVisible();
  await expect(page.getByRole("combobox", { name: en.settings_color_scheme, exact: true })).toHaveValue("");
  await expectDocumentScheme(page, null);
});

test("signed-out readers follow their device without a member appearance control or attribute", async ({ page }) => {
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await page.goto("/");
    await expectDocumentScheme(page, null);
    await expect(page.getByRole("combobox", { name: en.settings_color_scheme, exact: true })).toHaveCount(0);
  }
});
