import path from "node:path";
import { expect, type Page } from "@playwright/test";
import { test } from "./editor-fixture";
import { waitForClientRoute, captureScreenshot, useMember, formatMessage, clientHeaders, enMessages, jaMessages, openAdminMenu, openUserMenu, openPlaces, closePlaces, state  } from "./helpers";

const operatorHandle = "navigation_operator_long_12345";
const memberHandle = "navigation_member_long_1234567";

async function invite(page: Page, email: string) {
  await page.goto("/invites/new");
  await page.getByLabel(enMessages.invites_email, { exact: true }).fill(email);
  await page.getByRole("button", { name: enMessages.invites_submit, exact: true }).click();
  const code = page.locator("main code");
  await expect(code).toHaveText(/\/invite\//);
  return (await code.innerText()).trim();
}
async function pendingDraft(page: Page) {
  await page.goto("/settings/tokens");
  await page.getByLabel(enMessages.tokens_name).fill("navigation badge");
  await page.getByRole("radio", { name: enMessages.tokens_kind_draft }).check();
  await page.getByRole("button", { name: enMessages.tokens_create }).click();
  const token = (await page.locator("[role=status] code").innerText()).trim();
  const result = await page.request.post("/api/drafts", { headers: { Authorization: `Bearer ${token}`, "Content-Type": "text/markdown" }, data: "---\ntype: post\nlang: en\n---\nNavigation private draft" });
  expect(result.status()).toBe(201);
}
async function mention(page: Page, handles: string[]) {
  await page.goto("/t/new");
  await page.getByLabel(enMessages.field_body).fill(handles.map(handle => `@${handle}`).join(" ") + " notification for navigation checks");
  await page.getByRole("button", { name: enMessages.submit_post, exact: true }).click();
  await expect(page).toHaveURL(/\/t\/\d+/);
}
async function geometry(page: Page, width: number, height: number) {
  const measured = await page.locator("header").evaluate(header => {
    const rect = header.getBoundingClientRect();
    const style = getComputedStyle(header);
    const logo = header.querySelector(".logo")!.getBoundingClientRect();
    const reading = header.querySelector(".member-header-reading")!.getBoundingClientRect();
    const tools = [...header.children]
      .filter(child => !child.matches(".logo, .member-header-drawer, .member-header-reading, .site-tagline"))
      .map(child => child.getBoundingClientRect()).filter(box => box.width > 0 && box.height > 0);
    const centers = tools.map(box => box.y + box.height / 2);
    const readingControls = [...header.querySelector(".member-header-reading")!.children]
      .map(child => child.getBoundingClientRect()).filter(box => box.width > 0 && box.height > 0);
    const firstRow = [...readingControls, ...tools].sort((a, b) => a.left - b.left);
    const tagline = header.querySelector(".site-tagline")!.getBoundingClientRect();
    const contentTop = rect.top + parseFloat(style.borderTopWidth) + parseFloat(style.paddingTop);
    const contentBottom = rect.bottom - parseFloat(style.borderBottomWidth) - parseFloat(style.paddingBottom);
    return {
      height: rect.height, left: rect.left, right: rect.right, scroll: header.scrollWidth, client: header.clientWidth,
      logoCenterOffset: Math.abs(logo.y + logo.height / 2 - (contentTop + contentBottom) / 2),
      toolCount: tools.length, toolCenterSpread: Math.max(...centers) - Math.min(...centers),
      readingHeight: reading.height, readingBottom: reading.bottom, toolsTop: Math.min(...tools.map(box => box.top)),
      firstRowCenterSpread: Math.max(...firstRow.map(box => box.y + box.height / 2)) - Math.min(...firstRow.map(box => box.y + box.height / 2)),
      firstRowOverlaps: firstRow.slice(1).some((box, i) => box.left < firstRow[i].right - 1),
      firstRowBottom: Math.max(...firstRow.map(box => box.bottom)), taglineTop: tagline.top, taglineHeight: tagline.height,
    };
  });
  // A 56px mark spans both rows, above 12px padding and a 1px rule.
  // Keep that same height at narrow widths instead of growing another row.
  expect(measured.height).toBeLessThanOrEqual(56 + 12 + 1);
  expect(measured.left).toBeGreaterThanOrEqual(0);
  expect(measured.right).toBeLessThanOrEqual(width);
  expect(measured.scroll).toBeLessThanOrEqual(measured.client);
  expect(measured.logoCenterOffset).toBeLessThanOrEqual(1);
  expect(measured.toolCount).toBeGreaterThan(0);
  expect(measured.toolCenterSpread).toBeLessThanOrEqual(1);
  if (width >= 704) {
    expect(measured.firstRowCenterSpread).toBeLessThanOrEqual(1);
    expect(measured.firstRowOverlaps).toBe(false);
    expect(measured.taglineHeight).toBeGreaterThan(0);
    expect(measured.taglineTop).toBeGreaterThanOrEqual(measured.firstRowBottom - 1);
  } else {
    expect(measured.taglineHeight).toBe(0);
    if (measured.readingHeight > 0) expect(measured.readingBottom).toBeLessThanOrEqual(measured.toolsTop + 1);
  }
  const summary = page.locator("[data-member-menu-trigger]");
  await expect(summary).toBeVisible();
  const box = (await summary.boundingBox())!;
  expect(box.x + box.width).toBeLessThanOrEqual(width);
  expect(box.y + box.height).toBeLessThanOrEqual(height);
}

test("compact member navigation preserves badges, role links, filters, keyboard and readable no-JS pages", async ({ browser }) => {
  test.setTimeout(420_000);
  const contexts = await Promise.all(["10.19.0.1", "10.19.0.2", "10.19.0.3"].map(ip => browser.newContext({ extraHTTPHeaders: clientHeaders(ip) })));
  const [operator, member, moderator] = await Promise.all(contexts.map(context => context.newPage()));
  try {
    await useMember(operator, "navigation_operator@example.com");
    await useMember(member, "navigation_member@example.com");
    await useMember(moderator, "navigation_moderator@example.com");
    await operator.goto("/admin/roles?q=navmoderator");
    await operator.getByRole("button", { name: formatMessage(enMessages.admin_roles_grant, { lang: "日本語" }), exact: true }).click();
    await expect(operator.getByRole("status")).toContainText(enMessages.admin_roles_granted);
    for (const page of [operator, member, moderator]) await pendingDraft(page);
    await mention(operator, [memberHandle, "navmoderator"]);
    await mention(member, [operatorHandle, "navmoderator"]);

    for (const [page, role] of [[member, "member"], [operator, "operator"], [moderator, "moderator"]] as const) {
      for (const locale of ["en", "ja"] as const) {
        await page.goto("/");
        const current = await page.locator("html").getAttribute("lang");
        if (current !== locale) {
          const menu = await openUserMenu(page);
          await menu.getByRole("menuitem", { name: (current === "ja" ? jaMessages : enMessages).nav_language, exact: true }).click();
          await page.getByRole("menuitemradio", { name: locale === "ja" ? "日本語" : "English", exact: true }).click();
          await expect(page.locator("html")).toHaveAttribute("lang", locale);
        }
        await waitForClientRoute(page);
        const messages = locale === "ja" ? jaMessages : enMessages;
        const widths = role === "member" ? (locale === "en" ? [320, 1280] : [390, 640]) : role === "operator" ? (locale === "en" ? [320] : [1280]) : (locale === "en" ? [1280] : [390]);
        for (const width of widths) {
          const size = { width, height: width >= 1280 ? 900 : 844 };
          await page.setViewportSize(size);
          if (new URL(page.url()).pathname !== "/") await page.goto("/");
          await waitForClientRoute(page);
          await geometry(page, size.width, size.height);
          const header = page.locator("header");
          await expect(header.getByRole("link", { name: messages.site_name, exact: true })).toHaveAttribute("href", "/");
          // Following is a place: it is in the drawer, not in the header row.
          await expect(header.locator(":scope > a[href=\"/following\"]")).toHaveCount(0);
          const places = await openPlaces(page);
          await expect(places.locator('a[href="/following"]')).toContainText(messages.nav_following);
          await closePlaces(page);
          await expect(header.getByRole("link", { name: new RegExp(`^${messages.nav_notifications}`) })).toBeVisible();
          await expect(header.getByRole("link", { name: messages.nav_new_topic, exact: true })).toHaveAttribute("href", "/t/new");
          await expect(header.locator('a[href="/latest"]')).toHaveCount(0);
          await expect(header.getByRole("link", { name: messages.nav_home, exact: true })).toHaveCount(0);
          await expect(header.getByRole("link", { name: new RegExp(`^${messages.nav_notifications}`) }).getByRole("img")).toBeVisible();
          await expect(header.locator("[data-member-menu-trigger]").getByRole("img")).toBeVisible();
          await expect(page.locator("[data-member-links]").getByRole("link", { name: messages.nav_glossary, exact: true })).toBeVisible();
          await expect(page.locator("[data-member-links]").getByRole("link", { name: messages.nav_moderation_log, exact: true })).toBeVisible();
          const menu = await openUserMenu(page);
          await expect(menu.getByRole("menuitem", { name: messages.nav_following, exact: true })).toHaveCount(0);
          for (const href of ["/drafts", "/invites/new"]) await expect(menu.locator(`a[href="${href}"]`)).toBeVisible();
          await expect(menu.getByRole("menuitem", { name: messages.nav_settings, exact: true })).toHaveAttribute("href", "/settings?returnTo=%2F");
          await expect(menu.getByRole("menuitem", { name: messages.nav_logout, exact: true })).toBeVisible();
          await expect(menu.getByRole("menuitem", { name: messages.nav_language, exact: true })).toBeVisible();
          await expect(menu.getByRole("menuitem", { name: messages.nav_drafts })).toContainText("1");
          await expect(menu.getByRole("menuitem", { name: messages.nav_search_label, exact: true })).toHaveCount(0);
          await expect(header.getByRole("link", { name: messages.nav_search_label, exact: true })).toHaveCount(size.width < 640 ? 1 : 0);
          await expect(header.getByRole("searchbox")).toHaveCount(size.width < 640 ? 0 : 1);
          const panelBox = (await menu.boundingBox())!;
          expect(panelBox.x).toBeGreaterThanOrEqual(0);
          expect(panelBox.x + panelBox.width).toBeLessThanOrEqual(size.width);
          if (role !== "member") {
            const admin = await openAdminMenu(page);
            const group = size.width < 640 ? admin.locator("[data-mobile-admin]") : admin;
            expect(await group.getByRole("menuitem").evaluateAll(links => links.map(link => link.getAttribute("href")))).toEqual(["/mod", "/admin/translations", ...(role === "operator" ? ["/admin/invitations", "/admin/roles", "/admin/usage", "/admin/metrics", "/admin/observation"] : [])]);
          } else await expect(header.locator('a[href="/mod"]')).toHaveCount(0);
          await openUserMenu(page);
          await menu.getByRole("menuitem", { name: messages.nav_settings, exact: true }).click();
          await expect(page).toHaveURL(url => url.pathname === "/settings" && url.hash === "");
          await expect(page.locator("[data-member-menu]")).not.toBeVisible();
          if (role !== "member" && size.width >= 640) await expect(page.locator("[data-admin-menu]")).not.toBeVisible();
          if (process.env.E2E_EVIDENCE_DIR && role === "operator") {
            await page.goto("/");
            await captureScreenshot(page, { path: path.join(process.env.E2E_EVIDENCE_DIR, `navigation-unified-${locale}-${size.width}.png`) }, "e2e-navigation");
          }
        }
      }
    }

    await member.setViewportSize({ width: 390, height: 844 });
    await member.goto("/settings?from=menu");
    await waitForClientRoute(member);
    const summary = member.locator("[data-member-menu-trigger]");
    await summary.focus();
    await member.keyboard.press("Enter");
    await expect(member.locator("[data-member-menu]")).toBeVisible();
    const settings = member.locator('[data-member-menu] a[href="/settings"]');
    await settings.focus();
    await member.keyboard.press("Enter");
    await expect(member).toHaveURL(url => url.pathname === "/settings" && url.search === "" && url.hash === "");
    await waitForClientRoute(member);
    await expect(member.locator("[data-member-menu]")).not.toBeVisible();
    await summary.focus();
    await member.keyboard.press("Space");
    await expect(member.locator("[data-member-menu]")).toBeVisible();
    await member.keyboard.press("Escape");
    await expect(member.locator("[data-member-menu]")).not.toBeVisible();

    await member.goto("/a/ja?order=activity&asks=1&long=1&lang=en&page=2&posted=7");
    await member.locator("summary:has(h1)").click();
    let filter = member.getByRole("navigation", { name: jaMessages.home_origlang_label });
    await expect(filter.getByRole("link", { name: "日本語", exact: true })).toHaveAttribute("aria-current", "page");
    await filter.getByRole("link", { name: enMessages.language_name_en, exact: true }).click();
    await expect(member).toHaveURL(/\/a\/en\?order=activity&asks=1&long=1&lang=en$/);
    await waitForClientRoute(member);
    await expect(member.getByRole("heading", { level: 1 })).toHaveText(formatMessage(jaMessages.area_title, { lang: enMessages.language_name_en }));
    await member.locator("summary:has(h1)").click();
    filter = member.getByRole("navigation", { name: jaMessages.home_origlang_label });
    await expect(filter.getByRole("link", { name: enMessages.language_name_en, exact: true })).toHaveAttribute("aria-current", "page");
    await filter.getByRole("link", { name: jaMessages.home_filter_all, exact: true }).click();
    await expect(member).toHaveURL(/\/\?order=activity&asks=1&long=1&lang=en$/);
    await expect(member.getByRole("navigation", { name: jaMessages.home_origlang_label })).toHaveCount(0);

    const noJs = await browser.newContext({ javaScriptEnabled: false, storageState: await contexts[1].storageState(), viewport: { width: 390, height: 844 }, extraHTTPHeaders: clientHeaders("10.19.0.4") });
    try {
      const page = await noJs.newPage();
      await page.goto("/");
      await expect(page.locator("main li[id^=q-]").first()).toBeVisible();
      // Without JavaScript the places are a native disclosure.
      await page.locator("[data-navigation-drawer] > summary").click();
      await page.locator('[data-navigation-drawer] nav a[href="/following"]').click();
      await expect(page).toHaveURL(/\/following$/);
      await page.getByRole("link", { name: jaMessages.site_name, exact: true }).click();
      await expect(page).toHaveURL(new URL("/", state().baseURL).href);
    } finally { await noJs.close(); }
  } finally { await Promise.all(contexts.map(context => context.close())); }
});
