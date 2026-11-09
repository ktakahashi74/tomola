import sharp from "sharp";
import { enMessages as en } from "../e2e/helpers";
import { test, expect, useMember, state, watchCsp } from "./helpers";

test("production upload and rendering work with native WebP conversion under CSP", async ({ page }) => {
  const watch = await watchCsp(page);
  await useMember(page, "media_prod@example.com");
  await page.goto("/t/new");
  const button = page.getByRole("button", { name: en.media_insert, exact: true }); await expect(button).toBeVisible();
  await page.locator('input[name="title"]').fill("Production image fixture");
  const buffer = await sharp({ create: { width: 12, height: 8, channels: 3, background: "blue" } }).png().toBuffer();
  const chooser = page.waitForEvent("filechooser"); await button.click(); await (await chooser).setFiles({ name: "fixture.png", mimeType: "image/png", buffer });
  const body = page.locator('textarea[name="body"]'); await expect(body).toHaveValue(/!\[.*\]\(\/media\/[a-f0-9]{64}-12x8.webp\)/);
  await page.getByRole("button", { name: en.preview, exact: true }).click();
  await expect(page.locator("main img")).toBeVisible();
  await page.getByRole("button", { name: en.submit_post, exact: true }).click(); await expect(page).toHaveURL(url => /^\/t\/\d+$/.test(url.pathname));
  const image = page.locator("[data-reading-body] img").first(); await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate(el => (el as HTMLImageElement).naturalWidth)).toBe(12);
  const response = await page.request.get(new URL((await image.getAttribute("src"))!, state().baseURL).href);
  expect(response.headers()["content-type"]).toBe("image/webp");
  expect(response.headers()["x-content-type-options"]).toBe("nosniff");
  expect(response.headers()["content-security-policy"]).toBe("default-src 'none'; sandbox");
  expect(watch.violations).toEqual([]); expect(watch.pageErrors).toEqual([]); expect(watch.hydrationWarnings).toEqual([]);
});
