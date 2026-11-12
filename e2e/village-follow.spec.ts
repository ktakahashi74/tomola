import { expect } from "@playwright/test";
import { test } from "./editor-fixture";
import { clientHeaders, enMessages as m, useMember, visitListRow, waitForClientRoute } from "./helpers";

// The button's name is its visible word plus the village (the village part is for screen readers).
const followLabel = (name: string) => new RegExp(`^(${m.village_follow}|${m.village_following}) ${name}$`);

test("following a village puts its posts on the home's Following list and its name in the places list, and unfollowing takes them off", async ({ browser }) => {
  test.setTimeout(120_000);
  const context = await browser.newContext({ locale: "en-US", viewport: { width: 1280, height: 900 }, extraHTTPHeaders: clientHeaders("192.0.2.231") });
  try {
    const page = await context.newPage();
    await useMember(page, "vfollow_reader@example.com", "/v/follow-fixture");
    await waitForClientRoute(page);
    const follow = page.getByRole("button", { name: followLabel("Follow fixture village") });
    await expect(follow).toHaveAttribute("aria-pressed", "false");
    // Following is reading: no chat, no right to post here.
    await follow.click();
    await expect(follow).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("link", { name: m.village_post_here, exact: true })).toHaveCount(0);
    // The places list names it (under its own heading) without a mark or a number.
    const side = page.locator("[data-site-navigation]");
    await expect(side.getByRole("heading", { name: m.village_follow_places, exact: true })).toBeVisible();
    await expect(side.getByRole("link", { name: "Follow fixture village", exact: true })).toBeVisible();
    // The home's filter has the list; the other village's post is not on it, and the default list still has both across its pages.
    await page.goto("/");
    await waitForClientRoute(page);
    await page.locator("summary", { hasText: new RegExp(`^\\s*${m.home_filter_all}\\s*$`) }).click();
    await page.getByRole("navigation", { name: m.list_filter_label }).getByRole("link", { name: m.home_filter_following, exact: true }).click();
    await expect(page).toHaveURL(/follow=1/);
    await expect(page.getByRole("link", { name: "Follow fixture topic" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Follow other topic" })).toHaveCount(0);
    for (const name of ["Follow fixture topic", "Follow other topic"]) {
      const topic = page.getByRole("link", { name, exact: true });
      await visitListRow(page, "/", topic);
      await expect(topic).toBeVisible();
    }
    // The village's own page is where its follow is managed.
    await page.goto("/v/follow-fixture");
    await waitForClientRoute(page);
    await page.getByRole("button", { name: followLabel("Follow fixture village") }).click();
    await expect(page.getByRole("button", { name: followLabel("Follow fixture village") })).toHaveAttribute("aria-pressed", "false");
    await page.goto("/?follow=1");
    await expect(page.getByText(m.home_following_empty)).toBeVisible();
    // A narrow screen does not overflow.
    await page.setViewportSize({ width: 390, height: 800 });
    await page.goto("/v/follow-fixture");
    await waitForClientRoute(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally { await context.close(); }
});
