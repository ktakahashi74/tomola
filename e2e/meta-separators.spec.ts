import fs from "node:fs";
import path from "node:path";
import { expect, test, type Locator } from "@playwright/test";
import { enMessages, formatMessage, openUserMenu, state, useMember, visitListRow, waitForClientRoute } from "./helpers";

async function expectWordBoundaries(row: Locator) {
  const date = (await row.locator(":scope > .topic-date").boundingBox())!;
  expect(date).toBeTruthy();
  for (const selector of [":scope > .topic-title", "[data-list-meta]"]) {
    const other = (await row.locator(selector).boundingBox())!;
    expect(date.x + date.width <= other.x || other.x + other.width <= date.x || date.y + date.height <= other.y || other.y + other.height <= date.y).toBe(true);
  }
  const items = row.locator("[data-list-meta] > [data-meta-item]");
  expect(await items.count()).toBeGreaterThan(0);
  const structure = await items.evaluateAll(nodes => nodes.map((item, index) => {
    const next = nodes[index + 1];
    const spaces = [...item.querySelectorAll(":scope > .sr-only")].filter(node => node.textContent === " ");
    return {
      content: item.firstElementChild?.getBoundingClientRect().width ?? 0,
      spaces: spaces.length,
      expectedSpaces: next ? 1 : 0,
      hiddenSpaces: spaces.every(space => getComputedStyle(space).position === "absolute" && !space.hasAttribute("aria-hidden")),
    };
  }));
  for (const item of structure) {
    expect(item.content).toBeGreaterThan(0);
    expect(item.spaces).toBe(item.expectedSpaces);
    expect(item.hiddenSpaces).toBe(true);
  }
}

test("list metadata separates optional items and stays readable when it wraps", async ({ page }) => {
  const fixture: { rich: number; plain: number } = JSON.parse(fs.readFileSync(path.join(state().dir, "meta-separators.json"), "utf8"));
  await useMember(page, "listmeta_reader@example.com");
  let richHome = "";
  for (const [name, id] of Object.entries(fixture)) {
    const row = page.locator(`#q-${id}`);
    await visitListRow(page, "/?lang=en", row);
    if (name === "rich") richHome = page.url();
    for (const width of [1366, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await expectWordBoundaries(row);
      await expect(row.locator('a[href="/v/meta-separators"]')).toHaveCount(name === "rich" ? 1 : 0);
      await expect(row.locator(".sr-only").filter({ hasText: /\S/ })).toHaveCount(name === "rich" ? 1 : 0);
      if (name === "rich") {
        await expect(row.getByText(formatMessage(enMessages.label_from_lang_machine, { lang: enMessages.language_name_ja }), { exact: true })).toBeVisible();
        expect(await row.locator("[data-meta-item]").count()).toBeGreaterThan(4);
        if (width === 390) {
          const lines = await row.locator("[data-meta-item]").evaluateAll(items => new Set(items.map(item => item.getBoundingClientRect().top)).size);
          expect(lines).toBeGreaterThan(1);
        }
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
  }
  const latestRow = page.locator(`#q-${fixture.rich}`);
  await visitListRow(page, "/latest?lang=en", latestRow);
  for (const width of [1366, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await expectWordBoundaries(latestRow);
    await expect(latestRow.locator('[data-meta-item="badge"]')).toHaveCount(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  for (const locale of ["en", "ja"]) {
    if (locale === "ja") {
      const menu = await openUserMenu(page);
      await menu.getByRole("menuitem", { name: enMessages.nav_language, exact: true }).click();
      await page.getByRole("menuitemradio", { name: "日本語", exact: true }).click();
    }
    await expect(page.locator("html")).toHaveAttribute("lang", locale);
    await page.goto(richHome);
    await waitForClientRoute(page);
    for (const width of [1366, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await expectWordBoundaries(page.locator(`#q-${fixture.rich}`));
      await page.locator(`#q-${fixture.rich}`).scrollIntoViewIfNeeded();
      if (process.env.E2E_EVIDENCE_DIR) {
        fs.mkdirSync(process.env.E2E_EVIDENCE_DIR, { recursive: true });
        await page.screenshot({ path: path.join(process.env.E2E_EVIDENCE_DIR, `home-${locale}-${width}.png`), animations: "disabled" });
      }
    }
  }
});
