import fs from "node:fs";
import path from "node:path";
import { expect } from "@playwright/test";
import { test } from "./editor-fixture";
import { enMessages as en, formatMessage, messagePattern, useMember, state, waitForClientRoute, captureScreenshot } from "./helpers";

type Fixture = { topicId: number; ownReplyId: number; otherReplyId: number; englishId: number };
const fixture = (name: string): Fixture => JSON.parse(fs.readFileSync(path.join(state().dir, "reading-controls.json"), "utf8"))[name];

test("list selections preserve query choices with and without scripts", async ({ page, browser }) => {
  const f = fixture("lists");
  await useMember(page, "reading_controls_lists_reader@example.com", "/following?lang=en&all=1");
  const row = page.locator(`#q-${f.topicId}`);
  await expect(row).toContainText(messagePattern(en.label_from_lang_machine, { lang: /\S+/ }));
  await expect(row).not.toContainText(en.engine_fake);
  await expect(row.getByText(formatMessage(en.insightful_count_aria, { total: 2, langs: 2 }), { exact: true })).toHaveCount(1);
  await expect(page.locator(`#q-${f.englishId}`)).not.toContainText("English");
  const context = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 390, height: 844 }, storageState: await page.context().storageState() });
  try {
    for (const target of [page, await context.newPage()]) {
      await target.goto("/?lang=en&order=activity&page=2");
      const summary = target.locator(`summary[aria-label^="${en.filter_prefix}"]`);
      await expect(summary).toHaveText(en.home_filter_all);
      await summary.click();
      const filter = target.getByRole("navigation", { name: en.list_filter_label, exact: true });
      await filter.getByRole("link", { name: en.home_filter_long, exact: true }).click();
      await expect(target).toHaveURL(/lang=en&order=activity&long=1$/);
      await expect(filter).toBeHidden();
      await expect(summary).toHaveText(en.home_filter_long);
      await target.goto("/a/ja?lang=en&order=activity&asks=1&page=2");
      await target.locator("summary:has(h1)").click();
      const languages = target.getByRole("navigation", { name: en.home_origlang_label, exact: true });
      await languages.getByRole("link", { name: "English", exact: true }).click();
      await expect(target).toHaveURL(/\/a\/en\?lang=en&order=activity&asks=1$/);
      await expect(languages).toBeHidden();
    }
  } finally { await context.close(); }
});

test("reply actions disclose their forms directly and retain submission results", async ({ page, browser }) => {
  const f = fixture("actions");
  await useMember(page, "reading_controls_actions_reader@example.com", `/t/${f.topicId}?lang=en`);
  const other = page.locator(`#c-${f.otherReplyId}`);
  const translated = other.locator('form:has(input[name="intent"][value^="report"])');
  const report = other.locator('details:has(input[name="intent"][value="flag"])');
  await other.getByRole("button", { name: en.report_button, exact: true }).click();
  await expect(translated.locator('[name="note"]')).toBeVisible();
  await translated.locator('[name="note"]').fill("A translation report from the reading controls scenario.");
  await translated.getByRole("button", { name: en.save_changes, exact: true }).click();
  await expect(other.getByRole("status")).toBeVisible();
  await report.locator("summary").click();
  await expect(report.locator('[name="note"]')).toBeVisible();
  await report.getByRole("button", { name: en.flag_submit, exact: true }).click();
  await expect(other).toContainText(en.flag_already_reported);
  const own = page.locator(`#c-${f.ownReplyId}`);
  await own.locator("summary").filter({ hasText: en.delete_summary }).click();
  await expect(own.getByRole("button", { name: en.delete_confirm, exact: true })).toBeVisible();
  const context = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 390, height: 844 }, storageState: await page.context().storageState() });
  try {
    const native = await context.newPage();
    await native.goto(`/t/${f.topicId}?lang=en`);
    const owned = native.locator(`#c-${f.ownReplyId}`);
    await owned.locator("summary").filter({ hasText: en.delete_summary }).click();
    await owned.getByRole("button", { name: en.delete_confirm, exact: true }).click();
    await expect(owned).toHaveCount(0);
  } finally { await context.close(); }
});

test("author actions and the follow toggle remain available at the end of the article", async ({ page, browser }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const f = fixture("author");
  await useMember(page, "reading_controls_author_writer@example.com", `/t/${f.topicId}?lang=en`);
  await waitForClientRoute(page);
  const byline = page.locator("[data-article-details]");
  const following = byline.getByRole("button", { name: en.follow_unfollow, exact: true });
  await expect(following).not.toHaveAttribute("aria-pressed");
  await following.click();
  await expect(byline.getByRole("button", { name: en.follow_button, exact: true })).toBeVisible();
  await expect(byline.getByRole("button", { name: en.follow_button, exact: true })).not.toHaveAttribute("aria-pressed");
  await byline.getByRole("button", { name: en.follow_button, exact: true }).click();
  await expect(following).toBeVisible();
  await expect(page.locator('#reply [data-reply-heading]')).toContainText(en.reply_write_title);
  await expect(page.locator('#p-' + f.topicId + ' [data-reading-language]')).toContainText(en.show_original);
  await expect(byline.getByRole("link", { name: en.edit, exact: true })).toBeVisible();
  await expect(byline.locator("summary").filter({ hasText: en.delete_summary })).toBeVisible();
  await byline.getByRole("button", { name: en.intro_set, exact: true }).click();
  const context = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 390, height: 844 }, storageState: await page.context().storageState() });
  try {
    const native = await context.newPage();
    await native.goto(`/t/${f.topicId}?lang=en`);
    const meta = native.locator("[data-article-details]");
    await expect(meta.getByRole("button", { name: en.intro_unset, exact: true })).toBeVisible();
    await meta.locator("summary").filter({ hasText: en.delete_summary }).click();
    await expect(meta.getByRole("button", { name: en.delete_confirm, exact: true })).toBeVisible();
  } finally { await context.close(); }
});

test("owned topics expose edit and confirmed deletion at both ends, while other readers see neither", async ({ page }) => {
  const f = fixture("ownership");
  await useMember(page, "reading_controls_ownership_reader@example.com", `/t/${f.topicId}?lang=en`);
  const head = page.locator("[data-reading-byline]");
  const end = page.locator("[data-article-details]");
  for (const row of [head, end]) {
    await expect(row.getByRole("link", { name: en.edit, exact: true })).toHaveCount(0);
    await expect(row.locator('details:has(input[name="intent"][value="delete"])')).toHaveCount(0);
  }
  await useMember(page, "reading_controls_ownership_writer@example.com", `/t/${f.topicId}?lang=en`);
  await waitForClientRoute(page);
  for (const width of [390, 1366]) {
    await page.setViewportSize({ width, height: 900 });
    for (const [position, row] of [["head", head], ["end", end]] as const) {
      await expect(row.getByRole("link", { name: en.edit, exact: true })).toHaveAttribute("href", `/t/${f.topicId}/edit`);
      const remove = row.locator('details:has(input[name="intent"][value="delete"])');
      const summary = remove.locator(":scope > summary");
      await expect(summary).toBeVisible();
      await expect(summary).toHaveAccessibleName(en.delete_summary);
      await row.scrollIntoViewIfNeeded();
      await captureScreenshot(page, { path: `topic-${position}-${width}.png` }, "topic");
      const confirm = remove.getByRole("button", { name: en.delete_confirm, exact: true });
      await expect(confirm).toBeHidden();
      await summary.click();
      await expect(confirm).toBeVisible();
      const bounds = await row.boundingBox();
      const panel = await remove.locator(":scope > div").boundingBox();
      expect(Math.abs(panel!.width - bounds!.width)).toBeLessThanOrEqual(1);
      expect(Math.abs(panel!.x - bounds!.x)).toBeLessThanOrEqual(1);
      const otherRow = position === "head" ? end : head;
      await expect(otherRow.getByRole("button", { name: en.delete_confirm, exact: true })).toBeHidden();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await summary.click();
    }
  }
  await head.locator("summary").filter({ hasText: en.delete_summary }).click();
  await head.getByRole("button", { name: en.delete_confirm, exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  expect((await page.goto(`/t/${f.topicId}?lang=en`))!.status()).toBe(404);
  await expect(page.locator('[data-reading-byline], [data-article-details]')).toHaveCount(0);
});

test("opened reply panels use the action row's full width below their entrance", async ({ page, browser }) => {
  const f = fixture("panels");
  await useMember(page, "reading_controls_panels_reader@example.com", `/t/${f.topicId}?lang=en`);
  const nativeContext = await browser.newContext({ javaScriptEnabled: false, storageState: await page.context().storageState() });
  try {
    for (const target of [page, await nativeContext.newPage()]) {
      for (const width of [390, 1280]) {
        await target.setViewportSize({ width, height: 844 });
        await target.goto(`/t/${f.topicId}?lang=en`);
        const other = target.locator(`#c-${f.otherReplyId}`);
        if (await other.getByRole("button", { name: en.report_button, exact: true }).count()) {
          await other.getByRole("button", { name: en.report_button, exact: true }).click();
          await expect(other.getByRole("button", { name: en.report_reported, exact: true })).toBeDisabled();
        }
        const details = other.locator("details").filter({ hasText: en.report_optional_summary });
        if (await details.evaluate(element => (element as HTMLDetailsElement).open)) await details.locator("summary").click();
        for (const [id, label, panelSelector] of [
          [f.otherReplyId, en.report_optional_summary, ":scope > div"],
          [f.otherReplyId, en.flag_summary, ":scope > div"],
          [f.ownReplyId, en.delete_summary, ":scope > div"],
        ] as const) {
          const reply = target.locator(`#c-${id}`);
          const summary = reply.locator("summary").filter({ hasText: label });
          await summary.click();
          const details = summary.locator("..");
          const panel = details.locator(panelSelector);
          await expect(panel).toBeVisible();
          const row = reply.locator("[data-reply-actions]");
          const bounds = await row.boundingBox();
          const box = await panel.boundingBox();
          const entrance = await summary.boundingBox();
          expect(bounds).not.toBeNull(); expect(box).not.toBeNull(); expect(entrance).not.toBeNull();
          expect(Math.abs(box!.width - bounds!.width), `Panel width ${box!.width}, action row ${bounds!.width}`).toBeLessThanOrEqual(1);
          expect(Math.abs(box!.x - bounds!.x)).toBeLessThanOrEqual(1);
          expect(box!.y).toBeGreaterThanOrEqual(entrance!.y + entrance!.height);
          await summary.click();
        }
      }
    }
  } finally { await nativeContext.close(); }
});
