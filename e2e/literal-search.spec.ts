import fs from "node:fs";
import path from "node:path";
import { test, expect } from "@playwright/test";
import { enMessages as en, state, useMember } from "./helpers";

test("finds saved original and translated words, opens the article, and explains literal-only results", async ({ page }) => {
  const fixture = JSON.parse(fs.readFileSync(path.join(state().dir, "literal-search.json"), "utf8")) as { topic: number };
  await useMember(page, "zliteral_reader@example.com", "/search?lang=en");
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/search?lang=en");
    const input = page.locator("main").getByRole("searchbox");
    await input.fill("literal-browser-needle");
    await input.press("Enter");
    const result = page.locator("main li", { has: page.locator(`a[href^='/t/${fixture.topic}']`) });
    await expect(result.getByText(en.search_match_literal, { exact: true })).toBeVisible();
    await expect(result).toContainText("literal-browser-needle");
    await expect(result).toContainText(`${en.search_match_original} ${en.language_name_ja}`);
    await expect(result.locator('[data-meta-item="badge"]')).toHaveCount(3);
    const words = await result.locator("[data-list-meta] > [data-meta-item]").evaluateAll(items => items.map(item => item.textContent ?? ""));
    expect(words.slice(0, -1).every(item => item.endsWith(" "))).toBe(true);
    await expect(result.locator("time")).toHaveCount(1);
    if (process.env.LLM_MONTHLY_BUDGET_USD === "0") await expect(page.getByRole("status").filter({ hasText: en.search_literal_only })).toBeVisible();
    if (process.env.E2E_EVIDENCE_DIR) await page.screenshot({ path: path.join(process.env.E2E_EVIDENCE_DIR, `literal-search-results-${width}-${process.env.LLM_MONTHLY_BUDGET_USD === "0" ? "paused" : "combined"}.png`) });
    const markdown = page.locator("main").getByRole("link", { name: en.search_markdown, exact: true });
    const mdUrl = new URL((await markdown.getAttribute("href"))!, page.url());
    expect(mdUrl.searchParams.get("lang")).toBe("en");
    const response = await page.request.get(mdUrl.href);
    expect(response.status()).toBe(200);
    expect(await response.text()).toContain(process.env.LLM_MONTHLY_BUDGET_USD === "0" ? "search_status: literal_only" : "search_status: combined");
    const link = result.getByRole("link", { name: "A reading note found by its words", exact: true });
    await link.click();
    await expect(page).toHaveURL(url => url.pathname === `/t/${fixture.topic}` && url.searchParams.get("lang") === "en");
    await expect(page.locator("main")).toContainText("translated-browser-needle");
    await page.goto("/search?q=translated-browser-needle&lang=en");
    await expect(page.locator("main li").filter({ hasText: "translated-browser-needle" })).toContainText(en.search_match_literal);
    await page.goto("/search?q=literal-browser-nothing-found&lang=en");
    // Other browser tests add readable posts, and the fake embeddings can return them as similar in meaning, so only the literal part is empty for certain.
    await expect(page.locator("main li").filter({ hasText: en.search_match_literal })).toHaveCount(0);
    if (process.env.LLM_MONTHLY_BUDGET_USD === "0") {
      await expect(page.locator("main")).toContainText(en.search_no_results);
      await expect(page.getByRole("status").filter({ hasText: en.search_literal_only })).toBeVisible();
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    if (process.env.E2E_EVIDENCE_DIR) await page.screenshot({ path: path.join(process.env.E2E_EVIDENCE_DIR, `literal-search-${width}-${process.env.LLM_MONTHLY_BUDGET_USD === "0" ? "paused" : "combined"}.png`) });
  }
});
