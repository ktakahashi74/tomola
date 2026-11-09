import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { expect, type Browser, type Page } from "@playwright/test";
import { richEditorTest as test } from "./editor-fixture";
import { parseMediaPath } from "../app/lib/media";
import { captureScreenshot, useMember, clientHeaders, enMessages as en, jaMessages as ja, state, waitForFormReady, chooseEditorMode } from "./helpers";

const body = (page: Page) => page.locator('textarea[name="body"]');
const rich = (page: Page) => page.locator('[contenteditable="true"][role="textbox"]');
const alt = (page: Page, messages = en) => page.getByRole("textbox", { name: messages.media_alt_placeholder, exact: true });
const tool = (page: Page, label: string) => page.getByRole("toolbar").getByRole("button", { name: label, exact: true });
let png: Buffer;
test.beforeAll(async () => {
  png = await sharp({ create: { width: 2400, height: 1200, channels: 4, background: { r: 70, g: 130, b: 170, alpha: 1 } } }).png().toBuffer();
});
async function member(browser: Browser, name: string, index: number, japanese = false) {
  const context = await browser.newContext({ locale: japanese ? "ja-JP" : "en-US", extraHTTPHeaders: clientHeaders(`10.78.2.${index}`) });
  const page = await context.newPage();
  const invitation = JSON.parse(fs.readFileSync(path.join(state().dir, "rich-editor.json"), "utf8")).invitations[`images_${name}`];
  await useMember(page, invitation.email, "/t/new");
  await waitForFormReady(page.locator("form", { has: body(page) }));
  await expect(page.getByRole("button", { name: (japanese ? ja : en).media_insert, exact: true })).toBeVisible();
  return { context, page };
}
async function mode(page: Page, isRich: boolean, messages = en) {
  await chooseEditorMode(page, isRich ? messages.editor_mode_rich : messages.editor_mode_markdown);
  await expect(isRich ? rich(page) : body(page)).toBeVisible();
}
async function choose(page: Page, messages = en, buffer = png, name = "diagram.png", mimeType = "image/png") {
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: messages.media_insert, exact: true }).click();
  await (await chooser).setFiles({ name, mimeType, buffer });
}
async function publish(page: Page, title: string, messages = en) {
  await page.locator('input[name="title"]').fill(title);
  await page.getByRole("button", { name: messages.submit_post, exact: true }).click();
  await expect(page).toHaveURL(/\/t\/\d+(?:\?.*)?$/);
}
async function paste(page: Page, html: string, text = "") {
  await rich(page).focus();
  await rich(page).evaluate((element, { html, text }) => {
    const data = new DataTransfer();
    if (html) data.setData("text/html", html);
    data.setData("text/plain", text);
    element.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  }, { html, text });
}

test("Japanese image insertion, alt editing and mode switching publish the same local image at both widths", async ({ browser }) => {
  const { context, page } = await member(browser, "button", 1, true);
  const directory = path.join(process.cwd(), ".data/rich-editor/screenshots-images");
  fs.mkdirSync(directory, { recursive: true });
  try {
    for (const width of [1366, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await mode(page, false, ja); await body(page).fill("画像の前。\n\n画像の後。"); await mode(page, true, ja);
      await choose(page, ja);
      await expect(alt(page, ja)).toBeFocused();
      await expect(alt(page, ja)).toHaveValue("");
      await expect(alt(page, ja)).toHaveAttribute("placeholder", ja.media_alt_placeholder);
      const image = rich(page).locator("img[src]");
      await expect(image).toBeVisible();
      const src = (await image.getAttribute("src"))!;
      expect(parseMediaPath(src)).not.toBeNull();
      await captureScreenshot(page, { path: path.join(directory, `inserted-${width}.png`), fullPage: true }, "e2e-rich-editor-images");
      await alt(page, ja).fill("試験用の図");
      await alt(page, ja).evaluate(element => element.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true, cancelable: true })));
      await expect(alt(page, ja)).toBeVisible();
      await alt(page, ja).evaluate(element => element.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", keyCode: 229, bubbles: true, cancelable: true })));
      await expect(alt(page, ja)).toBeVisible();
      await alt(page, ja).press("Enter");
      await expect(alt(page, ja)).toHaveCount(0);
      await expect(image).toHaveAttribute("alt", "試験用の図");
      await captureScreenshot(page, { path: path.join(directory, `described-${width}.png`), fullPage: true }, "e2e-rich-editor-images");
      await image.click();
      await expect(image).toHaveClass(/ProseMirror-selectednode/);
      await expect(alt(page, ja)).toHaveValue("試験用の図");
      await captureScreenshot(page, { path: path.join(directory, `selected-${width}.png`), fullPage: true }, "e2e-rich-editor-images");
      const box = (await image.boundingBox())!, frame = (await page.locator(".rich-text-editor-frame").boundingBox())!;
      expect(box.x + box.width).toBeLessThanOrEqual(frame.x + frame.width);
      expect(box.width / box.height).toBeCloseTo(2);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      await alt(page, ja).focus(); await alt(page, ja).press("Escape");
      await mode(page, false, ja);
      const markdown = await body(page).inputValue();
      expect(markdown).toContain(`![試験用の図](${src})`);
      await mode(page, true, ja); await expect(image).toHaveAttribute("src", src);
      await expect(body(page)).toHaveValue(markdown);
    }
    await publish(page, "見たまま編集の画像", ja);
    const posted = page.locator('[data-reading-body] img[alt="試験用の図"]').first();
    await expect(posted).toBeVisible();
    await expect.poll(() => posted.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  } finally { await context.close(); }
});

test("image-only clipboard and drop use the shared uploader; Markdown remains its receiver after switching back", async ({ browser }) => {
  const { context, page } = await member(browser, "transfer", 2);
  try {
    await mode(page, true);
    for (const event of ["paste", "drop"] as const) {
      await rich(page).focus(); await page.keyboard.press("Control+End");
      await rich(page).evaluate((element, { event, bytes }) => {
        const data = new DataTransfer(); data.items.add(new File([Uint8Array.from(atob(bytes), c => c.charCodeAt(0))], "diagram.png", { type: "image/png" }));
        element.dispatchEvent(event === "paste" ? new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }) : new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true }));
      }, { event, bytes: png.toString("base64") });
      await expect(alt(page)).toBeFocused(); await alt(page).fill(event); await alt(page).press("Enter");
      await expect(rich(page).locator(`img[alt="${event}"]`)).toBeVisible();
    }
    await mode(page, false);
    const before = await body(page).inputValue();
    await choose(page);
    await expect(body(page)).toHaveValue(new RegExp(`${en.media_alt_placeholder}`));
    expect(await body(page).inputValue()).toContain(before);
    await expect(rich(page)).toHaveCount(0);
  } finally { await context.close(); }
});

for (const unfocused of [false, true]) {
  test(`upload completion preserves typed text and inserts ${unfocused ? "at the end when unfocused" : "after the current paragraph"}`, async ({ browser }) => {
    const { context, page } = await member(browser, unfocused ? "unfocused" : "cursor", unfocused ? 4 : 3);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    try {
      await mode(page, false); await body(page).fill("First.\n\nLast."); await mode(page, true);
      await page.route("**/media", async route => { const response = await route.fetch(); await gate; await route.fulfill({ response }); });
      await choose(page); await expect(page.getByRole("status").filter({ hasText: en.media_uploading })).toBeVisible();
      await rich(page).locator("p").first().click(); await page.keyboard.press("End"); await page.keyboard.insertText(" Typed while uploading.");
      await page.keyboard.press("Home"); await page.keyboard.press("ArrowRight");
      if (unfocused) await page.locator('input[name="title"]').focus();
      release(); await expect(alt(page)).toBeFocused();
      await expect(rich(page)).toContainText("First. Typed while uploading.");
      await expect(rich(page)).toContainText("Last.");
      expect(await rich(page).locator("p").evaluateAll(elements => elements.map(element => element.querySelector("img") ? "image" : element.textContent))).toEqual(unfocused ? ["First. Typed while uploading.", "Last.", "image"] : ["First. Typed while uploading.", "image", "Last."]);
    } finally { release?.(); await context.close(); }
  });
}

test("selected images support alt edits, empty alt, deletion and undo/redo", async ({ browser }) => {
  const { context, page } = await member(browser, "select", 5);
  try {
    await mode(page, true); await choose(page);
    await expect(alt(page)).toBeFocused(); await alt(page).fill("First description"); await alt(page).press("Enter");
    const image = rich(page).locator("img[src]");
    await image.click(); await alt(page).fill("Changed description"); await page.locator('input[name="title"]').click();
    await expect(image).toHaveAttribute("alt", "Changed description");
    await image.click(); await alt(page).fill(""); await alt(page).press("Enter");
    await expect(image).toHaveAttribute("alt", "");
    for (const key of ["Backspace", "Delete"]) {
      await image.click(); await page.keyboard.press(key);
      await expect(image).toHaveCount(0);
      await tool(page, en.editor_undo).click(); await expect(image).toBeVisible();
      await tool(page, en.editor_redo).click(); await expect(image).toHaveCount(0);
      await tool(page, en.editor_undo).click(); await expect(image).toBeVisible();
    }
  } finally { await context.close(); }
});

test("HTML and Markdown paste keep valid local images and discard external or malformed images", async ({ browser }) => {
  const { context, page } = await member(browser, "paste", 6);
  try {
    await mode(page, true); await choose(page); await expect(alt(page)).toBeFocused(); await alt(page).press("Enter");
    const src = (await rich(page).locator("img[src]").getAttribute("src"))!;
    let uploads = 0, externalReads = 0;
    page.on("request", request => { if (request.method() === "POST" && new URL(request.url()).pathname === "/media") uploads++; if (request.url().startsWith("https://outside.invalid/")) externalReads++; });
    await mode(page, false); await body(page).fill(""); await mode(page, true);
    await paste(page, `<p>HTML images</p><p><img src="${src}" alt="Local HTML"><img src="https://outside.invalid/image.png"><img src="/media/bad.webp"></p>`);
    await expect(rich(page).locator("img[src]")).toHaveCount(1);
    await expect(rich(page).locator("img[src]")).toHaveAttribute("src", src);
    await page.keyboard.press("Control+End"); await page.keyboard.press("Enter");
    await paste(page, "", `![Local Markdown](${src})\n\n![External](https://outside.invalid/image.png)\n\n![Invalid](/media/bad.webp)`);
    await expect(rich(page).locator("img[src]")).toHaveCount(2);
    await expect(body(page)).toHaveValue(/Local Markdown/);
    await mode(page, false); await body(page).fill("Before paste.\n\nAfter paste."); await mode(page, true);
    await rich(page).locator("p").first().click(); await page.keyboard.press("End"); await page.keyboard.press("Enter");
    await paste(page, "", `![Local Markdown](${src})\n\n  \n`);
    await expect(rich(page).locator(":scope > p")).toHaveCount(3);
    await expect(rich(page).locator(":scope > p").nth(1).locator("img[src]")).toHaveAttribute("src", src);
    await expect(body(page)).not.toHaveValue(/<br\b/i);
    expect(uploads).toBe(0); expect(externalReads).toBe(0);
  } finally { await context.close(); }
});

test("image topic editing preserves untouched source byte for byte and keeps its image after one text edit", async ({ browser }) => {
  const { context, page } = await member(browser, "edit", 7);
  try {
    await mode(page, false); await choose(page); await expect(body(page)).toHaveValue(/!\[/);
    const imageSource = await body(page).inputValue();
    const source = `First paragraph.\n\n${imageSource}\n\nLast paragraph.\n\n`;
    await body(page).fill(source); await publish(page, "Image source preservation");
    const editUrl = new URL(page.url()).pathname + "/edit";
    await page.goto(editUrl); await waitForFormReady(page.locator("form", { has: body(page) })); await mode(page, true);
    await expect(rich(page).locator("img[src]")).toBeVisible(); await expect(body(page)).toHaveValue(source);
    await page.getByRole("button", { name: en.save_changes, exact: true }).click(); await expect(page).not.toHaveURL(/\/edit$/);
    await page.goto(editUrl); await expect(rich(page)).toBeVisible(); await expect(body(page)).toHaveValue(source);
    await rich(page).locator("p").first().click(); await page.keyboard.press("Home"); await page.keyboard.insertText("Edited ");
    await expect(body(page)).toHaveValue(/Edited First paragraph/);
    expect(await body(page).inputValue()).toContain(imageSource);
    await page.getByRole("button", { name: en.save_changes, exact: true }).click(); await expect(page).not.toHaveURL(/\/edit$/);
    await expect(page.locator('[data-reading-body] img')).toBeVisible();
    expect(await (await page.request.get(`${new URL(page.url()).pathname}.md`)).text()).not.toMatch(/<br\b/i);
  } finally { await context.close(); }
});

test("an unsupported file displays the shared error without changing rich content", async ({ browser }) => {
  const { context, page } = await member(browser, "error", 8);
  try {
    await mode(page, false); await body(page).fill("Unchanged prose."); await mode(page, true);
    const original = await body(page).inputValue();
    await choose(page, en, Buffer.from("not an image"), "invalid.gif", "image/gif");
    await expect(page.getByRole("alert")).toHaveText(en.media_error_type);
    await expect(body(page)).toHaveValue(original); await expect(rich(page).locator("img[src]")).toHaveCount(0);
  } finally { await context.close(); }
});
