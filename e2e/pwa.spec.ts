import { waitForClientRoute } from "./helpers";
import { expect } from "@playwright/test";
import { test } from "./editor-fixture";
import { captureLogomarkPreviews } from "./logomark-preview";

// Ordinary scenarios check the manifest, icons and offline document with service workers blocked.
// Production-build browser tests (e2e-prod/production.spec.ts) verify service-worker registration, cache contents and offline guidance.
test("the manifest is linked and served while ordinary scenarios block service workers", async ({ page, request }) => {
  await page.goto("/login");
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute("href", "/manifest.webmanifest");
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", "#ffffff");
  await expect(page.locator('link[rel="icon"][type="image/svg+xml"]')).toHaveAttribute("href", /^\/t[a-f0-9]{8}\.svg$/);
  await expect(page.locator('link[rel="icon"][href^="/favicon.ico?v="]')).toHaveAttribute("sizes", "16x16 32x32 48x48");
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute("href", /^\/[a-f0-9]{8}\.png$/);
  const fingerprints = new Set<string>();
  for (const [selector, original] of [
    ['link[rel="icon"][type="image/svg+xml"]', "/icons/icon.svg"],
    ['link[rel="icon"][href^="/favicon.ico?v="]', "/favicon.ico"],
    ['link[rel="apple-touch-icon"]', "/icons/apple-touch-icon.png"],
  ]) {
    const href = (await page.locator(selector).getAttribute("href"))!;
    const response = await request.get(href);
    expect(response.status(), href).toBe(200);
    expect(await response.body()).toEqual(await (await request.get(original)).body());
    fingerprints.add(href.match(/[a-f0-9]{8}/)![0]);
  }
  expect(fingerprints.size).toBe(1);
  await waitForClientRoute(page);
  const manifest = (await (await request.get("/manifest.webmanifest")).json()) as { name: string; start_url: string; display: string };
  expect(manifest).toMatchObject({ name: "tomola", start_url: "/", display: "standalone" });
  expect(manifest).toMatchObject({ share_target: { action: "/t/new", method: "GET", params: { title: "title", text: "text", url: "url" } } });
  for (const file of ["/favicon.ico", "/icons/icon.svg", "/icons/icon-192.png", "/icons/icon-512.png", "/icons/icon-maskable-512.png", "/icons/apple-touch-icon.png", "/icons/share-default.png"]) {
    const response = await request.get(file);
    expect(response.status(), file).toBe(200);
    expect(response.headers()["content-type"], file).toMatch(file.endsWith(".svg") ? /^image\/svg\+xml/ : file.endsWith(".ico") ? /^image\/(?:x-icon|vnd.microsoft.icon)/ : /^image\/png/);
  }
  expect(await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length)).toBe(0);
  await captureLogomarkPreviews(page);
});
