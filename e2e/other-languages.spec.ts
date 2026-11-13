import { expect } from "@playwright/test";
import { test } from "./editor-fixture";
import { state, useMember, enMessages, formatMessage, waitForClientRoute, waitForFormReady, openPostSettings } from "./helpers";
import { greekReply, writeOtherLanguageReply } from "./other-languages-flow";

for (const locale of ["en", "ja"] as const) test(`unopened language replies preserve their language and reach readers in ${locale}`, async ({ page }) => {
  await page.context().addCookies([{ name: "PARAGLIDE_LOCALE", value: locale, url: state().baseURL }]);
  await useMember(page, `scribe_other_${locale}@example.com`);
  await writeOtherLanguageReply(page, locale);
});

test("a background source check updates the posted language", async ({ page }) => {
  await page.context().addCookies([{ name: "PARAGLIDE_LOCALE", value: "en", url: state().baseURL }]);
  await useMember(page, "scribe_other_check@example.com");
  await page.goto("/t/new");
  await waitForClientRoute(page);
  await page.getByRole("textbox", { name: enMessages.field_title, exact: true }).fill("Source check scenario");
  // The local whole-text detector sees English; the fake background checker sees
  // the Greek opening in its deliberately bounded sample.
  const body = greekReply.repeat(12) + "\n\n" + "The people are here to discuss the work and to learn from each other. ".repeat(60);
  await page.locator('textarea[name="body"]').fill(body);
  await page.getByRole("button", { name: enMessages.submit_post, exact: true }).click();
  await expect(page).toHaveURL(url => /^\/t\/\d+$/.test(url.pathname));
  await expect(page.getByRole("status").filter({ hasText: "Greek" }).getByRole("link", { name: enMessages.posted_fix_lang, exact: true })).toBeVisible({ timeout: 60_000 });
  await page.goto("/latest?order=created");
  await expect(page.getByRole("link", { name: /Source check scenario/ })).toBeVisible();
  await page.goto("/a/en?order=created");
  await expect(page.getByRole("link", { name: /Source check scenario/ })).toHaveCount(0);
});

test("an explicit source choice stays unchanged and offers an in-app repair link", async ({ page }) => {
  await page.context().addCookies([{ name: "PARAGLIDE_LOCALE", value: "en", url: state().baseURL }]);
  await useMember(page, "scribe_other_mismatch@example.com");
  await page.goto("/t/new");
  await waitForClientRoute(page);
  await page.getByRole("textbox", { name: enMessages.field_title, exact: true }).fill("Explicit source scenario");
  await page.locator('textarea[name="body"]').fill("The people are here to discuss the work and to learn from each other.");
  await page.getByRole("button", { name: enMessages.submit_post, exact: true }).click();
  await expect(page).toHaveURL(url => /^\/t\/\d+$/.test(url.pathname));
  const form = page.locator("form", { has: page.locator('textarea[name="body"]') });
  await waitForFormReady(form);
  await form.locator('textarea[name="body"]').fill(greekReply);
  await openPostSettings(page);
  await page.getByRole("combobox", { name: enMessages.field_lang_reply, exact: true }).click();
  await page.getByRole("option", { name: "English", exact: true }).click();
  await form.getByRole("button", { name: enMessages.submit_reply, exact: true }).click();
  const mismatch = formatMessage(enMessages.posted_language_mismatch, { lang: "English" });
  await expect(page.getByRole("status").filter({ hasText: mismatch })).toBeVisible({ timeout: 60_000 });
  await page.goto("/notifications");
  await page.getByRole("link").filter({ hasText: mismatch }).click();
  await expect(page).toHaveURL(url => /^\/c\/\d+\/edit$/.test(url.pathname));
  await expect(page.locator('input[name="lang"]')).toHaveValue("en");
});

test("public readers can read the English translation of an unopened source", async ({ page, browser }) => {
  await page.context().addCookies([{ name: "PARAGLIDE_LOCALE", value: "en", url: state().baseURL }]);
  await useMember(page, "scribe_other_public@example.com");
  const topic = await writeOtherLanguageReply(page, "en");
  const context = await browser.newContext({ locale: "en-US" });
  try {
    const reader = await context.newPage();
    await reader.goto(`${state().baseURL}${topic}?lang=en`);
    await expect(reader.locator('article[id^="c-"]').last()).toContainText("[en]");
  } finally { await context.close(); }
});
