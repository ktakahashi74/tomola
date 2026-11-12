import { expect, test, type Locator } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { captureScreenshot, clientHeaders, closePlaces, enMessages, jaMessages, openPlaces, useMember, waitForClientRoute } from "./helpers";

async function expectArtwork(artwork: Locator) {
  await expect(artwork).toBeVisible();
  const image = process.env.E2E_SERVER === "build"
    ? /url\("?.*\/assets\/logomark-[A-Za-z0-9_-]{8}\.svg"?\)/
    : /url\("?.*\/icons\/logomark\.svg\?no-inline"?\)/;
  await expect(artwork).toHaveCSS("background-image", image);
  await expect(artwork).toHaveCSS("mask-image", "none");
  // Decode the selected artwork too: a declared URL can hide a missing image.
  expect(await artwork.evaluate(async element => {
    const url = getComputedStyle(element).backgroundImage.match(/^url\(["']?(.*?)["']?\)$/)?.[1];
    if (!url) return false;
    const image = new Image();
    image.src = url;
    await image.decode();
    return image.naturalWidth > 0 && image.naturalHeight > 0;
  })).toBe(true);
}

for (const locale of ["en", "ja"] as const) {
  test(`the site name stays accessible and returns home for guests and members in ${locale}`, async ({ browser }, testInfo) => {
    const messages = locale === "ja" ? jaMessages : enMessages;
    for (const member of [false, true]) {
      const context = await browser.newContext({ locale: locale === "ja" ? "ja-JP" : "en-US", extraHTTPHeaders: clientHeaders(locale === "ja" ? "192.0.2.218" : "192.0.2.217") });
      try {
        const page = await context.newPage();
        if (member) await useMember(page, `wordmark_${locale}@example.com`, "/why");
        else await page.goto("/why");
        await waitForClientRoute(page);
        await expect(page.locator("html")).toHaveAttribute("lang", locale);
        const header = page.getByRole("banner");
        const logo = header.getByRole("link", { name: messages.site_name, exact: true });
        const artwork = logo.locator("[aria-hidden]");
        const text = logo.locator(":scope > span:last-child");
        const picture = async (width: number, state: string) => captureScreenshot(page, {
          path: `${member ? "member" : "guest"}-${locale}-${width}-${state}.png`, animations: "disabled",
        }, "wordmark");
        for (const width of [1366, 704, 703, 390]) {
          await page.setViewportSize({ width, height: 844 });
          await expect(logo).toBeVisible();
          await expect(artwork).toBeVisible();
          await expect(artwork).toHaveAttribute("aria-hidden", "true");
          await expectArtwork(artwork);
          const tagline = header.locator(":scope > .site-tagline");
          await expect(tagline).toHaveText(messages.site_tagline);
          await expect(tagline.locator("a")).toHaveCount(0);
          if (width >= 704) {
            await expect(tagline).toBeHidden();
            expect(await header.evaluate(element => {
              const controls = [...element.querySelectorAll(".logo, .member-header-drawer, .guest-header-links > a, .guest-header-account, .member-header-reading > *, :scope > a[aria-label], [data-admin-menu-trigger], [data-member-menu-trigger]")]
                .map(control => control.getBoundingClientRect()).filter(box => box.width > 0 && box.height > 0)
                .sort((a, b) => a.left - b.left);
              const centers = controls.map(box => box.y + box.height / 2);
              return Math.max(...centers) - Math.min(...centers) <= 1 &&
                controls.slice(1).every((box, index) => box.left >= controls[index].right - 1);
            })).toBe(true);
          } else await expect(tagline).toBeHidden();
          await expect(logo).toHaveAttribute("href", "/");
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
          await logo.evaluate(link => (link as HTMLElement).blur());
          await page.mouse.move(width - 1, 843);
          await picture(width, "normal");
          if (process.env.E2E_EVIDENCE_DIR) {
            const metrics = await logo.evaluate(link => {
              const style = getComputedStyle(link);
              const canvas = document.createElement("canvas").getContext("2d")!;
              canvas.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
              const text = canvas.measureText("tomola");
              const artwork = link.querySelector("[aria-hidden]");
              const box = (element: Element) => {
                const { x, y, width, height } = element.getBoundingClientRect();
                return { x, y, width, height };
              };
              return { fontSize: style.fontSize, fontFamily: style.fontFamily, textAscent: text.actualBoundingBoxAscent, textDescent: text.actualBoundingBoxDescent, textWidth: text.width, link: box(link), header: box(link.closest("header")!), artwork: artwork ? box(artwork) : null };
            });
            fs.writeFileSync(path.join(process.env.E2E_EVIDENCE_DIR, "wordmark", `${member ? "member" : "guest"}-${locale}-${width}-metrics.json`), JSON.stringify(metrics, null, 2) + "\n");
          }
          await logo.hover();
          await expect(logo).toHaveCSS("text-decoration-line", "none");
          await picture(width, "hover");
          await page.keyboard.press("Tab");
          await logo.focus();
          await expect(logo).toBeFocused();
          await expect(logo).toHaveCSS("outline-width", "2px");
          await picture(width, "focus");
          await page.emulateMedia({ forcedColors: "active" });
          await expect(logo).toBeVisible();
          await expect(logo).toHaveAccessibleName(messages.site_name);
          await expect(artwork).toHaveCSS("forced-color-adjust", "none");
          await expect(artwork).toBeVisible();
          await expectArtwork(artwork);
          await picture(width, "forced-colors");
          await page.emulateMedia({ forcedColors: "none" });
          await page.emulateMedia({ media: "print" });
          await expect(artwork).toBeHidden();
          await expect(text).toHaveCSS("position", "static");
          expect(await text.evaluate(element => element.getBoundingClientRect().width)).toBeGreaterThan(20);
          await expect(logo).toHaveAccessibleName(messages.site_name);
          await picture(width, "print");
          await page.emulateMedia({ media: "screen" });
          if (member && width === 390) {
            const places = await openPlaces(page);
            await expect(places.getByRole("link", { name: messages.nav_following, exact: true })).toBeVisible();
            await picture(width, "drawer");
            await closePlaces(page);
          }
        }
        await logo.focus();
        await page.keyboard.press("Enter");
        await expect(page).toHaveURL(url => url.pathname === (member || testInfo.config.metadata.publicReading ? "/" : "/login"));
        await waitForClientRoute(page);
        await expect(page.getByRole("banner").getByRole("link", { name: messages.site_name, exact: true })).toBeVisible();
        for (const width of [1366, 390]) {
          await page.setViewportSize({ width, height: 844 });
          await expectArtwork(page.getByRole("banner").locator(".logo > [aria-hidden]"));
          if (width >= 704) await expect(page.getByRole("banner").locator(".site-tagline")).toBeVisible();
          else await expect(page.getByRole("banner").locator(".site-tagline")).toBeHidden();
        }
      } finally { await context.close(); }
    }
  });
}

test("reading frames select their header without JavaScript", async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false, extraHTTPHeaders: clientHeaders("192.0.2.219") });
  try {
    const page = await context.newPage();
    for (const route of ["/why", "/name", "/principles", "/languages", "/terms", "/login"]) {
      await page.goto(route);
      const reading = await page.locator("main.reading-column").count() > 0;
      expect(reading).toBe(route !== "/login");
      for (const width of [704, 703]) {
        await page.setViewportSize({ width, height: 844 });
        await expectArtwork(page.getByRole("banner").locator(".logo > [aria-hidden]"));
        const tagline = page.getByRole("banner").locator(".site-tagline");
        if (!reading && width >= 704) await expect(tagline).toBeVisible();
        else await expect(tagline).toBeHidden();
      }
    }
  } finally { await context.close(); }
});
