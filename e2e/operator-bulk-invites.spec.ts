import { expect, test } from "@playwright/test";
import { captureScreenshot, enMessages as m, useMember, waitForClientRoute } from "./helpers";

test("an operator sends a batch and shares a single manually created invitation", async ({ page }) => {
  await page.addInitScript(() => {
    const writes = { clipboard: "", shared: "" };
    Object.assign(window, { __invitationWrites: writes });
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { writes.clipboard = text; } } });
    Object.defineProperty(navigator, "share", { configurable: true, value: async ({ text }: { text: string }) => { writes.shared = text; } });
  });
  await useMember(page, "invite_bulk_operator@example.com", "/invites/new");
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
  await page.getByRole("checkbox", { name: m.invites_bulk_send_email, exact: true }).uncheck();
  await page.getByLabel(m.invites_bulk_emails, { exact: true }).fill("bulk_browser_links_a@example.com\nbulk_browser_links_b@example.com");
  await page.getByRole("button", { name: m.invites_bulk_submit, exact: true }).click();
  await expect(results.locator("code")).toHaveCount(2);
  await expect(results.getByRole("button", { name: m.invites_copy_message, exact: true })).toHaveCount(0);
  await expect(results.getByRole("button", { name: m.invites_share, exact: true })).toHaveCount(0);
  await page.getByLabel(m.invites_bulk_emails, { exact: true }).fill("bulk_browser_single@example.com");
  await page.getByRole("button", { name: m.invites_bulk_submit, exact: true }).click();
  await expect(results.locator("code")).toHaveCount(1);
  const url = await results.locator("code").innerText();
  const message = await results.getByLabel(m.invites_message_label, { exact: true }).inputValue();
  expect(message).toContain(url);
  await results.getByRole("button", { name: m.invites_copy_message, exact: true }).click();
  await expect(results.getByRole("status")).toHaveText(m.invites_message_copied);
  await results.getByRole("button", { name: m.invites_share, exact: true }).click();
  expect(await page.evaluate(() => (window as unknown as { __invitationWrites: { clipboard: string; shared: string } }).__invitationWrites))
    .toEqual({ clipboard: message, shared: message });
});
