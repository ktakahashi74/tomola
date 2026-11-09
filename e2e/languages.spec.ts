import { expect } from "@playwright/test";
import { test } from "./editor-fixture";
import { useMember, formatMessage, clientHeaders, enMessages, state, waitForFormReady, openPostSettings } from "./helpers";
import { acceptSignedWrite, enableSigningAuthenticator } from "./signing-helper";

const english = "This is a place for people to share their ideas and to learn from each other.";
const french = "Nous avons une place pour les personnes qui veulent partager leurs idées avec les autres.";

test("automatic prose language survives language reselection and a real signed publication", async ({ browser }) => {
  const context = await browser.newContext({ extraHTTPHeaders: clientHeaders("10.26.0.1") });
  const page = await context.newPage();
  try {
    await useMember(page, "language_signer@example.com");
    await enableSigningAuthenticator(page);
    await page.goto("/settings");
    await page.getByRole("button", { name: enMessages.settings_passkeys_add, exact: true }).click();
    await expect(page.getByText(enMessages.settings_passkeys_added, { exact: true })).toBeVisible();
    if (!(await page.locator("#settings-advanced").evaluate(element => (element as HTMLDetailsElement).open))) await page.locator("summary").filter({ hasText: enMessages.settings_advanced_heading }).click();
    await page.getByRole("checkbox", { name: enMessages.settings_sign_posts_label, exact: true }).check();
    await page.locator('form:has(input[name="intent"][value="sign-posts"])').getByRole("button", { name: enMessages.save_changes, exact: true }).click();
    await acceptSignedWrite(page);
    await expect(page).toHaveURL(url => url.pathname === "/settings" && url.searchParams.get("saved") === "sign-posts" && url.hash === "#settings-signing");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/t/new");
    await waitForFormReady(page.locator('form', { has: page.locator('input[name="title"]') }));
    await expect(page.locator('input[name="lang"]')).toHaveValue("");
    await openPostSettings(page);
    await expect(page.getByRole("combobox", { name: enMessages.field_lang, exact: true }).locator('[data-slot="select-value"]')).toHaveText(enMessages.field_lang_auto);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByLabel(enMessages.field_body, { exact: true }).fill(english);
    await page.getByRole("button", { name: enMessages.submit_post, exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText(formatMessage(enMessages.original_lang_detected, { lang: "English" }), { exact: true })).toBeVisible();
    await dialog.getByRole("combobox").click();
    await page.getByRole("listbox").getByRole("option", { name: "日本語", exact: true }).click();
    await expect(dialog.getByText(formatMessage(enMessages.original_lang, { lang: "日本語" }), { exact: true })).toBeVisible();
    await expect(page.locator('input[name="lang"]')).toHaveValue("ja");
    await expect(dialog.getByText(formatMessage(enMessages.original_lang_mismatch, { detected: "English" }))).toBeVisible();
    await dialog.getByRole("button", { name: formatMessage(enMessages.original_lang_change, { detected: "English" }), exact: true }).click();
    await expect(dialog.getByText(formatMessage(enMessages.original_lang, { lang: "English" }), { exact: true })).toBeVisible();
    await expect(page.locator('input[name="lang"]')).toHaveValue("en");
    await acceptSignedWrite(page);
    await expect(page).toHaveURL(/\/t\/(\d+)\?posted=\1$/);
    const exported = await context.request.get("/settings/export");
    const data = await exported.json();
    expect(data.entries.find((entry: { body: string }) => entry.body === english).lang).toBe("en");
    expect(data.signatures.some((signature: { operation: string }) => signature.operation === "create-topic")).toBe(true);
    // Automatic detection itself is also signed (no explicit reselection).
    await page.goto("/t/new");
    await waitForFormReady(page.locator('form', { has: page.locator('input[name="title"]') }));
    await page.getByLabel(enMessages.field_body, { exact: true }).fill(`${english} We can learn together.`);
    await page.getByRole("button", { name: enMessages.submit_post, exact: true }).click();
    await expect(dialog.getByText(formatMessage(enMessages.original_lang_detected, { lang: "English" }), { exact: true })).toBeVisible();
    await acceptSignedWrite(page);
    await expect(page).toHaveURL(/\/t\/(\d+)\?posted=\1$/);
    const final = await (await context.request.get("/settings/export")).json();
    expect(final.entries.find((entry: { body: string }) => entry.body === `${english} We can learn together.`).lang).toBe("en");
    const id = new URL(page.url()).pathname.split("/")[2];
    await page.goto(`/t/${id}/edit`);
    await waitForFormReady(page.locator("form", { has: page.locator('input[name="title"]') }));
    await openPostSettings(page);
    await page.getByRole("combobox", { name: enMessages.field_lang, exact: true }).click();
    await page.getByRole("option", { name: "日本語", exact: true }).click();
    await page.getByRole("button", { name: enMessages.save_changes, exact: true }).click();
    await expect(dialog.getByText(formatMessage(enMessages.original_lang, { lang: "日本語" }), { exact: true })).toBeVisible();
    await acceptSignedWrite(page);
    await expect(page).toHaveURL(new RegExp(`/t/${id}(?:\\?sl=[\\w-]+)?$`));
    const corrected = await (await context.request.get("/settings/export")).json();
    expect(corrected.entries.find((entry: { body: string }) => entry.body === `${english} We can learn together.`).lang).toBe("ja");
    expect(corrected.signatures.some((signature: { operation: string }) => signature.operation === "edit-topic")).toBe(true);
  } finally { await context.close(); }
});

test("an author corrects only a topic's language and sees the selected language after reopening", async ({ page }) => {
  await useMember(page, "lang_corrector@example.com");
  await page.goto("/t/new");
  await waitForFormReady(page.locator("form", { has: page.locator('input[name="title"]') }));
  await page.getByLabel(enMessages.field_body, { exact: true }).fill(english);
  await openPostSettings(page);
  await page.getByRole("combobox", { name: enMessages.field_lang, exact: true }).click();
  await page.getByRole("option", { name: "日本語", exact: true }).click();
  await page.getByRole("button", { name: enMessages.submit_post, exact: true }).click();
  await expect(page).toHaveURL(/\/t\/(\d+)\?posted=\1$/);
  const id = new URL(page.url()).pathname.split("/")[2];
  await page.goto(`/t/${id}/edit`);
  await openPostSettings(page);
  await page.getByRole("combobox", { name: enMessages.field_lang, exact: true }).click();
  await page.getByRole("option", { name: "English", exact: true }).click();
  await page.getByRole("button", { name: enMessages.save_changes, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/t/${id}(?:\\?sl=[\\w-]+)?$`));
  await page.goto(`/t/${id}/edit`);
  await expect(page.locator('input[name="lang"]')).toHaveValue("en");
  await expect(page.getByLabel(enMessages.field_body, { exact: true })).toHaveValue(english);
});

test("French login footer follows the explicit preview setting", async ({ browser }) => {
  const context = await browser.newContext({ locale: "fr-FR" });
  const page = await context.newPage();
  try {
    await page.goto("/login");
    await expect(page.locator("html")).toHaveAttribute("lang", "fr");
    const preview = (process.env.E2E_PREVIEW_LANGS ?? "").split(",").includes("fr");
    await expect(page.locator("footer").getByText(enMessages.ui_preview_notice, { exact: true })).toHaveCount(preview ? 1 : 0);
  } finally { await context.close(); }
});
