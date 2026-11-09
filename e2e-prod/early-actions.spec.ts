import fs from "node:fs";
import path from "node:path";
import { expect, state, test, useMember, watchCsp } from "./helpers";
import { earlyFocus, earlyReports, earlySettings } from "../e2e/support/early-actions";
import type { EarlyFixture } from "../e2e/seed-early-actions";

test.use({ serviceWorkers: "block" });
test("early settings activation survives production hydration under CSP", async ({ page }) => {
  const watch = await watchCsp(page);
  await useMember(page, "early_settings@example.com");
  await page.addInitScript(() => {
    let shown: number | null = null;
    const observer = new MutationObserver(() => {
      if (document.querySelector('#settings-email button[type="submit"]')) shown ??= performance.now();
      else if (shown !== null) {
        (window as Window & { settingsFallbackMs?: number }).settingsFallbackMs = performance.now() - shown;
        observer.disconnect();
      }
    });
    observer.observe(document, { childList: true, subtree: true });
  });
  await page.goto("/settings");
  await page.waitForFunction(() => (window as Window & { settingsFallbackMs?: number }).settingsFallbackMs !== undefined);
  const exposureMs = await page.evaluate(() => (window as Window & { settingsFallbackMs?: number }).settingsFallbackMs!);
  console.log(`Settings fallback button visible for ${exposureMs.toFixed(1)} ms`);
  expect(exposureMs).toBeLessThan(1500);
  await earlySettings(page);
  expect(watch.violations).toEqual([]);
  expect(watch.pageErrors).toEqual([]);
  expect(watch.hydrationWarnings).toEqual([]);
});
test("closing the production language popup keeps the writer's new focus", async ({ page }) => {
  await useMember(page, "early_focus@example.com");
  await earlyFocus(page);
});
test("early reply reports survive production hydration under CSP", async ({ page }) => {
  const watch = await watchCsp(page);
  await useMember(page, "early_reports@example.com");
  const fixture: EarlyFixture = JSON.parse(fs.readFileSync(path.join(state().dir, "early-actions.json"), "utf8"));
  await earlyReports(page, fixture);
  expect(watch.violations).toEqual([]);
  expect(watch.pageErrors).toEqual([]);
  expect(watch.hydrationWarnings).toEqual([]);
});
