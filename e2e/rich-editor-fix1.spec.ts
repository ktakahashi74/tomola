import fs from "node:fs";
import path from "node:path";
import { expect, type Browser, type Page } from "@playwright/test";
import { richEditorTest as test } from "./editor-fixture";
import { captureScreenshot, useMember, clientHeaders, enMessages as en, jaMessages as ja, state, waitForFormReady, chooseEditorMode } from "./helpers";

const rich = (page: Page) => page.locator('[contenteditable="true"][role="textbox"]');
const body = (page: Page) => page.locator('textarea[name="body"]');
const tool = (page: Page, label: string) => page.getByRole("toolbar").getByRole("button", { name: label, exact: true });

async function member(browser: Browser, name: string, index: number, japanese = false) {
  const context = await browser.newContext({ locale: japanese ? "ja-JP" : "en-US", extraHTTPHeaders: clientHeaders(`10.78.1.${index}`) });
  const page = await context.newPage();
  const invitations = JSON.parse(fs.readFileSync(path.join(state().dir, "rich-editor.json"), "utf8")).invitations;
  const invitation = invitations[`fix1_${name}`];
  await useMember(page, invitation.email, "/t/new");
  await waitForFormReady(page.locator("form", { has: body(page) }));
  return { context, page };
}

test("Japanese compose controls show active formats and keep both editor frames aligned", async ({ browser }) => {
  const { context, page } = await member(browser, "layout", 5, true);
  const directory = path.join(process.cwd(), ".data/rich-editor/screenshots-fix1");
  fs.mkdirSync(directory, { recursive: true });
  try {
    for (const width of [1366, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/t/new");
      await waitForFormReady(page.locator("form", { has: body(page) }));
      await chooseEditorMode(page, ja.editor_mode_markdown);
      await body(page).fill("本文の見本");
      const nativeFrame = (await body(page).boundingBox())!;
      const title = (await page.locator('input[name="title"]').boundingBox())!;
      expect(nativeFrame.width).toBeCloseTo(title.width, 0);
      // Editing modes stay available beside the body while language settings are folded.
      await expect(page.locator("[data-post-settings]")).toHaveJSProperty("open", false);
      await expect(page.getByRole("group", { name: ja.editor_mode_label, exact: true })).toBeVisible();
      await page.getByRole("button", { name: ja.preview, exact: true }).click();
      const preview = page.getByRole("button", { name: ja.preview, exact: true }).locator("..").locator(".longread");
      await expect(preview).toBeVisible();
      await captureScreenshot(page, { path: path.join(directory, `new-markdown-${width}.png`), fullPage: true }, "e2e-rich-editor-fix1");
      await chooseEditorMode(page, ja.editor_mode_rich);
      await expect(rich(page)).toBeVisible();
      await expect(page.getByText(ja.writing_tips, { exact: true })).toBeHidden();
      await expect(page.getByRole("button", { name: ja.preview, exact: true })).toBeHidden();
      await expect(preview).toBeHidden();
      await expect(tool(page, ja.media_insert)).toBeVisible();
      const frame = (await page.locator(".rich-text-editor-frame").boundingBox())!;
      expect(frame.x).toBeCloseTo(nativeFrame.x, 0);
      expect(frame.width).toBeCloseTo(nativeFrame.width, 0);
      await expect(tool(page, ja.editor_heading)).toHaveText(ja.editor_heading);
      // On a narrow screen the toolbar is five tools and "…" (heading, list, bold, link, image); the rest open from "…". From the small breakpoint up, every tool is in the row.
      expect(await page.getByRole("toolbar").getByRole("button").allTextContents()).toEqual(width < 640
        ? [ja.editor_heading, "", "", "", "", ""]
        : [ja.editor_heading, ja.editor_subheading, "", "", "", "", "", "", "", "", "", ""]);
      if (width < 640) await page.getByRole("button", { name: ja.editor_more, exact: true }).click();
      await expect(tool(page, ja.editor_undo)).toBeDisabled();
      await expect(tool(page, ja.editor_redo)).toBeDisabled();
      await expect(tool(page, ja.editor_subheading)).toHaveText(ja.editor_subheading);
      await captureScreenshot(page, { path: path.join(directory, `new-rich-${width}.png`), fullPage: true }, "e2e-rich-editor-fix1");
      await rich(page).click();
      await page.keyboard.press("Control+End");
      const inactive = await tool(page, ja.editor_bold).evaluate(element => {
        const style = getComputedStyle(element);
        return { background: style.backgroundColor, shadow: style.boxShadow };
      });
      await tool(page, ja.editor_heading).click();
      await tool(page, ja.editor_bold).click();
      await expect(tool(page, ja.editor_heading)).toHaveAttribute("aria-pressed", "true");
      await expect(tool(page, ja.editor_bold)).toHaveAttribute("aria-pressed", "true");
      await page.keyboard.type(" 追加の文字");
      await expect(rich(page).locator("h2 strong")).toContainText("追加の文字");
      await expect(tool(page, ja.editor_undo)).toBeEnabled();
      const active = await tool(page, ja.editor_bold).evaluate(element => {
        const style = getComputedStyle(element);
        return { background: style.backgroundColor, shadow: style.boxShadow };
      });
      expect(active.background).not.toBe(inactive.background);
      expect(active.shadow).not.toBe(inactive.shadow);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      await captureScreenshot(page, { path: path.join(directory, `new-active-${width}.png`), fullPage: true }, "e2e-rich-editor-fix1");
      await tool(page, ja.editor_heading).click();
      await expect(rich(page).locator("h2")).toHaveCount(0);
      await expect(tool(page, ja.editor_heading)).toHaveAttribute("aria-pressed", "false");
      await tool(page, ja.editor_undo).click();
      await expect(tool(page, ja.editor_redo)).toBeEnabled();
      await chooseEditorMode(page, ja.editor_mode_markdown);
      await expect(page.getByText(ja.writing_tips, { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: ja.preview, exact: true })).toBeVisible();
      await expect(page.locator("[data-media-insert]")).toBeVisible();
    }
  } finally { await context.close(); }
});

for (const [index, name, label, selector] of [
  [1, "bold", en.editor_bold, "strong"],
  [2, "italic", en.editor_italic, "em"],
  [3, "heading", en.editor_heading, "h2"],
  [4, "list", en.editor_bullet_list, "ul li"],
] as const) {
  test(`${name}: immediate typing after formatting preserves the selected text`, async ({ browser }) => {
    const { context, page } = await member(browser, name, index);
    try {
      await chooseEditorMode(page, en.editor_mode_rich);
      await expect(rich(page)).toBeVisible();
      await rich(page).focus();
      await page.keyboard.type("abc def ghi");
      for (let i = 0; i < 3; i++) await page.keyboard.press("Shift+ArrowLeft");
      await tool(page, label).click();
      // Deliberately issue keys immediately; assertions would hide the race.
      await page.keyboard.press("End");
      await page.keyboard.press("Enter");
      await page.keyboard.type("next");
      await expect(rich(page)).toContainText("abc def ghi");
      await expect(rich(page)).toContainText("next");
      await expect(rich(page).locator(selector).first()).toContainText("ghi");
      await expect(body(page)).toHaveValue(/ghi[\s\S]*next/);
    } finally { await context.close(); }
  });
}
