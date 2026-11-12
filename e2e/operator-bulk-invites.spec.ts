import { expect, test } from "@playwright/test";
import { captureScreenshot, enMessages as m, useMember, waitForClientRoute } from "./helpers";

test("an operator pastes two addresses and sees a delivery result for each", async ({ page }) => {
  await useMember(page, "bulk_invite_operator@example.com", "/invites/new");
  await waitForClientRoute(page);
  await expect(page.getByRole("checkbox", { name: m.invites_bulk_send_email, exact: true })).toBeChecked();
  await page.getByLabel(m.invites_bulk_emails, { exact: true }).fill("bulk_browser_a@example.com\nbulk_browser_b@example.com");
  await page.getByRole("button", { name: m.invites_bulk_submit, exact: true }).click();
  const results = page.getByRole("region", { name: m.invites_bulk_results, exact: true });
  for (const email of ["bulk_browser_a@example.com", "bulk_browser_b@example.com"]) {
    await expect(results.getByRole("listitem").filter({ hasText: email })).toContainText(m.invites_result_sent);
  }
  await expect(results.locator("code")).toHaveCount(0);
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await captureScreenshot(page, { path: `operator-bulk-invites-${width}.png`, fullPage: true }, "operator-bulk-invites");
  }
});
