import { readingActions } from "./helpers";
import { completeTrialFields } from "./helpers";
import fs from "node:fs";
import path from "node:path";
import { expect, type Page } from "@playwright/test";
import { test } from "./editor-fixture";
import { waitForClientRoute, captureScreenshot, useMember, clientHeaders, enMessages as en, formatMessage, logSize, loginCodeFor, openUserMenu, state, waitForFormReady, openReplyMore, forgetLocalDrafts } from "./helpers";

type Fixture = { topicId: number; titlelessId: number; pendingId: number; replies: number[]; memberInvite: string; signupInvite: string };
const fixture = (): Fixture => JSON.parse(fs.readFileSync(path.join(state().dir, "plain-words.json"), "utf8"));
async function screenshot(page: Page, name: string) {
  if (!process.env.E2E_EVIDENCE_DIR) return;
  await waitForClientRoute(page);
  fs.mkdirSync(process.env.E2E_EVIDENCE_DIR, { recursive: true });
  await captureScreenshot(page, { path: path.join(process.env.E2E_EVIDENCE_DIR, `${name}.png`), fullPage: true, caret: "initial" }, "e2e-plain-words");
}
async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}

test("login and unusable invitations explain the next step, and signup returns to the original page", async ({ browser }) => {
  const f = fixture();
  const context = await browser.newContext({ extraHTTPHeaders: clientHeaders("10.64.0.1") });
  const page = await context.newPage();
  try {
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/login");
      await expect(page.getByText(en.login_invitation_short, { exact: true })).toBeVisible();
      await screenshot(page, `${width}-login`);
      await noOverflow(page);
      await page.goto("/invite/invalid-fixture-token");
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(en.invite_unusable_title);
      await expect(page).toHaveTitle(en.invite_unusable_title);
      await expect(page.getByRole("link", { name: en.invite_invalid_login })).toHaveAttribute("href", "/login");
      await screenshot(page, `${width}-invalid-invitation`);
      await noOverflow(page);
    }
    const next = `/t/${f.topicId}?lang=en#reply`;
    if (process.env.E2E_PUBLIC_READING === "1") {
      await page.goto(next);
      await page.locator("#reply").getByRole("link", { name: en.login_title, exact: true }).click();
      // The existing login link carries the article and query; preserve a fragment too.
      await expect(page).toHaveURL(/\/login\?next=/);
      expect(new URL(page.url()).searchParams.get("next")).toBe(next.split("#")[0]);
    }
    await page.goto(`/login?${new URLSearchParams({ next })}`);
    await page.getByLabel(en.login_email, { exact: true }).fill("plain_signup@example.com");
    const since = logSize();
    await page.getByRole("button", { name: en.login_submit, exact: true }).click();
    const code = await loginCodeFor("plain_signup@example.com", since);
    await page.getByLabel(en.login_code_label, { exact: true }).fill(code);
    await page.getByRole("button", { name: en.login_code_submit, exact: true }).click();
    await expect(page).toHaveURL(url => url.pathname === "/onboarding" && url.searchParams.get("next") === next);
    await expect(page.getByText(en.onboarding_language_help, { exact: true })).toBeVisible();
    const languageDetails = page.locator("details", { has: page.locator("summary", { hasText: en.onboarding_language_details }) });
    await expect(languageDetails.getByText(en.onboarding_home_area_help, { exact: true })).toBeHidden();
    await languageDetails.locator("summary").click();
    await expect(languageDetails.getByText(en.onboarding_home_area_help, { exact: true })).toBeVisible();
    const handle = page.getByLabel(en.onboarding_handle, { exact: true });
    await handle.fill("Plain_Signup");
    await expect(handle).toHaveValue("plain_signup");
    await expect(handle).toHaveAttribute("autocapitalize", "none");
    await expect(handle).toHaveAttribute("autocorrect", "off");
    await expect(handle).toHaveAttribute("spellcheck", "false");
    await handle.press("Home");
    await handle.pressSequentially("X");
    await expect(handle).toHaveValue("xplain_signup");
    expect(await handle.evaluate(input => (input as HTMLInputElement).selectionStart)).toBe(1);
    await handle.press("Backspace");
    await expect(handle).toHaveValue("plain_signup");
    await completeTrialFields(page);
    await page.getByRole("button", { name: en.onboarding_join, exact: true }).click();
    await expect(page).toHaveURL(new URL(next, state().baseURL).href);
    await expect(page.locator("[data-member-menu-trigger]")).toHaveAttribute("title", "@plain_signup");
    await expect(page.locator("#reply textarea[name=body]")).toBeVisible();
  } finally { await context.close(); }
});

test("post controls, metadata and empty states work at desktop and phone widths, including one-time logout", async ({ browser }) => {
  const f = fixture();
  const context = await browser.newContext({ extraHTTPHeaders: clientHeaders("10.64.0.2") });
  const page = await context.newPage();
  // Keep the pending fixture stable across both viewport checks.
  await page.route(`**/t/${f.pendingId}/translations*`, route => route.fulfill({ json: { ready: [], unavailable: [], stopped: false } }));
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  try {
    await useMember(page, "plain_member@example.com");
    await expect(page.getByText(en.passkey_prompt, { exact: true })).toBeVisible();
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/t/${f.topicId}?lang=en&tr=${f.topicId}`);
      const topic = page.locator(`#p-${f.topicId}`);
      const reply = page.locator(`#c-${f.replies[0]}`);
      const form = page.locator("#reply form");
      await waitForFormReady(form);
      await expect(page.getByLabel(en.field_body, { exact: true })).toHaveCount(1);
      // The reply field's extras (preview, writing help, writing with an AI) are behind "…"; the writing help is two short lines and says nothing of frontmatter.
      await expect(form.getByText(en.writing_math_help, { exact: true })).toBeHidden();
      await openReplyMore(page);
      await expect(form.getByText(en.writing_math_help, { exact: true })).toBeVisible();
      const connect = form.getByRole("link", { name: en.footer_connect, exact: true });
      await expect(connect).toHaveAttribute("href", "/connect");
      await expect(connect).toHaveAttribute("target", "_blank");
      await page.locator("[data-reply-more] > summary").click();
      await expect(topic.locator("[data-reading-language]")).toContainText(formatMessage(en.label_from_lang_machine_engine, { lang: en.language_name_ja, engine: en.engine_fake }));
      const actions = await readingActions(page);
      await expect(actions.getByRole("button", { name: en.open_in_ai, exact: true })).toHaveAttribute("title", en.open_in_ai_help);
      await actions.getByRole("button", { name: en.open_in_ai_menu, exact: true }).click();
      const menu = page.getByRole("menu");
      await expect(menu.getByText(en.open_in_ai_help, { exact: true })).toBeVisible();
      await expect(menu.getByRole("menuitem", { name: en.open_in_ai_help, exact: true })).toHaveCount(0);
      await page.keyboard.press("Escape");
      const child = page.locator(`#c-${f.replies[1]}`);
      // A reply to the branch root is grouped under it; the grouping stands in for the "in reply to" line.
      await expect(page.locator(`[data-reply-branch="${f.replies[0]}"] #c-${f.replies[1]}`)).toBeVisible();
      await expect(child.getByRole("link", { name: formatMessage(en.reply_parent_link, { handle: "kim" }), exact: true })).toHaveCount(0);
      for (const index of [3, 5]) {
        const unavailable = page.locator(`#c-${f.replies[index]}`);
        await expect(unavailable.getByRole("link", { name: formatMessage(en.reply_parent_link, { handle: "kim" }), exact: true })).toHaveCount(0);
      }
      // Reply and Insightful remain adjacent actions, with reporting below.
      const primary = reply.getByRole("link", { name: en.reply_to_button, exact: true });
      const primaryRow = primary.locator("..");
      await expect(primaryRow.getByRole("button", { name: en.insightful_give, exact: true })).toBeVisible();
      await expect(reply.getByRole("button", { name: en.report_button, exact: true })).toBeVisible();
      const body = reply.locator("[data-quote-entry]");
      await body.locator("p").first().scrollIntoViewIfNeeded();
      await body.locator("p").first().evaluate(paragraph => {
        const range = document.createRange();
        range.selectNodeContents(paragraph);
        window.getSelection()!.removeAllRanges();
        window.getSelection()!.addRange(range);
      });
      const quote = page.getByRole("button", { name: en.quote_reply, exact: true });
      await expect(quote).toBeVisible();
      expect((await quote.boundingBox())!.height).toBeGreaterThanOrEqual(32);
      const quoteColors = await quote.evaluate(button => ({ background: getComputedStyle(button).backgroundColor, foreground: getComputedStyle(button).color }));
      const postColors = await form.getByRole("button", { name: en.submit_reply, exact: true }).evaluate(button => ({ background: getComputedStyle(button).backgroundColor, foreground: getComputedStyle(button).color }));
      expect(quoteColors).toEqual(postColors);
      const overlaps = await quote.evaluate(button => {
        const box = button.getBoundingClientRect();
        // Only controls that are drawn count (the places in a closed drawer are not), and a touching edge of at most 2px is not an overlap.
        return [...document.querySelectorAll("button, a, summary, input, textarea, select")].filter(element => element !== button && element.checkVisibility({ contentVisibilityAuto: true })).some(element => {
          const other = element.getBoundingClientRect();
          return other.width > 0 && other.height > 0 && box.left < other.right && box.right > other.left && box.top + 2 < other.bottom && box.bottom > other.top + 2;
        });
      });
      expect(overlaps).toBe(false);
      await quote.click();
      await expect(form.getByText(formatMessage(en.reply_target_note, { handle: "kim" }), { exact: true })).toBeVisible();
      await expect(form.locator('input[name="parentId"]')).toHaveValue(String(f.replies[0]));
      await page.goto(`/t/${f.topicId}?reply_to=c-${f.replies[2]}`);
      await expect(page.locator("#reply").getByText(en.reply_parent_unavailable, { exact: true })).toBeVisible();
      await expect(page.locator("#reply").getByText(formatMessage(en.reply_target_note, { handle: "kim" }), { exact: true })).toHaveCount(0);
      await page.goto(`/t/${f.topicId}?lang=en&tr=${f.topicId}`);
      await screenshot(page, `${width}-topic`);
      await noOverflow(page);
      await page.goto("/t/new");
      await expect(page.getByText(en.related_link_help, { exact: true })).toBeHidden();
      await screenshot(page, `${width}-compose`);
      await noOverflow(page);
      await page.goto("/notifications");
      await expect(page.getByText(en.notifications_empty, { exact: true })).toBeVisible();
      const emailSettings = page.getByRole("link", { name: en.notifications_email_settings, exact: true });
      await expect(emailSettings).toHaveAttribute("href", "/settings#settings-email");
      await screenshot(page, `${width}-empty-notifications`);
      await noOverflow(page);
      await emailSettings.click();
      await expect(page).toHaveURL(url => url.pathname === "/settings" && url.hash === "#settings-email");
      await expect(page.getByRole("heading", { name: en.settings_email_heading, exact: true })).toBeInViewport();
    }
    await page.goto("/settings#settings-handle");
    const handleSettings = page.getByRole("region", { name: en.settings_handle_heading, exact: true });
    await handleSettings.locator("summary").click();
    const handle = handleSettings.getByLabel(en.onboarding_handle, { exact: true });
    await handle.fill("Plain_Changed");
    await expect(handle).toHaveValue("plain_changed");
    await expect(handle).toHaveAttribute("autocapitalize", "none");
    await expect(handle).toHaveAttribute("autocorrect", "off");
    await expect(handle).toHaveAttribute("spellcheck", "false");
    await handleSettings.getByRole("button", { name: en.settings_handle_heading, exact: true }).click();
    await expect(page.locator("[data-member-menu-trigger]")).toHaveAttribute("title", "@plain_changed");
    await page.reload();
    await expect(handle).toHaveValue("plain_changed");
    await page.goto(`/t/${f.titlelessId}`);
    const heading = page.getByRole("heading", { level: 1 });
    await expect(heading).toHaveCount(1);
    expect(await heading.evaluate(element => element.getBoundingClientRect().width)).toBeLessThanOrEqual(1);
    expect(Array.from(await page.title()).length).toBeLessThanOrEqual(41);
    await page.goto(`/t/${f.pendingId}?lang=en`);
    await expect(page.getByText(en.translation_working, { exact: true })).toBeVisible();
    await page.goto(`/t/${f.topicId}?lang=en&tr=${f.topicId}`);
    // The reply typed earlier (quoted text) is offered back on a visit; this part is about the post, so start from an empty reply and no unsent-text question on leaving.
    await forgetLocalDrafts(page);
    await page.reload();
    await waitForClientRoute(page);
    const topic = page.locator(`#p-${f.topicId}`);
    await topic.getByRole("button", { name: en.report_button, exact: true }).click();
    await expect(topic.getByRole("status").filter({ hasText: en.report_thanks })).toBeVisible();
    await topic.getByLabel(en.report_note, { exact: true }).fill("Fixture translation report");
    await topic.getByRole("button", { name: en.save_changes, exact: true }).click();
    await (await openUserMenu(page)).getByRole("menuitem", { name: en.nav_logout, exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: en.logged_out })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("status").filter({ hasText: en.logged_out })).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally { await context.close(); }
});
