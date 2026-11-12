import { test, expect } from "@playwright/test";
import { useMember, enMessages as en } from "./helpers";

test("community numbers and their Markdown twin follow reading access on narrow screens", async ({ page, request }, testInfo) => {
  const publicReading = Boolean(testInfo.config.metadata.publicReading);
  const anonymous = await request.get("/stats", { maxRedirects: 0 });
  expect(anonymous.status()).toBe(publicReading ? 200 : 302);
  expect((await request.get("/stats.md")).status()).toBe(publicReading ? 200 : 401);
  expect((await request.get("/stats.txt")).status()).toBe(publicReading ? 200 : 401);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(publicReading ? "/stats" : "/login");
  await expect(page.locator('footer a[href="/stats"]')).toHaveCount(publicReading ? 1 : 0);
  await useMember(page, "stats_reader@example.com", "/stats");
  await expect(page.getByRole("heading", { level: 1, name: en.stats_title })).toBeVisible();
  for (const title of [en.stats_reading_title, en.stats_system, en.stats_evaluation, en.stats_reactions, en.stats_scale, en.stats_active, en.stats_retention]) {
    await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
  }
  // Public documents are the same HTML for everyone, so a closed site shows the entry on member pages only.
  if (publicReading) await expect(page.locator('footer a[href="/stats"]')).toHaveText(en.stats_title);
  await expect(page.locator('link[rel="alternate"][type="text/markdown"]')).toHaveAttribute("href", "/stats.md?lang=en");
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  const twin = await page.request.get("/stats.md?lang=en");
  expect(twin.status()).toBe(200);
  const markdown = await twin.text();
  const textTwin = await page.request.get("/stats.txt?lang=en");
  expect(textTwin.status()).toBe(200);
  expect(await textTwin.text()).toBe(markdown);
  const collected = page.locator('main time').first();
  await expect(collected).toBeVisible();
  expect(await collected.textContent()).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  for (const title of [en.stats_reading_title, en.stats_title, en.stats_evaluation, en.stats_reactions, en.stats_scale]) expect(markdown).toContain(title);
  for (const text of [en.metrics_ai_title, en.metrics_dir_title, en.metrics_via_title, en.quality_eval_fake]) expect(markdown).not.toContain(text);
  await page.goto("/");
  await expect(page.locator('footer a[href="/stats"]')).toHaveText(en.stats_title);
});
