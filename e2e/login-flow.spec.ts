import { expect } from "@playwright/test";
import { test } from "./editor-fixture";
import { clientHeaders, enMessages as en, jaMessages as ja, logSize, loginCodeFor, magicLinkFor, loginWithMagicLink, state } from "./helpers";

test("the Japanese 390px login page names each state, preserves errors, and offers recovery for both code limits", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "ja-JP", extraHTTPHeaders: clientHeaders("10.33.0.1") });
  try {
    const page = await context.newPage();
    const path = "/login?next=" + encodeURIComponent("/settings?from=login-flow");
    const width = async () => expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1, name: ja.login_title, exact: true })).toBeVisible();
    await expect(page.getByLabel(ja.login_code_label, { exact: true })).toHaveCount(0);
    await width();
    const email = "login_flow_ja@example.com";
    await page.getByLabel(ja.login_email, { exact: true }).fill(email);
    await page.getByRole("button", { name: ja.login_submit, exact: true }).click();
    const input = page.getByLabel(ja.login_code_label, { exact: true });
    await expect(page.getByRole("heading", { level: 1, name: ja.login_code_heading, exact: true })).toBeVisible();
    await expect(page).toHaveTitle(ja.login_code_heading);
    await expect(input).toBeFocused();
    await expect(page.getByLabel(ja.login_email, { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: ja.login_passkey, exact: true })).toHaveCount(0);
    await expect(page.getByText(ja.login_sent.replace("{email}", email), { exact: true })).toBeVisible();
    await width();
    await input.fill("000000");
    await page.getByRole("button", { name: ja.login_code_submit, exact: true }).click();
    await expect(input).toHaveValue("000000");
    await expect(page.getByText(ja.login_code_invalid, { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByText(ja.login_code_invalid, { exact: true })).toBeVisible();
    for (let n = 0; n < 4; n++) {
      await input.fill("000000");
      const submitted = page.waitForResponse(r => r.request().method() === "POST");
      await page.getByRole("button", { name: ja.login_code_submit, exact: true }).click();
      await submitted;
    }
    await expect(input).toHaveCount(0);
    await expect(page.getByText(ja.login_code_limited, { exact: true })).toBeVisible();
    await expect(page.getByText(ja.login_code_invalid, { exact: true })).toHaveCount(0);
    await page.reload();
    await expect(page.getByText(ja.login_code_limited, { exact: true })).toBeVisible();
    await width();
    await page.getByRole("button", { name: ja.login_resend, exact: true }).click();
    await expect(input).toHaveValue("");
    await expect(input).toBeFocused();
    await expect(page.getByText(ja.login_resent, { exact: true })).toBeVisible();
    await expect(page.getByText(ja.login_code_limited, { exact: true })).toHaveCount(0);
    for (let round = 0; round < 3; round++) {
      for (let n = 0; n < 5; n++) {
        const denied = await context.request.post(path, { headers: { origin: state().baseURL }, form: { intent: "login-code", code: "000000" } });
        expect(denied.status()).toBe(400);
      }
      if (round < 2) await context.request.post(path, { headers: { origin: state().baseURL }, form: { intent: "login-resend", next: "/settings?from=login-flow" } });
    }
    await page.reload();
    await expect(page.getByText(ja.login_code_limited_address, { exact: true })).toBeVisible();
    await expect(input).toHaveCount(0);
    const resend = page.getByRole("button", { name: ja.login_resend, exact: true });
    await expect(resend).toBeVisible();
    expect(await resend.evaluate(element => Number.parseFloat(getComputedStyle(element).borderTopWidth))).toBeGreaterThan(0);
    await width();
    await page.getByRole("button", { name: ja.login_restart, exact: true }).click();
    await expect(page.getByLabel(ja.login_email, { exact: true })).toBeVisible();
    await expect(page).toHaveURL(path);
    await page.reload();
    await expect(page.getByLabel(ja.login_email, { exact: true })).toBeVisible();
    await expect(input).toHaveCount(0);
    await page.goto("/auth/confirm?token=" + "a".repeat(32));
    await expect(page.getByRole("heading", { name: ja.confirm_unknown_heading, exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: ja.confirm_submit, exact: true })).toHaveCount(0);
    await width();
    await page.goto("/invite/unknown");
    await expect(page.getByRole("link", { name: ja.invite_invalid_login, exact: true })).toHaveAttribute("href", "/login");
    await width();
  } finally { await context.close(); }
});

test("native invitation resend and restart preserve links, then code and link logins clear the pending screen", async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 390, height: 844 }, extraHTTPHeaders: clientHeaders("10.33.0.2") });
  try {
    const page = await context.newPage();
    const email = "login_flow@example.com";
    await page.goto("/login");
    await page.getByLabel(en.login_email, { exact: true }).fill("login_flow_other@example.com");
    await page.getByRole("button", { name: en.login_submit, exact: true }).click();
    await page.goto(state().loginFlowInvite);
    await expect(page.getByRole("button", { name: en.invite_submit, exact: true })).toBeVisible();
    await expect(page.getByLabel(en.login_code_label, { exact: true })).toHaveCount(0);
    const since = logSize();
    await page.getByRole("button", { name: en.invite_submit, exact: true }).click();
    await expect(page.getByRole("heading", { level: 1, name: en.login_code_heading })).toBeVisible();
    await expect(page.getByLabel(en.login_code_label, { exact: true })).toBeFocused();
    const link = await magicLinkFor(email, since);
    await page.getByRole("button", { name: en.login_restart, exact: true }).click();
    await expect(page).toHaveURL(state().loginFlowInvite);
    await expect(page.getByRole("button", { name: en.invite_submit, exact: true })).toBeVisible();
    await page.goto(link);
    await expect(page.getByRole("button", { name: en.confirm_submit, exact: true })).toBeVisible();
    await page.goto(state().loginFlowInvite);
    const next = logSize();
    await page.getByRole("button", { name: en.invite_submit, exact: true }).click();
    const oldCode = await loginCodeFor(email, next);
    const resent = logSize();
    await page.getByRole("button", { name: en.login_resend, exact: true }).click();
    await expect(page.getByText(en.login_resent, { exact: true })).toBeVisible();
    await expect(page.getByLabel(en.login_code_label, { exact: true })).toHaveValue("");
    const code = await loginCodeFor(email, resent);
    expect((await context.request.post("/login", { headers: { origin: state().baseURL }, form: { intent: "login-code", code: oldCode } })).status()).toBe(400);
    await page.getByLabel(en.login_code_label, { exact: true }).fill(code);
    await page.getByRole("button", { name: en.invite_code_submit, exact: true }).click();
    await expect(page).toHaveURL(/\/onboarding$/);
    expect((await context.cookies()).some(c => /tomola.login-(code|email)$/.test(c.name))).toBe(false);
    await context.request.post("/logout", { headers: { origin: state().baseURL }, form: {} });
    await page.goto("/login");
    await expect(page.getByLabel(en.login_email, { exact: true })).toBeVisible();
    await expect(page.getByLabel(en.login_code_label, { exact: true })).toHaveCount(0);
    await loginWithMagicLink(page, email);
    await expect(page).toHaveURL(/\/onboarding$/);
    expect((await context.cookies()).some(c => /tomola.login-(code|email)$/.test(c.name))).toBe(false);
    await context.request.post("/logout", { headers: { origin: state().baseURL }, form: {} });
    await page.goto("/login");
    await expect(page.getByRole("heading", { name: en.login_title, exact: true })).toBeVisible();
    await expect(page.getByLabel(en.login_code_label, { exact: true })).toHaveCount(0);
  } finally { await context.close(); }
});
