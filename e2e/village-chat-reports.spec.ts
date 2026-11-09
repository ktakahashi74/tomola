import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { state, enMessages as m, useMember, waitForClientRoute } from "./helpers";

test("a report is read with an audit trail, hides live chat, and is restored after independent appeal review", async ({ page, browser }) => {
  const fixture = JSON.parse(fs.readFileSync(path.join(state().dir, "chat-report.json"), "utf8"));
  await useMember(page, "crflow_writer@example.com");
  await page.goto("/v/chat-report-flow/chat"); await waitForClientRoute(page);
  const message = page.locator(`[data-chat-message="${fixture.id}"]`);
  await expect(message.getByRole("paragraph").filter({ hasText: fixture.body })).toBeVisible();
  const contexts = [];
  try {
    const reporterContext = await browser.newContext({ locale: "en-US" }); contexts.push(reporterContext);
    const reporter = await reporterContext.newPage(); await useMember(reporter, "crflow_reporter@example.com");
    await reporter.goto("/v/chat-report-flow/chat"); await waitForClientRoute(reporter);
    const reported = reporter.locator(`[data-chat-message="${fixture.id}"]`);
    await reported.hover(); await reported.getByText(m.chat_reports_flag, { exact: true }).click();
    await reporter.getByRole("dialog", { name: m.chat_reports_flag, exact: true }).getByRole("button", { name: m.flag_submit, exact: true }).click();
    await expect(reporter.getByText(m.chat_reports_flagged, { exact: true })).toBeVisible();

    const moderatorContext = await browser.newContext({ locale: "en-US" }); contexts.push(moderatorContext);
    const moderator = await moderatorContext.newPage(); await useMember(moderator, "crflow_mod@example.com");
    await moderator.goto("/mod"); await waitForClientRoute(moderator);
    await expect(moderator.locator("main")).not.toContainText(fixture.body);
    await moderator.locator("section").filter({ hasText: fixture.villageName }).getByRole("link", { name: m.chat_reports_open, exact: true }).click(); await waitForClientRoute(moderator);
    const reportPath = new URL(moderator.url()).pathname;
    await expect(moderator.getByRole("button", { name: m.chat_reports_unhide, exact: true })).toHaveCount(0);
    await expect(moderator.locator("main")).not.toContainText(fixture.body);
    await moderator.getByRole("button", { name: m.chat_reports_open, exact: true }).click();
    await expect(moderator.getByText(fixture.body, { exact: true })).toBeVisible();
    await moderator.getByRole("button", { name: m.chat_reports_context, exact: true }).click();
    await expect(moderator.getByText("Context before the reported message", { exact: true })).toBeVisible();
    await moderator.getByLabel(m.chat_reports_expand_reason, { exact: true }).fill("chat:additional context");
    await moderator.getByRole("button", { name: m.chat_reports_expand, exact: true }).click();
    await expect(moderator.getByRole("alert")).toHaveText(m.chat_reports_reserved_reason);
    for (let n = 0; n < 3; n++) {
      await moderator.getByLabel(m.chat_reports_expand_reason, { exact: true }).fill(`Additional context ${n + 1}`);
      const expanded = moderator.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === `${reportPath}.data`);
      await moderator.getByRole("button", { name: m.chat_reports_expand, exact: true }).click();
      expect((await expanded).status()).toBe(200);
      await expect(moderator.getByRole("button", { name: m.chat_reports_expand, exact: true })).toBeEnabled();
    }
    await moderator.getByLabel(m.chat_reports_expand_reason, { exact: true }).fill("Fourth expansion");
    await moderator.getByRole("button", { name: m.chat_reports_expand, exact: true }).click();
    await expect(moderator.getByRole("alert")).toHaveText(m.chat_reports_expand_limit);
    await moderator.getByLabel(m.mod_note, { exact: true }).fill("The reported message needs independent review.");
    await moderator.getByRole("button", { name: m.chat_reports_hide, exact: true }).click();
    await expect(moderator.getByText(m.chat_reports_done, { exact: true })).toBeVisible();
    await expect(moderator.getByText(m.chat_reports_closed, { exact: true })).toBeVisible();
    await expect(moderator.locator("main")).not.toContainText(fixture.body);
    for (const name of [m.chat_reports_open, m.chat_reports_context, m.chat_reports_hide, m.mod_dismiss]) await expect(moderator.getByRole("button", { name, exact: true })).toHaveCount(0);
    await expect(moderator.getByRole("button", { name: m.chat_reports_unhide, exact: true })).toBeVisible();
    const denied = await moderator.request.post(reportPath, { form: { intent: "open" }, headers: { Origin: new URL(moderator.url()).origin } });
    expect(denied.status()).toBe(409); expect(await denied.text()).not.toContain(fixture.body);
    const handled = await moderator.context().newPage();
    await handled.goto("/mod?tab=handled"); await waitForClientRoute(handled);
    await expect(handled.locator("section").filter({ hasText: fixture.villageName }).getByRole("link", { name: m.chat_reports_open, exact: true })).toHaveCount(0);
    await handled.locator("section").filter({ hasText: fixture.villageName }).getByRole("link", { name: m.chat_reports_manage_closed, exact: true }).click(); await waitForClientRoute(handled);
    expect(new URL(handled.url()).pathname).toBe(reportPath);
    await expect(handled.getByText(m.chat_reports_closed, { exact: true })).toBeVisible();
    await expect(handled.getByRole("button", { name: m.chat_reports_open, exact: true })).toHaveCount(0);
    await expect(handled.getByRole("button", { name: m.chat_reports_unhide, exact: true })).toBeVisible();
    await page.bringToFront();
    await expect(message.getByText(m.village_chat_hidden, { exact: true })).toBeVisible();
    await expect(message).not.toContainText(fixture.body);

    const notificationPage = await page.context().newPage(); await notificationPage.goto("/notifications"); await waitForClientRoute(notificationPage);
    await expect(notificationPage.locator("main")).not.toContainText(fixture.body);
    await notificationPage.getByRole("link", { name: m.notification_appeal, exact: true }).click(); await waitForClientRoute(notificationPage);
    await expect(notificationPage.getByText(fixture.body, { exact: true })).toBeVisible();
    const appealPath = new URL(notificationPage.url()).pathname;
    for (const suffix of ["", ".data"]) {
      const response = await notificationPage.request.get(appealPath + suffix);
      expect(response.status()).toBe(200);
      expect(response.headers()["cache-control"]).toBe("private, no-store");
      expect(await response.text()).toContain(fixture.body);
    }
    await notificationPage.getByLabel(m.appeal_text, { exact: true }).fill("Please review this decision independently.");
    await notificationPage.getByRole("button", { name: m.appeal_submit, exact: true }).click();
    await expect(notificationPage.getByText(m.appeal_sent, { exact: true })).toBeVisible();

    const reviewContext = await browser.newContext({ locale: "en-US" }); contexts.push(reviewContext);
    const reviewer = await reviewContext.newPage(); await useMember(reviewer, "crflow_review@example.com");
    await reviewer.goto("/mod/appeals"); await waitForClientRoute(reviewer);
    await expect(reviewer.locator("main")).not.toContainText(fixture.body);
    await reviewer.getByRole("link", { name: m.chat_reports_open, exact: true }).click(); await waitForClientRoute(reviewer);
    const reviewPath = new URL(reviewer.url()).pathname;
    await reviewer.getByRole("button", { name: m.chat_reports_open, exact: true }).click();
    await expect(reviewer.getByText(fixture.body, { exact: true })).toBeVisible();
    await reviewer.getByLabel(m.mod_appeals_note, { exact: true }).fill("The hiding decision is withdrawn.");
    await reviewer.getByRole("button", { name: m.mod_appeals_overturn, exact: true }).click();
    await expect(reviewer).toHaveURL(/\/mod\/appeals/);
    await reviewer.goto(reviewPath); await waitForClientRoute(reviewer);
    await expect(reviewer.getByText(m.chat_reports_closed, { exact: true })).toBeVisible();
    await expect(reviewer.getByRole("button", { name: m.chat_reports_open, exact: true })).toHaveCount(0);
    await expect(reviewer.locator("main")).not.toContainText(fixture.body);
    await page.bringToFront();
    await expect(message.getByRole("paragraph").filter({ hasText: fixture.body })).toBeVisible();

    await handled.goto("/mod?tab=handled"); await waitForClientRoute(handled);
    await expect(handled.locator("section").filter({ hasText: fixture.villageName }).getByRole("link", { name: m.chat_reports_manage_closed, exact: true })).toHaveCount(0);

    const operatorContext = await browser.newContext({ locale: "en-US" }); contexts.push(operatorContext);
    const operator = await operatorContext.newPage(); await useMember(operator, "crflow_op@example.com");
    await operator.goto("/admin/chat-access"); await waitForClientRoute(operator);
    await expect(operator.getByText(/@crflow_mod/)).toHaveCount(5);
    await expect(operator.getByText(/@crflow_review/)).toHaveCount(1);
    await expect(operator.locator("main")).not.toContainText(fixture.body);
    await expect(operator.getByRole("link", { name: fixture.villageName, exact: true })).toHaveCount(6);
    const caseAudit = operator.locator("main li").filter({ has: operator.getByRole("link", { name: fixture.villageName, exact: true }) });
    await expect(caseAudit.getByText(m.chat_access_report_review, { exact: true })).toHaveCount(2);
    await expect(caseAudit.getByText(m.chat_access_appeal_review, { exact: true })).toHaveCount(1);
    await expect(caseAudit.getByText("Additional context 1", { exact: true })).toBeVisible();
    await page.goto("/moderation"); await waitForClientRoute(page);
    await expect(page.getByText(m.log_action_hide_chat, { exact: true })).toBeVisible();
    await expect(page.getByText(m.log_action_unhide_chat, { exact: true })).toBeVisible();
    await expect(page.locator("main")).not.toContainText(fixture.body);
    await expect(page.locator("main")).not.toContainText(fixture.villageName);
  } finally { for (const context of contexts) await context.close(); }
});
