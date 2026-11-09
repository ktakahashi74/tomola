import fs from "node:fs";
import { HOME_AREA_CHANGE_DAYS } from "../app/lib/profile-settings";
import path from "node:path";
import { expect } from "@playwright/test";
import { test } from "./editor-fixture";
import { formatMessage, waitForClientRoute, captureScreenshot, clientHeaders, enMessages as en, signUp, state  } from "./helpers";

type Fixture = { topicId: number; replyId: number; invitation: string };
const fixture = (): Fixture => JSON.parse(fs.readFileSync(path.join(state().dir, "small-polish.json"), "utf8"));

test("settings guidance, signup descriptions, quote placement and reaction help work at desktop and phone widths", async ({ browser }, info) => {
  const f = fixture();
  const context = await browser.newContext({ extraHTTPHeaders: clientHeaders("10.71.0.2") });
  const page = await context.newPage();
  try {
    await signUp(page, f.invitation, "polish_reader@example.com", { handle: "polish_reader", mainLang: "en" }, async page => {
      const language = page.getByRole("combobox", { name: en.onboarding_home_area, exact: true });
      await expect(language).toHaveAccessibleDescription(en.onboarding_language_help);
      const description = page.locator("#onboarding-language-help");
      expect(await description.evaluate(element => element.closest("label") === null)).toBe(true);
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 844 });
        await captureScreenshot(page, { path: info.outputPath(`onboarding-${width}.png`), fullPage: true }, "e2e-small-polish");
      }
    });
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto("/settings");
      await waitForClientRoute(page);
      const area = page.locator("#settings-area");
      await expect(area.getByText(en.settings_area_short_help, { exact: true })).toBeVisible();
      await expect(area.getByText(formatMessage(en.settings_area_help, { days: HOME_AREA_CHANGE_DAYS }), { exact: true })).toBeHidden();
      await area.getByText(en.onboarding_language_details, { exact: true }).click();
      await expect(area.getByText(formatMessage(en.settings_area_help, { days: HOME_AREA_CHANGE_DAYS }), { exact: true })).toBeVisible();
      await expect(page.locator("#settings-sessions").getByText(en.settings_links_sessions_help, { exact: true })).toBeVisible();
      await page.locator("#settings-sessions").scrollIntoViewIfNeeded();
      await captureScreenshot(page, { path: info.outputPath(`settings-links-${width}.png`) }, "e2e-small-polish");
      await area.scrollIntoViewIfNeeded();
      await captureScreenshot(page, { path: info.outputPath(`settings-${width}.png`) }, "e2e-small-polish");
      await page.goto(`/t/${f.topicId}?lang=en`);
      const paragraph = page.locator(`#p-${f.topicId} [data-reading-body] > p`).last();
      await paragraph.scrollIntoViewIfNeeded();
      const first = await paragraph.evaluate(paragraph => {
        const text = paragraph.firstChild!;
        const range = document.createRange();
        range.setStart(text, 12);
        range.setEnd(text, 240);
        const selection = window.getSelection()!;
        selection.removeAllRanges();
        selection.addRange(range);
        return [...range.getClientRects()].filter(rect => rect.width > 0).map(rect => ({ x: rect.left, y: rect.top, bottom: rect.bottom, right: rect.right }));
      });
      expect(first.length).toBeGreaterThan(1);
      const quote = page.getByRole("button", { name: en.quote_reply, exact: true });
      await expect(quote).toBeVisible();
      const button = (await quote.boundingBox())!;
      expect(Math.abs(button.x - first[0].x)).toBeLessThanOrEqual(1);
      expect(button.y + button.height).toBeLessThan(first[0].y);
      expect(first[0].y - button.y - button.height).toBeLessThanOrEqual(8);
      await captureScreenshot(page, { path: info.outputPath(`quote-${width}.png`) }, "e2e-small-polish");
      await quote.click();
      await expect(page.locator('#reply textarea[name="body"]')).not.toBeEmpty();
      await page.locator(`#p-${f.topicId} blockquote`).scrollIntoViewIfNeeded();
      await captureScreenshot(page, { path: info.outputPath(`blockquote-${width}.png`) }, "e2e-small-polish");
      const reply = page.locator(`#c-${f.replyId}`);
      const insightful = reply.getByRole("button", { name: en.insightful_give, exact: true });
      await insightful.scrollIntoViewIfNeeded();
      await insightful.hover();
      await expect(page.getByRole("tooltip", { name: en.insightful_help, exact: true })).toBeVisible();
      await expect(insightful).toHaveAccessibleDescription(en.insightful_help);
      await insightful.click();
      await expect(page.getByRole("tooltip", { name: en.insightful_help, exact: true })).toBeHidden();
      await captureScreenshot(page, { path: info.outputPath(`reaction-${width}.png`) }, "e2e-small-polish");
      await page.mouse.move(0, 0);
      await page.keyboard.press("Tab");
      await page.keyboard.press("Shift+Tab");
      await expect(insightful).toBeFocused();
      await expect(page.getByRole("tooltip", { name: en.insightful_help, exact: true })).toBeVisible();
      await page.keyboard.press("Escape");
    }
  } finally { await context.close(); }
});
