import sharp from "sharp";
import { expect, type Page } from "@playwright/test";
import { richEditorTest as test } from "./editor-fixture";
import { captureScreenshot, chooseEditorMode, enMessages as en, useMember, waitForFormReady } from "./helpers";

const source = Array.from({ length: 65 }, (_, i) => `Line ${String(i).padStart(2, "0")}.`).join("\n\n");
const body = (page: Page) => page.locator('textarea[name="body"]');
const rich = (page: Page) => page.locator('[contenteditable="true"][role="textbox"]');
let png: Buffer;
test.beforeAll(async () => { png = await sharp({ create: { width: 1200, height: 480, channels: 3, background: "steelblue" } }).png().toBuffer(); });

for (const mode of ["markdown", "rich"] as const) for (const action of ["paste", "drop", "picker", "narrow"] as const) {
  test(`${mode} ${action} upload keeps the image, selection and writing position visible`, async ({ page }) => {
    const lineNumber = action === "narrow" ? 64 : 40;
    const lineText = `Line ${lineNumber}.`;
    const cursor = source.indexOf(lineText) + lineText.length;
    await page.setViewportSize({ width: action === "narrow" ? 390 : 1280, height: 800 });
    await useMember(page, `writing_${mode}_${action}@example.com`, "/t/new");
    await waitForFormReady(page.locator("form", { has: body(page) }));
    await chooseEditorMode(page, en.editor_mode_markdown);
    await expect(page.getByRole("button", { name: en.media_insert, exact: true })).toBeVisible();
    await body(page).fill(source);
    if (mode === "rich") {
      await chooseEditorMode(page, en.editor_mode_rich);
      const line = rich(page).locator("p").filter({ hasText: lineText });
      await line.click();
      await page.keyboard.press("End");
      await line.evaluate(element => element.scrollIntoView({ block: "center" }));
    } else {
      await body(page).evaluate((field: HTMLTextAreaElement, { cursor, lineNumber }) => {
        field.focus(); field.setSelectionRange(cursor, cursor);
        window.scrollTo(0, field.getBoundingClientRect().top + window.scrollY + 2 * lineNumber * parseFloat(getComputedStyle(field).lineHeight) - 300);
      }, { cursor, lineNumber });
    }
    const before = await page.evaluate(() => window.scrollY);
    expect(before).toBeGreaterThan(500);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    await page.route("**/media", async route => { const response = await route.fetch(); await gate; await route.fulfill({ response }); });
    try {
      if (action === "picker") {
        const chooser = page.waitForEvent("filechooser");
        await page.getByRole("button", { name: en.media_insert, exact: true }).click();
        await (await chooser).setFiles({ name: "diagram.png", mimeType: "image/png", buffer: png });
      } else {
        await (mode === "rich" ? rich(page) : body(page)).evaluate((element, { bytes, drop }) => {
          const transfer = new DataTransfer();
          transfer.items.add(new File([Uint8Array.from(atob(bytes), c => c.charCodeAt(0))], "diagram.png", { type: "image/png" }));
          element.dispatchEvent(drop ? new DragEvent("drop", { dataTransfer: transfer, bubbles: true, cancelable: true }) : new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }));
        }, { bytes: png.toString("base64"), drop: action === "drop" });
      }
      const uploading = await page.evaluate(() => window.scrollY);
      await expect(page.getByRole("status").filter({ hasText: en.media_uploading })).toHaveCount(1);
      expect(Math.abs(await page.evaluate(() => window.scrollY) - uploading)).toBeLessThan(50);
      if (action !== "picker") expect(Math.abs(uploading - before)).toBeLessThan(50);
      release();
      await expect(body(page)).toHaveValue(/!\[/);
      if (mode === "rich") {
        const image = rich(page).locator("img[src]");
        await expect.poll(() => image.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
        await expect(image).toBeInViewport();
        const alt = page.getByRole("textbox", { name: en.media_alt_placeholder, exact: true });
        await expect(alt).toBeFocused();
        await expect(alt).toBeInViewport({ ratio: 1 });
        expect(await rich(page).locator("p").nth(lineNumber).textContent()).toBe(lineText);
        await expect(rich(page).locator("p").nth(lineNumber + 1).locator("img[src]")).toHaveCount(1);
        await alt.fill("A diagram at the cursor");
        await captureScreenshot(page, { path: `rich-${action}.png`, fullPage: false }, "writing-media-scroll");
        await alt.press("Enter");
        await expect(rich(page)).toBeFocused();
        await expect(image).toBeInViewport();
      } else {
        await expect(body(page)).toBeFocused();
        const selection = await body(page).evaluate((field: HTMLTextAreaElement) => ({ start: field.selectionStart, end: field.selectionEnd, text: field.value.slice(field.selectionStart, field.selectionEnd), top: field.getBoundingClientRect().top + parseFloat(getComputedStyle(field).paddingTop) + field.value.slice(0, field.selectionStart).split("\n").length * parseFloat(getComputedStyle(field).lineHeight) }));
        expect(selection.start).toBe(cursor + 2);
        expect(selection.text).toBe(en.media_alt_placeholder);
        expect(selection.top).toBeGreaterThan(0);
        expect(selection.top).toBeLessThan(800);
        await page.keyboard.insertText("A diagram at the cursor");
        expect(await body(page).inputValue()).toContain(`${lineText}![A diagram at the cursor](/media/`);
        if (lineNumber < 64) await expect(body(page)).toHaveValue(/\)\n\nLine 41\./);
        await captureScreenshot(page, { path: `markdown-${action}.png`, fullPage: false }, "writing-media-scroll");
      }
      expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(before - 80);
      if (mode === "rich" && action === "narrow") {
        const image = rich(page).locator("img[src]");
        const alt = page.getByRole("textbox", { name: en.media_alt_placeholder, exact: true });
        await image.click();
        await expect(alt).toBeVisible();
        await expect(alt).not.toBeFocused();
        await page.evaluate(() => window.scrollBy(0, -650));
        await expect(image).not.toBeInViewport();
        const scrolled = await page.evaluate(() => window.scrollY);
        const resized = await page.evaluate(async () => {
          window.visualViewport!.dispatchEvent(new Event("resize"));
          await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
          return window.scrollY;
        });
        expect(resized).toBe(scrolled);
        await alt.evaluate((input: HTMLInputElement) => input.focus({ preventScroll: true }));
        await expect(alt).toBeFocused();
        await page.evaluate(() => window.visualViewport!.dispatchEvent(new Event("resize")));
        await expect(image).toBeInViewport();
        await expect(alt).toBeInViewport({ ratio: 1 });
        await captureScreenshot(page, { path: "rich-narrow-viewport.png", fullPage: false }, "writing-media-scroll");
      }
    } finally { release(); await page.unrouteAll({ behavior: "wait" }); }
  });
}
