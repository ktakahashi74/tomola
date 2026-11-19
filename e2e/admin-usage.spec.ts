import { expect, test } from "@playwright/test";
import { uiMessages, useMember } from "./helpers";

test("an operator can see settled input-only usage", async ({ page }) => {
  await useMember(page, "usage_operator@example.com", "/admin/usage");
  const m = await uiMessages(page);
  await expect(page.getByRole("heading", { name: m.usage_title })).toBeVisible();
  const row = page.getByRole("row").filter({ has: page.getByRole("cell", { name: "claude-usage-fixture", exact: true }) });
  await expect(row).toBeVisible();
  await expect(row.getByRole("cell", { name: "12", exact: true })).toBeVisible();
});
