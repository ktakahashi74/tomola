import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { captureScreenshot, state, uiMessages, useMember, waitForClientRoute } from "./helpers";
const fixtures = () => JSON.parse(fs.readFileSync(path.join(state().dir, "translation-on-read.json"), "utf8")) as Record<string, { id: number; body: string }>;

test("the author's language watch keeps its polling limit through loader revalidation", async ({ page }) => {
  const { id, body } = fixtures().watch;
  const hold = path.join(state().dir, "fake-body-translation-hold");
  fs.writeFileSync(hold, body);
  let statusCalls = 0;
  await page.route(`**/t/${id}/posted-status`, route => {
    statusCalls++;
    return route.fulfill({ json: { langs: [{ lang: "fr", state: "pending" }] } });
  });
  try {
    await page.clock.install();
    await useMember(page, "ondemand_watch@example.com", `/t/${id}?lang=fr`);
    const m = await uiMessages(page);
    await expect(page.getByText(m.translation_working, { exact: true })).toBeVisible();
    const revalidate = async () => {
      const loaded = page.waitForResponse(response => new URL(response.url()).pathname === `/t/${id}.data`);
      await page.evaluate(() => (window as unknown as { __reactRouterDataRouter: { revalidate(): void } }).__reactRouterDataRouter.revalidate());
      await loaded;
      await waitForClientRoute(page);
    };
    await revalidate();
    const tick = async () => {
      const next = page.waitForResponse(response => new URL(response.url()).pathname === `/t/${id}/posted-status`);
      await page.clock.fastForward(10_000);
      await next;
    };
    for (let round = 0; round < 30; round++) await tick();
    expect(statusCalls).toBe(30);
    await revalidate();
    for (let round = 0; round < 6; round++) await tick();
    expect(statusCalls).toBe(36);
    const extra = page.waitForRequest(request => new URL(request.url()).pathname === `/t/${id}/posted-status`, { timeout: 1000 }).catch(() => null);
    await page.clock.fastForward(10_000);
    await page.clock.fastForward(10_000);
    expect(await extra).toBeNull();
    expect(statusCalls).toBe(36);
  } finally { if (fs.existsSync(hold)) fs.unlinkSync(hold); }
});

test("the author's notice finishes without polling for unrequested languages, which remain selectable", async ({ page }) => {
  const { id, body } = fixtures().notice;
  const hold = path.join(state().dir, "fake-body-translation-hold");
  let statusCalls = 0;
  page.on("request", request => { if (request.url().includes(`/t/${id}/posted-status`)) statusCalls++; });
  fs.writeFileSync(hold, body);
  try {
    await page.clock.install();
    await useMember(page, "ondemand_notice@example.com", `/t/${id}?lang=en&posted=${id}`);
    const m = await uiMessages(page);
    await expect(page.getByText(m.posted_all_reached, { exact: true })).toBeVisible();
    await expect(page.getByText(m.posted_translating, { exact: false })).toHaveCount(0);
    await waitForClientRoute(page);
    const menu = page.locator("[data-reading-byline] details.reading-lang-menu");
    await menu.locator("summary").click();
    const french = menu.locator('a[hreflang="fr"]');
    await expect(french).not.toHaveAttribute("data-translation-pending", "true");
    await page.clock.fastForward(12_000);
    expect(statusCalls).toBe(0);
    await french.click();
    await expect(page.getByText(m.translation_working, { exact: true })).toBeVisible();
    fs.unlinkSync(hold);
    await expect(page.locator(`#p-${id} .longread`)).toHaveAttribute("lang", "fr", { timeout: 45_000 });
  } finally { if (fs.existsSync(hold)) fs.unlinkSync(hold); }
});

test("a status limit ends the wait and leaves the original without further polling", async ({ page }) => {
  const { id } = fixtures().limited;
  let calls = 0;
  await page.route(`**/t/${id}/translations*`, async route => {
    const intent = route.request().postDataJSON()?.intent;
    if (intent === "seen") return route.fulfill({ json: { ok: true } });
    calls++;
    if (intent === "status") return route.fulfill({ status: 429, body: "Too many requests" });
    await route.fulfill({ json: { ready: [], unavailable: [], stopped: false } });
  });
  await page.clock.install();
  await useMember(page, "ondemand_limited@example.com", `/t/${id}?lang=fr`);
  const m = await uiMessages(page);
  await expect(page.getByText(m.translation_working, { exact: true })).toBeVisible();
  await expect.poll(() => calls).toBeGreaterThan(0);
  await page.clock.fastForward(4000);
  await expect(page.getByText(m.translation_working, { exact: true })).toHaveCount(0);
  await expect(page.locator(`#p-${id} .longread`)).toHaveAttribute("lang", "ja");
  const finished = calls;
  await page.clock.fastForward(30_000);
  expect(calls).toBe(finished);
});

test("a browser requests one missing body and replaces it in place with no navigation", async ({ page }) => {
  const { id, body } = fixtures().member;
  const hold = path.join(state().dir, "fake-body-translation-hold");
  fs.writeFileSync(hold, body);
  let requests = 0;
  page.on("request", request => { if (request.url().includes(`/t/${id}/translations`) && request.postDataJSON()?.intent === "request") requests++; });
  try {
    await useMember(page, "ondemand_member@example.com", `/t/${id}?lang=fr`);
    const m = await uiMessages(page);
    await expect(page.getByText(m.translation_working, { exact: true })).toBeVisible();
    await waitForClientRoute(page);
    const article = page.locator(`#p-${id}`);
    await expect(article.locator(".longread")).toHaveAttribute("lang", "ja");
    for (const width of [1280, 1100, 390]) { await page.setViewportSize({ width, height: 800 }); await captureScreenshot(page, { path: `waiting-${width}.png` }, "translation-on-read"); }
    await page.setViewportSize({ width: 1280, height: 800 });
    // An in-page anchor remains the same reading page for completion notices.
    await page.evaluate(id => { history.replaceState(history.state, "", `${location.pathname}${location.search}#p-${id}`); }, id);
    await page.evaluate(() => window.scrollTo(0, 450));
    const before = await page.evaluate(() => window.scrollY);
    fs.unlinkSync(hold);
    await expect(article.locator(".longread")).toHaveAttribute("lang", "fr", { timeout: 45_000 });
    await expect(article.locator(".longread")).toContainText("[fr]");
    await expect(page.getByText(m.translation_working, { exact: true })).toHaveCount(0);
    expect(Math.abs(await page.evaluate(() => window.scrollY) - before)).toBeLessThan(25);
    expect(requests).toBe(1);
    await expect(page.getByRole("status").filter({ hasText: m.translation_arrived })).toHaveCount(1);
    await expect(page).toHaveURL(`/t/${id}?lang=fr#p-${id}`);
    for (const width of [1280, 1100, 390]) { await page.setViewportSize({ width, height: 800 }); await captureScreenshot(page, { path: `ready-${width}.png` }, "translation-on-read"); }
  } finally { if (fs.existsSync(hold)) fs.unlinkSync(hold); }
});

test("the wait ends after two minutes and stops polling without replacing the original", async ({ page }) => {
  const { id } = fixtures().timeout;
  let calls = 0;
  await page.route(`**/t/${id}/translations*`, async route => {
    if (route.request().postDataJSON()?.intent === "seen") return route.fulfill({ json: { ok: true } });
    calls++;
    await route.fulfill({ json: { ready: [], unavailable: [], stopped: false } });
  });
  await page.clock.install();
  await useMember(page, "ondemand_timeout@example.com", `/t/${id}?lang=fr`);
  const m = await uiMessages(page);
  await expect(page.getByText(m.translation_working, { exact: true })).toBeVisible();
  await expect.poll(() => calls).toBeGreaterThan(0);
  await page.clock.fastForward(121_000);
  await expect(page.getByText(m.translation_working, { exact: true })).toHaveCount(0);
  const finalCalls = calls;
  await page.clock.fastForward(30_000);
  expect(calls).toBe(finalCalls);
  await expect(page.locator(`#p-${id} .longread`)).toHaveAttribute("lang", "ja");
});

test("HTML and Markdown fetches stay passive; public browser reading can request work", async ({ page }, testInfo) => {
  const { id } = fixtures().public;
  // A request client never executes the page's effects.
  const html = await page.request.get(`/t/${id}?lang=fr`);
  if (testInfo.config.metadata.publicReading) {
    expect(html.ok()).toBe(true);
    const md = await page.request.get(`/t/${id}.md?lang=all`);
    expect(md.ok()).toBe(true);
    await page.goto(`/t/${id}?lang=fr`);
  } else {
    await useMember(page, "ondemand_public@example.com", `/t/${id}?lang=fr`);
  }
  await expect(page.locator(`#p-${id} .longread`)).toHaveAttribute("lang", "fr", { timeout: 45_000 });
});
