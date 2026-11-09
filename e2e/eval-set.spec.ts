import path from "node:path";
import fs from "node:fs";
import { test, expect } from "@playwright/test";
import { useMember, clientHeaders, enMessages as en, jaMessages as ja } from "./helpers";

test("operators can compare evaluation runs and aggregate use signals on desktop and mobile", async ({ browser }) => {
  const evidence = process.env.E2E_EVIDENCE_DIR;
  for (const [locale, width, messages] of [["en-US", 1280, en], ["ja-JP", 390, ja]] as const) {
    const context = await browser.newContext({ locale, viewport: { width, height: 1000 }, extraHTTPHeaders: clientHeaders("10.54.21.1") });
    try {
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      await useMember(page, "mobile@example.com", "/admin/metrics");
      const section = page.getByTestId("quality-evaluations");
      await expect(section.getByRole("heading", { name: messages.quality_eval_title })).toBeVisible();
      await expect(section.locator("details")).toHaveCount(2);
      await expect(section.getByText(messages.quality_eval_same_provider, { exact: true }).first()).toBeVisible();
      await expect(section.getByText(messages.quality_eval_fake, { exact: true }).first()).toBeVisible();
      await expect(section.locator("details").first().getByRole("cell", { name: /-\d+\.\d \/ \+[1-9]\d*/ }).first()).toBeVisible();
      await expect(section.locator("details").first().getByText(messages.quality_eval_config_changed, { exact: true }).first()).toBeVisible();
      await expect(section.locator("details").last().getByText(messages.quality_eval_config_changed, { exact: true })).toHaveCount(0);
      await expect(page.getByTestId("quality-signals").getByRole("columnheader", { name: messages.quality_signals_scope, exact: true })).toBeVisible();
      const signal = page.getByTestId("quality-signals").getByRole("row").filter({ has: page.getByRole("cell", { name: "ja → en", exact: true }) });
      await expect(signal.getByRole("cell").nth(3)).toHaveText(/^[1-9]\d* \/ \d+ \([\d.]+%\)$/);
      await expect(signal.getByRole("cell").nth(4)).toHaveText(/^[1-9]\d* \/ [1-9]\d* \([\d.]+%\)$/);
      await expect(page.getByTestId("quality-draft-edits").getByRole("cell", { name: "MCP", exact: true })).toBeVisible();
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
      if (evidence) { fs.mkdirSync(evidence, { recursive: true }); await section.screenshot({ path: path.join(evidence, `eval-set-${locale}-${width}.png`) }); await page.getByTestId("quality-signals").screenshot({ path: path.join(evidence, `quality-signals-${locale}-${width}.png`) }); }
      await section.locator("details").last().locator("summary").click();
      await expect(section.locator("details").last()).toHaveAttribute("open", "");
      expect(errors).toEqual([]);
    } finally { await context.close(); }
  }
});
