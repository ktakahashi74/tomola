import { hostCookieName } from "./helpers";
import { expect, type Page } from "@playwright/test";
import { test } from "./editor-fixture";
import { openVillageMembership, captureScreenshot, completeTrialFields, enMessages, loginWithMagicLink, state, useMember as openMemberPage, waitForClientRoute } from "./helpers";
import { LONG_SIGNUP_VILLAGE_NAME } from "./member-fixtures";
import fs from "node:fs";
import path from "node:path";

async function screenshots(page: Page, name: string) {
  for (const width of [1280, 1100, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await captureScreenshot(page, { path: `${name}-${width}.png`, fullPage: true }, "village-invite-signup");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
}

test("an invitation from a suspended owner omits village enrollment on both signup screens", async ({ page }) => {
  const token = fs.readFileSync(path.join(state().dir, "signup-stopped-invitation.txt"), "utf8");
  const notice = enMessages.invite_village.replace("{village}", "Stopped invitation village");
  await page.goto(`/invite/${token}`);
  await expect(page.getByRole("button", { name: enMessages.invite_submit, exact: true })).toBeVisible();
  await expect(page.getByText(notice, { exact: true })).toHaveCount(0);
  await loginWithMagicLink(page, "signup_stopped_recipient@example.com");
  await expect(page).toHaveURL(/\/onboarding$/);
  await expect(page.getByText(notice, { exact: true })).toHaveCount(0);
  await page.getByLabel(enMessages.onboarding_handle, { exact: true }).fill("signup_stopped_new");
  await completeTrialFields(page);
  await page.getByRole("button", { name: enMessages.onboarding_join, exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await page.goto("/v/signup-stopped");
  await expect(page.getByRole("button", { name: enMessages.village_accept, exact: true })).toHaveCount(0);
  await expect(page.locator("[data-village-header] summary").filter({ hasText: enMessages.village_joined })).toHaveCount(0);
  await expect(page.getByRole("link", { name: enMessages.village_post_here, exact: true })).toHaveCount(0);
});

test("an invitation from a village carries the opened destination through signup", async ({ page, browser }) => {
  const email = "signup_entry_recipient@example.com";
  const urls: string[] = [];
  for (const suffix of ["a", "b"]) {
    await openMemberPage(page, `signup_entry_${suffix}@example.com`, "/invites/new");
    await waitForClientRoute(page);
    await page.getByLabel(enMessages.invites_email, { exact: true }).fill(email);
    const choice = page.getByRole("combobox", { name: enMessages.invites_village, exact: true });
    await choice.click();
    await expect(page.getByRole("listbox").getByRole("option", { name: enMessages.language_name_en, exact: true })).toHaveCount(0);
    await page.getByRole("listbox").getByRole("option", { name: `Signup entry ${suffix.toUpperCase()}`, exact: true }).click();
    if (suffix === "a") await screenshots(page, "invites-new");
    await page.getByRole("button", { name: enMessages.invites_submit, exact: true }).click();
    const url = page.locator("code").filter({ hasText: "/invite/" });
    await expect(url).toBeVisible();
    urls.push((await url.textContent())!);
  }
  const context = await browser.newContext({ baseURL: state().baseURL, locale: "en-US" });
  try {
    const guest = await context.newPage();
    await guest.goto(urls[0]);
    const notice = enMessages.invite_village.replace("{village}", "Signup entry A");
    await expect(guest.getByText(notice, { exact: true })).toBeVisible();
    await screenshots(guest, "invite");
    const cookies = await context.cookies();
    expect(cookies.find(cookie => cookie.name === hostCookieName("tomola.invitation"))).toMatchObject({ httpOnly: true, sameSite: "Lax" });
    await loginWithMagicLink(guest, email);
    await expect(guest).toHaveURL(/\/onboarding$/);
    await context.clearCookies({ name: hostCookieName("tomola.invitation") });
    await guest.reload();
    await expect(guest.getByText(notice, { exact: true })).toBeVisible();
    await screenshots(guest, "onboarding");
    await guest.getByLabel(enMessages.onboarding_handle, { exact: true }).fill("signup_entry_new");
    await completeTrialFields(guest);
    await guest.getByRole("button", { name: enMessages.onboarding_join, exact: true }).click();
    await expect(guest).toHaveURL(/\/v\/signup-entry-a$/);
    await openVillageMembership(guest);
    await expect(guest.getByRole("button", { name: enMessages.village_leave, exact: true })).toBeVisible();
    await guest.goto("/v/signup-entry-b");
    await expect(guest.locator("[data-village-header] summary").filter({ hasText: enMessages.village_joined })).toHaveCount(0);
    await guest.goto("/notifications");
    await expect(guest.getByText(enMessages.notification_village_added.replace("{name}", "Signup entry A").replace("{actor}", "@signup_entry_a"), { exact: true })).toBeVisible();
    await guest.goto(urls[1]);
    await expect(guest.getByRole("button", { name: enMessages.invite_submit, exact: true })).toBeVisible();
  } finally { await context.close(); }
});

test("long village names fit the invitation selector and signup screens on a phone", async ({ page, browser }) => {
  const email = "signup_entry_long_recipient@example.com";
  await page.setViewportSize({ width: 390, height: 900 });
  await openMemberPage(page, "signup_entry_long@example.com", "/invites/new");
  const rename = async (name: string) => {
    const response = await page.request.post("/v/signup-entry-long", { headers: { origin: state().baseURL }, form: { intent: "edit", name, description: "", sourceLang: "en" } });
    expect(response.ok()).toBe(true);
  };
  const context = await browser.newContext({ baseURL: state().baseURL, locale: "en-US", viewport: { width: 390, height: 900 } });
  try {
    await rename(LONG_SIGNUP_VILLAGE_NAME);
    await page.reload();
    await waitForClientRoute(page);
    await page.getByLabel(enMessages.invites_email, { exact: true }).fill(email);
    await page.getByRole("combobox", { name: enMessages.invites_village, exact: true }).click();
    await page.getByRole("listbox").getByRole("option", { name: LONG_SIGNUP_VILLAGE_NAME, exact: true }).click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByRole("button", { name: enMessages.invites_submit, exact: true }).click();
    const url = page.locator("code").filter({ hasText: "/invite/" });
    await expect(url).toBeVisible();
    const guest = await context.newPage();
    await guest.goto((await url.textContent())!);
    const notice = enMessages.invite_village.replace("{village}", LONG_SIGNUP_VILLAGE_NAME);
    await expect(guest.getByText(notice, { exact: true })).toBeVisible();
    expect(await guest.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await loginWithMagicLink(guest, email);
    await expect(guest).toHaveURL(/\/onboarding$/);
    await expect(guest.getByText(notice, { exact: true })).toBeVisible();
    expect(await guest.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally {
    try { await context.close(); }
    finally { await rename("Signup entry LONG"); }
  }
});
