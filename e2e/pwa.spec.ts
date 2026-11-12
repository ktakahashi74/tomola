import { waitForClientRoute } from "./helpers";
import { expect } from "@playwright/test";
import { test } from "./editor-fixture";
import { captureLogomarkPreviews } from "./logomark-preview";

// Ordinary scenarios check the manifest, icons and offline document with service workers blocked.
// Production-build browser tests (e2e-prod/production.spec.ts) verify service-worker registration, cache contents and offline guidance.
test("the manifest is linked and served while ordinary scenarios block service workers", async ({ page, request }) => {
  await page.goto("/login");
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute("href", "/manifest.webmanifest");
  const themes = page.locator('meta[name="theme-color"]');
  await expect(themes).toHaveCount(2);
  await expect(themes.nth(0)).toHaveAttribute("media", "(prefers-color-scheme: light)");
  await expect(themes.nth(1)).toHaveAttribute("media", "(prefers-color-scheme: dark)");
  for (const theme of await themes.all()) {
    await page.emulateMedia({ colorScheme: (await theme.getAttribute("media"))!.includes("dark") ? "dark" : "light" });
    const colour = await theme.getAttribute("content");
    expect(await page.evaluate(value => {
      const probe = document.createElement("span"); probe.style.color = value!; document.body.append(probe);
      const matches = getComputedStyle(probe).color === getComputedStyle(document.body).backgroundColor;
      probe.remove(); return matches;
    }, colour)).toBe(true);
  }
  await page.emulateMedia({ colorScheme: "light" });
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

// Check device changes and future server-rendered preferences without pinning palette values.
test("device palettes react live and explicit root preferences take precedence", async ({ page }) => {
  await page.goto("/login");
  const background = () => page.locator("body").evaluate(body => getComputedStyle(body).backgroundColor);
  await page.emulateMedia({ colorScheme: "light" });
  const light = await background();
  await page.emulateMedia({ colorScheme: "dark" });
  const dark = await background();
  expect(dark).not.toBe(light);
  await page.locator("html").evaluate(html => html.setAttribute("data-color-scheme", "light"));
  expect(await background()).toBe(light);
  await page.emulateMedia({ colorScheme: "light" });
  await page.locator("html").evaluate(html => html.setAttribute("data-color-scheme", "dark"));
  expect(await background()).toBe(dark);
  await page.locator("html").evaluate(html => html.removeAttribute("data-color-scheme"));
  expect(await background()).toBe(light);
});
