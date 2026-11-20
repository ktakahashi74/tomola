import { test, expect } from "@playwright/test";
import sharp from "sharp";
import { state, useMember } from "./helpers";

test("unpublished media stays private when a browser switches accounts", async ({ page }) => {
  await useMember(page, "cache_image_reader@example.com");
  const readerCookies = await page.context().cookies();
  await useMember(page, "cache_image_owner@example.com");
  const headers = { Origin: state().baseURL };
  const buffer = await sharp({ create: { width: 17, height: 19, channels: 3, background: "#564312" } }).png().toBuffer();
  const upload = await page.request.post("/media", { headers, multipart: { image: { name: "unpublished.png", mimeType: "image/png", buffer } } });
  expect(upload.status()).toBe(201);
  const { url } = await upload.json();

  // Browser fetch uses Chromium's HTTP cache. Playwright's request client does not.
  const fetchStatus = () => page.evaluate(async path => {
    const response = await fetch(path);
    await response.arrayBuffer();
    return response.status;
  }, url);
  expect(await fetchStatus()).toBe(200);
  const logout = await page.request.post("/logout", { headers, form: {}, maxRedirects: 0 });
  expect(logout.status()).toBe(302);
  // Restore the second session without setStorageState, which clears the HTTP cache.
  await page.context().addCookies(readerCookies);
  await page.goto("/settings");
  await expect(page.locator("[data-member-menu-trigger]")).toHaveAttribute("title", "@cache_image_reader");
  expect(await fetchStatus()).toBe(404);
});
