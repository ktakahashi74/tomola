import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { captureScreenshot, state, uiMessages, useMember, waitForClientRoute } from "./helpers";
import { testOperator } from "./operator-fixture";

for (const locale of ["en", "ja"]) {
  test(`AI-use page and Markdown are public in ${locale} at reading widths`, async ({ browser, baseURL }) => {
    const context = await browser.newContext({ baseURL, locale, ignoreHTTPSErrors: true });
    try {
      await context.addCookies([{ name: "PARAGLIDE_LOCALE", value: locale, url: baseURL! }]);
      const page = await context.newPage();
      for (const width of [390, 1280]) {
        await page.setViewportSize({ width, height: 900 });
        const response = await page.goto("/ai-use");
        expect(response!.status()).toBe(200);
        expect(response!.headers()["x-robots-tag"]).toContain("noindex");
        await waitForClientRoute(page);
        const messages = await uiMessages(page);
        const fixture = JSON.parse(fs.readFileSync(path.join(state().dir, "ai-use.json"), "utf8"));
        await expect(page.getByRole("heading", { level: 1, name: messages.ai_use_title, exact: true })).toBeVisible();
        await expect(page.locator('[data-ai-purpose="translation-primary"]')).toContainText(fixture.model);
        await expect(page.locator('[data-ai-purpose="translation-retry"]')).toContainText(messages.ai_use_disabled);
        await expect(page.getByText(testOperator.aiUse.humanReview![locale], { exact: true })).toBeVisible();
        await expect(page.getByRole("link", { name: messages.ai_use_objections_link, exact: true })).toHaveAttribute("href", testOperator.aiUse.objectionsUrl!);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await captureScreenshot(page, { path: `ai-use-${locale}-${width}.png`, fullPage: true }, "e2e-ai-use");
      }
      for (const suffix of ["md", "txt"]) {
        const response = await context.request.get(`/ai-use.${suffix}?lang=${locale}`);
        expect(response.status()).toBe(200);
        expect(response.headers()["x-robots-tag"]).toContain("noindex");
        const body = await response.text();
        expect(body).toContain("id: ai-use");
        expect(body).toContain(`lang: ${locale}`);
      }
    } finally { await context.close(); }
  });
}

test("article translation provenance opens the public AI-use page and retains its model tooltip", async ({ page, baseURL }) => {
  const fixture = JSON.parse(fs.readFileSync(path.join(state().dir, "ai-use.json"), "utf8"));
  await useMember(page, "zai_use_reader@example.com");
  await page.context().addCookies([{ name: "PARAGLIDE_LOCALE", value: "en", url: baseURL! }]);
  await page.goto(`/t/${fixture.id}?lang=en`);
  await waitForClientRoute(page);
  const link = page.locator('[data-reading-language] a[href="/ai-use"]');
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute("title", fixture.model);
  const response = page.waitForResponse(value => value.request().isNavigationRequest() && new URL(value.url()).pathname === "/ai-use");
  await link.click();
  expect((await response).status()).toBe(200);
  const messages = await uiMessages(page);
  await expect(page.getByRole("heading", { level: 1, name: messages.ai_use_title, exact: true })).toBeVisible();
});
