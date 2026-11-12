import { expect, type Page } from "@playwright/test";
import { test } from "./editor-fixture";
import { captureScreenshot, enMessages as m, openVillageMembership, state, useMember, waitForClientRoute } from "./helpers";

const header = (page: Page) => page.locator("[data-village-header]");
const joined = (page: Page) => header(page).locator("summary").filter({ hasText: m.village_joined });
const follow = (page: Page) => header(page).locator('button[name="intent"][value="follow"], button[name="intent"][value="unfollow"]');
const hint = (page: Page) => header(page).locator("[data-village-participation-help]");

async function screenshots(page: Page, label: string) {
  if (!process.env.E2E_EVIDENCE_DIR) return;
  const membershipOpen = await header(page).locator("details[data-village-membership][open]").count() > 0;
  for (const locale of ["en", "ja"]) {
    await page.context().addCookies([{ name: "PARAGLIDE_LOCALE", value: locale, url: state().baseURL }]);
    await page.reload();
    await waitForClientRoute(page);
    if (membershipOpen) await header(page).locator("details[data-village-membership] > summary").click();
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await captureScreenshot(page, { path: `${label}-${locale}-${width}.png`, animations: "disabled" }, "village-join-state");
    }
  }
  await page.context().addCookies([{ name: "PARAGLIDE_LOCALE", value: "en", url: state().baseURL }]);
  await page.reload();
  await waitForClientRoute(page);
  if (membershipOpen) await header(page).locator("details[data-village-membership] > summary").click();
}

test("joined state replaces follow controls and leaving preserves an existing follow", async ({ page, browser }) => {
  await useMember(page, "zjoin_reader@example.com", "/v/join-state-open");
  await expect(hint(page)).toBeVisible();
  await screenshots(page, "not-joined-open");
  await follow(page).click();
  await expect(follow(page)).toHaveAttribute("aria-pressed", "true");
  await expect(hint(page)).toHaveCount(0);
  await header(page).getByRole("button", { name: m.village_join, exact: true }).click();
  await expect(joined(page)).toBeVisible();
  await expect(joined(page)).toHaveAccessibleName(m.village_joined);
  await expect(follow(page)).toHaveCount(0);
  await expect(hint(page)).toHaveCount(0);
  await screenshots(page, "joined");
  await joined(page).focus();
  await page.keyboard.press("Enter");
  await expect(joined(page).locator("..")).toHaveAttribute("open", "");
  await expect(header(page).getByRole("button", { name: m.village_leave, exact: true })).toBeVisible();
  await header(page).getByRole("button", { name: m.village_leave, exact: true }).click();
  await expect(joined(page)).toHaveCount(0);
  await expect(follow(page)).toHaveAttribute("aria-pressed", "true");
  await follow(page).click();
  await expect(hint(page)).toBeVisible();
  await page.goto("/v/join-state-invite");
  await expect(header(page).getByRole("button", { name: m.village_join, exact: true })).toHaveCount(0);
  await expect(hint(page)).toBeVisible();
  await screenshots(page, "not-joined-invite");
  await follow(page).click();
  await expect(hint(page)).toHaveCount(0);

  const context = await browser.newContext({ locale: "en-US" });
  try {
    const guest = await context.newPage();
    await context.addCookies([{ name: "PARAGLIDE_LOCALE", value: "en", url: state().baseURL }]);
    await guest.goto("/v/join-state-open");
    await expect(hint(guest)).toHaveCount(0);
    await expect(header(guest).getByRole("button")).toHaveCount(0);
    await expect(joined(guest)).toHaveCount(0);
    await screenshots(guest, "signed-out");
  } finally { await context.close(); }
});

test("invited members confirm departure and the last owner can leave only after ending", async ({ page }) => {
  await useMember(page, "zjoin_invited@example.com", "/v/join-state-invite");
  await expect(joined(page)).toBeVisible();
  await expect(follow(page)).toHaveCount(0);
  await expect(page.getByRole("button", { name: m.village_leave, exact: true })).toBeHidden();
  const membership = await openVillageMembership(page);
  await expect(membership.getByText(m.village_leave_confirm, { exact: true })).toBeVisible();
  await expect(membership.getByText(m.village_leave_invite_help, { exact: true })).toBeVisible();
  await screenshots(page, "invite-confirmation");
  await membership.getByRole("button", { name: m.village_leave, exact: true }).click();
  await expect(joined(page)).toHaveCount(0);
  await expect(hint(page)).toBeVisible();

  await useMember(page, "zjoin_owner@example.com", "/v/join-state-invite");
  const owner = await openVillageMembership(page);
  await expect(owner.getByRole("button", { name: m.village_leave, exact: true })).toBeDisabled();
  await expect(owner.getByText(m.village_error_last_owner, { exact: true })).toBeVisible();
  await screenshots(page, "last-owner");

  await useMember(page, "zjoin_ended@example.com", "/v/join-state-ended");
  await expect(joined(page)).toBeVisible();
  await expect(header(page).getByRole("link", { name: m.village_post_here, exact: true })).toHaveCount(0);
  const ended = await openVillageMembership(page);
  await expect(ended.getByText(m.village_leave_invite_help, { exact: true })).toHaveCount(0);
  await ended.getByRole("button", { name: m.village_leave, exact: true }).click();
  await expect(joined(page)).toHaveCount(0);
  await expect(follow(page)).toHaveCount(0);
  await expect(hint(page)).toHaveCount(0);
});

test("membership disclosure opens from the keyboard without JavaScript", async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false, locale: "en-US" });
  try {
    const page = await context.newPage();
    await useMember(page, "zjoin_native@example.com", "/v/join-state-native");
    await joined(page).focus();
    await page.keyboard.press("Space");
    await expect(header(page).getByRole("button", { name: m.village_leave, exact: true })).toBeDisabled();
    await expect(header(page).getByText(m.village_error_last_owner, { exact: true })).toBeVisible();
  } finally { await context.close(); }
});
