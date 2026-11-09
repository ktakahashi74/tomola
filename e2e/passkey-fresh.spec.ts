import fs from "node:fs";
import path from "node:path";
import { expect, type BrowserContext, type Page } from "@playwright/test";
import { test } from "./editor-fixture";
import { captureScreenshot, clientHeaders, enMessages as m, logSize, loginCodeFor, loginWithMagicLink, state, useMember, waitForClientRoute } from "./helpers";

// An older session cannot add a passkey. These scenarios age the member's
// session by moving the test server's clock, then check that registration
// first re-verifies by email and that the new session can register.
const DAY = 86_400_000;
const clock = () => path.join(state().dir, "server-clock.txt");
const ageSessions = () => fs.writeFileSync(clock(), String(DAY + 3_600_000));
const restoreClock = () => fs.writeFileSync(clock(), "0");

async function authenticator(context: BrowserContext, page: Page) {
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
}

async function reverify(page: Page, email: string, link = false) {
  await expect(page).toHaveURL(url => url.pathname === "/login" && url.searchParams.get("reauth") === "1");
  await expect(page.getByRole("heading", { level: 1, name: m.reauth_title, exact: true })).toBeVisible();
  // The address is the member's own, shown and not editable.
  await expect(page.getByLabel(m.login_email, { exact: true })).toHaveValue(email);
  if (link) {
    await loginWithMagicLink(page, email);
    return;
  }
  const since = logSize();
  await page.getByRole("button", { name: m.reauth_submit, exact: true }).click();
  await page.getByLabel(m.login_code_label, { exact: true }).fill(await loginCodeFor(email, since));
  await page.getByRole("button", { name: m.login_code_submit, exact: true }).click();
}

async function openAdvancedSettings(page: Page) {
  const advanced = page.locator("#settings-advanced");
  if (await advanced.count() && await advanced.getAttribute("open") === null) await advanced.locator(":scope > summary").click();
}

test("an older session registers from the home notice after re-verifying by email", async ({ browser }) => {
  test.setTimeout(120_000);
  const email = "pkfresh_home@example.com";
  const context = await browser.newContext({ extraHTTPHeaders: clientHeaders("10.31.0.1") });
  try {
    const page = await context.newPage();
    await useMember(page, email);
    await authenticator(context, page);
    ageSessions();
    await page.goto("/");
    const register = page.getByRole("link", { name: m.passkey_prompt_register, exact: true });
    for (const width of [1280, 1100, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await captureScreenshot(page, { fullPage: false }, `passkey-home-before-${width}`);
    }
    await expect(register).toHaveAttribute("href", "/login?reauth=1&next=%2F%3Fpasskey%3Dcontinue");
    await expect(page.getByRole("button", { name: m.passkey_prompt_register, exact: true })).toHaveCount(0);
    await register.click();
    await reverify(page, email, true);
    await expect(page).toHaveURL(new URL("/", state().baseURL).href);
    await waitForClientRoute(page);
    await expect(page.getByText(m.passkey_prompt_success, { exact: true })).toBeVisible();
  } finally { restoreClock(); await context.close(); }
});

test("an older session adds a passkey from settings after re-verifying by email", async ({ browser }) => {
  test.setTimeout(120_000);
  const email = "pkfresh_settings@example.com";
  const context = await browser.newContext({ extraHTTPHeaders: clientHeaders("10.31.0.2") });
  try {
    const page = await context.newPage();
    await useMember(page, email);
    await authenticator(context, page);
    ageSessions();
    await page.goto("/settings");
    await waitForClientRoute(page);
    await openAdvancedSettings(page);
    const add = page.locator("#settings-passkeys").getByRole("link", { name: m.settings_passkeys_add, exact: true });
    for (const width of [1280, 1100, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await add.scrollIntoViewIfNeeded();
      await captureScreenshot(page, { fullPage: false }, `passkey-settings-before-${width}`);
    }
    await expect(add).toHaveAttribute("href", "/login?reauth=1&next=%2Fsettings%3Fpasskey%3Dcontinue-settings%23settings-passkeys");
    await expect(page.locator("#settings-passkeys").getByRole("button", { name: m.settings_passkeys_add, exact: true })).toHaveCount(0);
    await add.click();
    await reverify(page, email);
    await expect(page).toHaveURL(url => url.pathname === "/settings" && url.hash === "#settings-passkeys");
    await waitForClientRoute(page);
    await openAdvancedSettings(page);
    await expect(page.locator("#settings-passkeys").getByRole("status").filter({ hasText: m.settings_passkeys_added })).toBeVisible();
    await expect(page).toHaveURL(url => !url.searchParams.has("passkey"));
  } finally { restoreClock(); await context.close(); }
});

test("a page opened while the session was fresh sends the member to re-verification when it expires", async ({ browser }) => {
  test.setTimeout(120_000);
  const email = "pkfresh_open@example.com";
  const context = await browser.newContext({ extraHTTPHeaders: clientHeaders("10.31.0.3") });
  try {
    const page = await context.newPage();
    await useMember(page, email);
    await authenticator(context, page);
    await page.goto("/");
    await waitForClientRoute(page);
    await expect(page.getByRole("button", { name: m.passkey_prompt_register, exact: true })).toBeVisible();
    ageSessions();
    await page.getByRole("button", { name: m.passkey_prompt_register, exact: true }).click();
    await expect(page).toHaveURL(url => url.pathname === "/login" && url.searchParams.get("reauth") === "1" && url.searchParams.get("next") === "/?passkey=continue");
    await expect(page.getByRole("heading", { level: 1, name: m.reauth_title, exact: true })).toBeVisible();
  } finally { restoreClock(); await context.close(); }
});
