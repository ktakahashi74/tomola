import { readingActions, captureScreenshot, enMessages, messagePattern  } from "./helpers";
import fs from "node:fs";
import path from "node:path";
import { expect } from "@playwright/test";
import { test } from "./editor-fixture";

// Topics made by earlier tests can push the seeded fixtures past the first home page.
async function homePageWith(page: import("@playwright/test").Page, title: string) {
  for (let n = 1; n <= 5; n++) {
    const path = n === 1 ? "/?lang=en" : `/?page=${n}&lang=en`;
    await page.goto(path);
    if (await page.getByRole("link", { name: title, exact: true }).count()) return path;
  }
  throw new Error(`${title} is not on the first five home pages`);
}


for (const javaScriptEnabled of [true, false]) {
  test(`reply-count links and last pages work with JavaScript ${javaScriptEnabled ? "enabled" : "disabled"}`, async ({ browser }) => {
    const context = await browser.newContext({ javaScriptEnabled, locale: "en-US" });
    const page = await context.newPage();
    try {
      const questionHome = await homePageWith(page, "Latest question fixture");
      const home = await homePageWith(page, "Latest reply pagination fixture");
      if (javaScriptEnabled) await expect(page.getByRole("button", { name: enMessages.open_in_ai, exact: true }).first()).toBeVisible();
      const card = page.locator("li[id^=q-]").filter({ has: page.getByRole("link", { name: "Latest reply pagination fixture", exact: true }) });
      const question = page.locator("li[id^=q-]").filter({ has: page.getByRole("link", { name: "Latest question fixture", exact: true }) });
      const latest = card.getByRole("link", { name: messagePattern(enMessages.home_replies, { count: /\d+/ }) });
      const href = (await latest.getAttribute("href"))!;
      const replyCountLabel = await latest.innerText();
      expect(href).toMatch(/^\/t\/\d+\?lang=en&page=2#c-\d+$/);
      await expect(card.locator("time")).toHaveCount(1);
      await expect(card.locator(".longread")).toHaveCount(0);
      await expect(card).not.toContainText("Latest translated reply");
      await expect(card.getByRole("link", { name: /^@/ })).toHaveCount(0);
      if (questionHome !== home) await page.goto(questionHome);
      await expect(question.getByRole("link", { name: messagePattern(enMessages.home_replies, { count: /\d+/ }) })).toBeVisible();
      await expect(question.locator(".line-clamp-2")).toHaveCount(0);
      expect(await page.content()).not.toContain("QUESTION_REASON_SENTINEL");
      const questionPath = (await question.getByRole("link", { name: "Latest question fixture", exact: true }).getAttribute("href"))!.split("?")[0];
      const questionCountLabel = await question.getByRole("link", { name: messagePattern(enMessages.home_replies, { count: /\d+/ }) }).innerText();

      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(home);
        if (javaScriptEnabled) await expect(page.getByRole("button", { name: enMessages.open_in_ai, exact: true }).first()).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        await expect(card.locator("time")).toBeVisible();
        if (process.env.E2E_EVIDENCE_DIR) {
          fs.mkdirSync(process.env.E2E_EVIDENCE_DIR, { recursive: true });
          await captureScreenshot(page, { path: path.join(process.env.E2E_EVIDENCE_DIR, `latest-row-${width}-js-${javaScriptEnabled}.png`), animations: "disabled" }, "e2e-latest-reply");
        }
        await latest.click();
        await expect(page).toHaveURL(new RegExp(`\\?lang=en&page=2#${href.split("#")[1]}$`));
        await expect(page.locator(`#${href.split("#")[1]}`)).toContainText("Latest translated reply");
        await expect(page.locator("#replies").getByRole("heading", { level: 2, name: replyCountLabel, exact: true })).toBeVisible();
        const jump = page.getByRole("link", { name: enMessages.thread_latest_reply, exact: true });
        await expect(jump).toHaveAttribute("href", href.replace("?lang=en&page=2", "?page=2&lang=en"));
        await jump.scrollIntoViewIfNeeded();
        if (process.env.E2E_EVIDENCE_DIR) await captureScreenshot(page, { path: path.join(process.env.E2E_EVIDENCE_DIR, `latest-thread-${width}-js-${javaScriptEnabled}.png`), animations: "disabled" }, "e2e-latest-reply");
        await page.getByRole("link", { name: enMessages.page_last, exact: true }).first().click();
        await expect(page).toHaveURL(/lang=en&page=3#replies$/);
        await expect(page.locator("#replies").getByRole("heading", { level: 2, name: replyCountLabel, exact: true })).toBeVisible();
        await expect(page.getByRole("link", { name: enMessages.page_last, exact: true })).toHaveCount(0);
        if (process.env.E2E_EVIDENCE_DIR) await captureScreenshot(page, { path: path.join(process.env.E2E_EVIDENCE_DIR, `last-thread-${width}-js-${javaScriptEnabled}.png`), animations: "disabled" }, "e2e-latest-reply");
      }
      await page.goto(`${questionPath}?tag=agree&lang=en`);
      if (javaScriptEnabled) await expect((await readingActions(page)).getByRole("button", { name: enMessages.open_in_ai, exact: true })).toBeVisible();
      await expect(page.locator("#replies").getByRole("heading", { level: 2, name: questionCountLabel, exact: true })).toBeVisible();
      await expect(page.getByRole("link", { name: enMessages.thread_latest_reply, exact: true })).toHaveCount(0);
      await page.getByRole("link", { name: enMessages.page_last, exact: true }).first().click();
      await expect(page).toHaveURL(/tag=agree&lang=en&page=2#replies$/);
      await expect(page.locator("#replies").getByRole("heading", { level: 2, name: questionCountLabel, exact: true })).toBeVisible();
      await expect(page.getByRole("link", { name: enMessages.page_last, exact: true })).toHaveCount(0);
      await page.goto("/a/en?lang=en");
      await expect(page.getByRole("link", { name: messagePattern(enMessages.home_replies, { count: /\d+/ }) }).first()).toBeVisible();
    } finally {
      await context.close();
    }
  });
}
