import fs from "node:fs";
import path from "node:path";
import { expect } from "@playwright/test";
import { test } from "./editor-fixture";
import { enMessages, state, useMember } from "./helpers";

test("a late appeal explains to the author and reviewer that erased text cannot be restored", async ({ page, browser }) => {
  const fixture = JSON.parse(fs.readFileSync(path.join(state().dir, "retention.json"), "utf8")) as { actionId: number };
  await useMember(page, "retention_author@example.com");
  await page.goto(`/appeal/${fixture.actionId}`);
  await expect(page.getByText(enMessages.appeal_fix_pruned, { exact: true })).toBeVisible();
  await expect(page.getByTestId("fix-before")).toHaveCount(0);
  const explanation = "Review the decision after the text was erased.";
  await page.getByLabel(enMessages.appeal_text).fill(explanation);
  await page.getByRole("button", { name: enMessages.appeal_submit }).click();
  await expect(page.getByText(enMessages.appeal_sent, { exact: true })).toBeVisible();
  const context = await browser.newContext();
  try {
    const reviewer = await context.newPage();
    await useMember(reviewer, "retention_reviewer@example.com");
    await reviewer.goto("/mod/appeals");
    const card = reviewer.locator("section[id^='a-']").filter({ hasText: explanation });
    await expect(card.getByText(enMessages.appeal_fix_pruned, { exact: true })).toBeVisible();
    await expect(card.getByRole("button", { name: enMessages.mod_appeals_overturn })).toBeVisible();
    await card.getByLabel(enMessages.mod_appeals_note).fill("The erased original cannot be restored.");
    await card.getByRole("button", { name: enMessages.mod_appeals_overturn }).click();
    await expect(reviewer.getByText(enMessages.mod_appeals_done_nochange, { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByText(enMessages.appeal_status_overturned_nochange, { exact: true })).toBeVisible();
  } finally { await context.close(); }
});
