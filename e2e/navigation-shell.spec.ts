import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { enMessages as m, openPostSettings, openUserMenu, state, useMember, waitForClientRoute } from "./helpers";

const fixture = () => JSON.parse(fs.readFileSync(path.join(state().dir, "navigation-shell.json"), "utf8")) as Record<string, number[]>;

// One owned reader keeps the same unread state across the two viewport checks.
test("the places list supports native navigation, chat marks and current sections", async ({ page, browser }) => {
  await useMember(page, "nav_shell_menu@example.com");
  const context = await browser.newContext({ javaScriptEnabled: false, locale: "en-US", storageState: await page.context().storageState() });
  try {
    const native = await context.newPage();
    const current = () => native.getByRole("banner").locator(":scope > a[aria-current='page']");
    // Without JavaScript the list is the side column on a wide screen and the drawer (a native disclosure) elsewhere.
    const places = async (width: number) => {
      if (width >= 1280) return native.locator("[data-site-navigation]");
      const drawer = native.locator("[data-navigation-drawer]");
      if (await drawer.getAttribute("open") === null) await drawer.locator("> summary").click();
      return drawer.locator("nav");
    };
    for (const width of [1280, 390]) {
      await native.setViewportSize({ width, height: 844 }); await native.goto("/");
      await expect(current()).toHaveAttribute("href", "/");
      const menu = await places(width);
      if (width < 1280) await expect(native.locator("[data-navigation-drawer] > summary")).toHaveAccessibleName(new RegExp(`^${m.nav_places}`));
      else await expect(menu).toHaveAccessibleName(m.nav_side_label);
      // News in a chat is a dot on its entrance, never a number; the entrance always opens the chat.
      await expect(menu.locator('a[href="/v/nav-shell-open/chat"]')).toHaveAccessibleName(`Navigation open village · ${m.village_chat_title} · ${m.notification_unread}`);
      await expect(menu.locator('a[href="/v/nav-shell-open/chat"] .bg-unread')).toHaveCount(1);
      await expect(menu.getByRole("link", { name: m.nav_all_villages, exact: true })).toHaveAttribute("href", "/villages");
      expect(await native.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await menu.getByRole("link", { name: "Navigation invited village", exact: true }).click();
      await expect(native).toHaveURL(/\/v\/nav-shell-invited$/);
      await expect((await places(width)).locator('[aria-current="page"]')).toHaveAttribute("href", "/v/nav-shell-invited");
      await native.goto("/following");
      await expect((await places(width)).locator('[aria-current="page"]')).toHaveAccessibleName(m.nav_following);
      await native.goto("/notifications");
      await expect(current()).toHaveAccessibleName(new RegExp(`^${m.nav_notifications}`));
    }
    await native.goto("/"); await native.locator("[data-navigation-drawer] > summary").click();
    await native.locator('[data-navigation-drawer] a[href="/v/nav-shell-open/chat"]').click();
    await expect(native).toHaveURL(/\/v\/nav-shell-open\/chat$/);
    await expect(native.getByRole("log")).toContainText("Navigation message");
  } finally { await context.close(); }
});

test("the header writes into the joined village and names its invitation-based public destination", async ({ page }) => {
  await useMember(page, "nav_shell_context@example.com", "/v/nav-shell-invited"); await waitForClientRoute(page);
  for (const route of ["/v/nav-shell-invited", "/v/nav-shell-invited/chat"]) {
    await page.goto(route); await waitForClientRoute(page);
    const post = page.locator("header").getByRole("link", { name: m.nav_new_topic, exact: true });
    await expect(post).toHaveAttribute("href", "/t/new?village=nav-shell-invited"); await post.click();
    await expect(page.locator('input[name="village"]')).toHaveValue("nav-shell-invited");
    await openPostSettings(page);
    await expect(page.getByRole("button", { name: new RegExp(`^${m.field_village}\\b`) })).toContainText(m.village_invite_public);
  }
  await page.goto("/v/nav-shell-reading");
  await expect(page.locator("header").getByRole("link", { name: m.nav_new_topic, exact: true })).toHaveAttribute("href", "/t/new");
});

for (const scripts of [true, false]) {
  test(`saved settings return to the originating article with scripts ${scripts}`, async ({ page, browser }) => {
    const scenario = scripts ? "settings" : "native";
    const source = `/t/${fixture()[scenario][0]}?lang=en#replies`;
    await useMember(page, `nav_shell_${scenario}@example.com`, source); await waitForClientRoute(page);
    if (scripts) {
      await (await openUserMenu(page)).getByRole("menuitem", { name: m.nav_settings, exact: true }).click();
      await expect(page).toHaveURL(url => url.pathname === "/settings" && url.searchParams.get("returnTo") === source);
    }
    const context = scripts ? null : await browser.newContext({ javaScriptEnabled: false, locale: "en-US", storageState: await page.context().storageState() });
    try {
      const settings = context ? await context.newPage() : page;
      if (context) { await settings.goto(source); await settings.goto(`/settings?returnTo=${encodeURIComponent(source)}`); }
      const section = settings.locator(scripts ? "#settings-email" : "#settings-languages");
      if (scripts) await section.getByRole("radio", { name: m.settings_email_daily, exact: true }).check();
      else await section.locator('input[name="readLangs"][value="ja"]').check();
      if (!scripts) await section.getByRole("button", { name: m.save_changes, exact: true }).click();
      await expect(settings).toHaveURL(url => (scripts || url.searchParams.get("saved") === "preferences") && url.searchParams.get("returnTo") === source);
      await expect(section.getByRole("status")).toContainText(m.settings_saved);
      if (!scripts) await expect(section.locator('input[name="readLangs"][value="ja"]')).toBeChecked();
      const back = settings.locator("main").getByRole("link", { name: m.settings_return, exact: true });
      await expect(back).toHaveAttribute("href", source); await back.click();
      await expect(settings).toHaveURL(new URL(source, state().baseURL).href);
    } finally { await context?.close(); }
  });
}

test("public articles offer village posts and reading exits after replies, including language villages", async ({ browser }) => {
  const page = await browser.newPage({ locale: "en-US" });
  try {
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 844 });
      for (const village of ["nav-shell-reading", "en"]) {
        const [current, ...peers] = fixture()[village];
        await page.goto(`/t/${current}`);
        const end = page.locator("[data-topic-continuation]");
        await expect(end.getByRole("heading")).toContainText(village === "en" ? "English" : "Navigation reading village");
        await expect(end.locator('li a')).toHaveCount(3);
        if (village !== "en") expect(await end.locator("li a").evaluateAll(links => links.map(link => link.getAttribute("href")))).toEqual(peers.reverse().map(id => `/t/${id}`));
        await expect(end.locator(`a[href="/t/${current}"]`)).toHaveCount(0);
        await expect(end.locator('a[href$="/chat"]')).toHaveCount(0);
        await expect(end.locator(`a[href="/v/${village}"]`)).toBeVisible();
        await expect(end.getByRole("link", { name: m.reading_home, exact: true })).toHaveAttribute("href", "/");
        expect(await end.evaluate(element => Boolean(document.getElementById("replies")!.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
        const next = await end.locator("li a").first().getAttribute("href");
        await end.locator("li a").first().click(); await expect(page).toHaveURL(new URL(next!, state().baseURL).href);
      }
    }
    const { id } = JSON.parse(fs.readFileSync(path.join(state().dir, "navigation-disclosure.json"), "utf8"));
    await page.goto(`/t/${id}`);
    const alone = page.locator("[data-topic-continuation]");
    await expect(alone.getByRole("heading")).toHaveCount(0);
    await expect(alone.getByRole("list")).toHaveCount(0);
    await expect(alone).toHaveAccessibleName("Single article village");
    await expect(alone.getByRole("link")).toHaveCount(2);
    await expect(alone.getByRole("link", { name: m.reading_more_posts.replace("{name}", "Single article village"), exact: true })).toHaveAttribute("href", "/v/nav-single-article");
    await expect(alone.getByRole("link", { name: m.reading_home, exact: true })).toHaveAttribute("href", "/");
    for (const route of ["/", "/villages", "/v/nav-shell-reading"]) {
      await page.goto(route);
      await expect(page.getByRole("banner").locator('[aria-current="page"]')).toHaveCount(1);
    }
  } finally { await page.close(); }
});
