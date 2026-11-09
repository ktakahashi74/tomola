import fs from "node:fs";
import path from "node:path";
import { expect, type Page } from "@playwright/test";
import { test } from "./editor-fixture";
import { useMember, state, waitForClientRoute, waitForFormReady, captureScreenshot, uiMessages, formatMessage } from "./helpers";
import { beforeHydration } from "./support/prehydration";

type Fixture = { topicId: number; rootA: number; rootB: number; a: number[]; b: number[]; chronological: number[]; hiddenRoot: number; hiddenChild: number; deletedRoot: number; deletedChild: number; continuationId: number; previousRoot: number; firstPageContinued: number[]; continued: number[]; spareRoot: number };
const fixture = (): Fixture => JSON.parse(fs.readFileSync(path.join(state().dir, "reply-branches.json"), "utf8"));
const branch = (page: Page, id: number) => page.locator(`[data-reply-branch="${id}"]`);
const tail = (page: Page, id: number) => branch(page, id).locator("details[data-reply-tail]");
async function noOverflow(page: Page) { expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true); }
async function visibleTarget(page: Page, id: number) {
  await expect(page.locator(`#c-${id}`)).toBeVisible();
  await expect.poll(() => page.locator(`#c-${id}`).evaluate(node => Math.abs(node.getBoundingClientRect().top) < window.innerHeight)).toBe(true);
}
async function shot(page: Page, name: string) {
  await captureScreenshot(page, { path: `${name}.png`, animations: "disabled" }, "reply-branches");
}

test("groups branches once, folds their tails and retains withheld placeholders at both widths", async ({ page }) => {
  const f = fixture();
  await useMember(page, "twig_layout@example.com");
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 1100 });
    await page.goto(`/t/${f.topicId}`);
    await waitForClientRoute(page);
    const messages = await uiMessages(page);
    await expect.poll(() => branch(page, f.rootA).locator("article").evaluateAll(nodes => nodes.map(node => Number(node.id.slice(2))))).toEqual([f.rootA, ...f.a]);
    await expect.poll(() => page.locator("[data-reply-list] article").evaluateAll(nodes => nodes.map(node => Number(node.id.slice(2))))).toEqual([f.rootA, ...f.a, f.rootB, ...f.b, f.hiddenRoot, f.hiddenChild, f.deletedRoot, f.deletedChild]);
    await expect(page.locator(`#c-${f.a[0]} a[href$="#c-${f.rootA}"]`)).toHaveCount(0);
    await expect(page.locator(`#c-${f.a[1]} a[href$="#c-${f.a[0]}"]`)).toHaveCount(1);
    await expect(tail(page, f.rootA)).toHaveJSProperty("open", false);
    const foldedCount = await tail(page, f.rootA).locator("article").count();
    await expect(tail(page, f.rootA).locator(":scope > summary")).toHaveText(formatMessage(messages.branch_more_replies, { count: foldedCount }));
    await expect(page.locator(`#c-${f.a.at(-1)}`)).not.toBeVisible();
    await expect(branch(page, f.rootA)).toHaveAccessibleName(/@twig_fixture/);
    await expect(branch(page, f.hiddenRoot)).toHaveAccessibleName(messages.entry_hidden_placeholder);
    await expect(branch(page, f.deletedRoot)).toHaveAccessibleName(messages.entry_deleted_placeholder);
    await expect(page.locator(`#c-${f.hiddenRoot}`)).toHaveText(messages.entry_hidden_placeholder);
    await expect(page.locator(`#c-${f.deletedRoot}`)).toHaveText(messages.entry_deleted_placeholder);
    await expect(page.locator("#replies")).not.toContainText("HIDDEN_BRANCH_BODY");
    await expect(page.locator("#replies")).not.toContainText("DELETED_BRANCH_BODY");
    const ids = await page.locator("[id]").evaluateAll(nodes => nodes.map(node => node.id));
    expect(new Set(ids).size).toBe(ids.length);
    await noOverflow(page);
    await page.locator("#replies").evaluate(element => element.scrollIntoView({ block: "start" }));
    await shot(page, `after-branches-${width}`);
    await tail(page, f.rootA).locator(":scope > summary").click();
    await expect(page.locator(`#c-${f.a.at(-1)}`)).toBeVisible();
    await tail(page, f.rootA).evaluate(element => element.scrollIntoView({ block: "start" }));
    await shot(page, `after-expanded-${width}`);
    await tail(page, f.rootA).locator(":scope > summary").click();
    await expect(page.locator(`#c-${f.a.at(-1)}`)).not.toBeVisible();

    await page.goto(`/t/${f.continuationId}?page=2`);
    await waitForClientRoute(page);
    await expect(branch(page, f.previousRoot).getByRole("link", { name: formatMessage(messages.reply_parent_link, { handle: "twig_fixture" }), exact: true }).first()).toHaveAttribute("href", `/t/${f.continuationId}#c-${f.previousRoot}`);
    await expect(page.locator(`#c-${f.previousRoot}`)).toHaveCount(0);
    await expect(branch(page, f.previousRoot).locator("article")).toHaveCount(f.continued.length);
    await expect(page.locator(`#c-${f.continued[0]} a[href$="#c-${f.previousRoot}"]`)).toHaveCount(0);
    await expect(branch(page, f.previousRoot).locator(`a[href$="#c-${f.previousRoot}"]`)).toHaveCount(1);
    await expect(branch(page, f.previousRoot)).toHaveAccessibleName(formatMessage(messages.reply_parent_link, { handle: "twig_fixture" }));
    await noOverflow(page);
    await branch(page, f.previousRoot).evaluate(element => element.scrollIntoView({ block: "start" }));
    await shot(page, `after-continuation-${width}`);
    if (width === 1280) {
      await tail(page, f.previousRoot).locator(":scope > summary").click();
      await expect(tail(page, f.previousRoot)).toHaveJSProperty("open", true);
      await page.getByRole("link", { name: messages.page_prev, exact: true }).first().click();
      await waitForClientRoute(page);
      await expect(tail(page, f.previousRoot)).toHaveJSProperty("open", false);
      await tail(page, f.previousRoot).locator(":scope > summary").click();
      await page.getByRole("link", { name: messages.page_next, exact: true }).first().click();
      await waitForClientRoute(page);
      await expect(tail(page, f.previousRoot)).toHaveJSProperty("open", false);
    }
  }
});

test("reveals folded fragment targets on initial load, hash changes and history navigation", async ({ page }) => {
  const f = fixture(), last = f.a.at(-1)!;
  await useMember(page, "twig_anchor@example.com");
  await page.goto(`/t/${f.topicId}#c-${last}`);
  await waitForClientRoute(page);
  await visibleTarget(page, last);
  await tail(page, f.rootA).locator(":scope > summary").click();
  await page.evaluate(id => { location.hash = `c-${id}`; }, f.a.at(-2)!);
  await visibleTarget(page, f.a.at(-2)!);
  await page.evaluate(id => { location.hash = `c-${id}`; }, f.rootB);
  await tail(page, f.rootA).locator(":scope > summary").click();
  await page.goBack();
  await visibleTarget(page, f.a.at(-2)!);
  await page.goto(`/t/${f.topicId}?reply_to=c-${last}#c-${last}`);
  await waitForClientRoute(page);
  await visibleTarget(page, last);
});

test("keeps the reading position on history return to an unfolded reply anchor", async ({ page }) => {
  const f = fixture();
  if (process.env.E2E_PUBLIC_READING !== "1") await useMember(page, "twig_restore@example.com");
  await page.goto(`/t/${f.topicId}#c-${f.rootB}`);
  await waitForClientRoute(page);
  await expect.poll(() => page.evaluate(() => localStorage.getItem("tomola.seen-replies"))).not.toBeNull();
  await page.evaluate(id => {
    const anchorBottom = document.getElementById(`c-${id}`)!.getBoundingClientRect().bottom + window.scrollY;
    const maximum = document.documentElement.scrollHeight - window.innerHeight;
    window.scrollTo(0, (anchorBottom + maximum) / 2);
  }, f.rootB);
  const anchorBottom = await page.locator(`#c-${f.rootB}`).evaluate(element => element.getBoundingClientRect().bottom + window.scrollY);
  const readingLine = await page.locator(`#c-${f.deletedChild} .longread > p`).first().evaluate(element => element.getBoundingClientRect().height);
  await page.evaluate(() => {
    const calls: string[] = [];
    (window as unknown as { replyScrollCalls: string[] }).replyScrollCalls = calls;
    const original = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = function(...args) { calls.push(this.id); return original.apply(this, args); };
  });
  expect(await page.locator(`#c-${f.rootB}`).evaluate(element => element.getBoundingClientRect().bottom)).toBeLessThan(0);
  // Navigate without the test runner scrolling an offscreen link into view.
  // Keep the saved reading position away from the page's bottom boundary.
  await page.evaluate(id => (window as unknown as {
    __reactRouterDataRouter: { navigate: (path: string) => Promise<void> };
  }).__reactRouterDataRouter.navigate(`/t/${id}`), f.continuationId);
  await waitForClientRoute(page);
  expect(new URL(page.url()).pathname).toBe(`/t/${f.continuationId}`);
  await page.goBack();
  await waitForClientRoute(page);
  await expect(page).toHaveURL(new RegExp(`#c-${f.rootB}$`));
  const restored = await page.evaluate(() => (window as unknown as {
    __reactRouterDataRouter: { state: { restoreScrollPosition: number | null | false } };
  }).__reactRouterDataRouter.state.restoreScrollPosition);
  // Compare with the saved position actually selected by ScrollRestoration,
  // not an earlier sample taken before the navigation starts.
  expect(typeof restored).toBe("number");
  expect(restored).toBeGreaterThan(anchorBottom);
  // Allow one rendered line for the browser's post-navigation layout settling;
  // this must still retain the reading position, not jump back to the anchor.
  await expect.poll(async () => Math.abs(await page.evaluate(() => window.scrollY) - (restored as number))).toBeLessThanOrEqual(readingLine);
  expect(await page.evaluate(() => (window as unknown as { replyScrollCalls: string[] }).replyScrollCalls)).not.toContain(`c-${f.rootB}`);
  expect(await page.locator(`#c-${f.rootB}`).evaluate(element => element.getBoundingClientRect().bottom)).toBeLessThan(0);
});

test("marks each initially new reply, opens new tails and retains the set across mutations and filters", async ({ page }) => {
  const f = fixture();
  await useMember(page, "twig_unread@example.com");
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 1100 });
    await page.goto("/");
    await waitForClientRoute(page);
    await page.evaluate(({ id, max }) => localStorage.setItem("tomola.seen-replies", JSON.stringify([[id, max]])), { id: f.topicId, max: f.rootB });
    await page.goto(`/t/${f.topicId}#c-${f.a.at(-1)}`);
    await waitForClientRoute(page);
    const messages = await uiMessages(page);
    const newIds = [...f.a, ...f.b, f.hiddenChild, f.deletedChild];
    const badges = page.locator("[data-new-reply]");
    const summary = page.locator("[data-new-replies]");
    await expect.poll(() => badges.evaluateAll(nodes => nodes.map(node => Number(node.id.slice(2))))).toEqual(newIds);
    await expect(summary).toContainText(formatMessage(messages.page_new_replies, { count: newIds.length }));
    await summary.evaluate(node => { node.dataset.revalidationIdentity = "retained"; });
    await page.evaluate(() => (window as unknown as { __reactRouterDataRouter: { revalidate(): Promise<void> } }).__reactRouterDataRouter.revalidate());
    await waitForClientRoute(page);
    await expect(summary).toHaveAttribute("data-revalidation-identity", "retained");
    await expect(summary.getByRole("link", { name: messages.first_new_reply, exact: true })).toHaveAttribute("href", `#c-${f.a[0]}`);
    await visibleTarget(page, f.a.at(-1)!);
    await page.locator("#replies").evaluate(element => element.scrollIntoView({ block: "start" }));
    await shot(page, `after-new-${width}`);
    await summary.getByRole("link").click();
    await visibleTarget(page, f.a[0]);
    await page.locator(`#c-${f.rootB}`).getByRole("button", { name: messages.insightful_give, exact: true }).click();
    await waitForClientRoute(page);
    await expect(badges).toHaveCount(newIds.length);
    await page.locator(`#c-${f.rootB}`).getByRole("link", { name: messages.reply_to_button, exact: true }).click();
    await expect(badges).toHaveCount(newIds.length);
    await page.getByRole("link", { name: messages.reply_target_clear, exact: true }).click();
    await expect(badges).toHaveCount(newIds.length);
    // Client navigation preserves the original new-ID set while the visible
    // filtered sequence stays chronological and removes withheld placeholders.
    await page.evaluate(() => {
      const router = (window as unknown as { __reactRouterDataRouter: { navigate: (url: string) => Promise<void> } }).__reactRouterDataRouter;
      return router.navigate(`${location.pathname}?tag=agree`);
    });
    await waitForClientRoute(page);
    await expect(page.locator("[data-reply-branch]")).toHaveCount(0);
    await expect.poll(() => page.locator("[data-reply-list] article").evaluateAll(nodes => nodes.map(node => Number(node.id.slice(2))))).toEqual([...f.chronological, f.hiddenChild, f.deletedChild]);
    await expect(badges).toHaveCount(newIds.length);
    await noOverflow(page);
    await page.reload();
    await waitForClientRoute(page);
    await expect(badges).toHaveCount(0);
  }
});

test("shows a posted reply inside a long branch and excludes one's own reply from the new markers", async ({ page }) => {
  const f = fixture();
  await useMember(page, "twig_post@example.com");
  await page.goto(`/t/${f.topicId}?reply_to=c-${f.rootA}#reply`);
  await waitForClientRoute(page);
  const messages = await uiMessages(page);
  await waitForFormReady(page.locator("#reply form"));
  await page.getByLabel(messages.field_body, { exact: true }).fill("Posted inside branch A");
  await page.getByRole("button", { name: messages.submit_reply, exact: true }).click();
  await expect(page.getByText("Posted inside branch A", { exact: true })).toBeVisible();
  const id = Number(new URL(page.url()).hash.slice(3));
  expect(new URL(page.url()).searchParams.get("posted")).toBe(String(id));
  await visibleTarget(page, id);
  await expect(tail(page, f.rootA)).toHaveJSProperty("open", true);
  await expect(page.locator(`#c-${id}[data-new-reply]`)).toHaveCount(0);
});

test("native branch tails work without JavaScript and query targets are open in server HTML", async ({ browser }) => {
  const f = fixture();
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  try {
    await useMember(page, "twig_nojs@example.com");
    await page.goto(`/t/${f.topicId}`);
    await expect(tail(page, f.rootA)).toHaveJSProperty("open", false);
    await tail(page, f.rootA).locator(":scope > summary").click();
    await expect(page.locator(`#c-${f.a.at(-1)}`)).toBeVisible();
    await expect(page.locator("[data-new-reply], [data-new-replies]")).toHaveCount(0);
    for (const query of [`reply_to=c-${f.a.at(-1)}`, `posted=${f.a.at(-1)}`]) {
      await page.goto(`/t/${f.topicId}?${query}`);
      await expect(tail(page, f.rootA)).toHaveJSProperty("open", true);
      await expect(page.locator(`#c-${f.a.at(-1)}`)).toBeVisible();
    }
  } finally { await context.close(); }
});

test("retains native open and closed choices made before hydration", async ({ page }) => {
  const f = fixture();
  await useMember(page, "twig_early@example.com");
  for (const initiallyOpen of [false, true]) {
    await beforeHydration(page, `/t/${f.topicId}${initiallyOpen ? `?reply_to=c-${f.a.at(-1)}#c-${f.a.at(-1)}` : ""}`, async () => {
      await tail(page, f.rootA).locator(":scope > summary").click();
      await expect(tail(page, f.rootA)).toHaveJSProperty("open", !initiallyOpen);
    });
    await waitForClientRoute(page);
    await expect(tail(page, f.rootA)).toHaveJSProperty("open", !initiallyOpen);
  }
});

test("public readers can open branch tails without revealing withheld content or member controls", async ({ browser }) => {
  const f = fixture();
  for (const javaScriptEnabled of [true, false]) {
    const context = await browser.newContext({ javaScriptEnabled, viewport: { width: 390, height: 900 } });
    const page = await context.newPage();
    try {
      const response = await page.goto(`/t/${f.topicId}${javaScriptEnabled ? `#c-${f.a.at(-1)}` : ""}`);
      expect(response?.status()).toBe(200);
      if (javaScriptEnabled) await waitForClientRoute(page);
      const messages = await uiMessages(page);
      if (!javaScriptEnabled) await tail(page, f.rootA).locator(":scope > summary").click();
      await expect(page.locator(`#c-${f.a.at(-1)}`)).toBeVisible();
      await expect(page.locator(`#c-${f.hiddenRoot}`)).toHaveText(messages.entry_hidden_placeholder);
      await expect(page.locator(`#c-${f.deletedRoot}`)).toHaveText(messages.entry_deleted_placeholder);
      await expect(page.locator("#replies")).not.toContainText("HIDDEN_BRANCH_BODY");
      await expect(page.locator("#replies")).not.toContainText("DELETED_BRANCH_BODY");
      await expect(page.getByRole("link", { name: messages.reply_to_button, exact: true })).toHaveCount(0);
      await expect(page.locator("#reply form")).toHaveCount(0);
      await noOverflow(page);
    } finally { await context.close(); }
  }
});
