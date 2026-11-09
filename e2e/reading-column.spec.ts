import { readTopicTranslation } from "./helpers";
import fs from "node:fs";
import path from "node:path";
import { expect } from "@playwright/test";
import { test } from "./editor-fixture";
import { enMessages as en, state, useMember, waitForHydration } from "./helpers";

test("article actions align with the displayed reading column across languages", async ({ page }) => {
  const f: { topicId: number; englishId: number } = JSON.parse(fs.readFileSync(path.join(state().dir, "reading-column.json"), "utf8"));
  await page.setViewportSize({ width: 1280, height: 900 });
  await useMember(page, "column_layout@example.com", `/t/${f.topicId}?lang=en&orig=${f.topicId}`);
  await waitForHydration(page);
  await page.evaluate(() => document.fonts.ready);
  const body = page.locator("[data-reading-body]");
  const assertColumn = async (lang: string) => {
    await expect(body).toHaveAttribute("lang", lang);
    await expect.poll(async () => {
      const column = (await body.boundingBox())!;
      const reply = (await page.locator("[data-reply-heading]").getByRole("button").last().boundingBox())!;
      const signature = (await page.locator("[data-article-signature]").boundingBox())!;
      return Math.max(Math.abs(signature.x + signature.width - column.x - column.width), Math.abs(reply.x + reply.width - column.x - column.width));
    }).toBeLessThanOrEqual(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
    return (await body.boundingBox())!.width;
  };
  const japaneseWidth = await assertColumn("ja");
  await readTopicTranslation(page);
  const englishWidth = await assertColumn("en");
  await page.getByRole("link", { name: en.show_original, exact: true }).click();
  expect(await assertColumn("ja")).toBe(japaneseWidth);
  await page.goto(`/t/${f.englishId}?lang=en`);
  expect(await assertColumn("en")).toBe(englishWidth);
});
