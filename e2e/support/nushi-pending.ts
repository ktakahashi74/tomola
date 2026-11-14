import { expect, type Locator, type Page } from "@playwright/test";
import { enMessages as en } from "../helpers";

export async function expectNushiPending(page: Page, status: Locator) {
  await expect(status).toBeVisible();
  await expect(status).toMatchAriaSnapshot(`- status: ${en.nushi_pending}`);
  await expect(status.locator('[aria-hidden="true"]')).toHaveText("...");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  for (const [time, opacity] of [[0, [0, 0, 0]], [400, [1, 0, 0]], [650, [1, 1, 0]], [900, [1, 1, 1]]] as const) {
    expect(await status.locator(".nushi-pending-dots > span").evaluateAll((elements, time) => elements.map(element => {
      const animation = element.getAnimations()[0];
      animation.pause(); animation.currentTime = time;
      return Number(getComputedStyle(element).opacity);
    }), time)).toEqual(opacity);
  }
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(await status.locator(".nushi-pending-dots > span").evaluateAll(elements => elements.map(element => [getComputedStyle(element).animationName, getComputedStyle(element).opacity]))).toEqual([["none", "1"], ["none", "1"], ["none", "1"]]);
  await expect(status).toMatchAriaSnapshot(`- status: ${en.nushi_pending}`);
  await page.emulateMedia({ reducedMotion: "no-preference" });
}
