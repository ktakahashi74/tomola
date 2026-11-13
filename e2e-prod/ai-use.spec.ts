import { test, expect, waitForClientRoute } from "./helpers";
import { uiMessages } from "../e2e/helpers";

test("production AI-use disclosure is anonymous, localized and works under the CSP", async ({ browser, baseURL }) => {
  for (const locale of ["en", "ja"]) {
    const context = await browser.newContext({ baseURL, locale, ignoreHTTPSErrors: true, serviceWorkers: "block" });
    try {
      await context.addCookies([{ name: "PARAGLIDE_LOCALE", value: locale, url: baseURL! }]);
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      page.on("console", message => { if (/Content Security Policy|Refused to/i.test(message.text())) errors.push(message.text()); });
      const response = await page.goto("/ai-use");
      expect(response!.status()).toBe(200);
      expect(response!.headers()["content-security-policy"]).toContain("nonce-");
      await waitForClientRoute(page);
      const messages = await uiMessages(page);
      await expect(page.getByRole("heading", { level: 1, name: messages.ai_use_title, exact: true })).toBeVisible();
      await expect(page.locator('link[rel="alternate"][type="text/markdown"]')).toHaveAttribute("href", `/ai-use.md?lang=${locale}`);
      const markdown = await context.request.get(`/ai-use.md?lang=${locale}`);
      expect(markdown.status()).toBe(200);
      const body = await markdown.text();
      expect(body).toContain("id: ai-use");
      expect(body).toContain(`lang: ${locale}`);
      expect(errors).toEqual([]);
    } finally { await context.close(); }
  }
});
