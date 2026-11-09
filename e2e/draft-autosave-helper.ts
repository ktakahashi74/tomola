import { expect, type Page } from "@playwright/test";
import { waitForFormReady } from "./helpers";

// Existing scenarios that continue on the draft page now wait for automatic saving.
export async function saveEditorDraft(page: Page) {
  await expect(page.locator('[data-draft-autosave]')).toHaveAttribute("data-draft-autosave", "saved");
  if (new URL(page.url()).pathname === "/t/new") {
    const id = await page.locator('input[name="fromDraft"]').inputValue();
    await page.goto(`/drafts/${id}?saved=1`);
    await waitForFormReady(page.locator("form", { has: page.locator('textarea[name="body"]') }).first());
  }
}
