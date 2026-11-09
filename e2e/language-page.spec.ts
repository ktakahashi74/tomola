import fs from "node:fs";
import path from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { openUserMenu, signUp, state, uiMessages, waitForClientRoute } from "./helpers";
import { testOperator } from "./operator-fixture";
import { LANG_LABELS } from "../app/lib/languages";

async function capture(page: Page, name: string) {
  if (!process.env.E2E_EVIDENCE_DIR) return;
  fs.mkdirSync(process.env.E2E_EVIDENCE_DIR, { recursive: true });
  await page.screenshot({ path: path.join(process.env.E2E_EVIDENCE_DIR, `${name}.png`), fullPage: true, animations: "disabled" });
}

for (const locale of ["ja", "en"]) {
  test(`anonymous language page, email draft and navigation in ${locale}`, async ({ browser }) => {
    const context = await browser.newContext({ locale });
    const page = await context.newPage();
    try {
      for (const width of [390, 1280]) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto("/languages");
        await waitForClientRoute(page);
        const messages = await uiMessages(page);
        await expect(page.getByRole("heading", { level: 1, name: messages.languages_title, exact: true })).toBeVisible();
        const mail = new URL((await page.getByRole("link", { name: messages.languages_request_email, exact: true }).getAttribute("href"))!);
        expect(mail.pathname).toBe(testOperator.contactEmail);
        expect(mail.searchParams.get("subject")).toBe(messages.languages_request_subject);
        expect(mail.searchParams.get("body")).toBe(messages.languages_request_body);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await capture(page, `page-${locale}-${width}`);
        await page.goto("/login");
        await waitForClientRoute(page);
        await page.getByRole("combobox", { name: messages.language_select, exact: true }).click();
        const other = page.getByRole("option", { name: messages.languages_other, exact: true });
        await expect(page.getByRole("option").last()).toHaveAttribute("href", "/languages");
        await expect(other).toBeVisible();
        await capture(page, `menu-${locale}-${width}`);
        // Keyboard activation follows the same link without changing the interface language.
        await other.focus();
        await page.keyboard.press("Enter");
        await expect(page.getByRole("listbox")).toHaveCount(0);
        await expect(page).toHaveURL(/\/languages$/);
        await expect(page.locator("html")).toHaveAttribute("lang", locale);
        await page.goto("/principles");
        await waitForClientRoute(page);
        const link = page.getByRole("main").getByRole("link", { name: messages.languages_other, exact: true });
        await expect(link).toBeVisible();
        await capture(page, `principles-${locale}-${width}`);
        await link.click();
        await expect(page).toHaveURL(/\/languages$/);
      }
      const markdown = await context.request.get(`/languages.md?lang=${locale}`);
      expect(markdown.ok()).toBe(true);
      expect(await markdown.text()).toContain("id: languages");
      await page.goto("/login");
      await waitForClientRoute(page);
      const messages = await uiMessages(page);
      const next = locale === "ja" ? "en" : "ja";
      await page.getByRole("combobox", { name: messages.language_select, exact: true }).click();
      await page.getByRole("option", { name: LANG_LABELS[next], exact: true }).click();
      await expect(page.locator("html")).toHaveAttribute("lang", next);
    } finally { await context.close(); }
  });

  test(`other main language keeps signup open in ${locale}`, async ({ browser }) => {
    const context = await browser.newContext({ locale });
    const page = await context.newPage();
    try {
      const invitations = JSON.parse(fs.readFileSync(path.join(state().dir, "language-page.json"), "utf8"));
      await signUp(page, invitations[locale], `language_page_${locale}@example.com`, { handle: `lp_signup_${locale}`, mainLang: "other" }, async () => {
        const messages = await uiMessages(page);
        const link = page.getByRole("main").getByRole("link", { name: messages.languages_signup, exact: true });
        await expect(link).toHaveCount(0);
        const choose = async (name: string) => {
          await page.getByRole("combobox", { name: messages.onboarding_home_area, exact: true }).click();
          await page.getByRole("option", { name, exact: true }).click();
        };
        await choose(messages.area_other);
        await expect(link).toHaveAttribute("href", "/languages");
        for (const width of [390, 1280]) {
          await page.setViewportSize({ width, height: 900 });
          await capture(page, `signup-${locale}-${width}`);
        }
        await link.click();
        await expect(page).toHaveURL(/\/languages$/);
        await page.goBack();
        await expect(link).toBeVisible();
        await choose("English");
        await expect(link).toHaveCount(0);
      });
      const exported = await (await context.request.get("/settings/export")).json();
      expect(exported.profile.home_area).toBe("other");
      for (const width of [390, 1280]) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto("/");
        const messages = await uiMessages(page);
        const menu = await openUserMenu(page);
        await menu.getByRole("menuitem", { name: messages.nav_language, exact: true }).click();
        const other = page.getByRole("menuitem", { name: messages.languages_other, exact: true });
        await expect(other).toHaveAttribute("href", "/languages");
        await capture(page, `member-menu-${locale}-${width}`);
        await other.click();
        await expect(page).toHaveURL(/\/languages$/);
        await expect(page.locator("html")).toHaveAttribute("lang", locale);
      }
    } finally { await context.close(); }
  });
}
