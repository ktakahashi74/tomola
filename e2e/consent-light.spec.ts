import { ELIGIBLE_COUNTRY } from "./operator-fixture";
import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { captureScreenshot, clientHeaders, enMessages as m, signUp, state, uiMessages, waitForClientRoute } from "./helpers";

test("invitation eligibility precedes signup and the summary retains full-document agreement", async ({ page }) => {
  const { invitation } = JSON.parse(fs.readFileSync(path.join(state().dir, "consent-light.json"), "utf8"));
  await page.context().setExtraHTTPHeaders(clientHeaders("10.90.15.1"));
  await page.goto(invitation);
  await waitForClientRoute(page);
  const trialRequired = (await page.request.get("/terms")).ok() && (await page.request.get("/privacy")).ok();
  const restriction = page.getByText(m.invite_excluded_countries, { exact: true });
  await expect(restriction).toHaveCount(trialRequired ? 1 : 0);
  await expect(page.getByRole("link", { name: m.invite_excluded_countries, exact: true })).toHaveCount(0);
  await expect(page.locator('main a[href="/terms#s2"]')).toHaveCount(0);
  if (trialRequired) {
    await expect(restriction).toHaveText(m.invite_excluded_countries);
    expect(await restriction.evaluate(node => Boolean(node.compareDocumentPosition(document.querySelector('main button[type="submit"]')!) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
  }
  if (process.env.E2E_EVIDENCE_DIR) {
    const viewport = page.viewportSize();
    for (const lang of ["ja", "en"]) {
      await page.context().addCookies([{ name: "PARAGLIDE_LOCALE", value: lang, url: state().baseURL }]);
      await page.setViewportSize({ width: 390, height: 900 });
      await page.goto(invitation); await waitForClientRoute(page);
      await expect(page.locator("html")).toHaveAttribute("lang", lang);
      const messages = await uiMessages(page);
      await expect(page.getByRole("link", { name: messages.invite_excluded_countries, exact: true })).toHaveCount(0);
      await expect(page.getByText(messages.invite_excluded_countries, { exact: true })).toHaveCount(trialRequired ? 1 : 0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.evaluate(() => document.fonts.ready);
      await captureScreenshot(page, { path: `invite-${lang}-390.png`, fullPage: true }, ".");
    }
    if (viewport) await page.setViewportSize(viewport);
  }
  await signUp(page, invitation, "consent_light_signup@example.com", { handle: "consent_light_signup" }, async page => {
    const summary = page.locator("main ul").filter({ hasText: m.trial_summary_eligibility });
    await expect(summary).toHaveCount(trialRequired ? 1 : 0);
    if (!trialRequired) return;
    await expect(summary.getByRole("listitem")).toHaveCount(3);
    await expect(page.getByText(m.trial_read_full, { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: m.notice_terms, exact: true })).toBeVisible();
    await expect(page.getByRole("main").getByRole("link", { name: m.notice_privacy, exact: true })).toBeVisible();
    const agreement = page.getByRole("checkbox", { name: m.onboarding_trial_agree, exact: true });
    await expect(agreement).toHaveAttribute("required", "");
    await page.locator('input[name="handle"]').fill("consent_light_signup");
    await page.locator('select[name="residenceCountry"]').selectOption(ELIGIBLE_COUNTRY);
    await page.locator('input[name="adult"]').check();
    await page.getByRole("button", { name: m.onboarding_join, exact: true }).click();
    await expect(page).toHaveURL(/\/onboarding$/);
    await expect(agreement).not.toBeChecked();
    expect(await agreement.evaluate(input => (input as HTMLInputElement).validity.valueMissing)).toBe(true);
  });
  const operator = page.locator('footer a[href="/privacy#s1"]');
  await expect(operator).toHaveCount((await page.request.get("/privacy")).ok() ? 1 : 0);
  if (await operator.count()) {
    await expect(operator).toHaveText(m.footer_operator);
    await operator.click();
    await expect(page).toHaveURL(/\/privacy#s1$/);
    await expect(page.locator("article #s1")).toBeVisible();
  }
});
