import { expect } from "@playwright/test";
import { test } from "./editor-fixture";
import { enMessages as m, formatMessage, openVillageManagement, useMember, waitForClientRoute } from "./helpers";

test("shares rosters with members, requires invitation acceptance and keeps guests and machine reads outside the roster", async ({ page, browser }) => {
  await useMember(page, "roster_owner@example.com", "/villages/new");
  await page.getByLabel(m.village_kind_invite_option, { exact: true }).check();
  await page.getByLabel(m.village_name_field, { exact: true }).fill("Roster browser fixture");
  await page.getByLabel(m.village_slug_field, { exact: true }).fill("roster-browser");
  await page.getByRole("button", { name: m.village_create, exact: true }).click();
  await expect(page).toHaveURL(/\/v\/roster-browser$/);
  const memberContext = await browser.newContext({ locale: "en-US" });
  const guestContext = await browser.newContext({ locale: "en-US" });
  const nativeContext = await browser.newContext({ locale: "en-US", javaScriptEnabled: false });
  try {
    const member = await memberContext.newPage(), guest = await guestContext.newPage(), native = await nativeContext.newPage();
    await useMember(member, "roster_reader@example.com", "/v/roster-browser");
    await member.getByRole("link", { name: formatMessage(m.village_members, { count: 1 }), exact: true }).click();
    await expect(member.locator("#village-roster")).toHaveAttribute("open", "");
    await expect(member.locator("#village-roster").getByText("@roster_owner", { exact: true })).toBeVisible();
    await expect(member.locator("#village-management")).toHaveCount(0);
    await expect(member.locator('[value="remove-member"]')).toHaveCount(0);
    await openVillageManagement(page);
    await page.getByLabel(m.village_invite_handle, { exact: true }).fill("roster_guest");
    await page.getByRole("button", { name: m.village_invite_member, exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: m.village_invite_sent })).toBeVisible();
    await expect(page.locator("#village-management")).toHaveAttribute("open", "");
    await expect(page.locator("#village-roster li").filter({ hasText: "@roster_guest" })).toHaveCount(0);
    await useMember(member, "roster_guest@example.com", "/v/roster-browser");
    await expect(member.getByText(m.village_join_visibility, { exact: true })).toBeVisible();
    await expect(member.getByRole("link", { name: m.village_post_here, exact: true })).toHaveCount(0);
    await member.getByRole("button", { name: m.village_accept, exact: true }).click();
    await expect(member.getByRole("link", { name: m.village_post_here, exact: true })).toBeVisible();
    await member.goto("/v/roster-browser/chat"); await waitForClientRoute(member);
    await expect(member.getByRole("link", { name: formatMessage(m.village_chat_readers, { count: 2 }), exact: true })).toHaveAttribute("href", "/v/roster-browser#village-roster");
    await member.goto("/v/en/chat");
    await expect(member.locator('main a[href$="#village-roster"]')).toHaveCount(0);
    await guest.goto("/v/roster-browser");
    await expect(guest.locator("#village-roster")).toHaveCount(0);
    expect(await guest.content()).not.toContain("roster_guest");
    for (const extension of ["md", "txt"]) {
      const response = await member.request.get(`/v/roster-browser.${extension}`);
      expect(response.status()).toBe(200); expect(await response.text()).not.toContain("roster_guest");
    }
    await useMember(native, "roster_owner@example.com", "/v/roster-browser?manage=1");
    await native.getByLabel(m.village_invite_handle, { exact: true }).fill("roster_native");
    await native.getByRole("button", { name: m.village_invite_member, exact: true }).click();
    await expect(native.getByRole("status").filter({ hasText: m.village_invite_sent })).toBeVisible();
    await native.getByRole("button", { name: m.village_cancel_invite, exact: true }).click();
    await expect(native.getByRole("status").filter({ hasText: m.village_invite_cancelled })).toBeVisible();
    await native.goto("/v/roster-browser?membersPage=1");
    const row = native.locator("#village-roster li").filter({ hasText: "@roster_guest" });
    await row.locator("summary").filter({ hasText: m.village_remove_member }).click();
    await row.getByRole("button", { name: m.village_remove_member, exact: true }).click();
    await expect(native.locator("#village-roster")).toHaveAttribute("open", "");
    await expect(native.getByRole("status").filter({ hasText: m.village_member_removed })).toBeVisible();
    await native.goto("/v/roster-browser?manage=1");
    await native.getByText(m.village_edit, { exact: true }).click();
    await native.getByLabel(m.village_description_field, { exact: true }).fill("Edited roster fixture.");
    await native.getByRole("button", { name: m.save_changes, exact: true }).click();
    await expect(native.getByRole("status").filter({ hasText: m.village_saved })).toBeVisible();
  } finally { await memberContext.close(); await guestContext.close(); await nativeContext.close(); }
});
