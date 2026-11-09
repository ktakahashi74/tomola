import { expect, type Browser, type Page } from "@playwright/test";
import { richEditorTest as test } from "./editor-fixture";
import { captureScreenshot, chooseEditorMode, clientHeaders, enMessages as en, jaMessages as ja, titleField, useMember, waitForFormReady } from "./helpers";

const rich = (page: Page) => page.locator('[contenteditable="true"][role="textbox"]');
const body = (page: Page) => page.locator('textarea[name="body"]');
const tool = (page: Page, label: string) => page.getByRole("toolbar").getByRole("button", { name: label, exact: true });

async function member(browser: Browser, scenario: string, index: number) {
  const context = await browser.newContext({ locale: scenario === "mobile" ? "ja-JP" : "en-US", extraHTTPHeaders: clientHeaders(`10.78.5.${index}`) });
  const page = await context.newPage();
  await useMember(page, `rich_table_${scenario}@example.com`, "/t/new");
  await waitForFormReady(page.locator("form", { has: body(page) }));
  await expect(rich(page)).toBeVisible();
  return { context, page };
}

async function selectedCell(page: Page) {
  return rich(page).evaluate(element => {
    const anchor = window.getSelection()?.anchorNode;
    const cell = (anchor instanceof Element ? anchor : anchor?.parentElement)?.closest<HTMLTableCellElement>("th, td");
    if (!cell || !element.contains(cell)) return null;
    return [(cell.parentElement as HTMLTableRowElement).rowIndex, cell.cellIndex];
  });
}

test("inserts a table at the cursor, moves between cells and saves GFM through reopening", async ({ browser }) => {
  const { context, page } = await member(browser, "create", 1);
  try {
    await rich(page).fill("Before after");
    await page.keyboard.press("Home");
    for (let i = 0; i < "Before ".length; i++) await page.keyboard.press("ArrowRight");
    await tool(page, en.editor_table).click();
    await expect(rich(page).locator("tr")).toHaveCount(3);
    await expect(rich(page).locator("th")).toHaveCount(3);
    await expect(rich(page).locator("td")).toHaveCount(6);
    await expect.poll(() => selectedCell(page)).toEqual([0, 0]);
    await page.keyboard.type("Item");
    await page.keyboard.press("Tab");
    await expect.poll(() => selectedCell(page)).toEqual([0, 1]);
    await page.keyboard.type("Value");
    await page.keyboard.press("Shift+Tab");
    await expect.poll(() => selectedCell(page)).toEqual([0, 0]);
    for (let i = 0; i < 3; i++) await page.keyboard.press("Tab");
    await expect.poll(() => selectedCell(page)).toEqual([1, 0]);
    await page.keyboard.type("Alpha");
    await page.keyboard.press("Tab");
    await page.keyboard.type("42");
    await chooseEditorMode(page, en.editor_mode_markdown);
    await expect(body(page)).toHaveValue(/Before[\s\S]*\| Item\s*\| Value\s*\|[\s\S]*\| :?-+:?[\s\S]*\| Alpha\s*\| 42\s*\|[\s\S]*after/);
    const markdown = await body(page).inputValue();
    await chooseEditorMode(page, en.editor_mode_rich);
    await titleField(page).fill("Created table round trip");
    await page.getByRole("button", { name: en.submit_post, exact: true }).click();
    await expect(page).toHaveURL(/\/t\/\d+(?:\?.*)?$/);
    await expect(page.locator("[data-reading-body]").first().locator("table")).toContainText("Alpha");
    const editUrl = new URL(page.url()).pathname + "/edit";
    await page.goto(editUrl);
    await expect(rich(page).locator("tr")).toHaveCount(3);
    await expect(rich(page).locator("th").first()).toHaveText("Item");
    await expect(body(page)).toHaveValue(markdown);
    await page.getByRole("button", { name: en.save_changes, exact: true }).click();
    await expect(page).not.toHaveURL(/\/edit$/);
    await page.goto(editUrl);
    await expect(rich(page).locator("table")).toContainText("42");
  } finally { await context.close(); }
});

test("table controls follow the cursor and add or delete the current row and column", async ({ browser }) => {
  const { context, page } = await member(browser, "structure", 2);
  try {
    const controls = [en.editor_table_add_row, en.editor_table_add_column, en.editor_table_delete_row, en.editor_table_delete_column];
    for (const label of controls) await expect(tool(page, label)).toHaveCount(0);
    await rich(page).fill("Outside");
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await tool(page, en.editor_table).click();
    for (const label of controls) await expect(tool(page, label)).toBeVisible();
    await rich(page).locator("td").nth(4).click();
    await page.keyboard.type("Keep");
    await tool(page, en.editor_table_add_row).click();
    await expect(rich(page).locator("tr")).toHaveCount(4);
    await expect(rich(page).locator("tr").nth(2)).toContainText("Keep");
    await tool(page, en.editor_table_add_column).click();
    await expect(rich(page).locator("tr").nth(2).locator("td")).toHaveCount(4);
    await rich(page).locator("tr").nth(1).locator("td").nth(2).click();
    await page.keyboard.type("Remove");
    await tool(page, en.editor_table_delete_column).click();
    await expect(rich(page).locator("tr").nth(2).locator("td")).toHaveCount(3);
    await expect(rich(page)).not.toContainText("Remove");
    await expect(rich(page)).toContainText("Keep");
    await rich(page).locator("tr").nth(1).locator("td").first().click();
    await page.keyboard.type("Delete row");
    await tool(page, en.editor_table_delete_row).click();
    await expect(rich(page).locator("tr")).toHaveCount(3);
    await expect(rich(page)).not.toContainText("Delete row");
    await expect(rich(page).locator("tr").nth(1)).toContainText("Keep");
    await rich(page).locator(":scope > p").first().click();
    for (const label of controls) await expect(tool(page, label)).toHaveCount(0);
    await rich(page).locator("th").first().click();
    await page.keyboard.type("Old heading");
    await tool(page, en.editor_table_delete_row).click();
    await expect(rich(page)).not.toContainText("Old heading");
    await expect(rich(page)).toContainText("Keep");
    await expect(rich(page).locator("tr")).toHaveCount(2);
    await expect(rich(page).locator("th")).toHaveCount(3);
    await chooseEditorMode(page, en.editor_mode_markdown);
    await expect(body(page)).toHaveValue(/\|[^\n]*Keep[^\n]*\|/);
    await chooseEditorMode(page, en.editor_mode_rich);
    await expect(rich(page).locator("th")).toHaveCount(3);
    await rich(page).locator("td").first().click();
    await page.keyboard.type("Next header");
    await rich(page).locator("th").first().click();
    await tool(page, en.editor_table_delete_row).click();
    await expect(rich(page).locator("th").first()).toHaveText("Next header");
    await expect(rich(page).locator("tr")).toHaveCount(2);
    await expect(rich(page).locator("td")).toHaveCount(3);
    // Deleting the final column removes the table, including its contextual tools.
    for (let remaining = 3; remaining > 0; remaining--) {
      await rich(page).locator("th").first().click();
      await tool(page, en.editor_table_delete_column).click();
      await expect(rich(page).locator("th")).toHaveCount(remaining - 1);
    }
    await expect(rich(page).locator("table")).toHaveCount(0);
    for (const label of controls) await expect(tool(page, label)).toHaveCount(0);
    await expect(rich(page)).toContainText("Outside");
  } finally { await context.close(); }
});

test("390px toolbar exposes table tools with keyboard access and keeps the last-cell Tab behavior", async ({ browser }) => {
  const { context, page } = await member(browser, "mobile", 3);
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(tool(page, ja.editor_table)).toBeHidden();
    await tool(page, ja.editor_more).click();
    await tool(page, ja.editor_table).focus();
    await page.keyboard.press("Enter");
    await expect.poll(() => selectedCell(page)).toEqual([0, 0]);
    // Arrow navigation uses the same toolbar focus management as the other tools.
    await tool(page, ja.editor_link).focus();
    await page.keyboard.press("ArrowRight");
    await expect(tool(page, ja.editor_table_add_row)).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(rich(page).locator("tr")).toHaveCount(4);
    await tool(page, ja.editor_table_add_column).focus();
    await page.keyboard.press("Space");
    await expect(rich(page).locator("th")).toHaveCount(4);
    await rich(page).locator("td").last().click();
    await page.keyboard.press("Tab");
    await expect(rich(page).locator("tr")).toHaveCount(4);
    await expect(rich(page).locator("th")).toHaveCount(4);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await captureScreenshot(page, { path: "table-390.png", fullPage: true }, "e2e-rich-editor-table");
    await tool(page, ja.editor_more).click();
    await expect(tool(page, ja.editor_table_add_row)).toBeHidden();
    await tool(page, ja.editor_more).click();
    await expect(tool(page, ja.editor_table_delete_row)).toBeVisible();
    await tool(page, ja.editor_table_delete_row).click();
    await expect(rich(page).locator("tr")).toHaveCount(3);
    await tool(page, ja.editor_table_delete_column).click();
    await expect(rich(page).locator("th")).toHaveCount(3);
  } finally { await context.close(); }
});
