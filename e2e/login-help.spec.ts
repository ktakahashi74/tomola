import fs from "node:fs";
import path from "node:path";
import { expect, type Page } from "@playwright/test";
import { test } from "./editor-fixture";
import { captureScreenshot, clientHeaders, messagePattern, state, uiMessages, waitForClientRoute } from "./helpers";
import { beforeHydration } from "./support/prehydration";

const invitations = (): { invitation: string } => JSON.parse(fs.readFileSync(path.join(state().dir, "login-help.json"), "utf8"));
async function help(page: Page) {
  const messages = await uiMessages(page);
  return page.locator("details", { has: page.getByText(messages.login_mail_help_heading, { exact: true }) });
}
async function send(page: Page, email: string) {
  await page.goto("/login");
  await waitForClientRoute(page);
  const messages = await uiMessages(page);
  await page.getByLabel(messages.login_email, { exact: true }).fill(email);
  await page.getByRole("button", { name: messages.login_submit, exact: true }).click();
  await expect(page.getByRole("heading", { name: messages.login_code_heading, exact: true })).toBeVisible();
  await waitForClientRoute(page);
}
async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

test("mail help after a send to a registered address, with Japanese desktop and mobile evidence", async ({ browser }) => {
  const email = "login_help_member@example.com";
  const context = await browser.newContext({ locale: "ja-JP", extraHTTPHeaders: clientHeaders("10.88.0.1") });
  try {
    const page = await context.newPage();
    await page.goto("/login");
    const messages = await uiMessages(page);
    await expect(page.getByText(messages.login_invitation_short, { exact: true })).toBeVisible();
    for (const width of [1366, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await noOverflow(page);
      await captureScreenshot(page, { path: `${width}-login.png`, fullPage: true }, "login-help");
    }
    await send(page, email);
    const details = await help(page);
    // The sent state says the mail was sent and names no condition; what it asks of the reader is the 6-digit code and where to look when it does not come.
    await expect(page.getByText(messages.login_sent.replace("{email}", email), { exact: true })).toBeVisible();
    await expect(details).not.toHaveAttribute("open");
    await expect(details.getByRole("listitem", { includeHidden: true })).toHaveCount(2);
    await expect(details.getByText(messages.login_mail_help_spam, { exact: true })).toBeHidden();
    for (const width of [1366, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await noOverflow(page);
      await captureScreenshot(page, { path: `${width}-sent-closed.png`, fullPage: true }, "login-help");
      await details.locator("summary").click();
      await expect(details.getByText(messages.login_mail_help_spam, { exact: true })).toBeVisible();
      await expect(details.getByText(messagePattern(messages.login_mail_help_limit, { count: /\d+/, minutes: /\d+/ }))).toBeVisible();
      await noOverflow(page);
      await captureScreenshot(page, { path: `${width}-sent-open.png`, fullPage: true }, "login-help");
      await details.locator("summary").click();
    }
    await page.getByRole("button", { name: messages.login_restart, exact: true }).click();
    await expect(page.getByLabel(messages.login_email, { exact: true })).toBeVisible();
  } finally { await context.close(); }
});

test("invitation mail help is the same list, with its own note", async ({ browser }) => {
  const context = await browser.newContext({ extraHTTPHeaders: clientHeaders("10.88.0.2") });
  try {
    const page = await context.newPage();
    await page.goto(invitations().invitation);
    await waitForClientRoute(page);
    const messages = await uiMessages(page);
    await page.getByRole("button", { name: messages.invite_submit, exact: true }).click();
    await expect(page.getByRole("heading", { name: messages.login_code_heading, exact: true })).toBeVisible();
    await expect(page.getByText(messages.invite_no_mail_note, { exact: true })).toBeVisible();
    const details = await help(page);
    await details.locator("summary").click();
    await expect(details.getByRole("listitem")).toHaveCount(2);
    await expect(details.getByText(messages.login_mail_help_spam, { exact: true })).toBeVisible();
  } finally { await context.close(); }
});

test("mail help opened before hydration stays open afterwards", async ({ browser }) => {
  const context = await browser.newContext({ extraHTTPHeaders: clientHeaders("10.88.0.3") });
  try {
    const page = await context.newPage();
    await send(page, "login_help_early@example.com");
    const messages = await uiMessages(page);
    await beforeHydration(page, "/login", async () => {
      expect(await page.evaluate(() => !!(window as unknown as { __reactRouterDataRouter?: unknown }).__reactRouterDataRouter)).toBe(false);
      const details = await help(page);
      await details.locator("summary").click();
      await expect(details).toHaveAttribute("open", "");
    });
    const details = await help(page);
    await expect(details).toHaveAttribute("open", "");
    await expect(details.getByText(messages.login_mail_help_spam, { exact: true })).toBeVisible();
    await details.locator("summary").click();
    await expect(details).not.toHaveAttribute("open");
  } finally { await context.close(); }
});
