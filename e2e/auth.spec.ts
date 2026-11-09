import { hostCookieName } from "./helpers";
import { completeTrialFields } from "./helpers";
import fs from "node:fs";
import { expect, request as playwrightRequest, type APIRequestContext, type BrowserContext, type Page } from "@playwright/test";
import { test } from "./editor-fixture";
import { waitForClientRoute, enMessages, openUserMenu, clientHeaders, logSize, magicLinkFor, requestMagicLink, confirmMagicLink, state, escapeRegex  } from "./helpers";

// Login and authentication: confirmation pages prevent mail scanners from consuming tokens; links are single-use; unknown addresses receive the same response;
// unused Better Auth endpoints are closed; logout checks its origin; passkey registration and login use Chromium's virtual authenticator.
// Use member pat, invited by e2e/seed.ts. Run serially because tests depend on earlier results.
test.describe.configure({ mode: "serial" });

let context: BrowserContext;
let page: Page;
let site: APIRequestContext;
let link: string;

test.beforeAll(async ({ browser }) => {
  // Use a client address dedicated to this file (clientHeaders), separating its per-IP rate limit of 20 requests per 15 minutes from other tests.
  context = await browser.newContext({ extraHTTPHeaders: clientHeaders("10.1.0.1") });
  page = await context.newPage();
  site = await playwrightRequest.newContext({ baseURL: state().baseURL, extraHTTPHeaders: clientHeaders("10.1.0.2") });
});

test.afterAll(async () => {
  await site.dispose();
  await context.close();
});

const mails = (since: number) => fs.readFileSync(state().logFile).subarray(since).toString("utf8");

async function logOut() {
  // A document navigation can finish before hydration closes the native menu.
  // Wait for the loaded page before opening it and submitting logout.
  await waitForClientRoute(page);
  const menu = await openUserMenu(page);
  await menu.getByRole("menuitem", { name: enMessages.nav_logout, exact: true }).click();
  await expect(page).toHaveURL(/\/login$/);
}

test("the emailed link opens a confirm page: opening it (as a mail scanner does) does not use the token; the button does", async () => {
  const since = logSize();
  // Retry if a dev-server page reload loses an immediate click after navigation. Sending links more than once is safe.
  await expect(async () => {
    await page.goto(state().authInvite);
    link = await requestMagicLink(page, "pat@example.com");
    await expect(page.getByText(enMessages.invite_sent.replace("{email}", "pat@example.com"), { exact: true })).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 60_000 });
  expect(new URL(link).pathname).toBe("/auth/confirm");
  // Mail is plain text in the UI language, English in this E2E test.
  // An invitation speaks of signing up, not of logging in.
  expect(mails(since)).toContain(`[mail] to=pat@example.com subject=${enMessages.mail_invite_subject}`);

  // A scanner opens the link repeatedly with GET, without consuming the token.
  // Referer includes only the origin, keeping tokens out of outgoing requests.
  for (let i = 0; i < 3; i++) {
    const res = await site.get(link);
    expect(res.status()).toBe(200);
    expect(res.headers()["cache-control"]).toContain("no-store");
    expect(res.headers()["referrer-policy"]).toBe("strict-origin");
    expect(res.headers()["set-cookie"]).toBeUndefined();
    expect(await res.text()).toContain(enMessages.confirm_unusable_heading);
  }

  // The invitation page also keeps its secret token out of Referer and storage.
  // A scanner opening it does not consume the invitation.
  const invitePage = await site.get(state().machineInvite);
  expect(invitePage.status()).toBe(200);
  expect(invitePage.headers()["cache-control"]).toContain("no-store");
  expect(invitePage.headers()["referrer-policy"]).toBe("strict-origin");

  // Login CSRF: another browser can open and click an unconsumed valid link,
  // but cannot inherit the requesting browser's account or consume its token.
  const victim = await context.browser()!.newContext({ extraHTTPHeaders: clientHeaders("10.1.0.30") });
  try {
    const p = await victim.newPage();
    await p.goto(link);
    await expect(p.getByRole("button", { name: enMessages.confirm_submit, exact: true })).toHaveCount(0);
    await expect(p.getByRole("heading", { name: enMessages.confirm_unusable_heading })).toBeVisible();
    const refused = await victim.request.post("/auth/confirm", { headers: { origin: state().baseURL }, form: { token: new URL(link).searchParams.get("token")! } });
    expect(refused.status()).toBe(400);
    await expect(p.getByText(enMessages.confirm_invalid_hint, { exact: true })).toBeVisible();
    await expect(p.locator('input[name="next"]')).toHaveCount(0);
    await requestMagicLink(p, "pat@example.com");
    await expect(p.getByText(enMessages.login_sent.replace("{email}", "pat@example.com"), { exact: true })).toBeVisible();
    await p.goto("/");
    await expect(p).toHaveURL(/\/login$/);
  } finally { await victim.close(); }

  // A person opens the page and presses the button to sign in and reach onboarding. A double-click does not send a second request or show "無効".
  await page.goto(link);
  await expect(page.getByRole("heading", { name: enMessages.confirm_title })).toBeVisible();
  await expect(page).toHaveURL(/\/auth\/confirm\?token=/);
  await expect(page.getByRole("button", { name: enMessages.login_title })).toBeVisible({ timeout: 5_000 });
  await page.getByRole("button", { name: enMessages.login_title }).dblclick();
  await expect(page).toHaveURL(/\/onboarding$/);
  await page.getByLabel(enMessages.onboarding_handle).fill("pat");
  await page.getByRole("combobox", { name: enMessages.onboarding_home_area, exact: true }).click();
  await page.getByRole("listbox").getByRole("option", { name: enMessages.language_name_en, exact: true }).click();
  await completeTrialFields(page);
  await page.getByRole("button", { name: enMessages.onboarding_join }).click();
  await expect(page).toHaveURL(new URL("/", state().baseURL).href);
  await expect(page.locator('[data-member-menu-trigger][title="@pat"]')).toBeVisible();
});

test("a member's email login returns to the requested topic path and query", async () => {
  await page.goto("/");
  await logOut();
  const destination = "/t/999999?page=1";
  await page.goto(destination);
  await expect(page).toHaveURL(`/login?next=${encodeURIComponent(destination)}`);
  await expect(page.locator('input[name="next"]')).toHaveValue(destination);
  const returningLink = await requestMagicLink(page, "pat@example.com");
  await expect(page.getByText(enMessages.login_sent.replace("{email}", "pat@example.com"), { exact: true })).toBeVisible();
  expect(new URL(returningLink).searchParams.has("next")).toBe(false);
  await confirmMagicLink(page, returningLink);
  await expect(page).toHaveURL(destination);
  await page.goto("/");
  await expect(page.locator('[data-member-menu-trigger][title="@pat"]')).toBeVisible();
});

test("lost-session revalidation and SPA navigation return to document URLs after email login", async () => {
  const logInAgain = async (destination: string) => {
    await expect(page).toHaveURL(`/login?next=${encodeURIComponent(destination)}`);
    const returningLink = await requestMagicLink(page, "pat@example.com");
    await expect(page.getByText(enMessages.login_sent.replace("{email}", "pat@example.com"), { exact: true })).toBeVisible();
    expect(new URL(returningLink).searchParams.has("next")).toBe(false);
    await confirmMagicLink(page, returningLink);
    await expect(page).toHaveURL(destination);
    await expect(page.locator('[data-member-menu-trigger][title="@pat"]')).toBeVisible();
  };

  const destination = "/settings?return-check=revalidation";
  await page.goto(destination);
  await expect(page.locator('[data-member-menu-trigger][title="@pat"]')).toBeVisible();
  await expect.poll(() => page.evaluate(() => typeof (window as unknown as { __reactRouterDataRouter?: { revalidate: unknown } }).__reactRouterDataRouter?.revalidate)).toBe("function");
  await context.clearCookies({ name: /session_token$/ });
  const revalidation = page.waitForRequest((request) => new URL(request.url()).pathname === "/settings.data");
  await page.evaluate(() => {
    void (window as unknown as { __reactRouterDataRouter: { revalidate(): Promise<void> } }).__reactRouterDataRouter.revalidate();
  });
  await revalidation;
  await logInAgain(destination);

  await logOut();
  const spaDestination = "/settings?return-check=spa";
  const navigation = page.waitForRequest((request) => new URL(request.url()).pathname === "/settings.data");
  await page.evaluate((path) => {
    void (window as unknown as { __reactRouterDataRouter: { navigate(path: string): Promise<void> } }).__reactRouterDataRouter.navigate(path);
  }, spaDestination);
  await navigation;
  await logInAgain(spaDestination);
  await page.goto("/");
});

test("the link works only once", async () => {
  const other = await context.browser()!.newContext({ extraHTTPHeaders: clientHeaders("10.1.0.3") });
  try {
    const p = await other.newPage();
    await p.goto(link);
    await expect(p.getByRole("button", { name: enMessages.confirm_submit, exact: true })).toHaveCount(0);
    await expect(p.getByRole("heading", { name: enMessages.confirm_used_heading })).toBeVisible();
    const refused = await other.request.post("/auth/confirm", { headers: { origin: state().baseURL }, form: { token: new URL(link).searchParams.get("token")! } });
    expect(refused.status()).toBe(400);
    await expect(p.getByLabel(enMessages.login_email, { exact: true })).toBeVisible();
    await expect(p.getByRole("button", { name: enMessages.login_submit, exact: true })).toBeVisible();
    // Not signed in.
    await p.goto("/");
    await expect(p).toHaveURL(/\/login$/);
  } finally {
    await other.close();
  }
});

test("a member's missing topic keeps the navigation header and supplies a 404 title", async () => {
  const response = await page.goto("/t/999999");
  expect(response!.status()).toBe(404);
  await expect(page.getByRole("heading", { name: enMessages.error_title_not_found, exact: true })).toBeVisible();
  await expect(page.locator('[data-member-menu-trigger][title="@pat"]')).toBeVisible();
  await expect(page.locator("header").getByRole("link", { name: enMessages.site_name, exact: true })).toBeVisible();
  await expect(page.getByRole("main").getByRole("link", { name: enMessages.error_go_home, exact: true })).toHaveAttribute("href", "/");
  await expect(page).toHaveTitle(`${enMessages.error_title_not_found} · ${enMessages.site_name}`);
  expect(response!.headers()["x-content-type-options"]).toBe("nosniff");
  expect(response!.headers()["referrer-policy"]).toBe("strict-origin-when-cross-origin");
  expect(response!.headers()["permissions-policy"]).toBeTruthy();
  await page.goto("/");
});

test("invitation creation rejects self-invites and copies the created link with failure feedback", async () => {
  await page.goto("/invites/new");
  await page.getByLabel(enMessages.invites_email, { exact: true }).fill("PAT@EXAMPLE.COM");
  await page.getByRole("button", { name: enMessages.invites_submit }).click();
  await expect(page.getByRole("alert")).toHaveText(enMessages.invites_self);
  await expect(page.locator("code")).toHaveCount(0);

  await page.getByLabel(enMessages.invites_email, { exact: true }).fill("pat-invitee@example.com");
  await page.getByRole("button", { name: enMessages.invites_submit }).click();
  const link = page.locator("code");
  await expect(link).toHaveText(new RegExp(`^${escapeRegex(state().baseURL)}/invite/[A-Za-z0-9_-]{43}$`));
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.getByRole("button", { name: enMessages.invites_copy, exact: true }).click();
  await expect(page.getByRole("status")).toHaveText(enMessages.invites_copied);
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(await link.innerText());

  await page.evaluate(() => Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: async () => { throw new Error("Permission denied"); } },
  }));
  await page.getByRole("button", { name: enMessages.invites_copy, exact: true }).click();
  await expect(page.getByRole("status")).toHaveText(enMessages.invites_copy_failed);
  await page.goto("/");
});

test("an unregistered address is told so, an invited one gets the code screen, and no mail is sent to the stranger", async () => {
  const since = logSize();
  const other = await context.browser()!.newContext({ extraHTTPHeaders: clientHeaders("10.1.0.4") });
  try {
    const p = await other.newPage();
    const ask = async (email: string, expected: string) => {
      await expect(async () => {
        await p.goto("/login");
        if (await p.getByRole("button", { name: enMessages.login_restart, exact: true }).count()) await p.getByRole("button", { name: enMessages.login_restart, exact: true }).click();
        await p.getByLabel(enMessages.login_email, { exact: true }).fill(email);
        const submitted = p.waitForResponse(res => res.request().method() === "POST" && /^\/login(?:\.data)?$/.test(new URL(res.url()).pathname));
        await p.getByRole("button", { name: enMessages.login_submit }).click();
        expect((await submitted).ok()).toBe(true);
        await expect(p.getByText(expected, { exact: true })).toBeVisible({ timeout: 5_000 });
      }).toPass({ timeout: 60_000 });
    };
    // This scenario owns its unconsumed invitation; other suites use their own members.
    // Keep pat's requests to the one in the first test, away from the per-email limit of 5 per 15 minutes.
    await ask("stranger@example.com", enMessages.login_not_registered);
    await expect(p.getByLabel(enMessages.login_email, { exact: true })).toHaveValue("stranger@example.com");
    await expect(p.getByRole("heading", { name: enMessages.login_code_heading, exact: true })).toHaveCount(0);
    await ask("auth_invited_comparison@example.com", enMessages.login_sent.replace("{email}", "auth_invited_comparison@example.com"));
    await magicLinkFor("auth_invited_comparison@example.com", since);
    expect(mails(since)).not.toContain("to=stranger@example.com");
  } finally {
    await other.close();
  }
});

test("authentication routing blocks unused sign-in and serves passkey options", async () => {
  expect((await site.post("/api/auth/sign-in/magic-link", { data: { email: "pat@example.com" }, headers: { origin: state().baseURL } })).status()).toBe(404);
  expect((await site.get("/api/auth/passkey/generate-authenticate-options")).status()).toBe(200);
});

test("a member adds a passkey, logs in with it, and retains the last key (Chromium's virtual authenticator)", async () => {
  // Use the member still signed in from the first test: login was within one day, so passkey registration is allowed. Do not request more email here
  // because the per-email limit is 5 per 15 minutes.
  await page.goto("/");
  await expect(page.locator('[data-member-menu-trigger][title="@pat"]')).toBeVisible();

  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });

  // Retry if a reload loses the click just after navigation, when the dev server first discovers a dependency loaded by that button.
  // Check the authenticator credential count to determine whether registration succeeded and avoid duplicate retries.
  await expect(async () => {
    await page.goto("/settings");
    await expect(page.getByRole("heading", { name: enMessages.settings_passkeys_heading })).toBeVisible();
    if ((await cdp.send("WebAuthn.getCredentials", { authenticatorId })).credentials.length === 0) {
      await page.getByLabel(/^Name \(optional/).fill("e2e key");
      await page.getByRole("button", { name: enMessages.settings_passkeys_add }).click();
    }
    await expect(page.getByText(enMessages.settings_passkeys_added)).toBeVisible({ timeout: 10_000 });
  }).toPass({ timeout: 60_000 });
  await expect(page.getByRole("listitem").filter({ hasText: "e2e key" })).toBeVisible();
  expect((await cdp.send("WebAuthn.getCredentials", { authenticatorId })).credentials).toHaveLength(1);

  // Log out, then sign in with a passkey, without email.
  await logOut();
  await expect(page).toHaveURL(/\/login$/);
  await context.addCookies([{ name: hostCookieName("tomola.reading-return"), value: "%2Ft%2F42", url: state().baseURL, secure: new URL(state().baseURL).protocol === "https:", httpOnly: true, sameSite: "Lax" }]);
  const mailsBefore = logSize();
  await expect(async () => {
    await page.goto("/settings?return-check=1");
    await expect(page).toHaveURL(/\/login\?next=/);
    await page.getByRole("button", { name: enMessages.login_passkey }).click();
    await expect(page.locator('[data-member-menu-trigger][title="@pat"]')).toBeVisible({ timeout: 10_000 });
  }).toPass({ timeout: 60_000 });
  await expect(page).toHaveURL(/\/settings\?return-check=1$/);
  expect((await context.cookies()).some(cookie => cookie.name === hostCookieName("tomola.reading-return"))).toBe(false);
  expect(mails(mailsBefore)).not.toContain("[mail]");
  // Sessions retain neither IP addresses nor user agents; the DB lives in the server. Here verify only that login persists.
  await page.goto("/settings");
  await expect(page.getByRole("listitem").filter({ hasText: "e2e key" })).toBeVisible();

  // A member must retain one key; losing every key requires operator recovery.
  await expect(page.getByRole("listitem").filter({ hasText: "e2e key" }).getByRole("button", { name: enMessages.settings_passkeys_remove })).toBeDisabled();

  await cdp.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId });
  await cdp.send("WebAuthn.disable");
});

test("logout is refused from another origin, and works from the page", async () => {
  const refused = await context.request.post("/logout", { headers: { origin: "https://evil.example" }, form: {} });
  expect(refused.status()).toBe(403);
  await page.goto("/");
  await expect(page.locator('[data-member-menu-trigger][title="@pat"]')).toBeVisible();
  await logOut();
  await expect(page).toHaveURL(/\/login$/);
});

test("logging in with a passkey when none is registered fails politely", async () => {
  // The preceding test logged out and left the login screen open.
  await expect(page).toHaveURL(/\/login$/);
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  await page.getByRole("button", { name: enMessages.login_passkey }).click();
  await expect(page.getByText(enMessages.login_passkey_failed)).toBeVisible();
  await expect(page).toHaveURL(/\/login$/);
  await cdp.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId });
});
