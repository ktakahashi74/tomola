import { oauthLoopback } from "./support/oauth-loopback";
import { completeTrialFields } from "./helpers";
import { createHash } from "node:crypto";
import { expect, type Page } from "@playwright/test";
import { test } from "./editor-fixture";
import { waitForClientRoute, clientHeaders, enMessages as m, logSize, loginCodeFor, magicLinkFor, requestMagicLink, openUserMenu, signUp, state  } from "./helpers";

async function expectOriginOnlyReferer(page: Page) {
  let referer: string | undefined;
  await page.route("https://referrer.example/receive", async route => {
    referer = route.request().headers().referer;
    await route.fulfill({ status: 200, contentType: "text/html", body: "Received" });
  });
  await page.evaluate(() => {
    const anchor = document.createElement("a");
    anchor.href = "https://referrer.example/receive"; anchor.textContent = "Referer fixture";
    document.body.append(anchor);
  });
  await page.getByRole("link", { name: "Referer fixture", exact: true }).click();
  expect(referer).toBe(`${state().baseURL}/`);
}

test("confirmation accepts a native POST without JavaScript and sends only the origin as Referer", async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false, extraHTTPHeaders: clientHeaders("10.28.0.4") });
  try {
    const page = await context.newPage();
    await page.goto(state().loginConfirmInvite);
    await expectOriginOnlyReferer(page);
    await page.goto("/login");
    const link = await requestMagicLink(page, "login_ease_confirm@example.com");
    await page.goto(link);
    await expectOriginOnlyReferer(page);
    const response = await page.goto(link);
    const post = page.waitForResponse(res => res.request().method() === "POST" && new URL(res.url()).pathname === "/auth/confirm");
    await expect(page.getByRole("button", { name: m.confirm_submit, exact: true })).toBeVisible({ timeout: 5_000 });
    await page.getByRole("button", { name: m.confirm_submit, exact: true }).click();
    const confirmed = await post;
    console.log(JSON.stringify({ nativeConfirmation: { status: confirmed.status(), origin: confirmed.request().headers().origin, referer: confirmed.request().headers().referer } }));
    expect(confirmed.status()).toBe(303);
    expect(confirmed.request().headers().origin).toBe(state().baseURL);
    expect(confirmed.request().headers().referer).toBe(`${state().baseURL}/`);
    expect(response!.headers()["referrer-policy"]).toBe("strict-origin");
    await expect(page).toHaveURL(/\/onboarding$/);
  } finally { await context.close(); }
});

test("prompt registers in place, then passkey login works and Later persists", async ({ browser }) => {
  test.setTimeout(120_000);
  const context = await browser.newContext({ extraHTTPHeaders: clientHeaders("10.28.0.1"), viewport: { width: 390, height: 844 } });
  try {
    const page = await context.newPage();
    // A previous successful send leaves the invitation in the state signUp must recover on retry.
    await page.goto(state().loginPromptInvite);
    await page.getByRole("button", { name: m.invite_submit, exact: true }).click();
    await expect(page.getByRole("heading", { level: 1, name: m.login_code_heading, exact: true })).toBeVisible();
    await signUp(page, state().loginPromptInvite, "login_ease_prompt@example.com", { handle: "login_prompt", mainLang: "en" });
    await expect(page.getByText(m.passkey_prompt, { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    // The notice is already present before hydration, above the member header.
    const html = await (await context.request.get("/")).text();
    const promptMarkup = m.passkey_prompt.replaceAll("&", "&amp;").replaceAll("\"", "&quot;").replaceAll("'", "&#x27;");
    expect(html.indexOf(promptMarkup)).toBeGreaterThan(-1);
    expect(html.indexOf(promptMarkup)).toBeLessThan(html.indexOf("<header"));
    await page.getByRole("button", { name: m.passkey_prompt_later, exact: true }).click();
    await page.goto("/settings"); await waitForClientRoute(page); await page.reload();
    await expect(page.getByText(m.passkey_prompt, { exact: true })).toHaveCount(0);
    await context.clearCookies({ name: /tomola\.passkey-later-/ }); await page.goto("/");
    const cdp = await context.newCDPSession(page); await cdp.send("WebAuthn.enable");
    const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
    await page.route("**/passkeys", route => route.abort());
    await page.getByRole("button", { name: m.passkey_prompt_register, exact: true }).click();
    await expect(page.getByText(m.passkey_prompt_failed, { exact: true })).toBeVisible();
    await expect(page.getByText(m.passkey_prompt, { exact: true })).toBeVisible();
    await page.unroute("**/passkeys");
    await page.getByRole("button", { name: m.passkey_prompt_register, exact: true }).click();
    await expect(page.getByText(m.passkey_prompt_success, { exact: true })).toBeVisible();
    await expect(page.getByText(m.passkey_prompt, { exact: true })).toHaveCount(0);
    expect((await cdp.send("WebAuthn.getCredentials", { authenticatorId })).credentials).toHaveLength(1);
    await page.reload(); await expect(page.getByText(m.passkey_prompt, { exact: true })).toHaveCount(0);
    await (await openUserMenu(page)).getByRole("menuitem", { name: m.nav_logout, exact: true }).click();
    // Clicking submits the router form; authentication changes only after navigation.
    await expect(page).toHaveURL(/\/login$/);
    await waitForClientRoute(page);
    let lastLink = "";
    for (let source = 0; source < 5; source++) {
      await context.setExtraHTTPHeaders(clientHeaders(`10.28.10.${source + 1}`));
      for (let round = 0; round < 4; round++) {
        const since = logSize();
        expect((await context.request.post("/login", { maxRedirects: 0, headers: { Origin: state().baseURL }, form: { email: "login_ease_prompt@example.com" } })).status()).toBe(200);
        lastLink = await magicLinkFor("login_ease_prompt@example.com", since);
        for (let guess = 0; guess < 5; guess++) expect((await context.request.post("/login", { headers: { Origin: state().baseURL }, form: { intent: "login-code", code: "wrong" } })).status()).toBe(400);
      }
    }
    await context.setExtraHTTPHeaders(clientHeaders("10.28.10.99"));
    const limitedPage = await page.goto("/login");
    expect(limitedPage!.headers()["cross-origin-opener-policy"]).toBeUndefined();
    await expect(page.getByText(m.login_code_limited_address, { exact: true })).toBeVisible();
    const linkPage = await page.goto(lastLink);
    expect(linkPage!.headers()["cross-origin-opener-policy"]).toBeUndefined();
    await expect(page.getByRole("button", { name: m.confirm_submit, exact: true })).toBeVisible({ timeout: 5_000 });
    await page.getByRole("button", { name: m.confirm_submit, exact: true }).click();
    await expect(page).toHaveURL(new URL("/", state().baseURL).href);
    await (await openUserMenu(page)).getByRole("menuitem", { name: m.nav_logout, exact: true }).click();
    // Clicking submits the router form; authentication changes only after navigation.
    await expect(page).toHaveURL(/\/login$/);
    await waitForClientRoute(page);
    await page.getByRole("button", { name: m.login_passkey, exact: true }).click();
    await expect(page).toHaveURL(new URL("/", state().baseURL).href);
    await cdp.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId });
  } finally { await context.close(); }
});

test("a member using an unsupported browser never sees the passkey prompt", async ({ browser }) => {
  const context = await browser.newContext({ extraHTTPHeaders: clientHeaders("10.28.0.5") });
  try {
    await context.addInitScript(() => Object.defineProperty(window, "PublicKeyCredential", { value: undefined, configurable: true }));
    const page = await context.newPage();
    await signUp(page, state().loginUnsupportedInvite, "login_ease_unsupported@example.com", { handle: "login_unsupported", mainLang: "en" });
    await waitForClientRoute(page);
    await expect(page.getByText(m.passkey_prompt, { exact: true })).toHaveCount(0);
  } finally { await context.close(); }
});


test("code signup and login work without JavaScript and preserve return paths", async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false, extraHTTPHeaders: clientHeaders("10.28.0.2"), viewport: { width: 390, height: 844 } });
  const second = await browser.newContext({ javaScriptEnabled: false, extraHTTPHeaders: clientHeaders("10.28.0.3") });
  try {
    const page = await context.newPage();
    const since = logSize();
    await page.goto(state().loginCodeInvite);
    await page.getByRole("button", { name: m.invite_submit, exact: true }).click();
    const code = await loginCodeFor("login_ease_code@example.com", since);
    const link = await magicLinkFor("login_ease_code@example.com", since);
    const foreign = await second.newPage();
    await foreign.goto(link); // Reading the email URL on another device never consumes it.
    const denied = await second.request.post("/login", { headers: { origin: state().baseURL }, form: { intent: "login-code", code } });
    expect(denied.status()).toBe(400);
    expect(await denied.text()).toContain(m.login_code_invalid);
    await expect(page.getByLabel(m.login_code_label, { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByLabel(m.login_code_label, { exact: true })).toBeVisible();
    expect(await page.content()).not.toContain(code);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByLabel(m.login_code_label, { exact: true }).fill(code === "000000" ? "111111" : "000000");
    const invalidPost = page.waitForResponse(res => res.request().method() === "POST");
    await page.getByRole("button", { name: m.invite_code_submit, exact: true }).click();
    const invalid = await invalidPost;
    expect(invalid.status()).toBe(400);
    expect(invalid.headers()["referrer-policy"]).toBe("strict-origin");
    await expect(page.getByText(m.login_code_invalid, { exact: true })).toBeVisible();
    await page.getByLabel(m.login_code_label, { exact: true }).fill(`${code.slice(0, 3)} - ${code.slice(3)}`);
    await page.getByRole("button", { name: m.invite_code_submit, exact: true }).click();
    await expect(page).toHaveURL(/\/onboarding$/);
    await page.getByLabel(m.onboarding_handle, { exact: true }).fill("login_code_member");
    // Keep the browser-derived English default; the code POST itself used no JS.
    await completeTrialFields(page);
    await page.getByRole("button", { name: m.onboarding_join, exact: true }).click();
    await expect(page).toHaveURL(new URL("/", state().baseURL).href);
    await page.goto(link);
    await expect(page).toHaveURL(new URL("/", state().baseURL).href);
    await expect(page.getByRole("button", { name: m.confirm_submit, exact: true })).toHaveCount(0);
    await page.goto("/");
    await context.request.post("/logout", { headers: { origin: state().baseURL }, form: {} });
    const loginMail = logSize();
    await page.goto("/login?next=" + encodeURIComponent("/settings?return-check=code"));
    await page.getByLabel(m.login_email, { exact: true }).fill("login_ease_code@example.com");
    await page.getByRole("button", { name: m.login_submit, exact: true }).click();
    await expect(page.getByLabel(m.login_code_label, { exact: true })).toBeVisible();
    await page.reload();
    const loginCode = await loginCodeFor("login_ease_code@example.com", loginMail);
    await page.getByLabel(m.login_code_label, { exact: true }).fill(loginCode === "000000" ? "111111" : "000000");
    const badLogin = page.waitForResponse(res => res.request().method() === "POST");
    await page.getByRole("button", { name: m.login_code_submit, exact: true }).click();
    expect((await badLogin).headers()["referrer-policy"]).toBe("strict-origin");
    await page.getByLabel(m.login_code_label, { exact: true }).fill(loginCode);
    await page.getByRole("button", { name: m.login_code_submit, exact: true }).click();
    await expect(page).toHaveURL(/\/settings\?return-check=code$/);
  } finally { await context.close(); await second.close(); }
});

test("code login resumes MCP consent without JavaScript and keeps the current session on revocation", async ({ browser, request }) => {
  const loopback = await oauthLoopback();
  const context = await browser.newContext({ extraHTTPHeaders: clientHeaders("10.28.0.7") });
  const second = await browser.newContext({ javaScriptEnabled: false, extraHTTPHeaders: clientHeaders("10.28.0.8") });
  try {
    const page = await context.newPage();
    const email = "login_ease_mcp@example.com";
    // Signup plus the three MCP sends uses four of the five allowed mails for this dedicated address.
    await signUp(page, state().loginMcpInvite, email, { handle: "login_mcp_member", mainLang: "en" });
    const foreign = await second.newPage();
    // A second browser logs in for OAuth, without modifying the first session.
    const registered = await request.post(`${state().baseURL}/api/auth/oauth2/register`, { data: { client_name: "Code login fixture", application_type: "native", redirect_uris: [loopback.redirectURI], grant_types: ["authorization_code"], response_types: ["code"], token_endpoint_auth_method: "none", scope: "read" } });
    expect(registered.status()).toBe(201);
    const clientId = (await registered.json()).client_id;
    const params = new URLSearchParams({ client_id: clientId, redirect_uri: loopback.redirectURI, response_type: "code", scope: "read", state: "code-fixture", code_challenge_method: "S256", code_challenge: createHash("sha256").update("v".repeat(64)).digest("base64url"), resource: `${state().baseURL}/mcp` });
    await foreign.goto(`${state().baseURL}/api/auth/oauth2/authorize?${params}`);
    await expect(foreign).toHaveURL(/\/mcp\/login\?/);
    await foreign.getByLabel(m.login_email, { exact: true }).fill(email);
    await foreign.getByRole("button", { name: m.login_submit, exact: true }).click();
    await expect(foreign.getByRole("heading", { level: 2, name: m.login_code_heading, exact: true })).toBeVisible();
    await expect(foreign.getByText(m.mcp_login_client.replace("{name}", "Code login fixture"), { exact: true })).toBeVisible();
    const loginPath = foreign.url();
    await foreign.getByRole("button", { name: m.login_resend, exact: true }).click();
    await expect(foreign.getByText(m.login_resent, { exact: true })).toBeVisible();
    await foreign.getByRole("button", { name: m.login_restart, exact: true }).click();
    await expect(foreign).toHaveURL(loginPath);
    await expect(foreign.getByText(m.mcp_login_client.replace("{name}", "Code login fixture"), { exact: true })).toBeVisible();
    await foreign.getByLabel(m.login_email, { exact: true }).fill(email);
    const mcpMail = logSize();
    await foreign.getByRole("button", { name: m.login_submit, exact: true }).click();
    // Wait for the native POST redirect to finish before reloading its document.
    await expect(foreign.getByRole("heading", { level: 2, name: m.login_code_heading, exact: true })).toBeVisible();
    await foreign.waitForLoadState("load");
    await foreign.reload();
    const mcpCode = await loginCodeFor(email, mcpMail);
    await foreign.getByLabel(m.login_code_label, { exact: true }).fill(mcpCode === "000000" ? "111111" : "000000");
    const badMcp = foreign.waitForResponse(res => res.request().method() === "POST");
    await foreign.getByRole("button", { name: m.login_code_submit, exact: true }).click();
    expect((await badMcp).headers()["referrer-policy"]).toBe("strict-origin");
    await foreign.getByLabel(m.login_code_label, { exact: true }).fill(mcpCode);
    await foreign.getByRole("button", { name: m.login_code_submit, exact: true }).click();
    await expect(foreign).toHaveURL(/\/mcp\/consent\?/);
    await foreign.goto("/settings");
    await foreign.getByRole("button", { name: m.settings_sessions_revoke, exact: true }).click();
    await expect(foreign.getByText(m.settings_sessions_revoked, { exact: true })).toBeVisible();
    await page.goto("/settings"); await expect(page).toHaveURL(/\/login\?next=/);
    await foreign.reload(); await expect(foreign).toHaveURL(/\/settings/);
  } finally { await context.close(); await second.close(); await loopback.close(); }
});
