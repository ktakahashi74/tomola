import { test, useMember, state } from "./helpers";
import { expect } from "@playwright/test";
import { clientHeaders, enMessages, formatMessage, waitForFormReady } from "../e2e/helpers";
import { enableSigningAuthenticator, acceptSignedWrite } from "../e2e/signing-helper";

const french = "Nous avons une place pour les personnes qui veulent partager leurs idées avec les autres.";

test("unopened French prose preserves its language and shows a non-blocking notice", async ({ browser }) => {
  const context = await browser.newContext({ extraHTTPHeaders: clientHeaders("10.26.0.2") });
  const page = await context.newPage();
  try {
    await useMember(page, "language_fallback_prod@example.com");
    await enableSigningAuthenticator(page);
    await page.goto("/settings");
    await page.getByRole("button", { name: enMessages.settings_passkeys_add, exact: true }).click();
    await expect(page.getByText(enMessages.settings_passkeys_added, { exact: true })).toBeVisible();
    if (!(await page.locator("#settings-advanced").evaluate(element => (element as HTMLDetailsElement).open))) await page.locator("#settings-advanced > summary").click();
    await page.getByRole("checkbox", { name: enMessages.settings_sign_posts_label, exact: true }).check();
    await page.locator('form:has(input[name="intent"][value="sign-posts"])').getByRole("button", { name: enMessages.save_changes, exact: true }).click();
    await acceptSignedWrite(page);
    await expect(page).toHaveURL(url => url.pathname === "/settings" && url.searchParams.get("saved") === "sign-posts" && url.hash === "#settings-signing");
    await page.goto("/t/new");
    await waitForFormReady(page.locator('form', { has: page.locator('input[name="title"]') }));
    await page.getByLabel(enMessages.field_body, { exact: true }).fill(french);
    await page.getByRole("button", { name: enMessages.submit_post, exact: true }).click();
    await expect(page.getByRole("dialog").getByText(formatMessage(enMessages.original_lang_detected, { lang: "Français" }), { exact: true })).toBeVisible();
    const notice = page.getByRole("dialog").getByRole("note");
    await expect(notice).toContainText(formatMessage(enMessages.original_lang_other_named, { lang: "French" }));
    await expect(notice.getByRole("link", { name: enMessages.languages_about, exact: true })).toHaveAttribute("href", "/languages");
    await acceptSignedWrite(page);
    await expect(page).toHaveURL(url => /^\/t\/\d+$/.test(url.pathname));
    const data = await (await context.request.get("/settings/export")).json();
    expect(data.entries.find((entry: { body: string }) => entry.body === french).lang).toBe("fr");
  } finally { await context.close(); }
});
