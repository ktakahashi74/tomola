import fs from "node:fs";
import path from "node:path";
import { expect } from "@playwright/test";
import { test } from "./editor-fixture";
import { completeTrialFields, enMessages as m, state, uiMessages, useMember } from "./helpers";
import { ELIGIBLE_COUNTRY, EXCLUDED_COUNTRY, testOperator, TRIAL_CONSENT_VERSION } from "./operator-fixture";

const fixture = () => JSON.parse(fs.readFileSync(path.join(state().dir, "privacy-page.json"), "utf8")) as { questionId: number };

const trialRequired = testOperator.participation.requireTrialConsent;

test("operator notices expose complete documents and language fallback", async ({ page }) => {
  for (const kind of ["privacy", "terms"]) {
    const available = true;
    for (const suffix of ["", "?lang=en", ".md", ".md?lang=en"]) expect((await page.request.get(`/${kind}${suffix}`)).status()).toBe(available ? 200 : 404);
    if (available) {
      await page.goto(`/${kind}?lang=ko`);
      // The fallback note is in the screen language that the page chose, whichever languages have interface translations.
      await expect(page.getByRole("note").filter({ hasText: (await uiMessages(page)).notice_language_fallback })).toBeVisible();
      await expect(page.locator('article[lang="en"] h1')).toBeVisible();
      expect(await (await page.request.get(`/${kind}.md?lang=en`)).text()).not.toMatch(/【[^】]*】/);
      if (kind === "terms") for (const lang of ["ja", "en"]) {
        await page.goto(`/terms?lang=${lang}#s6`);
        await expect(page.locator(`article[lang="${lang}"] #s6`)).toBeVisible();
        await expect(page.locator("#s6")).not.toContainText("★");
      }
    }
  }
  await page.goto("/login");
  await expect(page.locator('footer a[href="/privacy"]')).toHaveCount(1);
});

test("existing members confirm the configured participation version", async ({ page }) => {
  await page.context().setStorageState(JSON.parse(fs.readFileSync(path.join(state().dir, "members/privacy_existing@example.com.json"), "utf8")));
  await page.goto("/");
  if (trialRequired) {
    await expect(page.getByRole("heading", { name: m.onboarding_review_title })).toBeVisible();
    await expect(page.locator('input[name="handle"]')).toHaveCount(0);
    await expect(page.locator("main").getByRole("link", { name: m.notice_privacy, exact: true })).toBeVisible();
    await expect(page.locator('main a[href="/terms"]')).toBeVisible();
    await page.getByRole("link", { name: m.nav_settings, exact: true }).click();
    await expect(page).toHaveURL(/\/settings$/);
    await page.goto("/");
    await completeTrialFields(page);
    await page.getByRole("button", { name: m.save_changes, exact: true }).click();
  } else {
    await expect(page.getByRole("heading", { name: m.onboarding_review_title })).toHaveCount(0);
  }
  await expect(page).toHaveURL(new URL("/", state().baseURL).href);
  await page.goto("/settings");
  await expect(page).toHaveURL(/\/settings$/);
  const response = await page.request.get("/settings/export");
  expect(response.status()).toBe(200);
  expect((await response.json()).profile).toMatchObject(trialRequired
    ? { residence_country: ELIGIBLE_COUNTRY, adult_confirmed_at: expect.any(String), trial_consent_version: TRIAL_CONSENT_VERSION, trial_consent_at: expect.any(String) }
    : { residence_country: null, adult_confirmed_at: null, trial_consent_version: null, trial_consent_at: null });
});

test("configured country restrictions prevent registration and writes", async ({ page }) => {
  await page.context().setStorageState(JSON.parse(fs.readFileSync(path.join(state().dir, "members/privacy_restricted@example.com.json"), "utf8")));
  await page.goto("/onboarding");
  if (trialRequired) {
    await completeTrialFields(page);
    await page.getByLabel(m.onboarding_country, { exact: true }).selectOption(EXCLUDED_COUNTRY);
    await page.getByRole("button", { name: m.save_changes, exact: true }).click();
    await expect(page.getByRole("alert")).toContainText(m.onboarding_country_excluded);
    await expect(page.getByRole("alert").locator('a[href^="mailto:"]')).toHaveCount(0);
    await page.getByRole("link", { name: m.onboarding_read_only }).click();
    const write = await page.request.post("/stance", { form: { questionId: "1", version: "0", position: "agree" }, headers: { Origin: state().baseURL }, maxRedirects: 0 });
    expect(write.status()).toBe(302);
    expect(write.headers().location).toBe("/onboarding");
  } else {
    await expect(page).toHaveURL(new URL("/", state().baseURL).href);
    const ignored = await page.request.post("/onboarding", { form: { residenceCountry: EXCLUDED_COUNTRY, adult: "1", trialAgree: "1", trialVersion: String(TRIAL_CONSENT_VERSION) }, headers: { Origin: state().baseURL }, maxRedirects: 0 });
    expect(ignored.status()).toBe(302);
    expect((await (await page.request.get("/settings/export")).json()).profile).toMatchObject({ residence_country: null, trial_consent_at: null });
  }
  await expect(page).toHaveURL(new URL("/", state().baseURL).href);
});

test.describe("without JavaScript", () => {
  test.use({ javaScriptEnabled: false });

  test("stance selection asks separately and revocation preserves the existing record", async ({ page }) => {
    const { questionId } = fixture();
    await useMember(page, "privacy_stance@example.com", `/t/${questionId}`);
    await page.locator("#stance").getByRole("button", { name: m.stance_agree, exact: true }).click();
    await expect(page).toHaveURL(/\/settings\/stances\?.*#consent$/);
    await expect(page.locator("#consent")).toContainText(m.stance_consent_text);
    await page.getByRole("checkbox", { name: m.stance_consent_agree, exact: true }).check();
    await page.getByRole("button", { name: m.stance_consent_continue, exact: true }).click();
    await expect(page).toHaveURL(url => url.pathname === `/t/${questionId}` && url.search === "" && url.hash === "#stance");
    await page.locator("#stance").getByRole("button", { name: m.stance_agree, exact: true }).click();
    await expect(page.locator("#stance").getByRole("button", { name: m.stance_agree, exact: true })).toHaveAttribute("aria-pressed", "true");
    await page.goto("/settings/stances");
    await page.getByRole("button", { name: m.stance_consent_revoke, exact: true }).click();
    await expect(page.getByRole("checkbox", { name: m.stance_consent_agree, exact: true })).toBeVisible();
    await expect(page.locator(`#q-${questionId}`)).toBeVisible();
  });

});
