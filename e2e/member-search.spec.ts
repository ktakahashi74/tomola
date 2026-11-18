import path from "node:path";
import { test, expect } from "@playwright/test";
import { enMessages as en, useMember, waitForHydration } from "./helpers";

test("members find a name fragment and open the member page, with no section for an unmatched query", async ({ page }) => {
  await useMember(page, "zmember_search_reader@example.com", "/search?lang=en");
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/search?lang=en");
    await waitForHydration(page);
    const input = page.locator("main").getByRole("searchbox");
    await input.fill("見すみ");
    await input.press("Enter");
    const members = page.getByRole("region", { name: en.search_members, exact: true });
    await expect(members.getByRole("heading", { level: 2, name: en.search_members, exact: true })).toBeVisible();
    const link = members.getByRole("link", { name: "Sumire Kazami @zmember_search_target", exact: true });
    await expect(link).toHaveAttribute("href", "/u/zmember_search_target");
    await expect(members.locator("img")).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    if (process.env.E2E_EVIDENCE_DIR) await page.screenshot({ path: path.join(process.env.E2E_EVIDENCE_DIR, `member-search-${width}-${process.env.E2E_PUBLIC_READING === "1" ? "public" : "private"}.png`) });
    await link.click();
    await expect(page).toHaveURL(url => url.pathname === "/u/zmember_search_target");
    await expect(page.locator("main")).toContainText("Sumire Kazami");
    await page.goto("/search?q=zmember-search-no-such-name&lang=en");
    await expect(members).toHaveCount(0);
    await expect(page.locator("main").getByRole("searchbox")).toHaveValue("zmember-search-no-such-name");
  }
});
