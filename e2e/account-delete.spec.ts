import fs from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { captureScreenshot, clientHeaders, enMessages as en, state, useMember } from "./helpers";
import { acceptSignedWrite, enableSigningAuthenticator } from "./signing-helper";

type Fixture = { topicId: number; slug: string; body: string; chat: string };
function fixture(name: string): Fixture { return JSON.parse(fs.readFileSync(path.join(state().dir, "account-delete.json"), "utf8"))[name]; }

async function requireVillageChoice(page: Page, handle: string) {
  const form = page.locator('form:has(input[name="intent"][value="delete-account"])');
  const choices = form.locator('select[name^="village:"]');
  await expect(choices).toHaveValue("");
  await expect(choices).toHaveAttribute("required", "");
  await page.locator('input[name="confirmation"]').fill(handle);
  await page.getByRole("button", { name: en.account_delete_confirm, exact: true }).click();
  expect(await choices.evaluate(node => (node as HTMLSelectElement).validity.valueMissing)).toBe(true);
  // Exercise the server check as well as native constraint validation.
  await form.evaluate(node => { (node as HTMLFormElement).noValidate = true; });
  await page.getByRole("button", { name: en.account_delete_confirm, exact: true }).click();
  await expect(choices).toHaveAttribute("aria-invalid", "true");
  const errorId = await choices.getAttribute("aria-describedby");
  expect(errorId).toBeTruthy();
  await expect(page.locator(`[id="${errorId}"]`)).toHaveText(en.account_delete_village_required);
  await expect(page).toHaveURL(/\/settings\/delete-account$/);
  await form.evaluate(node => { (node as HTMLFormElement).noValidate = false; });
  await page.locator('input[name="confirmation"]').fill(handle);
  return choices;
}

for (const scenario of ["keep", "delete"]) {
  test(`account deletion ${scenario}: confirms ownership, logs out, erases chat and applies the post choice`, async ({ browser }, info) => {
    const context = await browser.newContext({ locale: "en-US", extraHTTPHeaders: clientHeaders(`10.47.1.${scenario === "keep" ? "1" : "2"}`) });
    const page = await context.newPage(); const f = fixture(scenario);
    try {
      await useMember(page, `quit_${scenario}_writer@example.com`, "/settings");
      await page.getByRole("link", { name: en.account_delete_title, exact: true }).click();
      await expect(page.getByRole("heading", { name: en.account_delete_title, exact: true })).toBeVisible();
      await expect(page.getByRole("link", { name: en.settings_export_link, exact: true })).toHaveAttribute("href", "/settings/export");
      await expect(page.getByRole("radio", { name: en.account_delete_keep, exact: true })).toBeChecked();
      await expect(page.getByText(en.account_delete_chat_help, { exact: true })).toBeVisible();
      await page.locator('input[name="confirmation"]').fill("wrong");
      await page.getByRole("button", { name: en.account_delete_confirm, exact: true }).click();
      await expect(page.getByRole("alert")).toHaveText(en.account_delete_error_confirmation);
      await page.locator('input[name="confirmation"]').fill(`quit_${scenario}_writer`);
      if (scenario === "delete") await page.getByRole("radio", { name: en.account_delete_remove, exact: true }).check();
      await page.setViewportSize({ width: 390, height: 844 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await captureScreenshot(page, { path: info.outputPath(`account-delete-${scenario}-mobile.png`), fullPage: true }, "account-delete");
      let release!: () => void, intercepted!: () => void;
      const gate = new Promise<void>(r => { release = r; }), started = new Promise<void>(r => { intercepted = r; });
      await page.route(/\/settings\/delete-account\.data(?:\?|$)/, async route => { intercepted(); await gate; await route.continue(); });
      const submitted = page.getByRole("button", { name: en.account_delete_confirm, exact: true }).click();
      await started;
      try { await expect(page.getByRole("button", { name: en.account_delete_confirm, exact: true })).toBeDisabled(); }
      finally { release(); }
      await submitted;
      await expect(page).toHaveURL(/\/login\?account-deleted=1$/);
      await expect(page.getByRole("status")).toContainText(en.account_delete_complete);
      await page.goto("/settings");
      await expect(page).toHaveURL(/\/login/);
      await useMember(page, `quit_${scenario}_reader@example.com`, `/t/${f.topicId}`);
      if (scenario === "keep") {
        await expect(page.getByText(f.body, { exact: true })).toBeVisible();
        for (const scope of ["[data-reading-byline]", "[data-article-signature]"]) {
          await expect(page.locator(scope).getByText(en.account_delete_member, { exact: true })).toBeVisible();
        }
        await expect(page.locator(`a[href="/u/quit_${scenario}_writer"]`)).toHaveCount(0);
        const twin = await context.request.get(`/t/${f.topicId}.md`);
        const text = await twin.text();
        expect(text).toContain(en.account_delete_member);
        expect(text).not.toContain(`quit_${scenario}_writer`);
      } else await expect(page.getByText(f.body, { exact: true })).toHaveCount(0);
      await page.goto(`/v/${f.slug}/chat`);
      await expect(page.getByText(f.chat, { exact: true })).toHaveCount(0);
    } finally { await context.close(); }
  });
}

test("signed account deletion binds the post choice and uses real passkey confirmation", async ({ browser }) => {
  const context = await browser.newContext({ locale: "en-US", extraHTTPHeaders: clientHeaders("10.47.1.3") });
  const page = await context.newPage();
  try {
    await useMember(page, "quit_signed_writer@example.com", "/settings");
    await enableSigningAuthenticator(page);
    await page.getByRole("button", { name: en.settings_passkeys_add, exact: true }).click();
    await expect(page.getByText(en.settings_passkeys_added, { exact: true })).toBeVisible();
    await page.locator("#settings-advanced summary").first().click();
    await page.getByRole("checkbox", { name: en.settings_sign_posts_label, exact: true }).check();
    await page.locator('form', { has: page.locator('input[name="intent"][value="sign-posts"]') }).getByRole("button", { name: en.save_changes, exact: true }).click();
    await acceptSignedWrite(page);
    await page.goto("/settings/delete-account");
    await page.locator('form[data-ready="true"]').waitFor();
    await page.locator('input[name="confirmation"]').fill("quit_signed_writer");
    await page.getByRole("button", { name: en.account_delete_confirm, exact: true }).click();
    const dialog = page.getByRole("dialog", { name: en.signing_heading, exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(en.account_delete_chat_help, { exact: false })).toBeVisible();
    await dialog.getByRole("button", { name: en.signing_accept_remove, exact: true }).click();
    await expect(page).toHaveURL(/\/login\?account-deleted=1$/);
  } finally { await context.close(); }
});


test("native account deletion transfers a sole-owned village and repeats the completion safely", async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false, locale: "en-US", extraHTTPHeaders: clientHeaders("10.47.1.4") });
  const page = await context.newPage(); const f = fixture("duplicate");
  try {
    await useMember(page, "quit_duplicate_writer@example.com", "/settings/delete-account");
    const form = page.locator('form:has(input[name="intent"][value="delete-account"])');
    const choices = await requireVillageChoice(page, "quit_duplicate_writer");
    await choices.selectOption({ label: en.account_delete_transfer_member.replace("{handle}", "quit_duplicate_reader") });
    await page.locator('input[name="confirmation"]').fill("quit_duplicate_writer");
    const pairs = await form.evaluate(node => [...new FormData(node as HTMLFormElement)].map(([key,value]) => [key,String(value)]));
    const body = new URLSearchParams(pairs as [string,string][]).toString();
    const origin = new URL(page.url()).origin;
    await page.getByRole("button", { name: en.account_delete_confirm, exact: true }).click();
    await expect(page).toHaveURL(/\/login\?account-deleted=1$/);
    const repeated = await context.request.post("/settings/delete-account", { data: body, headers: { origin, "content-type": "application/x-www-form-urlencoded" } });
    expect(repeated.url()).toMatch(/\/login\?account-deleted=1$/);
    expect(await repeated.text()).toContain(en.account_delete_complete);
    await useMember(page, "quit_duplicate_reader@example.com", `/v/${f.slug}`);
    await expect(page.getByText(en.village_ended, { exact: true })).toHaveCount(0);
    await page.goto("/notifications");
    await expect(page.getByText(en.notification_village_owner_changed.replace("{name}", "Quit duplicate village"), { exact: true })).toBeVisible();
  } finally { await context.close(); }
});

test("native account deletion requires an explicit village choice with JavaScript before ending it", async ({ browser }, info) => {
  const context = await browser.newContext({ locale: "en-US", extraHTTPHeaders: clientHeaders("10.47.1.5") });
  const page = await context.newPage(); const f = fixture("choose");
  try {
    await useMember(page, "quit_choose_writer@example.com", "/settings/delete-account");
    await page.locator('form[data-ready="true"]').waitFor();
    const choices = await requireVillageChoice(page, "quit_choose_writer");
    await page.setViewportSize({ width: 390, height: 844 });
    await captureScreenshot(page, { path: info.outputPath("account-delete-village-required.png"), fullPage: true }, "account-delete");
    await choices.selectOption("end");
    await page.getByRole("button", { name: en.account_delete_confirm, exact: true }).click();
    await expect(page).toHaveURL(/\/login\?account-deleted=1$/);
    await useMember(page, "quit_choose_reader@example.com", `/v/${f.slug}`);
    await expect(page.getByText(en.village_ended, { exact: true })).toBeVisible();
  } finally { await context.close(); }
});
