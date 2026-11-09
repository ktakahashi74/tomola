import fs from "node:fs";
import path from "node:path";
import { expect } from "@playwright/test";
import { test } from "./editor-fixture";
import { enMessages as en, formatMessage, state, useMember } from "./helpers";

type Fixture = { mixed: number; single: number; one: number; marked: number; taggedReply: number };
const fixture = (): Fixture => JSON.parse(fs.readFileSync(path.join(state().dir, "ai-readiness.json"), "utf8"));

test("the replies heading names the number of original languages from two on, and fits a narrow screen", async ({ page }) => {
  const f = fixture();
  await useMember(page, "ai_readiness_reader@example.com", `/t/${f.mixed}?lang=en`);
  const heading = page.locator("#replies h2").first();
  await expect(heading).toContainText(formatMessage(en.home_replies, { count: 3 }));
  await expect(heading).toContainText(formatMessage(en.thread_reply_langs, { count: 3 }));
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(heading).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  // One language, or one reply, adds nothing.
  for (const id of [f.single, f.one]) {
    await page.goto(`/t/${id}?lang=en`);
    await expect(page.locator("#replies h2").first()).toHaveText(formatMessage(en.home_replies, { count: id === f.single ? 3 : 1 }));
  }
});

test("moderators see the posts with format characters to check, with reasons and counts but never the characters themselves", async ({ page }) => {
  const f = fixture();
  await useMember(page, "ai_readiness_operator@example.com", "/mod?tab=review");
  await expect(page.getByRole("heading", { name: en.mod_tab_review, exact: true })).toBeAttached();
  await expect(page.getByText(formatMessage(en.mod_review_intro, { days: 30 }), { exact: true })).toBeVisible();
  const items = page.locator("main li");
  const topic = items.filter({ has: page.locator(`a[href="/t/${f.marked}#p-${f.marked}"]`) });
  await expect(topic).toContainText(formatMessage(en.mod_review_reason_bidi_control, { count: 1 }));
  const reply = items.filter({ has: page.locator(`a[href="/t/${f.marked}#c-${f.taggedReply}"]`) });
  await expect(reply).toContainText(formatMessage(en.mod_review_reason_tag_characters, { count: 2 }));
  // Posts without such characters are not listed, and the page shows no excerpt of the matched text.
  await expect(page.locator(`a[href^="/t/${f.mixed}"]`)).toHaveCount(0);
  await expect(page.getByText("A reply")).toHaveCount(0);
  // The tab sits beside the report tabs.
  await page.getByRole("link", { name: en.mod_tab_open, exact: true }).click();
  await expect(page).toHaveURL(/\/mod$/);
});
