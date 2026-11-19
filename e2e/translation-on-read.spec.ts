import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { BODY_TRANSLATION_WAIT_MS } from "../app/lib/body-translation-poll";
import { localizedLanguageLabel } from "../app/lib/language-label";
import { captureScreenshot, formatMessage, state, uiMessages, useMember, waitForClientRoute } from "./helpers";
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
    await expect(page.locator("[data-article-translation-waiting]")).toBeVisible();
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

test("the author's notice finishes after source confirmation without polling for unrequested languages, which remain selectable", async ({ page }) => {
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
    await expect(page.locator("[data-article-translation-waiting]")).toBeVisible();
    fs.unlinkSync(hold);
    await expect(page.locator(`#p-${id} .longread`)).toHaveAttribute("lang", "fr", { timeout: 45_000 });
  } finally { if (fs.existsSync(hold)) fs.unlinkSync(hold); }
});

test("the author's notice polls for source confirmation alone and stops when it finishes", async ({ page }) => {
  const { id } = fixtures().sourceNotice;
  let statusCalls = 0;
  await page.route(`**/t/${id}/posted-status`, route => {
    statusCalls++;
    return route.fulfill({ json: { lang: "ja", langCode: null, checking: false, mismatch: true, untranslatable: false, langs: [{ lang: "en", state: "available" }] } });
  });
  await page.clock.install();
  await useMember(page, "ondemand_notice@example.com", `/t/${id}?lang=en&posted=${id}`);
  const m = await uiMessages(page);
  await expect(page.getByText(m.posted_all_reached, { exact: true })).toBeVisible();
  await expect(page.getByText(m.posted_translating, { exact: false })).toHaveCount(0);
  await page.clock.fastForward(12_000);
  await expect(page.getByText(formatMessage(m.posted_language_mismatch, { lang: localizedLanguageLabel("ja", "en") }), { exact: false })).toBeVisible();
  expect(statusCalls).toBe(1);
  await page.clock.fastForward(12_000);
  expect(statusCalls).toBe(1);
});

test("a status limit shows the original with an unavailable notice and stops polling", async ({ page }) => {
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
  await expect(page.locator("[data-article-translation-waiting]")).toBeVisible();
  await expect.poll(() => calls).toBeGreaterThan(0);
  await page.clock.fastForward(4000);
  await expect(page.locator("[data-article-translation-waiting]")).toHaveCount(0);
  await expect(page.getByText(m.label_no_translation, { exact: true })).toBeVisible();
  await expect(page.locator(`#p-${id} .longread`)).toHaveAttribute("lang", "ja");
  const finished = calls;
  await page.clock.fastForward(30_000);
  expect(calls).toBe(finished);
});

test("a reservation wait stops body polling for members and public readers", async ({ page }, testInfo) => {
  const { id } = fixtures().limited;
  let calls = 0;
  await page.addInitScript(() => {
    new MutationObserver(() => {
      if (document.querySelector("[data-article-translation-waiting]")) document.documentElement.dataset.translationWorkingSeen = "true";
    }).observe(document, { childList: true, subtree: true });
  });
  await page.route(`**/t/${id}/translations*`, route => {
    const intent = route.request().postDataJSON()?.intent;
    if (intent !== "request" && intent !== "status") return route.fulfill({ json: { ok: true } });
    calls++;
    return route.fulfill({ json: { ready: [], unavailable: [], paused: [id], stopped: false } });
  });
  await page.clock.install();
  if (testInfo.config.metadata.publicReading) await page.goto(`/t/${id}?lang=fr`);
  else await useMember(page, "ondemand_limited@example.com", `/t/${id}?lang=fr`);
  const m = await uiMessages(page);
  await expect(page.getByText(m.label_no_translation, { exact: true })).toBeVisible();
  await expect(page.locator("[data-article-translation-waiting]")).toHaveCount(0);
  await expect(page.locator(`#p-${id} .longread`)).toHaveAttribute("lang", "ja");
  await page.clock.fastForward(30_000);
  expect(calls).toBe(1);
  expect(await page.locator("html").getAttribute("data-translation-working-seen")).toBeNull();
});

test("a browser requests one missing body and replaces it in place with no navigation", async ({ page }) => {
  const { id, body } = fixtures().member;
  const hold = path.join(state().dir, "fake-body-translation-hold");
  fs.writeFileSync(hold, body);
  let requests = 0;
  page.on("request", request => { if (request.url().includes(`/t/${id}/translations`) && request.postDataJSON()?.intent === "request") requests++; });
  try {
    await useMember(page, "ondemand_member@example.com");
    await page.context().addCookies([{ name: "PARAGLIDE_LOCALE", value: "ja", url: state().baseURL }]);
    await page.goto(`/t/${id}?lang=fr`);
    const m = await uiMessages(page);
    const waiting = page.locator("[data-article-translation-waiting]");
    await expect(waiting).toHaveText(formatMessage(m.translation_article_working, { target: localizedLanguageLabel("fr", "ja") }));
    const notice = page.getByRole("status").filter({ has: waiting });
    await expect(notice).toHaveCount(1);
    await expect(notice).toContainText(formatMessage(m.translation_article_original, { source: localizedLanguageLabel("ja", "ja") }));
    await expect(notice).toContainText(m.translation_article_long);
    const dot = waiting.locator('[aria-hidden="true"]');
    await expect(dot).toHaveCSS("animation-name", "pulse");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect(dot).toHaveCSS("animation-name", "none");
    await waitForClientRoute(page);
    const article = page.locator(`#p-${id}`);
    await expect(article.locator(".longread")).toHaveAttribute("lang", "ja");
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 800 });
      await expect(notice).toBeInViewport();
      expect(await notice.evaluate(node => {
        const byline = node.parentElement!.querySelector("[data-reading-byline]")!.getBoundingClientRect();
        const body = node.parentElement!.querySelector("[data-reading-body]")!.getBoundingClientRect();
        const box = node.getBoundingClientRect();
        return byline.bottom <= box.top && box.bottom <= body.top && box.left >= 0 && box.right <= innerWidth;
      })).toBe(true);
      await captureScreenshot(page, { path: `waiting-${width}.png` }, "translation-on-read");
    }
    await page.setViewportSize({ width: 1280, height: 800 });
    // An in-page anchor remains the same reading page for completion notices.
    await page.evaluate(id => { history.replaceState(history.state, "", `${location.pathname}${location.search}#p-${id}`); }, id);
    await page.evaluate(() => window.scrollTo(0, 450));
    const before = await page.evaluate(() => window.scrollY);
    let resume!: () => void;
    const refreshHeld = new Promise<void>(resolve => { resume = resolve; });
    const topicData = `**/t/${id}.data*`;
    await page.route(topicData, async route => {
      await refreshHeld;
      await route.continue();
    });
    const revalidation = page.waitForRequest(topicData, { timeout: 45_000 });
    try {
      fs.unlinkSync(hold);
      await revalidation;
      await expect(waiting).toBeVisible();
    } finally { resume(); }
    await expect(article.locator(".longread")).toHaveAttribute("lang", "fr", { timeout: 45_000 });
    await expect(article.locator(".longread")).toContainText("[fr]");
    await expect(waiting).toHaveCount(0);
    expect(Math.abs(await page.evaluate(() => window.scrollY) - before)).toBeLessThan(25);
    expect(requests).toBe(1);
    await expect(page.getByRole("status").filter({ hasText: m.translation_article_arrived })).toHaveCount(1);
    await expect(page).toHaveURL(`/t/${id}?lang=fr#p-${id}`);
  } finally { if (fs.existsSync(hold)) fs.unlinkSync(hold); }
});

test("waiting continues after two minutes, skips hidden pages and shows an unavailable notice at its deadline", async ({ page }) => {
  const { id } = fixtures().timeout;
  let calls = 0;
  await page.route(`**/t/${id}/translations*`, async route => {
    const intent = route.request().postDataJSON()?.intent;
    if (intent !== "request" && intent !== "status") return route.fulfill({ json: { ok: true } });
    calls++;
    await route.fulfill({ json: { ready: [], unavailable: [], stopped: false } });
  });
  await page.clock.install();
  await useMember(page, "ondemand_timeout@example.com", `/t/${id}?lang=fr`);
  const m = await uiMessages(page);
  const waiting = page.locator("[data-article-translation-waiting]");
  await expect(waiting).toBeVisible();
  await expect(waiting.locator("..")).not.toContainText(m.translation_article_long);
  const initialCalls = calls;
  expect(initialCalls).toBeGreaterThan(0);
  await page.clock.fastForward(121_000);
  await expect.poll(() => calls).toBeGreaterThan(initialCalls);
  await expect(waiting).toBeVisible();
  await page.evaluate(() => Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" }));
  const visibleCalls = calls;
  await page.clock.fastForward(30_001);
  expect(calls).toBe(visibleCalls);
  await page.evaluate(() => Reflect.deleteProperty(document, "visibilityState"));
  await page.clock.fastForward(30_001);
  await expect.poll(() => calls).toBeGreaterThan(visibleCalls);
  await page.clock.fastForward(BODY_TRANSLATION_WAIT_MS);
  await expect(waiting).toHaveCount(0);
  await expect(page.getByText(m.label_no_translation, { exact: true })).toBeVisible();
  const finalCalls = calls;
  await page.clock.fastForward(30_000);
  expect(calls).toBe(finalCalls);
  await expect(page.locator(`#p-${id} .longread`)).toHaveAttribute("lang", "ja");
});

test("a failed translation replaces the waiting message with the existing failure notice", async ({ page }) => {
  const { id } = fixtures().timeout;
  await page.route(`**/t/${id}/translations*`, route => {
    const intent = route.request().postDataJSON()?.intent;
    return route.fulfill({ json: { ready: [], unavailable: intent === "status" ? [id] : [], paused: [], stopped: false } });
  });
  await page.clock.install();
  await useMember(page, "ondemand_timeout@example.com", `/t/${id}?lang=fr`);
  const m = await uiMessages(page);
  const waiting = page.locator("[data-article-translation-waiting]");
  await expect(waiting).toBeVisible();
  await page.clock.fastForward(4000);
  await expect(waiting).toHaveCount(0);
  await expect(page.getByText(m.translation_unavailable, { exact: true })).toBeVisible();
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
