import fs from "node:fs";
import path from "node:path";
import { expect } from "@playwright/test";
import { test } from "./editor-fixture";
import { captureScreenshot, clientHeaders, enMessages as m, logSize, loginCodeFor, openUserMenu, state, useMember, waitForClientRoute } from "./helpers";
import { enableSigningAuthenticator } from "./signing-helper";

const clock = () => path.join(state().dir, "server-clock.txt");

for (const target of ["home", "settings"] as const) {
  test(`passkey return to ${target} focuses registration when automatic creation is refused`, async ({ browser }) => {
    test.setTimeout(120_000);
    const email = `pkreturn_${target}@example.com`;
    const context = await browser.newContext({ extraHTTPHeaders: clientHeaders(target === "home" ? "10.31.1.1" : "10.31.1.2") });
    let attempts = 0;
    await context.exposeBinding("recordPasskeyCreation", () => { attempts++; });
    await context.addInitScript(() => {
      const create = navigator.credentials.create.bind(navigator.credentials);
      navigator.credentials.create = async options => {
        await (window as unknown as { recordPasskeyCreation(): Promise<void> }).recordPasskeyCreation();
        if (!sessionStorage.getItem("passkey-activation-refused")) {
          sessionStorage.setItem("passkey-activation-refused", "1");
          throw new DOMException("A user gesture is required", "NotAllowedError");
        }
        return create(options);
      };
    });
    try {
      const page = await context.newPage();
      const authenticator = await enableSigningAuthenticator(page);
      await useMember(page, email);
      fs.writeFileSync(clock(), String(90_000_000));
      const destination = target === "home" ? "/?lang=en" : "/settings?returnTo=%2Ffollowing#settings-passkeys";
      await page.goto(destination);
      await waitForClientRoute(page);
      const scope = target === "home" ? page.getByRole("region", { name: m.passkey_prompt_register, exact: true }) : page.locator("#settings-passkeys");
      const label = target === "home" ? m.passkey_prompt_register : m.settings_passkeys_add;
      await scope.getByRole("link", { name: label, exact: true }).click();
      await expect(page).toHaveURL(url => url.pathname === "/login" && url.searchParams.get("reauth") === "1");
      const since = logSize();
      await page.getByRole("button", { name: m.reauth_submit, exact: true }).click();
      await page.getByLabel(m.login_code_label, { exact: true }).fill(await loginCodeFor(email, since));
      await page.getByRole("button", { name: m.login_code_submit, exact: true }).click();
      const register = scope.getByRole("button", { name: label, exact: true });
      await expect(register).toBeFocused();
      await expect(scope.getByRole("alert")).toHaveCount(0);
      await expect(page).toHaveURL(new URL(destination, state().baseURL).href);
      await expect(page.locator('a[href*="passkey=continue"]')).toHaveCount(0);
      expect(attempts).toBe(1);
      for (const width of [1280, 1100, 390]) {
        await page.setViewportSize({ width, height: 900 });
        await register.scrollIntoViewIfNeeded();
        await captureScreenshot(page, { fullPage: false }, `passkey-${target}-after-${width}`);
      }
      if (target === "home") {
        await expect(register).toHaveClass(/(?:^|\s)ring-3(?:\s|$)/);
        await (await openUserMenu(page)).getByRole("menuitem", { name: m.nav_settings, exact: true }).click();
        await waitForClientRoute(page);
        await expect(register).not.toHaveClass(/(?:^|\s)ring-3(?:\s|$)/);
        await page.locator("header").getByRole("link", { name: m.site_name, exact: true }).click();
        await waitForClientRoute(page);
        await expect(register).not.toHaveClass(/(?:^|\s)ring-3(?:\s|$)/);
      }
      // Replacing the history entry prevents another automatic request on
      // reload and when coming back from a different screen.
      await page.reload();
      await waitForClientRoute(page);
      await page.goto("/following");
      await page.goBack();
      await waitForClientRoute(page);
      expect(attempts).toBe(1);
      await register.click();
      await expect(target === "home" ? page.getByText(m.passkey_prompt_success, { exact: true }) : scope.getByRole("status")).toContainText(target === "home" ? m.passkey_prompt_success : m.settings_passkeys_added);
      expect(attempts).toBe(2);
      expect((await authenticator.client.send("WebAuthn.getCredentials", { authenticatorId: authenticator.authenticatorId })).credentials).toHaveLength(1);
      if (target === "settings") await expect(page.getByRole("button", { name: m.passkey_prompt_register, exact: true })).toHaveCount(0);
    } finally { fs.writeFileSync(clock(), "0"); await context.close(); }
  });
}

for (const condition of ["stale", "deferred", "existing"] as const) {
  test(`a passkey return marker does not register for a ${condition} home notice`, async ({ browser }) => {
    const context = await browser.newContext({ extraHTTPHeaders: clientHeaders(`10.31.2.${["stale", "deferred", "existing"].indexOf(condition) + 1}`) });
    try {
      const page = await context.newPage();
      await enableSigningAuthenticator(page);
      await useMember(page, `pkreturn_${condition}@example.com`);
      await waitForClientRoute(page);
      if (condition === "deferred") {
        await page.getByRole("button", { name: m.passkey_prompt_later, exact: true }).click();
        await (await openUserMenu(page)).getByRole("menuitem", { name: m.nav_drafts, exact: true }).click();
        await waitForClientRoute(page);
        await page.locator("header").getByRole("link", { name: m.site_name, exact: true }).click();
        await waitForClientRoute(page);
        await expect(page.getByRole("region", { name: m.passkey_prompt_register, exact: true })).toHaveCount(0);
      }
      if (condition === "existing") {
        await page.getByRole("button", { name: m.passkey_prompt_register, exact: true }).click();
        await expect(page.getByText(m.passkey_prompt_success, { exact: true })).toBeVisible();
      }
      if (condition === "stale") fs.writeFileSync(clock(), String(90_000_000));
      let requests = 0;
      page.on("request", request => { if (new URL(request.url()).pathname === "/passkeys") requests++; });
      await page.goto("/?passkey=continue");
      await waitForClientRoute(page);
      if (condition === "stale") {
        await expect(page.getByRole("link", { name: m.passkey_prompt_register, exact: true })).toBeVisible();
        await page.goto("/settings?passkey=continue-settings#settings-passkeys");
        await waitForClientRoute(page);
        await expect(page.locator("#settings-passkeys").getByRole("link", { name: m.settings_passkeys_add, exact: true })).toBeVisible();
      } else await expect(page.getByRole("region", { name: m.passkey_prompt_register, exact: true })).toHaveCount(0);
      expect(requests).toBe(0);
    } finally { fs.writeFileSync(clock(), "0"); await context.close(); }
  });
}

test("dismissing the home notice while the return loads prevents registration", async ({ browser }) => {
  const context = await browser.newContext({ extraHTTPHeaders: clientHeaders("10.31.3.1") });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  try {
    const page = await context.newPage();
    await enableSigningAuthenticator(page);
    await useMember(page, "pkreturn_defer_loading@example.com");
    await waitForClientRoute(page);
    let loading!: () => void;
    const started = new Promise<void>(resolve => { loading = resolve; });
    await page.route("**/*.data*", async route => {
      const url = new URL(route.request().url());
      if (url.pathname === "/_.data" && url.searchParams.get("order") === "activity" && !url.searchParams.has("passkey")) {
        loading();
        await gate;
      }
      await route.continue();
    });
    let requests = 0;
    page.on("request", request => { if (new URL(request.url()).pathname === "/passkeys") requests++; });
    await page.goto("/?order=activity&passkey=continue");
    await started;
    await page.getByRole("button", { name: m.passkey_prompt_later, exact: true }).click();
    release();
    await waitForClientRoute(page);
    await expect(page).toHaveURL(url => !url.searchParams.has("passkey"));
    await expect(page.getByRole("region", { name: m.passkey_prompt_register, exact: true })).toHaveCount(0);
    expect(requests).toBe(0);
  } finally { release(); await context.close(); }
});
