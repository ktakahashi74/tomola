import fs from "node:fs";
import { expect, type BrowserContext, type Page } from "@playwright/test";
import { test } from "./editor-fixture";
import { captureScreenshot, waitForClientRoute, useMember, visitListRow, clientHeaders, enMessages as en, state  } from "./helpers";

test.describe.configure({ mode: "serial" });

let context: BrowserContext;
let page: Page;
let fixture: Record<string, { id: number; sourceTitle: string; listTitle: string }>;
test.beforeAll(async ({ browser }) => {
  fixture = JSON.parse(fs.readFileSync(`${state().dir}/title-first.json`, "utf8"));
  context = await browser.newContext({ locale: "en-US", colorScheme: "light", extraHTTPHeaders: clientHeaders("192.0.2.227") });
  page = await context.newPage();
  // These list fixtures intentionally stay pending while topic reads now request
  // work. Live completion is covered by translation-on-read.spec.ts.
  for (const topic of [fixture.pending, fixture.provisional]) {
    await page.route(`**/t/${topic.id}/translations*`, route => route.fulfill({ json: { ready: [], unavailable: [], stopped: false } }));
  }
  await useMember(page, "title_first@example.com");
  for (const topic of Object.values(fixture)) {
    await page.goto(`/t/${topic.id}`);
    await page.getByRole("button", { name: en.follow_button, exact: true }).click();
    await expect(page.getByRole("button", { name: en.follow_unfollow, exact: true })).toBeVisible();
  }
});
test.afterAll(async () => { await context?.close(); });

for (const width of [1280, 390]) {
  test(`pending list titles are muted and remain clickable at width ${width}`, async ({}, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    for (const path of ["/", "/a/ja", "/following?all=1", "/search?q=Title+first", "/u/kim"]) {
      const complete = page.locator(`main li a[href^="/t/${fixture.complete.id}"]`).first();
      const provisional = page.locator(`main li a[href^="/t/${fixture.provisional.id}"]`).first();
      const pending = page.locator(`main li a[href^="/t/${fixture.pending.id}"]`).first();
      const colours: string[] = [];
      await visitListRow(page, path, provisional);
      await waitForClientRoute(page);
      for (const [link, topic] of [[complete, fixture.complete], [provisional, fixture.provisional], [pending, fixture.pending]] as const) {
        // Own rows can lie on different pages; only navigate when this row is absent.
        if (!(await link.count())) await visitListRow(page, path, link);
        await expect(link).toHaveText(topic.listTitle);
        colours.push(await link.evaluate(el => getComputedStyle(el).color));
      }
      if (!(await provisional.count())) await visitListRow(page, path, provisional);

      expect(colours[1]).toBe(colours[2]);
      expect(colours[1]).not.toBe(colours[0]);
      // Compare with the existing supplementary text, rather than freezing a theme colour.
      const supplementary = provisional.locator("..").locator("time").first();
      await expect(supplementary).toBeVisible();
      expect(colours[1]).toBe(await supplementary.evaluate(el => getComputedStyle(el).color));
      const contrast = await provisional.evaluate(el => {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 1;
        const ctx = canvas.getContext("2d")!;
        const luminance = (colour: string) => {
          ctx.fillStyle = colour; ctx.fillRect(0, 0, 1, 1);
          const rgb = [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3).map(v => {
            const x = v / 255;
            return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
          });
          return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
        };
        const fg = luminance(getComputedStyle(el).color);
        const bg = luminance(getComputedStyle(document.body).backgroundColor);
        return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
      });
      expect(contrast).toBeGreaterThanOrEqual(4.5);
      await captureScreenshot(page, { path: testInfo.outputPath(`${path.split("?")[0].replaceAll("/", "-")}-${width}.png`), fullPage: true }, "e2e-title-first");
      await provisional.click();
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(fixture.provisional.sourceTitle);
      await expect(page.getByText(en.translation_working, { exact: true })).toBeVisible();
    }
    await page.goto(`/t/${fixture.complete.id}`);
    await waitForClientRoute(page);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(fixture.complete.listTitle);
  });
}
