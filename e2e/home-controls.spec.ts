import fs from "node:fs";
import path from "node:path";
import { expect, type Page } from "@playwright/test";
import { test } from "./editor-fixture";
import { LANG_LABELS } from "../app/lib/languages";
import { captureScreenshot, waitForClientRoute, useMember, clientHeaders, enMessages as en, jaMessages as ja, openUserMenu, state  } from "./helpers";

type Messages = typeof en;

async function controls(page: Page, messages: Messages, area = false) {
  const order = page.getByRole("navigation", { name: messages.home_order_label, exact: true });
  const filter = page.getByRole("navigation", { name: messages.list_filter_label, exact: true });
  if (!area) {
    const summary = page.locator(`summary[aria-label^="${messages.filter_prefix}"]`);
    // The name of the filter is read out but not drawn: the chosen value alone is the text.
    const accessible = messages === ja ? `${ja.filter_prefix}${ja.home_filter_all}` : `${en.filter_prefix} ${en.home_filter_all}`;
    await expect(summary).toHaveText(messages.home_filter_all);
    await expect(page.locator("main .more-info")).toHaveCount(0);
    await expect(summary).toHaveAccessibleName(accessible);
    await summary.click();
  }
  await expect(filter).toBeVisible();
  await expect(filter).not.toContainText(messages.filter_prefix);
  await expect(order).toBeVisible();
  await expect(order).not.toContainText(messages.home_order_label);
  await expect(order.locator('[aria-current="page"]')).toHaveCount(1);
  await expect(filter.locator('[aria-current="true"]')).toHaveCount(1);
  if (!area) await page.locator(`summary[aria-label^="${messages.filter_prefix}"]`).click();
  const languages = page.getByRole("navigation", { name: messages.home_origlang_label, exact: true });
  if (area) {
    await page.locator("summary:has(h1)").click();
    await expect(languages).toBeVisible();
    await expect(languages).not.toContainText(messages.home_origlang_label);
    await expect(languages.getByRole("link", { name: LANG_LABELS.ja, exact: true })).toHaveAttribute("aria-current", "page");
    await expect(languages.getByRole("link", { name: messages.home_filter_all, exact: true })).toHaveAttribute("href", "/");
    await page.locator("summary:has(h1)").click();
  } else {
    await expect(languages).toHaveCount(0);
  }
}

async function evidence(page: Page, name: string, messages: Messages) {
  const directory = path.join(process.cwd(), ".data", "home-controls");
  fs.mkdirSync(directory, { recursive: true });
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${name} at ${width}px`).toBe(true);
    const navigations = page.getByRole("navigation", { name: messages.home_order_label, exact: true })
      .or(page.getByRole("navigation", { name: messages.list_filter_label, exact: true }))
      .or(page.getByRole("navigation", { name: messages.home_origlang_label, exact: true }));
    const heights = await navigations.locator("a:visible").evaluateAll(links => links.map(link => link.getBoundingClientRect().height));
    for (const height of heights) expect(height).toBeGreaterThanOrEqual(24);
    await captureScreenshot(page, { path: path.join(directory, `${name}-${width}.png`), animations: "disabled" }, "e2e-home-controls");
  }
}

test("home and language lists retain accessible controls for public readers", async ({ browser }) => {

  for (const [locale, messages, ip] of [["en-US", en, "192.0.2.220"], ["ja-JP", ja, "192.0.2.221"]] as const) {
    const context = await browser.newContext({ locale, extraHTTPHeaders: clientHeaders(ip) });
    try {
      const page = await context.newPage();
      for (const url of ["/", "/a/ja"]) {
        await page.goto(url);
        await controls(page, messages, url.startsWith("/a/"));
        for (const width of [390, 1280]) {
          await page.setViewportSize({ width, height: 900 });
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
          if (url === "/" && width === 390) {
            const order = page.getByRole("navigation", { name: messages.home_order_label, exact: true });
            const filter = page.locator(`summary[aria-label^="${messages.filter_prefix}"]`);
            for (const [query, label] of [["", messages.home_filter_all], ["asks=1", messages.list_questions_only], ["long=1", messages.home_filter_long]]) {
              await page.goto(`/?${query}`);
              await waitForClientRoute(page);
              await expect(filter).toHaveText(label);
              await expect(page.locator("main .more-info")).toHaveCount(0);
              const a = (await order.boundingBox())!, b = (await filter.boundingBox())!;
              expect(a.x + a.width <= b.x || b.x + b.width <= a.x).toBe(true);
              expect(a.y < b.y + b.height && b.y < a.y + a.height).toBe(true);
              expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
              await filter.click();
              const options = page.getByRole("navigation", { name: messages.list_filter_label, exact: true });
              await expect(options.getByRole("link", { name: label, exact: true })).toHaveAttribute("aria-current", "true");
            }
          }
        }
      }
    } finally { await context.close(); }
  }
});

test("member list controls work with keyboard and fit narrow and wide screens in both languages", async ({ browser }) => {
  test.setTimeout(180_000);
  const context = await browser.newContext({ extraHTTPHeaders: clientHeaders("192.0.2.222") });
  try {
    const page = await context.newPage();
    const invitation = JSON.parse(fs.readFileSync(path.join(state().dir, "home-controls-invite.json"), "utf8")) as string;
    await useMember(page, "home_controls@example.com");
    for (const [locale, messages] of [["en", en], ["ja", ja]] as const) {
      await page.goto("/");
      const current = await page.locator("html").getAttribute("lang");
      if (current !== locale) {
        const menu = await openUserMenu(page);
        await menu.getByRole("menuitem", { name: (current === "ja" ? ja : en).nav_language, exact: true }).click();
        await page.getByRole("menuitemradio", { name: LANG_LABELS[locale], exact: true }).click();
        await expect(page.locator("html")).toHaveAttribute("lang", locale);
      }
      for (const url of ["/", "/a/ja", "/following", "/latest"]) {
        await page.goto(url);
        await waitForClientRoute(page);
        if (url === "/" || url.startsWith("/a/")) await controls(page, messages, url.startsWith("/a/"));
        else await expect(page.getByRole("navigation", { name: messages.list_filter_label, exact: true })).toBeVisible();
        await evidence(page, `${url === "/" ? "home" : url.slice(1).replaceAll("/", "-")}-${locale}`, messages);
      }
      await page.goto(`/?page=2&lang=${locale}`);
      const order = page.getByRole("navigation", { name: messages.home_order_label, exact: true });
      await order.getByRole("link", { name: messages.home_order_created, exact: true }).focus();
      await page.keyboard.press("Tab");
      await expect(order.getByRole("link", { name: messages.home_order_activity, exact: true })).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(new URL(`/?lang=${locale}&order=activity`, state().baseURL).href);
      await waitForClientRoute(page);
      const filter = page.getByRole("navigation", { name: messages.list_filter_label, exact: true });
      const summary = page.locator(`summary[aria-label^="${messages.filter_prefix}"]`);
      const filterLabel = (label: string) => label;
      await expect(order.getByRole("link", { name: messages.home_order_activity, exact: true })).toHaveAttribute("aria-current", "page");
      await summary.click();
      await filter.getByRole("link", { name: messages.home_filter_long, exact: true }).click();
      await expect(page).toHaveURL(new URL(`/?lang=${locale}&order=activity&long=1`, state().baseURL).href);
      await waitForClientRoute(page);
      await expect(summary).toHaveText(filterLabel(messages.home_filter_long));
      await summary.click();
      await expect(filter.getByRole("link", { name: messages.home_filter_long, exact: true })).toHaveAttribute("aria-current", "true");
      await filter.getByRole("link", { name: messages.list_questions_only, exact: true }).click();
      await expect(page).toHaveURL(new URL(`/?lang=${locale}&order=activity&asks=1`, state().baseURL).href);
      await waitForClientRoute(page);
      await expect(summary).toHaveText(filterLabel(messages.list_questions_only));
      await summary.click();
      await filter.getByRole("link", { name: messages.home_filter_all, exact: true }).click();
      await expect(page).toHaveURL(new URL(`/?lang=${locale}&order=activity`, state().baseURL).href);
      await waitForClientRoute(page);
      await expect(summary).toHaveText(filterLabel(messages.home_filter_all));
    }
  } finally { await context.close(); }
});
