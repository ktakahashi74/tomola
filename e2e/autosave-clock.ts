import { expect, type BrowserContext, type Page } from "@playwright/test";

// Advance browser debounce time only; persistence still uses the real server.
export async function autosaveState(page: Page, state: "saved" | "failed") {
  await expect(page.locator('form[data-autosave="ready"]')).toHaveCount(1);
  await page.clock.fastForward(3000);
  await expect(page.locator("[data-draft-autosave]")).toHaveAttribute("data-draft-autosave", state);
}

// Allow a short real-time window for unintended writes before negative assertions.
export async function autosaveQuiet(page: Page, ms = 3000) {
  await page.clock.fastForward(ms);
  await page.waitForTimeout(500);
}

export async function autosavePage(context: BrowserContext) {
  const page = await context.newPage();
  await page.clock.install();
  return page;
}
