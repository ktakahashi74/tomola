import { test, expect } from "@playwright/test";
import { captureScreenshot, enMessages as en, useMember, waitForHydration } from "./helpers";

test("members find villages by name and follow their links with the shared search placeholder", async ({ page }) => {
  await useMember(page, "zvillage_search_reader@example.com", "/search?lang=en");
  const enabled = process.env.E2E_PUBLIC_READING === "1" || process.env.E2E_VILLAGES === "1";
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/search?lang=en");
    await waitForHydration(page);
    if (width >= 640) await expect(page.locator("header").getByRole("searchbox")).toHaveAttribute("placeholder", en.nav_search_placeholder);
    const input = page.locator("main").getByRole("searchbox");
    await input.fill("Alpine geometry");
    await input.press("Enter");
    await expect(input).toHaveValue("Alpine geometry");
    await waitForHydration(page);
    const section = page.getByRole("region", { name: en.search_villages, exact: true });
    if (enabled) {
      await expect(section.getByRole("heading", { level: 2, name: en.search_villages, exact: true })).toBeVisible();
      const link = section.getByRole("link", { name: "Alpine geometry circle", exact: true });
      await expect(link).toHaveAttribute("href", "/v/alpine-geometry?lang=en");
      await expect(section.locator("img")).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await captureScreenshot(page, { path: `village-search-${width}.png` }, "village-search");
      await link.click();
      await expect(page).toHaveURL(url => url.pathname === "/v/alpine-geometry");
      await expect(page.locator("main")).toContainText("Alpine geometry circle");
    } else {
      await expect(section).toHaveCount(0);
    }
    await page.goto("/search?q=zvillage-search-no-such-place&lang=en");
    await expect(section).toHaveCount(0);
  }
});
