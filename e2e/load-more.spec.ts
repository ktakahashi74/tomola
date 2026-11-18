import fs from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { deferred } from "../tests/helpers/deferred";
import { enMessages as m, messageTitleField, state, restoreMember, waitForClientRoute, waitForFormReady } from "./helpers";

const fixture = () => JSON.parse(fs.readFileSync(`${state().dir}/load-more.json`, "utf8")) as { path: string; ids: number[]; before: string };
const rows = (page: Page) => page.locator('[data-reading-list="list"] li[id^="q-"]');
const rowIds = (page: Page) => rows(page).evaluateAll(items => items.map(item => Number(item.id.slice(2))));
const more = (page: Page) => page.locator('[data-reading-list="list"]').locator("[data-load-more]");

async function pauseRequest(page: Page, match: (url: URL) => boolean, method = "GET") {
  const arrived = deferred();
  const release = deferred();
  await page.route(match, async route => {
    if (route.request().method() === method) {
      arrived.resolve();
      await release.promise;
    }
    await route.continue();
  });
  return { arrived: arrived.promise, release: release.resolve };
}

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

test("members and guests can open a post while the next batch is still loading", async ({ page }) => {
  const path = "/?lang=en";
  if (test.info().config.metadata.publicReading) await page.goto(path);
  else await restoreMember(page, state().dir, "load_more_navigation@example.com", "load_more_navigation", path);
  await waitForClientRoute(page);
  const link = rows(page).first().locator("a.topic-title");
  const title = (await link.innerText()).trim();
  const destination = new URL((await link.getAttribute("href"))!, page.url()).pathname;
  const chunk = await pauseRequest(page, url => url.searchParams.has("_reading_chunk"));
  const navigation = await pauseRequest(page, url => url.pathname === `${destination}.data`);

  try {
    await more(page).click();
    await chunk.arrived;
    await expect(more(page)).toBeDisabled();
    await link.click();
    await navigation.arrived;
    chunk.release();
    await expect(more(page)).toBeEnabled();
    await expect(rows(page)).toHaveCount(30);
    expect(new URL(page.url()).searchParams.has("list_count")).toBe(false);
    navigation.release();
    await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
    expect(new URL(page.url()).pathname).toBe(destination);
  } finally {
    chunk.release();
    navigation.release();
  }
});

test("members and guests return to the same row after appending without reloading", async ({ page }) => {
  const path = "/?lang=en";
  if (test.info().config.metadata.publicReading) await page.goto(path);
  else await restoreMember(page, state().dir, "load_more_history@example.com", "load_more_history", path);
  await waitForClientRoute(page);
  const latest = page.getByRole("link", { name: m.list_back_latest, exact: true });
  await expect(latest).toHaveCount(0);
  await more(page).click();
  await expect(rows(page)).toHaveCount(60);
  const expanded = page.url();
  const ids = await rowIds(page);
  const row = page.locator(`#q-${ids[40]}`);
  const link = row.locator("a.topic-title");
  await link.scrollIntoViewIfNeeded();
  await link.focus();
  const top = await row.evaluate(item => item.getBoundingClientRect().top);
  await link.press("Enter");
  await expect(page).toHaveURL(/\/t\/\d+/);
  await page.goBack();
  await waitForClientRoute(page);
  await expect(page).toHaveURL(expanded);
  await expect(latest).toBeVisible();
  expect(await rowIds(page)).toEqual(ids);
  await expect.poll(async () => Math.abs(await row.evaluate(item => item.getBoundingClientRect().top) - top)).toBeLessThan(2);
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

test("members keep the expanded saved range, position and focus when removing an appended post", async ({ page }) => {
  await restoreMember(page, state().dir, "load_more_saver@example.com", "load_more_saver", "/saved");
  await waitForClientRoute(page);
  let rangeLoads = 0;
  page.on("request", request => {
    const url = new URL(request.url());
    if (url.pathname === "/saved.data" && url.searchParams.get("list_count") === "60") rangeLoads++;
  });
  await more(page).click();
  await expect(rows(page)).toHaveCount(60);
  expect(rangeLoads).toBe(0);
  const ids = fixture().ids;
  expect(await rowIds(page)).toEqual(ids.slice(0, 60));
  const trigger = rows(page).nth(40).getByRole("button", { name: m.saved_remove });
  await trigger.scrollIntoViewIfNeeded();
  await trigger.focus();
  const anchor = page.locator(`#q-${ids[39]}`);
  await expect(anchor).toBeInViewport();
  const position = await anchor.evaluate(row => row.getBoundingClientRect().top);
  const expanded = page.url();
  await trigger.press("Enter");
  await expect(page.locator(`#q-${ids[40]}`)).toHaveCount(0);
  expect(rangeLoads).toBe(1);
  expect(await rowIds(page)).toEqual(ids.slice(0, 61).filter(id => id !== ids[40]));
  await expect(page.locator(`#q-${ids[41]}`).getByRole("button", { name: m.saved_remove })).toBeFocused();
  await expect(page).toHaveURL(expanded);
  expect(Math.abs(await anchor.evaluate(row => row.getBoundingClientRect().top) - position)).toBeLessThan(2);
});

test("members can return to a new post from restored and legacy ranges", async ({ page, context }) => {
  const title = "A new post above the expanded list";
  const start = fixture().path;
  await restoreMember(page, state().dir, "load_more_publisher@example.com", "load_more_publisher", start);
  await waitForClientRoute(page);
  await more(page).click();
  await expect(rows(page)).toHaveCount(60);
  const expanded = await rowIds(page);

  const writer = await context.newPage();
  await writer.goto("/t/new");
  const titleInput = messageTitleField(writer);
  await waitForFormReady(writer.locator("form", { has: titleInput }));
  await titleInput.fill(title);
  await writer.getByLabel(m.field_body).fill("A fixture posted while reading an older range.");
  await writer.getByRole("button", { name: m.submit_post, exact: true }).click();
  await expect(writer.getByRole("heading", { name: title, exact: true })).toBeVisible();
  await writer.close();

  await page.reload();
  expect(await rowIds(page)).toEqual(expanded);
  await expect(rows(page).getByText(title, { exact: true })).toHaveCount(0);
  await page.getByRole("link", { name: m.list_back_latest, exact: true }).click();
  await expect(rows(page).getByText(title, { exact: true })).toBeVisible();

  await page.goto("/?lang=en&page=2");
  await waitForClientRoute(page);
  await more(page).click();
  await expect(rows(page)).toHaveCount(60);
  const legacyRange = await rowIds(page);
  await page.reload();
  expect(await rowIds(page)).toEqual(legacyRange);
  await page.getByRole("link", { name: m.list_back_latest, exact: true }).click();
  await expect(rows(page).getByText(title, { exact: true })).toBeVisible();
});

test("members without JavaScript stay at the member-page section anchor", async ({ browser }) => {
  const context = await browser.newContext({ baseURL: state().baseURL, javaScriptEnabled: false, ignoreHTTPSErrors: true, locale: "en-US" });
  try {
    const page = await context.newPage();
    await restoreMember(page, state().dir, "load_more_links@example.com", "load_more_links", "/u/load_more_author");
    const anchor = test.info().config.metadata.publicReading ? "#village" : "#posts";
    const section = page.locator(anchor);
    await section.getByRole("link", { name: m.list_load_more, exact: true }).click();
    expect(new URL(page.url()).hash).toBe(anchor);
    expect(await section.locator("li.topic-row").first().getAttribute("id")).toBe(`q-${fixture().ids[30]}`);
    await section.getByRole("link", { name: m.list_back_latest, exact: true }).click();
    expect(new URL(page.url()).hash).toBe(anchor);
    expect(await section.locator("li.topic-row").first().getAttribute("id")).toBe(`q-${fixture().ids[0]}`);
  } finally { await context.close(); }
});

test("public readers keep the list and can retry after network and HTTP failures", async ({ page }) => {
  const f = fixture();
  await page.goto(f.path);
  await waitForClientRoute(page);
  const url = page.url();
  let attempts = 0;
  await page.route(url => url.searchParams.has("_reading_chunk"), async route => {
    attempts++;
    if (attempts === 1) await route.abort();
    else if (attempts === 2) await route.fulfill({ status: 400 });
    else await route.continue();
  });
  for (let attempt = 1; attempt <= 2; attempt++) {
    await more(page).press("Enter");
    await expect.poll(() => attempts).toBe(attempt);
    await expect(page.locator('[data-reading-list="list"] > [role="status"]')).toHaveText(m.list_load_failed);
    await expect(more(page)).toBeEnabled();
    await expect(more(page)).toBeFocused();
    expect(await rowIds(page)).toEqual(f.ids.slice(0, 30));
    await expect(page).toHaveURL(url);
  }
  await more(page).press("Enter");
  await expect(rows(page)).toHaveCount(60);
  await expect(page.locator('[data-reading-list="list"] > [role="status"]')).toHaveText("Added 30 posts.");
});

test("public readers can sign in and follow a personal village without losing its expanded range", async ({ page }) => {
  await restoreMember(page, state().dir, "load_more_follower@example.com", "load_more_follower", "/u/load_more_author#village");
  await waitForClientRoute(page);
  const section = page.locator("#village");
  const button = section.getByRole("button", { name: m.list_load_more, exact: true });
  await button.click();
  await expect(section.locator("li.topic-row")).toHaveCount(60);
  const expanded = page.url();
  const chunk = await pauseRequest(page, url => url.searchParams.has("_reading_chunk"));
  const submission = await pauseRequest(page, url => url.pathname === "/u/load_more_author.data", "POST");
  try {
    await button.click();
    await chunk.arrived;
    await expect(button).toBeDisabled();
    await section.getByRole("button", { name: `${m.village_follow} @load_more_author` }).click();
    await submission.arrived;
    chunk.release();
    await expect(button).toBeEnabled();
    await expect(section.locator("li.topic-row")).toHaveCount(60);
    submission.release();
    await expect(section.getByRole("button", { name: `${m.village_following} @load_more_author` })).toBeVisible();
    await expect(page).toHaveURL(expanded);
    await expect(section.locator("li.topic-row")).toHaveCount(60);
  } finally {
    chunk.release();
    submission.release();
  }
});
