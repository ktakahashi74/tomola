import fs from "node:fs";
import { test, expect, state, useMember, watchCsp } from "./helpers";
import { enMessages } from "../e2e/helpers";

const enabled = process.env.E2E_GOOGLE_LOGIN === "1";

test("Google entrypoints and privacy text follow the feature flag without pre-button Google traffic", async ({ page }) => {
  const external: string[] = [];
  await page.route("**/*", route => {
    const url = new URL(route.request().url());
    if (url.origin === state().baseURL) return route.continue();
    external.push(url.hostname); return route.abort();
  });
  const csp = await watchCsp(page);
  for (const path of ["/login", new URL(state().invites["mika@example.com"]).pathname]) {
    await page.goto(path);
    await expect(page.getByRole("button", { name: enMessages.google_continue, exact: true })).toHaveCount(enabled ? 1 : 0);
  }
  await page.goto("/privacy?lang=en");
  await expect(page.getByRole("heading", { name: /Google sign-in/ })).toHaveCount(enabled ? 1 : 0);
  expect(external).toEqual([]);
  expect(csp.violations).toEqual([]); expect(csp.pageErrors).toEqual([]);
  expect(csp.hydrationWarnings).toEqual([]);
  await useMember(page, "pat@example.com"); await page.goto("/settings");
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
  const invitation = state().invites["mika@example.com"];
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
  await expect(page.getByRole("alert")).toContainText("m***@example.com");
  await expect(email).toBeVisible();
  const log = fs.readFileSync(state().serverLog, "utf8");
  expect(log).not.toContain(new URL(invitation).pathname.split("/").at(-1)!);
  expect(log).not.toContain("mika@example.com");
  await page.screenshot({ path: testInfo.outputPath("google-login.png"), fullPage: true });
});

for (const ua of ["Line/15.0", "FBAN/FBIOS;FBAV/1", "Messenger/1", "Instagram 300", "LinkedInApp LIAPP/1"]) {
  test(`embedded browser ${ua} offers URL copying and email instead of Google`, async ({ browser }) => {
    test.skip(!enabled);
    const context = await browser.newContext({ userAgent: ua });
    const page = await context.newPage();
    try {
      for (const path of ["/login", state().invites["mika@example.com"]]) {
        await page.goto(new URL(path, state().baseURL).toString());
        await expect(page.getByText(enMessages.google_open_browser, { exact: true })).toBeVisible();
        await expect(page.getByRole("button", { name: enMessages.google_copy_url, exact: true })).toBeVisible();
        await expect(page.getByRole("button", { name: enMessages.google_continue, exact: true })).toHaveCount(0);
      }
    } finally { await context.close(); }
  });
}

for (const mode of ["display-mode", "ios"]) {
  test(`standalone ${mode} hides Google and copies the current URL`, async ({ page, context }) => {
    test.skip(!enabled);
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.addInitScript(mode => {
      if (mode === "ios") Object.defineProperty(navigator, "standalone", { value: true });
      else {
        const match = window.matchMedia.bind(window);
        window.matchMedia = query => {
          const result = match(query);
          if (query === "(display-mode: standalone)") Object.defineProperty(result, "matches", { value: true });
          return result;
        };
      }
    }, mode);
    await page.goto(state().invites["mika@example.com"]);
    await expect(page.getByText(enMessages.google_open_browser, { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: enMessages.google_continue, exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: enMessages.google_copy_url, exact: true }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(page.url());
    await expect(page.getByRole("button", { name: enMessages.invite_submit, exact: true })).toBeVisible();
  });
}

test("settings show connection date and allow disconnecting while retaining email login", async ({ page }) => {
  test.skip(!enabled);
  await useMember(page, "style_preloads_reader@example.com"); await page.goto("/settings");
  const section = page.locator("#settings-google");
  await expect(section).toContainText(/Connected on \d{4}-\d{2}-\d{2}/);
  await section.getByRole("button", { name: enMessages.google_disconnect, exact: true }).click();
  await expect(section).toContainText(enMessages.google_not_connected);
  await expect(section.getByRole("button", { name: enMessages.google_connect, exact: true })).toBeVisible();
});
