import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { captureScreenshot, formatMessage, state, uiMessages, useMember, waitForHydration } from "./helpers";

const fixtures = () => JSON.parse(fs.readFileSync(path.join(state().dir, "translation-report-results.json"), "utf8")) as Record<string, { topicId: number; replyId: number; title: string }>;

for (const [size, width] of [["wide", 1440], ["narrow", 390]] as const) {
  test(`a reporter reads the result and returns to the translated reply at ${width}px`, async ({ page, browser }) => {
    await page.setViewportSize({ width, height: 900 });
    const f = fixtures()[size];
    await useMember(page, `zresult_${size}_reader@example.com`, `/t/${f.topicId}?page=2&lang=fr#c-${f.replyId}`);
    await waitForHydration(page);
    const m = await uiMessages(page);
    const reply = page.locator(`#c-${f.replyId}`);
    await expect(reply.locator(".longread")).toHaveAttribute("lang", "fr");
    await reply.getByRole("button", { name: m.report_button, exact: true }).click();
    await expect(reply.getByRole("button", { name: m.report_reported, exact: true })).toBeDisabled();
    const modContext = await browser.newContext();
    const otherContext = await browser.newContext();
    try {
      const mod = await modContext.newPage();
      await useMember(mod, `zresult_${size}_mod@example.com`, "/admin/translations");
      const mm = await uiMessages(mod);
      const card = mod.locator("section").filter({ has: mod.locator(`a[href$="#c-${f.replyId}"]`) });
      await expect(card).toHaveCount(1);
      await card.locator('textarea[name="text"]').fill(`Corrected translation ${size}`);
      await card.getByRole("button", { name: mm.admin_report_resolve, exact: true }).click();
      await expect(card).toHaveCount(0);
      await page.goto("/notifications");
      await expect(page.locator("html")).toHaveAttribute("lang", "en");
      const notices = await uiMessages(page);
      const row = page.locator("main li").filter({ hasText: f.title });
      await expect(row).toHaveCount(1);
      await expect(row).toContainText(formatMessage(notices.translation_report_result_human, { title: f.title, language: notices.language_name_fr, field: notices.translation_report_result_body }));
      const open = row.getByRole("link");
      await expect(open).toBeVisible();
      await open.focus();
      await expect(open).toBeFocused();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await captureScreenshot(page, { path: `translation-result-${width}.png` }, "translation-report-results");
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(new RegExp(`/t/${f.topicId}\\?page=2&lang=fr#c-${f.replyId}$`));
      await expect(page.locator(`#c-${f.replyId} .longread`)).toHaveAttribute("lang", "fr");
      await expect(page.locator(`#c-${f.replyId} .longread`)).toContainText(`Corrected translation ${size}`);
      const other = await otherContext.newPage();
      await useMember(other, `zresult_${size}_other@example.com`, "/notifications");
      await expect(other.locator("main li").filter({ hasText: f.title })).toHaveCount(0);
    } finally { await modContext.close(); await otherContext.close(); }
  });
}
