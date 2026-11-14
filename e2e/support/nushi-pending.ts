import { expect, type Locator, type Page } from "@playwright/test";
import { enMessages as en } from "../helpers";

export async function expectNushiPending(page: Page, status: Locator) {
  await expect(status).toBeVisible();
  await expect(status).toMatchAriaSnapshot(`- status: ${en.nushi_pending}`);
  await expect(status.locator('[aria-hidden="true"]')).toHaveText("...");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const dots = await status.locator(".nushi-pending-dots > span").evaluateAll(elements => elements.map(element => {
    const style = getComputedStyle(element);
    return { name: style.animationName, delay: style.animationDelay };
  }));
  expect(dots).toHaveLength(3);
  expect(dots.every(dot => dot.name !== "none")).toBe(true);
  expect(new Set(dots.map(dot => dot.delay)).size).toBe(3);
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(await status.locator(".nushi-pending-dots > span").evaluateAll(elements => elements.map(element => [getComputedStyle(element).animationName, getComputedStyle(element).opacity]))).toEqual([["none", "1"], ["none", "1"], ["none", "1"]]);
  await expect(status).toMatchAriaSnapshot(`- status: ${en.nushi_pending}`);
  await page.emulateMedia({ reducedMotion: "no-preference" });
}
