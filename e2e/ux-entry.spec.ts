import { expect } from "@playwright/test";
import { test } from "./editor-fixture";
import { enableSigningAuthenticator } from "./signing-helper";
import { readPrinciplesSource } from "../tests/helpers/principles-source";
import { clientHeaders, completeTrialFields, enMessages as en, formatMessage, logSize, requestMagicLink, confirmMagicLink, mailFor, uiMessages, useMember, waitForClientRoute } from "./helpers";

// The first sentence of the Japanese principles, read from the edition itself.
function japaneseOpening() {
  const first = readPrinciplesSource("ja").markdown.split(/\r?\n/).slice(1).find(line => line.trim() !== "")!;
  return first.slice(0, first.indexOf("。") + 1);
}

// The way in and the settings screen: who invited you, where you are, what comes next, a greeting once, and a settings page in five parts.
test("an invitation names who sent it and where you are, and the new member is greeted once", async ({ browser }) => {
  const inviterContext = await browser.newContext({ extraHTTPHeaders: clientHeaders("192.0.2.241") });
  const inviter = await inviterContext.newPage();
  const guestContext = await browser.newContext({ extraHTTPHeaders: clientHeaders("192.0.2.242") });
  const page = await guestContext.newPage();
  try {
    await useMember(inviter, "ux_entry_inviter@example.com", "/invites/new");
    await waitForClientRoute(inviter);
    await expect(inviter.getByText(formatMessage(en.invites_help, { days: 14 }), { exact: true })).toBeVisible();
    await inviter.getByLabel(en.invites_email, { exact: true }).fill("ux_entry_guest@example.com");
    await inviter.getByRole("button", { name: en.invites_submit, exact: true }).click();
    const link = (await inviter.locator("main code").innerText()).trim();
    // The message that can be sent as it is carries the link.
    await expect(inviter.getByLabel(en.invites_message_label, { exact: true })).toHaveValue(formatMessage(en.invites_message, { url: link }));
    await expect(inviter.getByRole("button", { name: en.invites_copy_message, exact: true })).toBeVisible();

    await page.goto(link);
    await waitForClientRoute(page);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(formatMessage(en.invite_title_from, { handle: "ux_inviter" }));
    const steps = page.getByRole("list", { name: en.entry_steps_label, exact: true });
    await expect(steps.locator('[aria-current="step"]')).toHaveText(`1 ${en.entry_step_mail}`);
    await expect(page.getByText(en.invite_next, { exact: true })).toBeVisible();
    const since = logSize();
    const confirmation = await requestMagicLink(page, "ux_entry_guest@example.com");
    // On the way in, the code step speaks of signing up, in the button and in the mail.
    await expect(page.getByRole("button", { name: en.invite_code_submit, exact: true })).toBeVisible();
    await expect(steps.locator('[aria-current="step"]')).toHaveText(`2 ${en.entry_step_code}`);
    await expect(page.getByText(en.invite_no_mail_note, { exact: true })).toBeVisible();
    expect((await mailFor("ux_entry_guest@example.com", since)).subject).toBe(en.mail_invite_subject);
    await confirmMagicLink(page, confirmation);
    await expect(page).toHaveURL(/\/onboarding$/);
    await waitForClientRoute(page);

    // Signup: two groups, the name checked as it is typed, and what the chosen language buys.
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(en.onboarding_welcome);
    await expect(steps.locator('[aria-current="step"]')).toHaveText(`3 ${en.entry_step_profile}`);
    await expect(page.getByRole("group", { name: en.onboarding_group_you, exact: true })).toBeVisible();
    await expect(page.getByRole("group", { name: en.onboarding_group_before, exact: true })).toBeVisible();
    await page.getByLabel(en.onboarding_handle, { exact: true }).fill("Mari_Test");
    await expect(page.getByText(formatMessage(en.onboarding_handle_ok, { handle: "mari_test" }), { exact: true })).toBeVisible();
    // The check judges the name as the server will save it: trimmed, full-width letters made ordinary, lowercase.
    await page.getByLabel(en.onboarding_handle, { exact: true }).fill(" Ｍari_Test ");
    await expect(page.getByText(formatMessage(en.onboarding_handle_ok, { handle: "mari_test" }), { exact: true })).toBeVisible();
    await page.getByLabel(en.onboarding_handle, { exact: true }).fill("!");
    await expect(page.getByText(en.onboarding_error_handle, { exact: true })).toBeVisible();
    await page.getByLabel(en.onboarding_handle, { exact: true }).fill("mari_test");
    await page.getByRole("combobox", { name: en.onboarding_home_area, exact: true }).click();
    await page.getByRole("listbox").getByRole("option", { name: "日本語", exact: true }).click();
    await expect(page.getByTestId("onboarding-language-echo")).toContainText(japaneseOpening());
    await completeTrialFields(page);
    await page.getByRole("button", { name: en.onboarding_join, exact: true }).click();

    // The greeting shows once on the page the member arrives on, and not again.
    await expect(page).toHaveURL(new URL("/", page.url()).href);
    await expect(page.locator("html")).toHaveAttribute("lang", "ja");
    const ui = await uiMessages(page);
    const welcome = page.getByRole("complementary", { name: ui.welcome_label, exact: true });
    await expect(welcome).toContainText(formatMessage(ui.welcome_hello, { handle: "mari_test" }));
    await expect(welcome.getByRole("link", { name: ui.welcome_write_intro, exact: true })).toHaveAttribute("href", "/u/mari_test");
    await expect(welcome.getByRole("link", { name: ui.connect_keep_using_link, exact: true })).toHaveAttribute("href", "/connect");
    // The server drops the greeting's cookie on the page that shows it, so it needs no script to be once.
    expect((await guestContext.cookies()).some(cookie => cookie.name === "tomola.welcome")).toBe(false);
    await welcome.getByRole("button", { name: ui.welcome_close, exact: true }).click();
    await expect(welcome).toHaveCount(0);
    await page.goto("/");
    await expect(page.getByRole("complementary", { name: ui.welcome_label, exact: true })).toHaveCount(0);
  } finally { await inviterContext.close(); await guestContext.close(); }
});

test("confirming it is you names the member and what it is for, and does not look like a logout", async ({ browser }) => {
  const context = await browser.newContext({ extraHTTPHeaders: clientHeaders("192.0.2.244") });
  const page = await context.newPage();
  try {
    await useMember(page, "ux_entry_reauth@example.com");
    await page.goto("/login?reauth=1&next=%2Fsettings%2Ftokens");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(en.reauth_title);
    await expect(page.getByText(formatMessage(en.reauth_for_tokens, { who: "@ux_reauth" }), { exact: true })).toBeVisible();
    await expect(page.getByLabel(en.login_email, { exact: true })).toHaveValue("ux_entry_reauth@example.com");
    await expect(page.getByLabel(en.login_email, { exact: true })).not.toBeEditable();
    await expect(page.getByRole("button", { name: en.reauth_submit, exact: true })).toBeVisible();
    // The way out leads back to the screen that asked.
    await expect(page.getByRole("link", { name: en.reauth_cancel, exact: true })).toHaveAttribute("href", "/settings/tokens");
    // Neither the description of the place nor the note on invitations belongs to this screen.
    await expect(page.getByText(en.entry_intro, { exact: true })).toHaveCount(0);
    await expect(page.getByText(en.login_invitation_short, { exact: true })).toHaveCount(0);
  } finally { await context.close(); }
});

test("a member with a passkey is offered it from the email field, and only when the field is used", async ({ browser }) => {
  const context = await browser.newContext({ extraHTTPHeaders: clientHeaders("192.0.2.246") });
  const page = await context.newPage();
  try {
    await useMember(page, "ux_entry_passkey@example.com", "/settings");
    await waitForClientRoute(page);
    await enableSigningAuthenticator(page);
    await page.getByRole("button", { name: en.settings_passkeys_add, exact: true }).click();
    await expect(page.getByText(en.settings_passkeys_added, { exact: true })).toBeVisible();
    await context.request.post("/logout", { headers: { origin: new URL(page.url()).origin }, form: {} });
    await page.goto("/login");
    await waitForClientRoute(page);
    // Looking at the login page asks nothing of the passkey; going into the email field lets the browser offer it, and choosing it signs in.
    await page.waitForTimeout(1500);
    await expect(page).toHaveURL(/\/login$/);
    await page.getByLabel(en.login_email, { exact: true }).focus();
    await expect(page.locator("[data-member-menu-trigger]")).toHaveAttribute("title", "@ux_passkey");
  } finally { await context.close(); }
});
