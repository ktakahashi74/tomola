import { expect, type Page } from "@playwright/test";
import { test } from "./editor-fixture";
import { openVillageMembership, captureScreenshot, enMessages as m, useMember, waitForClientRoute, openVillageManagement } from "./helpers";

async function screenshots(page: Page, label: string) {
  for (const width of [1280, 1100, 390]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await captureScreenshot(page, { path: `${label}-${width}.png`, animations: "disabled", fullPage: true }, "villages-create");
  }
}
async function create(page: Page, slug: string, name: string, invited: boolean) {
  await page.goto("/villages"); await waitForClientRoute(page);
  await page.getByRole("link", { name: m.village_create, exact: true }).click();
  await expect(page.getByText(m.village_slug_help, { exact: true })).toBeVisible();
  await page.getByLabel(invited ? m.village_kind_invite_option : m.village_kind_open_option, { exact: true }).check();
  await page.getByLabel(m.village_name_field, { exact: true }).fill(name);
  await page.getByLabel(m.village_slug_field, { exact: true }).fill(slug);
  await page.getByLabel(m.village_description_field, { exact: true }).fill("<b>A public description</b>");
  await screenshots(page, "create");
  await page.getByRole("button", { name: m.village_create, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/v/${slug}$`));
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  await expect(page.getByRole("paragraph").filter({ hasText: "<b>A public description</b>" })).toBeVisible();
  await expect(page.locator("main b")).toHaveCount(0);
}

test("creates a member-posting public village, invites a writer, posts and ends without losing public reading", async ({ page, browser }) => {
  await useMember(page, "vc_creator@example.com");
  await create(page, "owned-public-club", "An owned public club", true);
  await expect(page.locator("#village-management")).not.toHaveAttribute("open", "");
  await expect(page.getByText(m.village_report, { exact: true })).toHaveCount(0);
  await screenshots(page, "owner");
  await openVillageManagement(page);
  await page.getByLabel(m.village_invite_handle, { exact: true }).fill("@VC_JOINER");
  await page.getByRole("button", { name: m.village_invite_member, exact: true }).click();
  await expect(page.locator("#village-roster li").filter({ hasText: "@vc_joiner" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: m.village_cancel_invite, exact: true })).toHaveCount(1);
  const context = await browser.newContext({ locale: "en-US" }); const other = await context.newPage();
  try {
    await useMember(other, "vc_outsider@example.com", "/v/owned-public-club");
    await expect(other.getByRole("button", { name: m.village_join, exact: true })).toHaveCount(0);
    await expect(other.getByRole("link", { name: m.village_post_here, exact: true })).toHaveCount(0);
    const denied = await other.request.post("/v/owned-public-club", { form: { intent: "post-here" }, headers: { Origin: new URL(other.url()).origin } });
    expect(denied.status()).toBe(404);
    await useMember(other, "vc_joiner@example.com", "/notifications");
    await expect(other.locator("main").getByText(m.notification_village_invite.replace("{name}", "An owned public club").replace("{handle}", "vc_creator"), { exact: true })).toBeVisible();
    await other.goto("/v/owned-public-club");
    await other.getByRole("button", { name: m.village_accept, exact: true }).click();
    await screenshots(other, "added-member");
    await expect(other.getByText(m.village_roster, { exact: true })).toHaveCount(1);
    await expect(other.getByRole("button", { name: m.village_leave, exact: true })).toBeHidden();
    await other.locator("summary").filter({ hasText: m.village_joined }).click();
    await expect(other.getByText(m.village_leave_invite_help, { exact: true })).toBeVisible();
    await expect(other.getByRole("button", { name: m.village_leave, exact: true })).toBeVisible();
    await other.locator("summary").filter({ hasText: m.village_joined }).click();
    await other.getByRole("link", { name: m.village_post_here, exact: true }).click(); await waitForClientRoute(other);
    await expect(other.locator('input[name="village"]')).toHaveValue("owned-public-club");
    await other.locator('textarea[name="body"]').fill("A member's public village post.");
    await other.getByRole("button", { name: m.submit_post, exact: true }).click();
    await expect(other).toHaveURL(/\/t\/\d+/);
    const topicUrl = other.url(), topicId = topicUrl.match(/\/t\/(\d+)/)![1];
    await expect(other.locator("[data-article-details]").getByRole("link", { name: "An owned public club", exact: true })).toBeVisible();
    await other.goto("/");
    await expect(other.locator(`#q-${topicId}`).getByRole("link", { name: "An owned public club", exact: true })).toBeVisible();
    await page.reload();
    await openVillageManagement(page);
    await page.locator("#village-roster > summary").click();
    const member = page.locator("#village-roster li").filter({ hasText: "@vc_joiner" });
    await expect(member.locator('textarea[name="reason"]')).toBeHidden();
    await member.locator("summary").filter({ hasText: m.village_remove_member }).click();
    await expect(member.locator('textarea[name="reason"]')).toBeVisible();
    await page.getByRole("link", { name: m.village_end, exact: true }).click();
    await expect(page.getByRole("heading", { name: m.village_end_confirm, exact: true })).toBeVisible();
    await screenshots(page, "end-confirmation");
    await page.getByRole("button", { name: m.village_end, exact: true }).click();
    await expect(page.getByText(m.village_ended, { exact: true })).toBeVisible();
    await screenshots(page, "ended");
    await openVillageManagement(page);
    if (!await page.locator("#village-roster").getAttribute("open").then(value => value !== null)) await page.locator("#village-roster > summary").click();
    await expect(page.locator("#village-roster").getByText(m.village_remove_member, { exact: true })).toHaveCount(0);
    await expect(page.getByRole("link", { name: m.village_post_here, exact: true })).toHaveCount(0);
    await other.goto(topicUrl);
    await expect(other.locator("[data-article-details]").getByRole("link", { name: "An owned public club", exact: true })).toBeVisible();
    expect((await other.request.get("/v/owned-public-club.md")).status()).toBe(200);
    await other.goto("/villages");
    await expect(other.getByRole("link", { name: "An owned public club", exact: true })).toHaveCount(0);
  } finally { await context.close(); }
});

test("invites removed and departed members and keeps co-ownership subject to acceptance", async ({ page, browser }) => {
  await useMember(page, "direct_owner@example.com");
  await create(page, "direct-members", "Invited membership village", true);
  const context = await browser.newContext({ locale: "en-US" }); const guest = await context.newPage();
  try {
    await useMember(guest, "direct_guest@example.com", "/v/direct-members");
    const invite = async () => {
      await openVillageManagement(page);
      await page.getByLabel(m.village_invite_handle, { exact: true }).fill("direct_guest");
      await Promise.all([
        page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname.startsWith("/v/direct-members")),
        page.getByRole("button", { name: m.village_invite_member, exact: true }).click(),
      ]);
      await expect(page.locator("#village-invites").getByText("@direct_guest", { exact: true })).toBeVisible();
      await expect(page.getByRole("status").filter({ hasText: m.village_invite_sent })).toBeVisible();
      await guest.reload();
      await expect(guest.getByText(m.village_join_visibility, { exact: true })).toBeVisible();
      await guest.getByRole("button", { name: m.village_accept, exact: true }).click();
      await expect(guest.getByRole("link", { name: m.village_post_here, exact: true })).toBeVisible();
      await page.reload();
      if (!await page.locator("#village-roster").evaluate(element => (element as HTMLDetailsElement).open)) await page.locator("#village-roster > summary").click();
    };
    await invite();
    const member = page.locator("#village-roster li").filter({ hasText: "@direct_guest" });
    await member.locator("summary").filter({ hasText: m.village_remove_member }).click();
    await expect(member.locator('textarea[name="reason"]')).not.toHaveAttribute("required");
    await member.getByRole("button", { name: m.village_remove_member, exact: true }).click();
    await expect(member).toHaveCount(0);
    await expect(page.getByRole("status").filter({ hasText: m.village_member_removed })).toBeVisible();
    await invite();
    await openVillageMembership(guest);
    await guest.getByRole("button", { name: m.village_leave, exact: true }).click();
    await expect(guest.getByRole("link", { name: m.village_post_here, exact: true })).toHaveCount(0);
    await page.reload(); await invite();
    await member.getByRole("button", { name: m.village_add_owner, exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: m.village_owner_invite_sent })).toBeVisible();
    await guest.reload();
    await expect(guest.locator("#village-management")).toHaveCount(0);
    await guest.getByRole("button", { name: m.village_accept, exact: true }).click();
    await expect(guest.locator("#village-management")).toBeVisible();
  } finally { await context.close(); }
});

test("creates an open village and permits a member to join while keeping management owner-only", async ({ page }) => {
  await useMember(page, "vc_open_creator@example.com");
  await create(page, "owned-open-club", "An owned open club", false);
  await useMember(page, "vc_outsider@example.com", "/v/owned-open-club");
  await expect(page.getByRole("heading", { name: m.village_manage, exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: m.village_join, exact: true }).click();
  await openVillageMembership(page);
  await expect(page.getByRole("button", { name: m.village_leave, exact: true })).toBeVisible();
  await expect(page.getByText(m.village_roster, { exact: true })).toHaveCount(1);
  await expect(page.locator("#village-roster").getByText("@vc_open_creator", { exact: false })).toHaveCount(1);
  await expect(page.getByRole("button", { name: m.village_add_owner, exact: true })).toHaveCount(0);
  await useMember(page, "vc_open_creator@example.com", "/v/owned-open-club");
  await openVillageManagement(page);
  await page.getByText(m.village_roster, { exact: true }).click();
  await expect(page.locator("main").getByText("@vc_outsider", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: m.village_add_owner, exact: true })).toBeVisible();
  await openVillageMembership(page);
  await expect(page.getByRole("button", { name: m.village_leave, exact: true })).toBeDisabled();
  await screenshots(page, "owner-roster");
  // A forged departure uses the page's ordinary error, not a missing-page response.
  const failed = await page.request.post("/v/owned-open-club", { form: { intent: "leave" }, headers: { Origin: new URL(page.url()).origin } });
  expect(failed.status()).toBe(400);
  expect(await failed.text()).toContain(m.village_error_last_owner);
  await page.goto("/v/en");
  await expect(page.getByText(m.village_roster, { exact: true })).toHaveCount(0);
  await useMember(page, "navigation_operator@example.com", "/v/owned-open-club");
  await expect(page.locator("#village-management")).toHaveCount(0);
  await page.getByText(m.village_roster, { exact: true }).click();
  await expect(page.locator("main").getByText("@vc_outsider", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: m.village_add_owner, exact: true })).toHaveCount(0);
  await page.goto("/v/en");
  await expect(page.getByText(m.village_roster, { exact: true })).toHaveCount(0);
  await openVillageManagement(page);
  await page.getByText(m.village_edit, { exact: true }).click();
  await expect(page.getByLabel(m.village_name_field, { exact: true })).toHaveCount(0);
});

test("pages invitations and keeps the roster open on return without carrying roster pages to topics", async ({ page, browser }) => {
  await useMember(page, "vpage_owner@example.com", "/v/paged-village"); await waitForClientRoute(page);
  await openVillageManagement(page);
  expect(await page.locator('main a[href="/t/new?village=paged-village"]').evaluate(element => !!(element.compareDocumentPosition(document.querySelector("main ul.divide-y")!) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
  expect(await page.locator("main ul.divide-y").evaluate(element => !!(element.compareDocumentPosition(document.querySelector("#village-management")!) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
  const invites = page.getByRole("navigation", { name: m.village_invite_pages, exact: true });
  await invites.getByRole("link", { name: m.page_next, exact: true }).click();
  await expect(page).toHaveURL(/invitesPage=2#village-invites$/);
  await expect(page.getByRole("button", { name: m.village_cancel_invite, exact: true })).toHaveCount(1);
  await invites.getByRole("link", { name: m.page_prev, exact: true }).click();
  await expect(page).toHaveURL(/invitesPage=1#village-invites$/);
  await expect(page.getByRole("button", { name: m.village_cancel_invite, exact: true })).toHaveCount(50);
  await page.reload(); await waitForClientRoute(page);
  await expect(page.locator("#village-management")).toHaveAttribute("open", "");
  await page.locator("#village-roster > summary").click();
  const roster = page.getByRole("navigation", { name: m.village_roster_pages, exact: true });
  await roster.getByRole("link", { name: m.page_next, exact: true }).click();
  await expect(page).toHaveURL(/membersPage=2#village-roster$/);
  await expect(page.locator("#village-roster")).toHaveAttribute("open", "");
  await roster.getByRole("link", { name: m.page_prev, exact: true }).click();
  await expect(page).toHaveURL(/membersPage=1#village-roster$/);
  await expect(page.locator("#village-roster")).toHaveAttribute("open", "");
  await page.reload(); await waitForClientRoute(page);
  await expect(page.locator("#village-management")).not.toHaveAttribute("open", "");
  await expect(page.locator("#village-roster")).toHaveAttribute("open", "");
  await roster.getByRole("link", { name: m.page_next, exact: true }).click();
  await expect(page).toHaveURL(/membersPage=2#village-roster$/);
  const nextTopics = page.getByRole("navigation", { name: m.page_nav, exact: true }).getByRole("link", { name: m.page_next, exact: true });
  expect(await nextTopics.getAttribute("href")).not.toContain("membersPage");
  expect(await nextTopics.getAttribute("href")).not.toContain("invitesPage");
  await nextTopics.click();
  await expect(page).toHaveURL(/\?page=2$/);
  const context = await browser.newContext({ javaScriptEnabled: false });
  try {
    const native = await context.newPage();
    await useMember(native, "vpage_owner@example.com", "/v/paged-village?membersPage=2");
    await native.getByRole("navigation", { name: m.village_roster_pages, exact: true }).getByRole("link", { name: m.page_prev, exact: true }).click();
    await expect(native).toHaveURL(/membersPage=1#village-roster$/);
    await expect(native.locator("#village-management")).not.toHaveAttribute("open", "");
    await expect(native.locator("#village-roster")).toHaveAttribute("open", "");
    await native.goto("/v/paged-village?invitesPage=2");
    await native.getByRole("navigation", { name: m.village_invite_pages, exact: true }).getByRole("link", { name: m.page_prev, exact: true }).click();
    await expect(native).toHaveURL(/invitesPage=1#village-invites$/);
    await expect(native.locator("#village-management")).toHaveAttribute("open", "");
    await expect(native.getByRole("button", { name: m.village_cancel_invite, exact: true })).toHaveCount(50);
  } finally { await context.close(); }
});
