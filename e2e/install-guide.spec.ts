import { devices, expect, type Page } from "@playwright/test";
import { test } from "./editor-fixture";
import { captureScreenshot, clientHeaders, state, uiMessages, useMember, waitForClientRoute } from "./helpers";
import { INSTALL_GUIDE_DISMISSED } from "../app/lib/install-guide";

const iphone = { ...devices["iPhone 13"], viewport: { width: 390, height: 844 }, locale: "ja-JP" };
const android = { ...devices["Pixel 5"], viewport: { width: 390, height: 844 }, locale: "ja-JP" };
const guide = (page: Page) => page.locator("[data-install-guide]");
async function ready(page: Page) { await waitForClientRoute(page); }
async function offerInstall(page: Page, outcome: "accepted" | "dismissed" = "dismissed") {
  await page.evaluate(outcome => {
    const event = new Event("beforeinstallprompt", { cancelable: true });
    Object.assign(event, { prompt: async () => {
      document.documentElement.dataset.installPrompt = String(Number(document.documentElement.dataset.installPrompt ?? "0") + 1);
      document.documentElement.dataset.installGesture = String(navigator.userActivation.isActive);
      return { outcome };
    } });
    window.dispatchEvent(event);
  }, outcome);
}
async function evidence(page: Page, file: string) {
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await captureScreenshot(page, { path: file, fullPage: false }, ".");
}
async function withinViewport(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

test("iOS steps expand, dismissal persists, and only an inside focus moves", async ({ browser }) => {
  const context = await browser.newContext({ ...iphone, extraHTTPHeaders: clientHeaders("10.219.0.1") });
  try {
    const page = await context.newPage();
    await useMember(page, "install_guide_ios@example.com"); await ready(page);
    const m = await uiMessages(page);
    await expect(guide(page)).toBeVisible();
    const steps = guide(page).getByRole("button", { name: m.install_guide_steps, exact: true });
    await expect(steps).toHaveAttribute("aria-expanded", "false");
    await evidence(page, "after-home-iphone.png");
    await steps.click();
    await expect(steps).toHaveAttribute("aria-expanded", "true");
    await expect(guide(page).getByRole("listitem")).toHaveCount(3);
    await withinViewport(page);
    await evidence(page, "after-home-steps-iphone.png");
    const close = guide(page).getByRole("button", { name: m.install_guide_dismiss, exact: true });
    const box = await close.boundingBox();
    expect(box!.width).toBeGreaterThanOrEqual(44); expect(box!.height).toBeGreaterThanOrEqual(44);
    await close.focus(); await page.keyboard.press("Enter");
    await expect(guide(page)).toHaveCount(0);
    expect(await page.evaluate(() => document.activeElement?.closest("main") !== null)).toBe(true);
    expect(await page.evaluate(() => localStorage.getItem("tomola:install-guide-dismissed"))).toBe("1");
    await page.reload(); await ready(page);
    await expect(guide(page)).toHaveCount(0);
    await page.evaluate(key => localStorage.removeItem(key), INSTALL_GUIDE_DISMISSED);
    await page.reload(); await ready(page); await expect(guide(page)).toBeVisible();
    const outside = page.locator('main a[href]').first();
    await outside.focus();
    await guide(page).getByRole("button", { name: m.install_guide_dismiss, exact: true }).evaluate(button => (button as HTMLButtonElement).click());
    await expect(guide(page)).toHaveCount(0); await expect(outside).toBeFocused();
    await page.goto("/settings#settings-install"); await ready(page);
    await expect(page.locator("#settings-install").getByRole("listitem")).toHaveCount(3);
    await page.locator("#settings-install").scrollIntoViewIfNeeded();
    await evidence(page, "after-settings-iphone.png");
  } finally { await context.close(); }
});

test("Android offers a native prompt only after the event and remembers installation", async ({ browser }) => {
  const context = await browser.newContext({ ...android, extraHTTPHeaders: clientHeaders("10.219.0.2") });
  try {
    const page = await context.newPage();
    await useMember(page, "install_guide_android@example.com"); await ready(page);
    await expect(guide(page)).toHaveCount(0);
    await offerInstall(page);
    const m = await uiMessages(page);
    await expect(guide(page)).toBeVisible(); await withinViewport(page);
    await evidence(page, "after-home-android.png");
    await guide(page).getByRole("button", { name: m.install_guide_add, exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-install-prompt", "1");
    await expect(page.locator("html")).toHaveAttribute("data-install-gesture", "true");
    await expect(guide(page)).toHaveCount(0);
    await offerInstall(page);
    await expect(guide(page)).toBeVisible();
    await page.evaluate(() => window.dispatchEvent(new Event("appinstalled")));
    await expect(guide(page)).toHaveCount(0);
    await page.reload(); await ready(page); await offerInstall(page);
    await expect(guide(page)).toHaveCount(0);
    await page.goto("/settings#settings-install"); await ready(page); await offerInstall(page);
    const section = page.locator("#settings-install");
    await expect(section.getByRole("button", { name: m.install_guide_add, exact: true })).toBeVisible();
    await section.scrollIntoViewIfNeeded(); await evidence(page, "after-settings-android.png");
    await section.getByRole("button", { name: m.install_guide_add, exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-install-prompt", "1");
  } finally { await context.close(); }
});

test("desktop width changes do not enable the home banner, while settings retain instructions", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, extraHTTPHeaders: clientHeaders("10.219.0.3") });
  try {
    const page = await context.newPage();
    await useMember(page, "install_guide_desktop@example.com"); await ready(page); await offerInstall(page);
    await expect(guide(page)).toHaveCount(0);
    await page.setViewportSize({ width: 1440, height: 900 }); await expect(guide(page)).toHaveCount(0);
    await page.goto("/settings#settings-install"); await ready(page);
    const m = await uiMessages(page);
    await expect(page.locator("#settings-install").getByRole("listitem")).toHaveCount(3);
    await expect(page.getByText(m.install_guide_desktop, { exact: true })).toBeVisible();
  } finally { await context.close(); }
});

test("standalone iOS hides installation guidance and keeps email-code login in the app", async ({ browser }) => {
  const context = await browser.newContext({ ...iphone, extraHTTPHeaders: clientHeaders("10.219.0.4") });
  try {
    await context.addInitScript(() => Object.defineProperty(navigator, "standalone", { value: true, configurable: true }));
    const page = await context.newPage();
    await page.goto("/login"); await ready(page);
    const m = await uiMessages(page);
    await expect(page.locator("[data-ios-login-note]")).toBeVisible();
    await evidence(page, "after-login-standalone-iphone.png"); await withinViewport(page);
    await page.getByLabel(m.login_email, { exact: true }).fill("install_guide_login@example.com");
    await page.getByRole("button", { name: m.login_submit, exact: true }).click();
    await expect(page.getByLabel(m.login_code_label, { exact: true })).toBeVisible();
    await expect(page.locator("[data-ios-login-note]")).toBeVisible();
    await evidence(page, "after-login-code-standalone-iphone.png");
    await context.clearCookies();
    await useMember(page, "install_guide_installed@example.com"); await ready(page);
    await expect(guide(page)).toHaveCount(0);
    // Reauthentication from the home screen also needs the note: a confirmation link opens outside the app.
    await page.goto("/login?reauth=1"); await ready(page);
    await expect(page.locator("[data-ios-login-note]")).toBeVisible();
  } finally { await context.close(); }
});

test("guidance reflows with larger text in both source languages", async ({ browser }) => {
  const context = await browser.newContext({ ...iphone, extraHTTPHeaders: clientHeaders("10.219.0.6") });
  try {
    const page = await context.newPage();
    for (const locale of ["ja", "en"]) {
      await context.addCookies([{ name: "PARAGLIDE_LOCALE", value: locale, url: state().baseURL }]);
      await useMember(page, "install_guide_expanded@example.com"); await ready(page);
      const m = await uiMessages(page);
      await expect(page.locator("html")).toHaveAttribute("lang", locale);
      await guide(page).getByRole("button", { name: m.install_guide_steps, exact: true }).click();
      await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
      expect(await guide(page).evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      await expect(guide(page).getByRole("listitem")).toHaveCount(3);
      await page.goto("/settings#settings-install"); await ready(page);
      await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
      await expect(page.locator("#settings-install")).toBeVisible();
      expect(await page.locator("#settings-install").evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    }
  } finally { await context.close(); }
});

test("a failed native prompt leaves a dismissible recovery message", async ({ browser }) => {
  const context = await browser.newContext({ ...android, extraHTTPHeaders: clientHeaders("10.219.0.7") });
  try {
    const page = await context.newPage();
    await useMember(page, "install_guide_failure@example.com"); await ready(page);
    const m = await uiMessages(page);
    await page.evaluate(() => {
      const event = new Event("beforeinstallprompt", { cancelable: true });
      Object.assign(event, { prompt: () => Promise.reject(new Error("unavailable")) });
      window.dispatchEvent(event);
    });
    await guide(page).getByRole("button", { name: m.install_guide_add, exact: true }).click();
    await expect(guide(page).getByRole("status")).toBeVisible();
    await guide(page).getByRole("button", { name: m.install_guide_dismiss, exact: true }).click();
    await expect(guide(page)).toHaveCount(0);
  } finally { await context.close(); }
});

for (const [name, device] of [["ios", iphone], ["android", android], ["desktop", {}]] as const) {
  test(`anonymous ${name} readers never receive installation guidance`, async ({ browser }) => {
    const context = await browser.newContext({ ...device, extraHTTPHeaders: clientHeaders(`10.219.1.${name === "ios" ? 1 : name === "android" ? 2 : 3}`) });
    try {
      const page = await context.newPage();
      await page.goto("/"); await ready(page); await offerInstall(page);
      await expect(guide(page)).toHaveCount(0);
      await page.goto("/login"); await ready(page);
      await expect(page.locator("[data-ios-login-note]")).toHaveCount(0);
    } finally { await context.close(); }
  });
}

test("settings can install after the home guide was dismissed", async ({ browser }) => {
  const context = await browser.newContext({ ...android, extraHTTPHeaders: clientHeaders("10.219.0.5") });
  try {
    const page = await context.newPage();
    await useMember(page, "install_guide_settings@example.com"); await ready(page);
    await page.evaluate(key => localStorage.setItem(key, "1"), INSTALL_GUIDE_DISMISSED);
    await page.goto("/settings#settings-install"); await ready(page);
    const m = await uiMessages(page);
    const add = page.locator("#settings-install").getByRole("button", { name: m.install_guide_add, exact: true });
    await expect(add).toHaveCount(0);
    await offerInstall(page, "accepted"); await expect(add).toBeVisible(); await add.click();
    await expect(page.locator("html")).toHaveAttribute("data-install-prompt", "1");
    await expect(add).toHaveCount(0);
    await page.goto("/"); await ready(page); await expect(guide(page)).toHaveCount(0);
  } finally { await context.close(); }
});
