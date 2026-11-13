import { expect } from "@playwright/test";
import { test } from "./editor-fixture";
import { captureScreenshot, clientHeaders, enMessages as m, openPlaces, openPostSettings, useMember, waitForClientRoute } from "./helpers";

test("a personal village has its own follow section and delivers only the posts placed there", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US", extraHTTPHeaders: clientHeaders("192.0.2.240") });
  try {
    const page = await context.newPage();
    await useMember(page, "pv_browser_reader@example.com", "/u/pv_author"); await waitForClientRoute(page);
    const village = page.locator("#village");
    await expect(page.getByRole("heading", { name: "@pv_author", exact: true })).toHaveCount(1);
    await expect(village.getByRole("heading", { name: m.member_page_topics_heading, exact: true })).toBeVisible();
    const personalPost = await village.getByRole("link", { name: "Personal browser post", exact: true }).getAttribute("href");
    await expect(village.getByRole("link", { name: "Personal browser post", exact: true })).toBeVisible();
    await expect(village.getByRole("link", { name: "Personal elsewhere post", exact: true })).toHaveCount(0);
    await expect(page.locator("#posts").getByRole("link", { name: "Personal elsewhere post", exact: true })).toBeVisible();
    const elsewhere = page.locator("#posts li").filter({ has: page.getByRole("link", { name: "Personal elsewhere post", exact: true }) });
    await expect(elsewhere.locator('a[href="/v/en"]')).toHaveCount(0);
    await expect(elsewhere.locator('span[lang="en"]')).toBeVisible();
    await village.getByRole("button", { name: `${m.village_follow} @pv_author`, exact: true }).click();
    await expect(village.getByRole("button", { name: `${m.village_following} @pv_author`, exact: true })).toHaveAttribute("aria-pressed", "true");
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/u/pv_author"); await waitForClientRoute(page);
      await captureScreenshot(page, { path: `after-member-${width}.png`, fullPage: true }, "personal-villages");
      await page.goto("/?follow=1"); await waitForClientRoute(page);
      await expect(page.getByRole("link", { name: "Personal browser post", exact: true })).toBeVisible();
      await expect(page.getByRole("link", { name: "Personal elsewhere post", exact: true })).toHaveCount(0);
      if (width === 390) await openPlaces(page);
      await expect(page.getByRole("link", { name: m.village_personal, exact: true })).toHaveAttribute("href", "/u/pv_browser_reader");
      await captureScreenshot(page, { path: `after-places-${width}.png`, fullPage: true }, "personal-villages");
      await page.goto("/following"); await waitForClientRoute(page);
      const place = page.locator("main").getByRole("link", { name: "@pv_author", exact: true });
      await expect(place).toHaveCount(0);
      await captureScreenshot(page, { path: `after-following-${width}.png`, fullPage: true }, "personal-villages");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    const twin = await context.request.get("/following.md");
    expect(await twin.text()).not.toContain("@pv_author");
    await page.goto("/u/pv_author");
    await page.locator("#village").getByRole("button", { name: `${m.village_following} @pv_author`, exact: true }).click();
    await expect(page.locator("#village").getByRole("button", { name: `${m.village_follow} @pv_author`, exact: true })).toBeVisible();
    const guest = await browser.newContext();
    try {
      const anonymous = await guest.newPage();
      await anonymous.goto(personalPost!);
      await expect(anonymous.locator("main")).toContainText("Personal browser post");
      await anonymous.goto("/u/pv_author");
      await expect(anonymous).toHaveURL(/\/login/);
    } finally { await guest.close(); }
  } finally { await context.close(); }
});

test("members find their own village first in the column, drawer and directory without listing other personal villages", async ({ page, browser }) => {
  const ownPath = "/u/zown_nav_member";
  const otherPath = "/u/zown_nav_other";
  await useMember(page, "zown_nav_member@example.com");
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/"); await waitForClientRoute(page);
    const places = width === 1280 ? page.locator("[data-site-navigation]") : await openPlaces(page);
    const own = places.getByRole("link", { name: m.village_personal, exact: true });
    const joined = places.locator("ul").filter({ has: page.locator(`a[href="${ownPath}"]`) });
    await expect(joined.getByRole("listitem").first().getByRole("link")).toHaveAttribute("href", ownPath);
    await expect(own.locator("img")).toBeVisible();
    await expect(joined.getByRole("listitem")).toHaveCount(1);
    await expect(places.locator(`a[href="${otherPath}"]`)).toHaveCount(0);
    await expect(joined.locator('a[href$="/chat"]')).toHaveCount(0);
    await captureScreenshot(page, { path: `places-${width}.png`, fullPage: true }, "own-village-nav");
    await own.click();
    await expect(page).toHaveURL(new RegExp(`${ownPath}$`));
    await waitForClientRoute(page);
    await expect((await openPlaces(page)).getByRole("link", { name: m.village_personal, exact: true })).toHaveAttribute("aria-current", "page");

    await page.goto("/villages"); await waitForClientRoute(page);
    const directory = page.locator("main");
    const first = directory.locator('section[aria-labelledby="joined-villages"] li').first();
    await expect(first.getByRole("link")).toHaveAttribute("href", ownPath);
    await expect(directory.locator('section[aria-labelledby="joined-villages"] li')).toHaveCount(1);
    await expect(first.locator('p, a[href$="/chat"]')).toHaveCount(0);
    await expect(directory.locator(`a[href="${otherPath}"]`)).toHaveCount(0);
    await captureScreenshot(page, { path: `directory-${width}.png`, fullPage: true }, "own-village-nav");
    await first.getByRole("link").click();
    await expect(page).toHaveURL(new RegExp(`${ownPath}$`));
  }
  await page.goto("/v/en"); await waitForClientRoute(page);
  await page.getByRole("button", { name: m.village_join, exact: true }).click();
  await expect(page.locator("[data-village-header] summary").filter({ hasText: m.village_joined })).toBeVisible();
  await page.goto("/villages"); await waitForClientRoute(page);
  const joined = page.locator('main section[aria-labelledby="joined-villages"] li');
  await expect(joined).toHaveCount(2);
  await expect(joined.first().getByRole("link")).toHaveAttribute("href", ownPath);
  await expect(joined.locator('a[href="/v/en"]')).toBeVisible();
  expect(await (await page.request.get("/villages.md")).text()).not.toContain("@zown_nav_member");

  const guest = await browser.newContext();
  try {
    const anonymous = await guest.newPage();
    for (const route of ["/", "/villages"]) {
      await anonymous.goto(route); await waitForClientRoute(anonymous);
      await expect(anonymous.getByRole("link", { name: m.village_personal, exact: true })).toHaveCount(0);
      await expect(anonymous.locator(`a[href="${ownPath}"], a[href="${otherPath}"]`)).toHaveCount(0);
    }
  } finally { await guest.close(); }
});

test("personal compose and settings choices show the resolved default, with no self follow button", async ({ browser }) => {
  const context = await browser.newContext({ locale: "en-US", extraHTTPHeaders: clientHeaders("192.0.2.241") });
  try {
    const page = await context.newPage();
    await useMember(page, "pv_composer@example.com", "/u/pv_composer");
    await expect(page.locator("#village").getByRole("button")).toHaveCount(0);
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/t/new"); await waitForClientRoute(page); await openPostSettings(page);
      await expect(page.locator('input[name="village"]')).toHaveValue("@pv_composer");
      await expect(page.getByRole("button", { name: `${m.field_village} ${m.village_personal}`, exact: true })).toBeVisible();
      await captureScreenshot(page, { path: `after-compose-${width}.png`, fullPage: true }, "personal-villages");
      await page.goto("/settings"); await waitForClientRoute(page);
      await expect(page.locator('select[name="village"]')).toHaveValue("@pv_composer");
      await captureScreenshot(page, { path: `after-settings-${width}.png`, fullPage: true }, "personal-villages");
    }
  } finally { await context.close(); }
});
