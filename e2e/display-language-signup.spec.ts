import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { captureScreenshot, clientHeaders, completeTrialFields, confirmMagicLink, enMessages as en, jaMessages as ja, requestMagicLink, state, waitForClientRoute } from "./helpers";

test("Japanese main language sets the display language after signup in an English browser and on another device", async ({ browser }, testInfo) => {
  const context = await browser.newContext({ locale: "en-US", extraHTTPHeaders: clientHeaders("192.0.2.246") });
  try {
    const { invitation } = JSON.parse(fs.readFileSync(path.join(state().dir, "display-language-signup.json"), "utf8"));
    const page = await context.newPage();
    await page.goto(invitation);
    await confirmMagicLink(page, await requestMagicLink(page, "locale_signup@example.com"));
    await expect(page).toHaveURL(/\/onboarding(?:\?|$)/);
    await waitForClientRoute(page);
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await page.getByRole("textbox", { name: en.onboarding_handle, exact: true }).fill("locale_signup");
    await page.getByRole("combobox", { name: en.onboarding_home_area, exact: true }).click();
    await page.getByRole("listbox").getByRole("option", { name: "日本語", exact: true }).click();
    await completeTrialFields(page);
    await page.getByRole("button", { name: en.onboarding_join, exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("lang", "ja");
    expect((await context.cookies()).find(cookie => cookie.name === "PARAGLIDE_LOCALE")?.value).toBe("ja");
    await page.goBack();
    await page.waitForLoadState("load");
    await expect(page.locator("[data-member-menu-trigger]")).toHaveAttribute("title", "@locale_signup");
    await expect.poll(async () => {
      try { return await page.evaluate(() => window.history.state?.onboarding ?? null); }
      catch (error) {
        if (error instanceof Error && error.message.includes("Execution context was destroyed")) return "navigating";
        throw error;
      }
    }).toBeNull();
    await page.goto("/settings");
    await expect(page.locator("#settings-languages").getByRole("combobox", { name: ja.language_select, exact: true }).locator('[data-slot="select-value"]')).toHaveText("日本語");
    await expect(page.locator("#settings-display-lang")).not.toBeVisible();
    await captureScreenshot(page, { path: testInfo.outputPath("languages-ja.png"), fullPage: true }, "display-language");
    await context.clearCookies({ name: "PARAGLIDE_LOCALE" });
    await page.goto("/settings?lang=fr");
    await expect(page.locator("html")).toHaveAttribute("lang", "ja");
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("lang", "ja");
  } finally { await context.close(); }
});
