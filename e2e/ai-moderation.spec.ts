import fs from "node:fs";
import { expect, test } from "@playwright/test";
import { enMessages, state, useMember, visitListRow } from "./helpers";

const fixture = (): { topicId: number; hiddenId: number; actionId: number; chatReportId: number; resolvedEntryId: number } => JSON.parse(fs.readFileSync(`${state().dir}/ai-moderation.json`, "utf8"));

test("automatic hiding identifies automation, notifies the author, and accepts an appeal for human review", async ({ page }) => {
  const data = fixture();
  await useMember(page, "am_ui_reader@example.com", `/t/${data.topicId}`);
  await expect(page.locator(`#c-${data.hiddenId}`)).toContainText(enMessages.entry_hidden_placeholder);
  await useMember(page, "am_ui_writer@example.com", "/notifications");
  await expect(page.getByText(enMessages.notification_moderation_automatic, { exact: true })).toBeVisible();
  await page.goto(`/appeal/${data.actionId}`);
  await expect(page.getByText(enMessages.moderation_automatic, { exact: true })).toBeVisible();
  await expect(page.locator("main")).not.toContainText("spam:");
  await page.getByLabel(enMessages.appeal_text).fill("Please review the repeated text.");
  await page.getByRole("button", { name: enMessages.appeal_submit, exact: true }).click();
  await expect(page.getByText(enMessages.appeal_sent, { exact: true })).toBeVisible();
  await useMember(page, "am_ui_mod@example.com", "/mod/appeals");
  const appeal = page.locator("section", { hasText: "Please review the repeated text." });
  await appeal.getByLabel(enMessages.mod_appeals_note).fill("Reviewed by a person.");
  await appeal.getByRole("button", { name: enMessages.mod_appeals_uphold, exact: true }).click();
  await expect(page.getByText(enMessages.mod_appeals_done_upheld, { exact: true })).toBeVisible();
});

test("chat assessments require opening audited evidence while lists show priority and automatic report resolution", async ({ page }) => {
  const data = fixture();
  await useMember(page, "am_guard_mod@example.com", "/mod");
  const card = page.locator("section", { has: page.locator(`a[href='/mod/chat/report/${data.chatReportId}']`) });
  await visitListRow(page, "/mod", card);
  await expect(card).toContainText(enMessages.mod_ai_urgent);
  await expect(page.locator("main")).not.toContainText("PRIVATE_ASSESSMENT_EXAMPLE");
  await page.goto(`/mod/chat/report/${data.chatReportId}`);
  await expect(page.locator("main")).not.toContainText("PRIVATE_ASSESSMENT_EXAMPLE");
  await page.getByRole("button", { name: enMessages.chat_reports_open, exact: true }).click();
  await expect(page.locator("main")).toContainText("PRIVATE_ASSESSMENT_EXAMPLE");
  const resolved = page.locator(`#e-${data.resolvedEntryId}`);
  await visitListRow(page, "/mod?tab=handled", resolved);
  await expect(resolved).toContainText(enMessages.moderation_automatic);
});

test("moderators see labeled AI priority and assessment in their interface language", async ({ page }) => {
  const data = fixture();
  await useMember(page, "am_ui_mod@example.com", "/mod?tab=handled");
  const card = page.locator(`#e-${data.topicId}`);
  await expect(card.getByText(enMessages.mod_ai_priority, { exact: true })).toBeVisible();
  await expect(card.getByText(enMessages.mod_ai_assessment, { exact: true })).toBeVisible();
  await expect(card).toContainText(enMessages.mod_ai_urgent);
  await expect(card).toContainText("Potential concern. Human review required.");
  await expect(card).toContainText(enMessages.mod_ai_notice);
});
