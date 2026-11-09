import { expect } from "@playwright/test";
import { test } from "./editor-fixture";
import { enMessages as en, titleField, useMember, waitForFormReady } from "./helpers";

const saved = (page: import("@playwright/test").Page) => expect(page.locator("[data-draft-autosave]")).toHaveAttribute("data-draft-autosave", "saved");

test("autosave restores the question checkbox and persists taking it off on the draft screen", async ({ page }) => {
  await useMember(page, "asks_checkbox_autosave@example.com", "/t/new");
  const checkbox = page.getByRole("checkbox", { name: en.asks_stance_checkbox, exact: true });
  await waitForFormReady(page.locator("form", { has: checkbox }));
  await titleField(page).fill("A question that becomes an ordinary post");
  await page.locator('textarea[name="body"]').fill("The draft keeps the selected option.");
  await checkbox.check();
  await saved(page);
  const id = await page.locator('input[name="fromDraft"]').inputValue();
  await page.goto(`/drafts/${id}`);
  await waitForFormReady(page.locator("form", { has: checkbox }));
  await expect(checkbox).toBeChecked();
  await checkbox.uncheck();
  await saved(page);
  await page.reload();
  await waitForFormReady(page.locator("form", { has: checkbox }));
  await expect(checkbox).not.toBeChecked();
  await expect(titleField(page)).not.toHaveAttribute("required", "");
  await page.getByRole("button", { name: en.draft_publish, exact: true }).click();
  await expect(page).toHaveURL(/\/t\/\d+\?posted=/);
  await expect(page.locator("article").first().getByText(en.question_badge, { exact: true })).toHaveCount(0);
});
