import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { closePlaces, enMessages as m, openPlaces, state, useMember, waitForClientRoute } from "./helpers";

const fixture = (scenario: string) => JSON.parse(fs.readFileSync(path.join(state().dir, "left-navigation.json"), "utf8"))[scenario] as { slug: string; topic: number };
const navigationBoundaryEm = Number(fs.readFileSync(new URL("../app/app.css", import.meta.url), "utf8")
  .match(/@media \(min-width: ([\d.]+)em\) \{[\s\S]*?body:has\(\.site-navigation\)/)![1]);

test("wide navigation appears only on browsing routes and yields to the header below its boundary", async ({ page, browser }) => {
  const guest = await browser.newContext({ locale: "en-US", viewport: { width: 1280, height: 900 } });
  try {
    const anonymous = await guest.newPage();
    for (const route of ["/", "/a/en", "/villages", "/v/side-nav-routes"]) {
      await anonymous.goto(route);
      await expect(anonymous.locator("[data-site-navigation]")).toHaveCount(0);
      await expect(anonymous.locator("header").getByRole("link", { name: m.villages_title, exact: true })).toBeVisible();
    }
  } finally { await guest.close(); }
  const { slug, topic } = fixture("routes");
  await page.setViewportSize({ width: 1280, height: 900 });
  await useMember(page, "side_nav_routes@example.com");
  const side = page.locator("[data-site-navigation]");
  const header = page.locator("header");
  for (const route of ["/", "/a/en", "/villages", `/v/${slug}`, `/v/${slug}/chat`, "/following", "/following/", "/notifications"]) {
    await page.goto(route); await waitForClientRoute(page);
    await expect(side).toBeVisible();
    await expect(side).toHaveAccessibleName(m.nav_side_label);
    await expect(page.locator("[data-navigation-drawer]:visible")).toHaveCount(0);
    await expect(header.getByRole("link", { name: m.site_name, exact: true })).toBeVisible();
    await expect(header.getByRole("search")).toBeVisible();
    await expect(header.getByRole("link", { name: new RegExp(`^${m.nav_notifications}`) })).toBeVisible();
    await expect(header.getByRole("link", { name: m.nav_new_topic, exact: true })).toBeVisible();
    const current = route === "/a/en" ? "/" : route.replace(/\/$/, "") || "/";
    // On the chat the village's name says the member is inside it ("true"); the village page is "page".
    const inChat = route.endsWith("/chat");
    if (current !== "/notifications") await expect(side.locator(route === "/a/en" || inChat ? '[aria-current="true"]' : '[aria-current="page"]')).toHaveAttribute("href", inChat ? current.replace(/\/chat$/, "") : current);
    const separated = await side.evaluate(el => el.getBoundingClientRect().right <= document.querySelector("main")!.getBoundingClientRect().left);
    expect(separated).toBe(true);
  }
  for (const width of [1023, 390]) {
    await page.setViewportSize({ width, height: 844 }); await page.goto("/"); await waitForClientRoute(page);
    await expect(side).not.toBeVisible();
    await expect(header.locator("[data-navigation-drawer] > summary")).toBeVisible();
    await expect((await openPlaces(page)).getByRole("link", { name: m.nav_following, exact: true })).toBeVisible();
    await closePlaces(page);
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  for (const route of [`/t/${topic}`, "/t/new", `/t/${topic}/edit`, "/settings", "/search", "/drafts", "/villages/new"]) {
    await page.goto(route); await waitForClientRoute(page);
    await expect(side).toHaveCount(0);
    await expect(header.locator("[data-navigation-drawer] > summary")).toBeVisible();
    await expect((await openPlaces(page)).getByRole("link", { name: m.nav_following, exact: true })).toBeVisible();
    await closePlaces(page);
  }
});

test("the column also appears on narrower wide screens and moves the body clear of itself", async ({ page }) => {
  const { topic } = fixture("routes");
  await useMember(page, "side_nav_routes@example.com");
  const side = page.locator("[data-site-navigation]");
  const header = page.locator("header");
  const layout = () => page.evaluate(() => {
    const body = document.body.getBoundingClientRect();
    const nav = document.querySelector("[data-site-navigation]")?.getBoundingClientRect();
    const text = document.querySelector("[data-reading-body]")?.getBoundingClientRect();
    const toc = document.querySelector(".reading-toc-sidebar")?.getBoundingClientRect();
    return { bodyLeft: body.left, bodyRight: body.right, navRight: nav?.right ?? null, readingLeft: text?.left, readingRight: toc?.right, overflow: document.documentElement.scrollWidth > innerWidth, width: innerWidth };
  });
  const session = await page.context().newCDPSession(page);
  for (const defaultSize of [16, 20]) {
    await session.send("Page.setFontSizes", { fontSizes: { standard: defaultSize } });
    const boundary = navigationBoundaryEm * defaultSize;
    await page.setViewportSize({ width: boundary - 1, height: 900 });
    await page.goto("/"); await waitForClientRoute(page);
    await expect(page.locator("html")).toHaveCSS("font-size", `${defaultSize}px`);
    await expect(side).not.toBeVisible();
    expect((await layout()).overflow).toBe(false);
    for (const width of [boundary, boundary + 76, boundary * 1.25 - 1]) {
      await page.setViewportSize({ width, height: 900 });
      for (const route of ["/", "/villages"]) {
        await page.goto(route); await waitForClientRoute(page);
        await expect(side).toBeVisible();
        await expect(page.locator("[data-navigation-drawer]:visible")).toHaveCount(0);
        const box = await layout();
        expect(box.navRight!).toBeLessThanOrEqual(box.bodyLeft);
        expect(box.bodyRight).toBeLessThanOrEqual(box.width);
        expect(box.overflow).toBe(false);
      }
      await page.goto(`/t/${topic}`); await waitForClientRoute(page);
      await expect(side).toHaveCount(0);
      await expect(header.locator("[data-navigation-drawer] > summary")).toBeVisible();
      await expect(page.locator(".reading-toc-sidebar")).toBeVisible();
      const box = await layout();
      expect(Math.abs(box.readingLeft! - (box.width - box.readingRight!))).toBeLessThanOrEqual(2);
      expect(box.overflow).toBe(false);
      for (const route of ["/settings", "/search"]) {
        await page.goto(route); await waitForClientRoute(page);
        await expect(side).toHaveCount(0);
        await expect(page.locator(".reading-toc-sidebar")).toHaveCount(0);
        const centered = await layout();
        expect(centered.bodyLeft).toBeCloseTo(centered.width - centered.bodyRight, 0);
        expect(centered.overflow).toBe(false);
      }
    }
    await page.setViewportSize({ width: boundary * 1.25, height: 900 });
    await page.goto("/"); await waitForClientRoute(page);
    await expect(side).toBeVisible();
    const box = await layout();
    expect(box.bodyLeft).toBeCloseTo(box.width - box.bodyRight, 0);
    expect(box.navRight!).toBeLessThanOrEqual(box.bodyLeft);
  }
});

test("wide navigation links work before hydration and without scripts", async ({ page, browser }) => {
  const { slug } = fixture("native");
  await useMember(page, "side_nav_native@example.com");
  const context = await browser.newContext({ javaScriptEnabled: false, locale: "en-US", viewport: { width: 1280, height: 900 }, storageState: await page.context().storageState() });
  try {
    const native = await context.newPage(); await native.goto("/");
    const side = native.locator("[data-site-navigation]");
    await expect(side).toBeVisible();
    await expect(native.locator("header [data-navigation-drawer]")).not.toBeVisible();
    // A chat with nothing new has no mark (only the village's name); one with news has a dot, not a number.
    await expect(side.locator('a[href="/v/en/chat"]')).toHaveCount(0);
    await expect(side.locator(`a[href="/v/${slug}/chat"] .bg-unread`)).toHaveCount(1);
    await expect(side.locator(`a[href="/v/${slug}/chat"]`)).not.toContainText("3");
    await side.getByRole("link", { name: `Side navigation native`, exact: true }).click();
    await expect(native).toHaveURL(new RegExp(`/v/${slug}$`));
    await expect(side.locator('[aria-current="page"]')).toHaveAttribute("href", `/v/${slug}`);
    await side.locator(`a[href="/v/${slug}/chat"]`).click();
    await expect(side.locator('[aria-current="true"]')).toHaveAttribute("href", `/v/${slug}`);
    await expect(native).toHaveURL(new RegExp(`/v/${slug}/chat$`));
    await side.getByRole("link", { name: m.nav_all_villages, exact: true }).click();
    await expect(native).toHaveURL(/\/villages$/);
    await expect(side.getByRole("link", { name: m.nav_all_villages, exact: true })).toHaveAttribute("aria-current", "page");
  } finally { await context.close(); }
});

test("reading the bottom clears the shared navigation count across route changes", async ({ page }) => {
  const { slug } = fixture("read");
  await page.setViewportSize({ width: 1280, height: 900 });
  await useMember(page, "side_nav_read@example.com"); await waitForClientRoute(page);
  const side = page.locator("[data-site-navigation]");
  await expect(side.locator(`a[href="/v/${slug}/chat"] .bg-unread`)).toHaveCount(1);
  await side.locator(`a[href="/v/${slug}/chat"]`).click(); await waitForClientRoute(page);
  await expect(page.locator("#chat-unread")).toBeInViewport();
  await expect(side.locator('[aria-current="true"]')).toHaveAttribute("href", `/v/${slug}`);
  await page.getByRole("link", { name: m.village_chat_latest, exact: true }).click();
  await expect(side.locator("a[href$='/chat'] .bg-unread")).toHaveCount(0);
  await expect(side.getByRole("link", { name: "Side navigation read", exact: true })).toBeVisible();
  await expect.poll(async () => (await (await page.request.get("/navigation-header")).json()).chatUnreadTotal).toBe(0);
  await side.getByRole("link", { name: m.nav_home, exact: true }).click(); await waitForClientRoute(page);
  await expect(side.locator(`a[href="/v/${slug}/chat"] .bg-unread`)).toHaveCount(0);
  await expect(side.getByRole("link", { name: m.nav_home, exact: true })).toHaveAttribute("aria-current", "page");
});

test("other villages keep live unread counts when leaving chat and zero-unread names switch chats directly", async ({ page, browser }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await useMember(page, "side_nav_live@example.com", "/v/side-nav-live/chat"); await waitForClientRoute(page);
  const side = page.locator("[data-site-navigation]");
  const other = side.getByRole("link", { name: "Side navigation other", exact: true });
  const count = side.locator('a[href="/v/side-nav-other/chat"] .bg-unread');
  await expect(count).toHaveCount(0);
  const context = await browser.newContext({ locale: "en-US" });
  try {
    const writer = await context.newPage();
    await useMember(writer, "side_nav_live_writer@example.com", "/v/side-nav-other/chat"); await waitForClientRoute(writer);
    await writer.getByLabel(m.village_chat_body, { exact: true }).fill("A new message in the other village");
    await writer.getByRole("button", { name: m.village_chat_send, exact: true }).click();
    await expect(writer.getByLabel(m.village_chat_body, { exact: true })).toHaveValue("");
    // Cross the count-refresh interval before resuming the existing chat poll.
    const counted = page.waitForResponse(response => response.url().includes("/chat/changes?") && new URL(response.url()).searchParams.get("counts") === "1");
    await page.evaluate(() => { const now = Date.now.bind(Date); Date.now = () => now() + 31_000; document.dispatchEvent(new Event("visibilitychange")); });
    await counted;
    await expect(count).toHaveCount(1);
    await side.evaluate(nav => {
      const target = window as unknown as { navigationCounts: string[]; navigationObserver: MutationObserver };
      target.navigationCounts = [];
      const record = () => target.navigationCounts.push(String(nav.querySelectorAll('a[href="/v/side-nav-other/chat"] .bg-unread').length));
      target.navigationObserver = new MutationObserver(record);
      target.navigationObserver.observe(nav, { childList: true, characterData: true, subtree: true, attributes: true });
      record();
    });
    await side.getByRole("link", { name: m.nav_home, exact: true }).click(); await waitForClientRoute(page);
    await expect(count).toHaveCount(1);
    const transitions = await page.evaluate(() => {
      const target = window as unknown as { navigationCounts: string[]; navigationObserver: MutationObserver };
      target.navigationObserver.disconnect(); return target.navigationCounts;
    });
    expect(transitions.length).toBeGreaterThan(0);
    expect(transitions.every(value => value === "1")).toBe(true);
    // A village's name always opens its posts, whichever screen is shown; its chat entrance always opens the chat.
    await expect(other).toHaveAttribute("href", "/v/side-nav-other");
    await side.getByRole("link", { name: "Side navigation live", exact: true }).click(); await waitForClientRoute(page);
    await page.locator("[data-village-header]").getByRole("link", { name: new RegExp(`^${m.village_chat_title}`) }).click(); await waitForClientRoute(page);
    await expect(other).toHaveAttribute("href", "/v/side-nav-other");
    await expect(side.getByRole("link", { name: "Side navigation no-consent", exact: true })).toHaveAttribute("href", "/v/side-nav-no-consent");
    await expect(side.locator('a[href="/v/side-nav-no-consent/chat"]')).toHaveCount(0);
    // With nothing new there is no mark; the chat is reached from the village page's "Chat" tab, and the name then says the member is inside it.
    await expect(side.locator('a[href="/v/side-nav-quiet/chat"]')).toHaveCount(0);
    await side.getByRole("link", { name: "Side navigation quiet", exact: true }).click(); await waitForClientRoute(page);
    await page.locator("[data-village-header]").getByRole("link", { name: new RegExp(`^${m.village_chat_title}`) }).click(); await expect(page).toHaveURL(/\/v\/side-nav-quiet\/chat$/); await waitForClientRoute(page);
    await expect(side.getByRole("link", { name: "Side navigation quiet", exact: true })).toHaveAttribute("aria-current", "true");
    await side.locator('a[href="/v/side-nav-other/chat"]').click(); await expect(page).toHaveURL(/\/v\/side-nav-other\/chat$/);
  } finally { await context.close(); }
});

test("in Japanese at a narrow wide-screen width, a village's name and its chat mark stay on one line", async ({ browser }) => {
  const context = await browser.newContext({ locale: "ja-JP", viewport: { width: 1100, height: 800 }, extraHTTPHeaders: { "Accept-Language": "ja-JP" } });
  try {
    const page = await context.newPage();
    await useMember(page, "uxnav_count@example.com"); await waitForClientRoute(page);
    const side = page.locator("[data-site-navigation]");
    await expect(side).toBeVisible();
    for (const slug of ["ux-nav-chat", "ux-nav-news"]) {
      const name = side.locator(`a[href="/v/${slug}"]`), mark = side.locator(`a[href="/v/${slug}/chat"]`);
      await expect(mark).toHaveCount(1);
      const [n, k] = [await name.boundingBox(), await mark.boundingBox()];
      expect(k!.x).toBeGreaterThanOrEqual(n!.x + n!.width - 1);
      expect(Math.abs(n!.y + n!.height / 2 - (k!.y + k!.height / 2))).toBeLessThan(3);
    }
  } finally { await context.close(); }
});
