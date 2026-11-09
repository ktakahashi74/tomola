import { expect } from "@playwright/test";
import { test } from "./editor-fixture";
import { enMessages, jaMessages } from "./helpers";

test("an unmatched URL has a localized 404, title, home link and security headers", async ({ browser }) => {
  for (const [locale, messages] of [["ja-JP", jaMessages], ["en-US", enMessages]] as const) {
    const context = await browser.newContext({ locale });
    try {
      const page = await context.newPage();
      const response = await page.goto("/no-such-page");
      expect(response!.status()).toBe(404);
      await expect(page.locator("html")).toHaveAttribute("lang", locale === "ja-JP" ? "ja" : "en");
      await expect(page.getByRole("heading", { level: 1, name: messages.error_title_not_found, exact: true })).toBeVisible();
      await expect(page.getByText(messages.error_body_not_found, { exact: true })).toBeVisible();
      await expect(page.getByText("404", { exact: true })).toBeVisible();
      await expect(page).toHaveTitle(`${messages.error_title_not_found} · ${messages.site_name}`);
      // The usual header and footer stay around the message, and the one next step is the home page.
      await expect(page.getByRole("banner").getByRole("link", { name: messages.site_name, exact: true })).toHaveAttribute("href", "/");
      await expect(page.getByRole("main").getByRole("link", { name: messages.error_go_home, exact: true })).toHaveAttribute("href", "/");
      await expect(page.getByRole("contentinfo")).toBeVisible();
      expect(response!.headers()["x-content-type-options"]).toBe("nosniff");
      expect(response!.headers()["referrer-policy"]).toBe("strict-origin-when-cross-origin");
      expect(response!.headers()["permissions-policy"]).toBeTruthy();
      expect(response!.headers()["vary"]).toContain("Accept-Language");
    } finally {
      await context.close();
    }
  }
});
