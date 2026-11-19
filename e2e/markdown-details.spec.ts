import { expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { test } from "./editor-fixture";
import { enMessages as en, useMember, titleField, waitForFormReady, waitForClientRoute, chooseEditorMode, state } from "./helpers";

const body = (page: Page) => page.locator('textarea[name="body"]');
const rich = (page: Page) => page.locator('[contenteditable="true"][role="textbox"]');
const source = "## Start\n\n::::details[**Proof** and $x^2$]\n\nAn enclosed reference[^n].\n\n:::details[Inner]\n\n## Enclosed target\n\nInside.\n\n:::\n\n::::\n\n## End\n\n[^n]: A note.";
const longSource = "Before.\n\n:::details[Supplement]\n\n## Enclosed target\n\nInside.\n\n:::\n\n## Continue\n\n" + Array.from({ length: 30 }, (_, index) => `Reading paragraph ${index + 1}.`).join("\n\n");

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

test("rich clipboard preserves a cut block and external plain Markdown", async ({ page }) => {
  await useMember(page, "details_clipboard@example.com");
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  const blockSource = "::::details[**Outer**]\n\nA  line.\n\n:::details[Inner]\nBody\n:::\n\n::::";
  const text = blockSource + "\n\nAfter";
  await compose(page, text);
  await chooseEditorMode(page, en.editor_mode_rich);
  const block = rich(page).locator("[data-details-source]");
  await expect(block).toHaveCount(1);
  await block.click();
  await expect(block).toHaveClass(/ProseMirror-selectednode/);
  await page.keyboard.press("Control+x");
  await expect(block).toHaveCount(0);
  await rich(page).locator(":scope > p").last().click();
  await page.keyboard.press("Home");
  await page.keyboard.press("Control+v");
  await expect(block).toHaveCount(1);
  await expect(block.locator("pre")).toHaveText(blockSource);
  await chooseEditorMode(page, en.editor_mode_markdown);
  expect((await body(page).inputValue()).trimEnd()).toBe(text);

  await body(page).fill("After");
  await chooseEditorMode(page, en.editor_mode_rich);
  await expect(rich(page)).toBeVisible();
  await rich(page).locator(":scope > p").last().click();
  await page.keyboard.press("Home");
  await page.evaluate(text => navigator.clipboard.writeText(text), blockSource + "\n\n");
  await page.keyboard.press("Control+v");
  await expect(block).toHaveCount(1);
  await expect(block.locator("pre")).toHaveText(blockSource);
  await chooseEditorMode(page, en.editor_mode_markdown);
  expect((await body(page).inputValue()).trimEnd()).toBe(text);
});

async function leaveFragmentBehind(page: Page) {
  const article = page.locator("[data-reading-body]").first();
  const hidden = article.getByRole("heading", { name: "Enclosed target", includeHidden: true });
  const id = await hidden.getAttribute("id");
  await page.evaluate(id => { location.hash = id!; }, id);
  await expect(hidden).toBeFocused();
  await article.locator("p").last().evaluate(node => {
    node.tabIndex = 0;
    node.scrollIntoView({ block: "center" });
    node.focus({ preventScroll: true });
  });
  return { article, hidden, scroll: await page.evaluate(() => scrollY) };
}

test("switching translations keeps the reading position and leaves closed destinations alone", async ({ page }) => {
  await useMember(page, "details_switch@example.com");
  await publish(page, longSource);
  const url = new URL(page.url());
  url.searchParams.set("lang", "fr");
  await page.goto(url.href);
  const article = page.locator("[data-reading-body]").first();
  await expect(article).toHaveAttribute("lang", "fr", { timeout: 45_000 });
  const { hidden, scroll } = await leaveFragmentBehind(page);
  await page.getByRole("link", { name: en.show_original, exact: true }).evaluate(node => (node as HTMLElement).click());
  await expect(article).toHaveAttribute("lang", "en");
  await expect(article.locator("details")).not.toHaveAttribute("open");
  await expect(hidden).not.toBeFocused();
  expect(Math.abs(await page.evaluate(() => scrollY) - scroll)).toBeLessThan(25);
  await page.locator('details.reading-lang-menu a[hreflang="fr"]').first().evaluate(node => (node as HTMLElement).click());
  await expect(article).toHaveAttribute("lang", "fr");
  await expect(article.locator("details")).not.toHaveAttribute("open");
  await expect(hidden).not.toBeFocused();
  expect(Math.abs(await page.evaluate(() => scrollY) - scroll)).toBeLessThan(25);

  // A destination with no closed ancestor needs no custom scroll or focus.
  await article.locator("p").last().evaluate(node => { node.tabIndex = 0; node.focus({ preventScroll: true }); });
  await page.evaluate(() => {
    const heading = document.querySelector('[data-reading-body] > h2')!;
    history.replaceState(history.state, "", `#${heading.id}`);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
  await expect(article.locator("p").last()).toBeFocused();
  expect(Math.abs(await page.evaluate(() => scrollY) - scroll)).toBeLessThan(25);
});

test("an arriving translation does not reopen an old fragment or move focus back", async ({ page }) => {
  await useMember(page, "details_arrival@example.com");
  const hold = path.join(state().dir, "fake-body-translation-hold");
  fs.writeFileSync(hold, longSource);
  try {
    await publish(page, longSource);
    const url = new URL(page.url());
    url.searchParams.delete("posted");
    url.searchParams.set("lang", "fr");
    await page.goto(url.href);
    const article = page.locator("[data-reading-body]").first();
    await expect(article).toHaveAttribute("lang", "en");
    await expect(page.locator("[data-article-translation-waiting]")).toBeVisible();
    const { hidden, scroll } = await leaveFragmentBehind(page);
    const control = page.locator("[data-member-menu-trigger]");
    await control.evaluate(node => (node as HTMLElement).focus({ preventScroll: true }));
    fs.unlinkSync(hold);
    await expect(article).toHaveAttribute("lang", "fr", { timeout: 45_000 });
    await expect(article.locator("details")).not.toHaveAttribute("open");
    await expect(hidden).not.toBeFocused();
    await expect(control).toBeFocused();
    expect(Math.abs(await page.evaluate(() => scrollY) - scroll)).toBeLessThan(25);
  } finally { if (fs.existsSync(hold)) fs.unlinkSync(hold); }
});

test("writing warns about literal containers without eagerly fetching the grammar", async ({ page }) => {
  await useMember(page, "details_notice@example.com");
  await compose(page, "Ordinary text");
  expect(await page.evaluate(() => performance.getEntriesByType("resource").some(entry => /markdown-rules-|rich-text-editor\.client-/.test(entry.name)))).toBe(false);
  await body(page).fill(":::details[Unclosed]\nBody");
  await expect(page.getByRole("status").filter({ hasText: en.draft_details_unclosed })).toContainText("1");
  await body(page).fill(":::details[Closed]\nBody\n:::");
  await expect(page.getByRole("status").filter({ hasText: en.draft_details_unclosed })).toHaveCount(0);
  await body(page).fill(":::details[Title[^1]]\nBody\n:::\n\n[^1]: Note.");
  await expect(page.getByRole("status").filter({ hasText: "a footnote reference in a summary" })).toContainText("Line 1");
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
