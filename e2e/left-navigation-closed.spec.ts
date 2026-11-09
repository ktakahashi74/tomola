import { expect, test } from "@playwright/test";
import { closePlaces, enMessages as m, openPlaces, useMember, waitForClientRoute } from "./helpers";

test("closed villages keep the ordinary wide header without a side navigation", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await useMember(page, "side_nav_closed@example.com");
  for (const route of ["/", "/a/en", "/following", "/notifications"]) {
    await page.goto(route); await waitForClientRoute(page);
    await expect(page.locator("[data-site-navigation]")).toHaveCount(0);
    // The places are in the drawer; with villages closed they are Home and Following only.
    const places = await openPlaces(page);
    await expect(places.getByRole("link", { name: m.nav_following, exact: true })).toBeVisible();
    await expect(places.getByRole("link", { name: m.nav_home, exact: true })).toBeVisible();
    await expect(places.getByRole("heading", { name: m.villages_title, exact: true })).toHaveCount(0);
    await closePlaces(page);
  }
});
