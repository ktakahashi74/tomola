import fs from "node:fs";
import path from "node:path";
import { expect, type Page } from "@playwright/test";

export async function captureListRows(page: Page, screen: string) {
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const rows = page.locator("main li[id^=q-]");
    expect(await rows.count()).toBeGreaterThan(0);
    expect(await rows.locator("time").count()).toBe(await rows.count());
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    if (process.env.E2E_EVIDENCE_DIR) {
      fs.mkdirSync(process.env.E2E_EVIDENCE_DIR, { recursive: true });
      await page.screenshot({ path: path.join(process.env.E2E_EVIDENCE_DIR, `${screen}-${width}.png`), animations: "disabled" });
    }
  }
  await page.setViewportSize({ width: 1280, height: 900 });
}
