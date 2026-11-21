import { expect, type Page } from "@playwright/test";
import { test } from "./editor-fixture";
import { captureScreenshot, jaMessages as m, openPlaces, closePlaces, state, useMember, waitForClientRoute } from "./helpers";

const screenshots = async (page: Page, name: string, width: number) => {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await captureScreenshot(page, { path: `${name}-${width}.png`, animations: "disabled" }, "screens");
};

test("the home scope survives filters and navigation and can be saved without JavaScript", async ({ page, browser }) => {
  test.skip(process.env.E2E_PUBLIC_READING !== "1" && process.env.E2E_VILLAGES !== "1", "Needs villages enabled");
  await useMember(page, "quartz_browser_reader@example.com", "/?scope=following");
  await waitForClientRoute(page);
  await expect(page.locator("html")).toHaveAttribute("lang", "ja");
  const all = page.getByRole("button", { name: m.home_scope_all, exact: true });
  const following = page.getByRole("button", { name: m.home_scope_following, exact: true });
  const filter = page.getByRole("navigation", { name: m.list_filter_label, exact: true });
  const summary = page.locator(`summary:is([aria-label="${m.home_filter_label}"], [aria-label^="${m.filter_prefix}"])`);
  await expect(following).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText(m.home_following_empty)).toBeVisible();
  await expect(page.getByRole("link", { name: m.home_see_all, exact: true })).toHaveAttribute("href", "/?scope=all");
  await expect(page.getByRole("link", { name: m.introductions_read, exact: true })).toHaveAttribute("href", "/introductions");
  await page.goto("/");
  await expect(all).toHaveAttribute("aria-pressed", "true");
  await following.click();
  await expect(following).toHaveAttribute("aria-pressed", "true");
  await expect(page).toHaveURL(`${state().baseURL}/`);
  await page.goto("/?scope=all");
  const more = page.locator('a[data-load-more="true"]').first();
  expect(new URL((await more.getAttribute("href"))!, state().baseURL).searchParams.get("scope")).toBe("all");
  await page.goto((await more.getAttribute("href"))!);
  await expect(all).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("link", { name: m.home_order_activity, exact: true }).click();
  await expect(page).toHaveURL(url => url.searchParams.get("scope") === "all" && url.searchParams.get("order") === "activity" && !url.searchParams.has("list_after"));
  await summary.click();
  await filter.getByRole("link", { name: m.list_questions_only, exact: true }).click();
  await expect(page).toHaveURL(url => url.searchParams.get("scope") === "all" && url.searchParams.get("asks") === "1");
  await page.locator(".reading-lang-menu summary").click();
  await page.getByRole("navigation", { name: m.reading_lang_label }).getByRole("link", { name: "English", exact: true }).click();
  await expect(page).toHaveURL(url => url.searchParams.get("lang") === "en" && url.searchParams.get("scope") === "all");
  await page.goto("/?scope=following&order=activity&asks=1");
  const clear = page.getByRole("link", { name: m.home_clear_filter });
  await expect(clear).toHaveAttribute("href", "/?scope=following&order=activity");
  await clear.click();
  await expect(page.getByText(m.home_following_empty)).toBeVisible();

  const native = await browser.newContext({ javaScriptEnabled: false, ignoreHTTPSErrors: true, storageState: await page.context().storageState() });
  try {
    const withoutScripts = await native.newPage();
    await withoutScripts.goto("/?order=activity&long=1&lang=ja&page=2&scope=following");
    await withoutScripts.getByRole("button", { name: m.home_scope_all, exact: true }).click();
    await expect(withoutScripts).toHaveURL(`${state().baseURL}/?order=activity&long=1&lang=ja`);
    await expect(withoutScripts.getByRole("button", { name: m.home_scope_all, exact: true })).toHaveAttribute("aria-pressed", "true");
  } finally { await native.close(); }

  await page.goto("/v/quartz-reading");
  await page.getByRole("button", { name: m.village_join, exact: true }).click();
  const membership = page.locator("details[data-village-membership]");
  await membership.locator(":scope > summary").click();
  await expect(membership.getByRole("button", { name: m.village_membership_unfollow, exact: true })).toBeVisible();
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await screenshots(page, "joined-menu", width);
  }
  await page.goto("/u/quartz_browser_author");
  const memberFollow = page.getByRole("button", { name: `${m.village_follow} @quartz_browser_author`, exact: true });
  await expect(memberFollow).toBeVisible();
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await screenshots(page, "member-profile", width);
  }
  await memberFollow.click();
  await page.goto("/");
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await all.click();
    await expect(all).toHaveAttribute("aria-pressed", "true");
    await screenshots(page, "home-all", width);
    await following.click();
    await expect(following).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("link", { name: "読書会で話したいこと", exact: true })).toHaveCount(1);
    await screenshots(page, "home-following", width);
    await summary.click();
    await expect(filter.getByRole("link", { name: m.list_all_topics, exact: true })).toBeVisible();
    await screenshots(page, "home-filter", width);
    await summary.click();
    const places = width === 390 ? await openPlaces(page) : page.locator("[data-site-navigation]");
    await expect(places.getByRole("heading", { name: m.nav_followed_members, exact: true })).toBeVisible();
    await expect(places.getByRole("link", { name: "@quartz_browser_author", exact: true })).toHaveAttribute("href", "/u/quartz_browser_author");
    await expect(places.getByRole("link", { name: m.nav_following, exact: true })).toHaveAttribute("href", "/following");
    await screenshots(page, "navigation", width);
    if (width === 390) await closePlaces(page);
  }
});
