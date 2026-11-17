import fs from "node:fs";
import { test, expect, openUserMenu, state, useMember, watchCsp } from "./helpers";
import { enMessages, waitForClientRoute } from "../e2e/helpers";
import { beforeHydration } from "../e2e/support/prehydration";

const enabled = process.env.E2E_GOOGLE_LOGIN === "1";

test("Google entrypoints and privacy text follow the feature flag without pre-button Google traffic", async ({ page }) => {
  const external: string[] = [];
  await page.route("**/*", route => {
    const url = new URL(route.request().url());
    if (url.origin === state().baseURL) return route.continue();
    external.push(url.hostname); return route.abort();
  });
  const csp = await watchCsp(page);
  for (const path of ["/login", new URL(state().invites["google_invitee@example.com"]).pathname]) {
    await page.goto(path);
    await expect(page.getByRole("button", { name: enMessages.google_continue, exact: true })).toHaveCount(enabled ? 1 : 0);
  }
  await page.goto("/privacy?lang=en");
  await expect(page.getByRole("heading", { name: /Google sign-in/ })).toHaveCount(enabled ? 1 : 0);
  expect(external).toEqual([]);
  expect(csp.violations).toEqual([]); expect(csp.pageErrors).toEqual([]);
  expect(csp.hydrationWarnings).toEqual([]);
  await useMember(page, "google_controls@example.com"); await page.goto("/settings");
  await expect(page.locator("#settings-google")).toHaveCount(enabled ? 1 : 0);
  await expect(page.getByRole("button", { name: enMessages.google_connect, exact: true })).toHaveCount(enabled ? 1 : 0);
  if (!enabled) {
    expect((await page.request.post("/api/auth/sign-in/social", { data: { provider: "google" } })).status()).toBe(404);
    expect((await page.request.get("/api/auth/callback/google?state=fixture&code=fixture")).status()).toBe(404);
  }
});

test("Google navigation sends no invitation Referer and cancellation preserves email fallback", async ({ page }, testInfo) => {
  test.skip(!enabled);
  let authorization: URL | undefined;
  let referer: string | undefined;
  const contacts: string[] = [];
  page.on("request", request => {
    const url = new URL(request.url());
    if (url.origin !== state().baseURL) contacts.push(url.hostname);
  });
  const invitation = state().invites["google_cancel@example.com"];
  await page.goto(invitation);
  const google = page.getByRole("button", { name: enMessages.google_continue, exact: true });
  await expect(google).toBeVisible();
  expect(contacts).toEqual([]);
  const email = page.getByRole("button", { name: enMessages.invite_submit, exact: true });
  expect(await google.evaluate((button, emailText) => [...document.querySelectorAll<Element>("button")].findIndex(value => value.textContent === emailText) > [...document.querySelectorAll<Element>("button")].indexOf(button), enMessages.invite_submit)).toBe(true);
  const blocked = page.waitForEvent("requestfailed", request => new URL(request.url()).hostname === "accounts.google.com");
  await google.click();
  const attempted = await blocked;
  expect(attempted.failure()?.errorText).toContain("ERR_NAME_NOT_RESOLVED");
  authorization = new URL(attempted.url());
  referer = (await attempted.allHeaders()).referer;
  expect(contacts).toEqual(["accounts.google.com"]);
  expect(referer).toBeUndefined();
  expect(authorization!.searchParams.get("scope")).toBe("openid email");
  expect(authorization!.searchParams.get("code_challenge_method")).toBe("S256");
  expect(authorization!.searchParams.has("nonce")).toBe(false);
  expect(authorization!.searchParams.has("login_hint")).toBe(false);
  await page.goto(`${state().baseURL}/api/auth/callback/google?error=access_denied&state=${authorization!.searchParams.get("state")}`);
  await expect(page.getByRole("alert")).toContainText(enMessages.google_failed);
  await expect(page).toHaveURL(/\/invite\?google=1&error=access_denied$/);
  await expect(page.getByRole("alert")).toContainText("g***@example.com");
  await expect(email).toBeVisible();
  const log = fs.readFileSync(state().serverLog, "utf8");
  expect(log).not.toContain(new URL(invitation).pathname.split("/").at(-1)!);
  expect(log).not.toContain("google_cancel@example.com");
  await page.getByRole("button", { name: enMessages.invite_submit, exact: true }).click();
  await expect(page.getByRole("heading", { name: enMessages.login_code_heading, exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("google-login.png"), fullPage: true });
});

for (const ua of ["Line/15.0", "FBAN/FBIOS;FBAV/1", "Messenger/1", "Instagram 300", "LinkedInApp LIAPP/1", "KAKAOTALK 26.1", "Mozilla/5.0 (Linux; Android 15; Pixel 9; wv) AppleWebKit/537.36 Version/4.0 Chrome/140.0 Mobile Safari/537.36"]) {
  test(`embedded browser ${ua} offers URL copying and email instead of Google`, async ({ browser }) => {
    test.skip(!enabled);
    const context = await browser.newContext({ userAgent: ua, baseURL: state().baseURL, javaScriptEnabled: false });
    const page = await context.newPage();
    try {
      for (const path of ["/login", state().invites["google_invitee@example.com"]]) {
        await page.goto(new URL(path, state().baseURL).toString());
        await expect(page.getByText(enMessages.google_open_browser, { exact: true })).toBeVisible();
        await expect(page.getByRole("button", { name: enMessages.google_copy_url, exact: true })).toBeVisible();
        await expect(page.getByRole("button", { name: enMessages.google_continue, exact: true })).toHaveCount(0);
      }
      await useMember(page, "google_controls@example.com"); await page.goto("/settings");
      await expect(page.locator("#settings-google [data-google-browser-note]")).toBeVisible();
      await expect(page.locator("#settings-google .google-login-form")).toHaveCount(0);
    } finally { await context.close(); }
  });
}

test("initial HTML offers Google on login, invitation and settings without JavaScript", async ({ browser }) => {
  const context = await browser.newContext({ baseURL: state().baseURL, javaScriptEnabled: false });
  const page = await context.newPage();
  try {
    for (const path of ["/login", state().invites["google_invitee@example.com"]]) {
      await page.goto(path);
      await expect(page.getByRole("button", { name: enMessages.google_continue, exact: true })).toHaveCount(enabled ? 1 : 0);
      await expect(page.getByRole("button", { name: enMessages.google_copy_url, exact: true })).toHaveCount(0);
    }
    await useMember(page, "google_controls@example.com"); await page.goto("/settings");
    await expect(page.getByRole("button", { name: enMessages.google_connect, exact: true })).toHaveCount(enabled ? 1 : 0);
    await expect(page.getByRole("button", { name: enMessages.google_copy_url, exact: true })).toHaveCount(0);
  } finally { await context.close(); }
});

for (const javaScriptEnabled of [false, true]) {
  test(`standalone CSS shows browser guidance with JavaScript ${javaScriptEnabled ? "enabled" : "disabled"}`, async ({ browser }) => {
    test.skip(!enabled);
    const context = await browser.newContext({ baseURL: state().baseURL, javaScriptEnabled, permissions: ["clipboard-read", "clipboard-write"] });
    const page = await context.newPage();
    try {
      for (const path of ["/login?next=%2F#ignored", `${state().invites["google_invitee@example.com"]}#ignored`, "/settings#settings-google"]) {
        if (path.startsWith("/settings") && javaScriptEnabled) {
          await useMember(page, "google_controls@example.com");
          await waitForClientRoute(page);
          const menu = await openUserMenu(page);
          const loaded = page.waitForResponse(response => new URL(response.url()).pathname === "/settings.data");
          await menu.getByRole("menuitem", { name: enMessages.nav_settings, exact: true }).click();
          expect((await loaded).ok()).toBe(true);
          await expect(page).toHaveURL(url => url.pathname === "/settings");
        } else {
          if (path.startsWith("/settings")) await useMember(page, "google_controls@example.com");
          await page.goto(path);
        }
        if (javaScriptEnabled) await waitForClientRoute(page);
        const google = page.locator(".google-login");
        await expect(google.locator(".google-login-form")).toBeVisible();
        await expect(google.locator("[data-google-browser-note]")).toBeHidden();
        const height = (await google.boundingBox())!.height;
        // Playwright cannot emulate display-mode. Activate the shipped media
        // rule itself, without duplicating its declarations or using app JS.
        const applied = await page.evaluate(() => {
          let found = false;
          function activate(rules: CSSRuleList) {
            for (const rule of rules) {
              if (rule instanceof CSSMediaRule && /display-mode:\s*standalone/.test(rule.conditionText) && rule.cssText.includes(".google-login-form")) {
                rule.media.mediaText = "all"; found = true;
              } else if ("cssRules" in rule) activate((rule as CSSGroupingRule).cssRules);
            }
          }
          for (const sheet of document.styleSheets) activate(sheet.cssRules);
          return found;
        });
        expect(applied).toBe(true);
        await expect(google.locator(".google-login-form")).toBeHidden();
        await expect(google.locator("[data-google-browser-note]")).toBeVisible();
        // Role lookup excludes the display:none branch from accessibility.
        await expect(google.getByRole("button", { name: /Google/ })).toHaveCount(0);
        expect(Math.abs((await google.boundingBox())!.height - height)).toBeLessThanOrEqual(1);
        if (javaScriptEnabled) {
          await google.getByRole("button", { name: enMessages.google_copy_url, exact: true }).click();
          const expected = new URL(page.url()); expected.hash = "";
          expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(expected.href);
        }
      }
    } finally { await context.close(); }
  });
}

test("settings retain Google and adjacent control positions across hydration", async ({ page }, testInfo) => {
  test.skip(!enabled);
  await useMember(page, "google_controls@example.com");
  const csp = await watchCsp(page);
  const positions = () => page.evaluate(() => {
    // Other settings above this area replace their native fallback controls.
    // Measure from the preceding section to isolate movement caused by Google.
    const anchor = document.querySelector("#settings-passkeys")!.getBoundingClientRect().bottom;
    return ["#settings-google", "#settings-sessions", "#settings-advanced > summary"].map(selector => {
      const rect = document.querySelector(selector)!.getBoundingClientRect();
      return { selector, top: rect.top - anchor, height: rect.height };
    });
  });
  let before: Awaited<ReturnType<typeof positions>> = [];
  await beforeHydration(page, "/settings", async () => {
    await expect(page.locator(".google-login-form button")).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    before = await positions();
  });
  const after = await positions();
  await testInfo.attach("google-hydration-positions", { body: JSON.stringify({ before, after }, null, 2), contentType: "application/json" });
  for (let i = 0; i < before.length; i++) {
    expect(Math.abs(after[i].top - before[i].top), before[i].selector).toBeLessThanOrEqual(1);
    expect(Math.abs(after[i].height - before[i].height), before[i].selector).toBeLessThanOrEqual(1);
  }
  expect(csp.violations).toEqual([]); expect(csp.pageErrors).toEqual([]);
  expect(csp.hydrationWarnings).toEqual([]);
});

test("settings show connection date and allow disconnecting while retaining email login", async ({ page }) => {
  test.skip(!enabled);
  await useMember(page, "google_disconnect@example.com"); await page.goto("/settings");
  const section = page.locator("#settings-google");
  await expect(section).toContainText(/Connected on \d{4}-\d{2}-\d{2}/);
  await section.getByRole("button", { name: enMessages.google_disconnect, exact: true }).click();
  await expect(section).toContainText(enMessages.google_not_connected);
  await expect(section.getByRole("button", { name: enMessages.google_connect, exact: true })).toBeVisible();
});

test("a missing invitation cookie asks the visitor to reopen the email link", async ({ page }) => {
  test.skip(!enabled);
  await page.goto(`${state().baseURL}/invite?google=1&error=access_denied`);
  await expect(page.getByText(enMessages.google_invitation_reopen, { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: enMessages.google_continue, exact: true })).toHaveCount(0);
});
