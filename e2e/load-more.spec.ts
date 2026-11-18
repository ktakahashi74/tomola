import fs from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { enMessages as m, state, restoreMember, waitForClientRoute } from "./helpers";

const fixture = () => JSON.parse(fs.readFileSync(`${state().dir}/load-more.json`, "utf8")) as { path: string; ids: number[]; before: string };
const rows = (page: Page) => page.locator('[data-reading-list="list"] li[id^="q-"]');
const rowIds = (page: Page) => rows(page).evaluateAll(items => items.map(item => Number(item.id.slice(2))));
const more = (page: Page) => page.locator('[data-reading-list="list"]').locator("[data-load-more]");

async function appendAndReturn(page: Page, path: string, ids: number[]) {
  await page.goto(path);
  await waitForClientRoute(page);
  await expect(rows(page)).toHaveCount(30);
  expect(await rowIds(page)).toEqual(ids.slice(0, 30));
  await expect(page.getByRole("button", { name: m.list_load_more, exact: true })).toBeVisible();
  await more(page).scrollIntoViewIfNeeded();
  await more(page).focus();
  const y = await page.evaluate(() => window.scrollY);
  const firstTop = await rows(page).first().evaluate(item => item.getBoundingClientRect().top);
  await more(page).click();
  await expect(rows(page)).toHaveCount(60);
  expect(await rowIds(page)).toEqual(ids.slice(0, 60));
  await expect(page.locator('[data-reading-list="list"] [role="status"]')).toHaveText("Added 30 posts.");
  await expect(more(page)).toBeFocused();
  expect(Math.abs(await page.evaluate(() => window.scrollY) - y)).toBeLessThan(2);
  expect(Math.abs(await rows(page).first().evaluate(item => item.getBoundingClientRect().top) - firstTop)).toBeLessThan(2);
  expect(new URL(page.url()).searchParams.get("list_count")).toBe("60");
  const expanded = page.url();
  await page.reload();
  await waitForClientRoute(page);
  expect(await rowIds(page)).toEqual(ids.slice(0, 60));
  const target = rows(page).nth(40).locator("a.topic-title");
  await target.scrollIntoViewIfNeeded();
  await target.focus();
  // Record the departure at the link event, after keyboard focus scrolling.
  await target.evaluate(link => link.addEventListener("click", () => sessionStorage.setItem("load-more-departure-y", String(window.scrollY)), { once: true }));
  await target.press("Enter");
  await expect(page).toHaveURL(/\/t\/\d+/);
  await page.goBack();
  await waitForClientRoute(page);
  expect(page.url()).toBe(expanded);
  const returnY = await page.evaluate(() => Number(sessionStorage.getItem("load-more-departure-y")));
  await expect.poll(async () => Math.abs(await page.evaluate(() => window.scrollY) - returnY)).toBeLessThan(2);
  expect(await rowIds(page)).toEqual(ids.slice(0, 60));
}

test("members append, announce, restore and mark posts without another watermark exchange", async ({ page }) => {
  const f = fixture();
  await restoreMember(page, state().dir, "load_more_reader@example.com", "load_more_reader", "/settings");
  let exchanges = 0;
  page.on("request", request => { if (new URL(request.url()).pathname === "/list-seen") exchanges++; });
  await page.goto(f.path);
  await waitForClientRoute(page);
  await expect.poll(() => exchanges).toBe(1);
  await expect(rows(page).first().getByText(m.list_new_post, { exact: true })).toHaveCount(1);
  await more(page).click();
  await expect(rows(page)).toHaveCount(60);
  await expect(rows(page).nth(38).getByText(m.list_new_post, { exact: true })).toHaveCount(1);
  await expect(rows(page).nth(39).getByText(m.list_new_post, { exact: true })).toHaveCount(0);
  await expect(page.locator("[data-seen-boundary]")).toHaveCount(1);
  expect(exchanges).toBe(1);
  await appendAndReturn(page, f.path, f.ids);
});

test("members keep independent sections and stop the expanded range at 300", async ({ page }) => {
  await restoreMember(page, state().dir, "load_more_author@example.com", "load_more_author", "/u/load_more_author");
  const f = fixture();
  const publicMode = !!test.info().config.metadata.publicReading;
  const section = page.locator(publicMode ? "#village" : "#posts");
  const button = section.locator("[data-load-more]");
  for (let count = 30; count < 300; count += 30) {
    await expect(section.locator("li.topic-row")).toHaveCount(count);
    await button.click();
  }
  await expect(section.locator("li.topic-row")).toHaveCount(300);
  if (publicMode) await expect(page.locator("#posts li")).toHaveCount(0);
  await page.reload();
  await expect(section.locator("li.topic-row")).toHaveCount(300);
  await button.click();
  await expect(section.locator("li.topic-row")).toHaveCount(30);
  await expect(section.getByRole("link", { name: m.list_back_latest, exact: true })).toBeVisible();
  await expect(button).toHaveCount(0);
  const ids = await section.locator("li.topic-row").evaluateAll(items => items.map(item => Number(item.id.slice(2))));
  expect(ids).toEqual(f.ids.slice(300));
});

test("public readers append and return with frozen guest marks", async ({ page }) => {
  const f = fixture();
  await page.goto("/principles");
  await page.evaluate(before => localStorage.setItem("tomola.seen-posts", JSON.stringify([["/", before]])), f.before);
  await page.goto(f.path);
  await waitForClientRoute(page);
  await more(page).click();
  await expect(rows(page)).toHaveCount(60);
  await expect(rows(page).nth(38).getByText(m.list_new_post, { exact: true })).toHaveCount(1);
  await expect(rows(page).nth(39).getByText(m.list_new_post, { exact: true })).toHaveCount(0);
  await expect(page.locator("[data-seen-boundary]")).toHaveCount(1);
  await appendAndReturn(page, f.path, f.ids);
});

test("public readers without JavaScript follow a cursor link and return to latest", async ({ browser }) => {
  const context = await browser.newContext({ baseURL: state().baseURL, javaScriptEnabled: false, ignoreHTTPSErrors: true, locale: "en-US" });
  try {
    const page = await context.newPage(), f = fixture();
    await page.goto(f.path);
    expect(await rowIds(page)).toEqual(f.ids.slice(0, 30));
    await expect(page.getByRole("link", { name: m.list_load_more, exact: true })).toBeVisible();
    const href = await more(page).getAttribute("href");
    expect(href).toContain("list_after=");
    await more(page).click();
    expect(await rowIds(page)).toEqual(f.ids.slice(30, 60));
    await expect(page.getByRole("link", { name: m.list_back_latest, exact: true })).toHaveAttribute("href", "/?lang=en");
  } finally { await context.close(); }
});
