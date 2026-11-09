import { expect, type Page } from "@playwright/test";
import { test } from "./editor-fixture";
import { captureScreenshot, enMessages, jaMessages, useMember, waitForFormReady } from "./helpers";

const body = (page: Page) => page.locator('textarea[name="body"]');
const source = "A **bold** paragraph.\n\nSecond paragraph.\n";

for (const locale of ["en", "ja"] as const) {
  test.describe(locale, () => {
    test.use({ locale: locale === "ja" ? "ja-JP" : "en-US" });
    for (const surface of ["new", "edit", "draft"] as const) {
      test(`${surface}: editor modes stay beside the body with settings closed`, async ({ page }) => {
        const messages = locale === "ja" ? jaMessages : enMessages;
        await useMember(page, `editor_switch_${surface}_${locale}@example.com`, "/t/new");
        const form = page.locator("form", { has: body(page) });
        await waitForFormReady(form);
        const modes = page.getByRole("group", { name: messages.editor_mode_label, exact: true });
        const markdown = modes.getByRole("button", { name: messages.editor_mode_markdown, exact: true });
        const visual = modes.getByRole("button", { name: messages.editor_mode_rich, exact: true });
        await markdown.click();
        await body(page).fill(source);

        if (surface === "edit") {
          await page.locator('input[name="title"]').fill(`Editor modes ${locale}`);
          await page.getByRole("button", { name: messages.submit_post, exact: true }).click();
          await expect(page).toHaveURL(/\/t\/\d+(?:\?.*)?$/);
          await page.goto(new URL(page.url()).pathname + "/edit");
        } else if (surface === "draft") {
          await expect(page.locator("[data-draft-autosave]")).toHaveAttribute("data-draft-autosave", "saved");
          const id = await page.locator('input[name="fromDraft"]').inputValue();
          await page.goto(`/drafts/${id}`);
        }
        await waitForFormReady(form);

        for (const width of [1280, 390]) {
          await page.setViewportSize({ width, height: 844 });
          await expect(modes).toBeVisible();
          await expect(form.locator("[data-post-settings]")).toHaveJSProperty("open", false);
          expect(await modes.evaluate(element => Boolean(element.closest("details")))).toBe(false);
          await expect(form.locator("[data-editor-mode-slot]")).toHaveCount(0);
          await expect(markdown).toHaveAttribute("aria-pressed", "true");
          await expect(visual).toHaveAttribute("aria-pressed", "false");
          await expect(body(page)).toHaveValue(source);

          const modeBox = (await modes.boundingBox())!;
          const bodyBox = (await body(page).boundingBox())!;
          expect(modeBox.y + modeBox.height).toBeLessThanOrEqual(bodyBox.y);
          expect(bodyBox.y - modeBox.y - modeBox.height).toBeLessThanOrEqual(16);
          expect(modeBox.x).toBeGreaterThanOrEqual(bodyBox.x - 1);
          expect(modeBox.x + modeBox.width).toBeLessThanOrEqual(bodyBox.x + bodyBox.width + 1);
          await captureScreenshot(page, { path: `${surface}-${locale}-markdown-${width}.png`, fullPage: true }, "editor-mode-switch");

          // Keyboard selection works while the language settings stay folded.
          await visual.focus();
          await page.keyboard.press("Enter");
          const editor = page.locator('[contenteditable="true"][role="textbox"]');
          await expect(editor).toBeVisible();
          await expect(editor.locator("strong")).toHaveText("bold");
          await expect(body(page)).toHaveValue(source);
          await expect(visual).toHaveAttribute("aria-pressed", "true");
          await expect(markdown).toHaveAttribute("aria-pressed", "false");
          const richBox = (await editor.boundingBox())!;
          const switchBox = (await modes.boundingBox())!;
          const toolbarBox = (await page.getByRole("toolbar").boundingBox())!;
          expect(switchBox.y + switchBox.height).toBeLessThanOrEqual(richBox.y);
          expect(switchBox.y + switchBox.height).toBeLessThanOrEqual(toolbarBox.y);
          await editor.press("Control+End");
          await page.keyboard.insertText(" Continued.");
          await expect(editor).toContainText("Continued.");
          await captureScreenshot(page, { path: `${surface}-${locale}-rich-${width}.png`, fullPage: true }, "editor-mode-switch");

          await markdown.click();
          await expect(body(page)).toBeVisible();
          await expect(body(page)).toHaveValue(/\*\*bold\*\*[\s\S]*Continued\./);
          await expect(form.locator("[data-post-settings]")).toHaveJSProperty("open", false);
          expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
          await body(page).fill(source);
        }
      });
    }
  });
}
