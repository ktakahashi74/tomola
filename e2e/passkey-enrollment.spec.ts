import { saveEditorDraft } from "./draft-autosave-helper";
import { expect } from "@playwright/test";
import { test } from "./editor-fixture";
import { useMember, clientHeaders, enMessages, state, messageTitleField as titleField, waitForFormReady } from "./helpers";

test("a member without passkeys publishes browser drafts and exports unsigned posts", async ({ browser }) => {
  const context = await browser.newContext({ extraHTTPHeaders: clientHeaders("10.17.1.1") });
  const page = await context.newPage();
  try {
    await useMember(page, "enrollment@example.com");
    await expect(page).toHaveURL(new URL("/", state().baseURL).href);
    await page.goto("/t/new");
    await waitForFormReady(page.locator("form", { has: titleField(page) }));
    await page.getByRole("textbox", { name: enMessages.field_body, exact: true }).fill("My first post without a passkey");
    await page.getByRole("button", { name: enMessages.submit_post, exact: true }).click();
    await expect(page).toHaveURL(/\/t\/(\d+)\?posted=\1$/);
    await page.goto("/settings");
    if (!(await page.locator("#settings-advanced").evaluate(element => (element as HTMLDetailsElement).open))) await page.locator("summary").filter({ hasText: enMessages.settings_advanced_heading }).click();
    await expect(page.getByRole("checkbox", { name: enMessages.settings_sign_posts_label, exact: true })).toBeDisabled();
    await expect(page.getByRole("checkbox", { name: enMessages.settings_sign_posts_label, exact: true })).not.toBeChecked();
    await expect(page.getByText(enMessages.settings_sign_posts_need_passkey, { exact: true })).toBeVisible();
    await page.locator("#settings-handle summary").click();
    await page.getByLabel(enMessages.onboarding_handle, { exact: true }).fill("new_enrollment");
    await page.getByRole("button", { name: enMessages.settings_handle_heading, exact: true }).click();
    await expect(page).toHaveURL(url => url.pathname === "/settings" && url.searchParams.get("saved") === "handle" && url.hash === "#settings-handle");

    await page.goto("/t/new");
    await waitForFormReady(page.locator("form", { has: titleField(page) }));
    await titleField(page).fill("Browser-authored draft");
    await page.getByLabel(enMessages.field_body).fill("Private browser text");
    await saveEditorDraft(page);
    await expect(page).toHaveURL(/\/drafts\/\d+(?:\?saved=1)?$/);
    await page.getByRole("button", { name: enMessages.draft_publish, exact: true }).click();
    await expect(page).toHaveURL(/\/t\/(\d+)\?posted=\1$/);
    const topicPath = new URL(page.url()).pathname;
    await page.goto(`${topicPath}/edit`);
    await page.getByLabel(enMessages.field_body).fill("Edited browser text");
    await page.getByRole("button", { name: enMessages.save_changes, exact: true }).click();
    await expect(page).toHaveURL(new URL(topicPath, state().baseURL).href);

    const exported = await (await context.request.get("/settings/export")).json();
    expect(exported.profile.sign_posts).toBe(false);
    expect(exported.signatures).toEqual([]);
  } finally { await context.close(); }
});
