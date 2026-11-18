import { expect, type Page } from "@playwright/test";
import { test } from "./editor-fixture";
import { enMessages as en, useMember, titleField, waitForFormReady, waitForClientRoute, chooseEditorMode } from "./helpers";

const body = (page: Page) => page.locator('textarea[name="body"]');
const rich = (page: Page) => page.locator('[contenteditable="true"][role="textbox"]');
const source = "## Start\n\n::::details[**Proof** and $x^2$]\n\nAn enclosed reference[^n].\n\n:::details[Inner]\n\n## Enclosed target\n\nInside.\n\n:::\n\n::::\n\n## End\n\n[^n]: A note.";

async function compose(page: Page, text: string) {
  await page.goto("/t/new");
  await waitForFormReady(page.locator("form", { has: body(page) }));
  await body(page).fill(text);
}

async function publish(page: Page, text: string) {
  await compose(page, text);
  await titleField(page).fill("Collapsible supplementary material");
  await page.getByRole("button", { name: en.submit_post, exact: true }).click();
  await expect(page).toHaveURL(/\/t\/\d+(?:\?.*)?$/);
  await waitForClientRoute(page);
}

test("details reveal navigation targets, restore print state and offer desktop and mobile controls", async ({ page }) => {
  await useMember(page, "details_reading@example.com");
  await publish(page, source);
  const article = page.locator("[data-reading-body]").first();
  const folds = article.locator("details");
  await expect(folds).toHaveCount(2);
  expect(await folds.evaluateAll(nodes => nodes.every(node => !(node as HTMLDetailsElement).open))).toBe(true);
  await folds.first().locator(":scope > summary").click();
  await expect(folds.first()).toHaveAttribute("open", "");
  await article.locator("a[data-footnote-ref]").click();
  await folds.first().evaluate(node => { (node as HTMLDetailsElement).open = false; });
  await article.locator("a[data-footnote-backref]").click();
  await expect(folds.first()).toHaveAttribute("open", "");
  await expect(article.locator("a[data-footnote-ref]")).toBeFocused();

  await page.getByRole("button", { name: en.details_open_all, exact: true }).click();
  expect(await folds.evaluateAll(nodes => nodes.every(node => (node as HTMLDetailsElement).open))).toBe(true);
  await page.getByRole("button", { name: en.details_close_all, exact: true }).click();
  const hidden = article.getByRole("heading", { name: "Enclosed target", includeHidden: true });
  const id = await hidden.getAttribute("id");
  const url = new URL(page.url());
  url.hash = id!;
  await page.goto(url.href);
  await expect(hidden).toBeVisible();
  await expect(hidden).toBeFocused();
  expect(await folds.evaluateAll(nodes => nodes.every(node => (node as HTMLDetailsElement).open))).toBe(true);
  await page.getByRole("button", { name: en.details_close_all, exact: true }).click();
  await page.evaluate(() => { location.hash = ""; });
  await page.evaluate(id => { location.hash = id!; }, id);
  await expect(hidden).toBeVisible();
  await expect(hidden).toBeFocused();
  await page.evaluate(() => { location.hash = ""; });
  await page.getByRole("button", { name: en.details_close_all, exact: true }).click();
  await page.goBack();
  await expect(hidden).toBeVisible();

  await folds.nth(1).locator(":scope > summary").click();
  const before = await folds.evaluateAll(nodes => nodes.map(node => (node as HTMLDetailsElement).open));
  await page.evaluate(() => window.dispatchEvent(new Event("beforeprint")));
  expect(await folds.evaluateAll(nodes => nodes.every(node => (node as HTMLDetailsElement).open))).toBe(true);
  await page.evaluate(() => window.dispatchEvent(new Event("afterprint")));
  expect(await folds.evaluateAll(nodes => nodes.map(node => (node as HTMLDetailsElement).open))).toEqual(before);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator(".reading-action-menu > summary").click();
  await page.getByRole("button", { name: en.details_open_all, exact: true }).click();
  expect(await folds.evaluateAll(nodes => nodes.every(node => (node as HTMLDetailsElement).open))).toBe(true);
});

test("rich editing preserves valid, nested, list and literal source through a round trip and adjacent edits", async ({ page }) => {
  await useMember(page, "details_editor@example.com");
  const text = "::::details[**Outer**]\n\nA  line.\n\n:::details[Inner]\nBody\n:::\n\n::::\n\n- Item\n\n  :::details[List]\n  Body\n  :::\n\n:::unknown[Literal]{open}\nOriginal *characters*.\n:::\n\nAfter";
  await compose(page, text);
  await chooseEditorMode(page, en.editor_mode_rich);
  await expect(rich(page)).toBeVisible();
  await expect(rich(page).locator("[data-details-source]")).toHaveCount(3);
  await chooseEditorMode(page, en.editor_mode_markdown);
  await expect(body(page)).toHaveValue(text);
  await chooseEditorMode(page, en.editor_mode_rich);
  await expect(rich(page)).toBeVisible();
  await expect(rich(page)).toContainText("After");
  await rich(page).locator(":scope > p").last().click();
  await page.keyboard.press("End");
  await page.keyboard.insertText("!");
  await expect(rich(page)).toContainText("After!");
  await chooseEditorMode(page, en.editor_mode_markdown);
  await expect(body(page)).toHaveValue(text + "!\n");
});

test("writing warns about literal containers without eagerly fetching the grammar", async ({ page }) => {
  await useMember(page, "details_notice@example.com");
  await compose(page, "Ordinary text");
  expect(await page.evaluate(() => performance.getEntriesByType("resource").some(entry => /markdown-rules-|rich-text-editor\.client-/.test(entry.name)))).toBe(false);
  await body(page).fill(":::details[Unclosed]\nBody");
  await expect(page.getByRole("status").filter({ hasText: en.draft_details_unclosed })).toContainText("1");
  await body(page).fill(":::details[Closed]\nBody\n:::");
  await expect(page.getByRole("status").filter({ hasText: en.draft_details_unclosed })).toHaveCount(0);
});

test("native details remain operable without JavaScript", async ({ page, browser }) => {
  await useMember(page, "details_native@example.com");
  await publish(page, source);
  const context = await browser.newContext({ javaScriptEnabled: false, storageState: await page.context().storageState() });
  try {
    const native = await context.newPage();
    await native.goto(page.url());
    const fold = native.locator("[data-reading-body] details").first();
    await expect(fold).not.toHaveAttribute("open", "");
    await fold.locator(":scope > summary").click();
    await expect(fold).toHaveAttribute("open", "");
    await expect(fold).toContainText("An enclosed reference");
  } finally { await context.close(); }
});
