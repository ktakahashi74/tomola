import { modulePath, routeModule } from "./support/module-route";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { expect, type Browser, type Page } from "@playwright/test";
import { richEditorTest as test } from "./editor-fixture";
import { EDITOR_MODE_STORAGE_KEY } from "../app/lib/rich-editor";
import { waitForClientRoute, captureScreenshot, useMember, clientHeaders, enMessages as en, jaMessages as ja, messagePattern, state, waitForFormReady, chooseEditorMode, forgetLocalDrafts } from "./helpers";

const body = (page: Page) => page.locator('textarea[name="body"]');
const rich = (page: Page) => page.locator('[contenteditable="true"][role="textbox"]');
const preference = (page: Page) => page.evaluate(key => localStorage.getItem(key), EDITOR_MODE_STORAGE_KEY);
async function member(browser: Browser, name: string, index: number, handle = `default_${name}`, japanese = false) {
  const context = await browser.newContext({ locale: japanese ? "ja-JP" : "en-US", extraHTTPHeaders: clientHeaders(`10.83.0.${index}`) });
  const page = await context.newPage();
  const invite = JSON.parse(fs.readFileSync(path.join(state().dir, "rich-editor.json"), "utf8")).invitations[name];
  await useMember(page, invite.email);
  return { page, context };
}
async function newPost(page: Page) {
  await page.goto("/t/new");
  await waitForFormReady(page.locator("form", { has: body(page) }));
}
async function publish(page: Page, title: string) {
  await page.locator('input[name="title"]').fill(title);
  await page.getByRole("button", { name: en.submit_post, exact: true }).click();
  await expect(page).toHaveURL(/\/t\/\d+(?:\?.*)?$/);
}

test("an unset preference opens new and edit routes in rich mode without rewriting untouched source", async ({ browser }) => {
  const { context, page } = await member(browser, "default", 1);
  try {
    await newPost(page); await expect(rich(page)).toBeVisible();
    expect(await preference(page)).toBeNull();
    await rich(page).pressSequentially("Unchanged source.");
    const source = await body(page).inputValue();
    await publish(page, "Default rich editor");
    const edit = new URL(page.url()).pathname + "/edit";
    await page.goto(edit); await expect(rich(page)).toBeVisible();
    await expect(body(page)).toHaveValue(source);
    expect(await preference(page)).toBeNull();
    await page.getByRole("button", { name: en.save_changes, exact: true }).click();
    await page.goto(edit); await expect(body(page)).toHaveValue(source);
    await expect(rich(page)).toBeVisible();
    // Replies remain the native Markdown editor.
    await page.goto(edit.replace(/\/edit$/, ""));
    await expect(page.locator('#reply textarea[name="body"]')).toBeVisible();
    await expect(rich(page)).toHaveCount(0);
  } finally { await context.close(); }
});

test("explicit Markdown persists and prevents optional editor requests", async ({ browser }) => {
  const { context, page } = await member(browser, "memory", 2);
  try {
    await newPost(page); await expect(rich(page)).toBeVisible();
    await chooseEditorMode(page, en.editor_mode_markdown);
    expect(await preference(page)).toBe("markdown");
    const optional: string[] = [];
    const editorModule = modulePath("app/components/rich-text-editor.client.tsx");
    page.on("request", request => { if (new URL(request.url()).pathname === editorModule) optional.push(request.url()); });
    await page.reload(); await waitForFormReady(page.locator("form", { has: body(page) }));
    await expect(body(page)).toBeVisible();
    await waitForClientRoute(page);
    expect(optional).toEqual([]);
  } finally { await context.close(); }
});

test("a math edit stays native without replacing the automatic rich preference", async ({ browser }) => {
  const { context, page } = await member(browser, "math", 3);
  try {
    await newPost(page); await expect(rich(page)).toBeVisible();
    await chooseEditorMode(page, en.editor_mode_markdown);
    const source = "Formula $x^2$ stays literal.";
    await body(page).fill(source); await publish(page, "Math fallback");
    const edit = new URL(page.url()).pathname + "/edit";
    await page.goto(edit); await waitForFormReady(page.locator("form", { has: body(page) }));
    await expect(page.getByRole("status").filter({ hasText: en.editor_mode_markdown_only })).toBeVisible();
    expect(await preference(page)).toBe("markdown");
    await page.evaluate(key => localStorage.removeItem(key), EDITOR_MODE_STORAGE_KEY);
    await page.goto(edit); await waitForFormReady(page.locator("form", { has: body(page) }));
    await expect(body(page)).toBeVisible(); await expect(body(page)).toHaveValue(source);
    await expect(page.getByRole("status").filter({ hasText: en.editor_mode_markdown_only })).toBeVisible();
    expect(await preference(page)).toBeNull();
    await newPost(page); await expect(rich(page)).toBeVisible();
    expect(await preference(page)).toBeNull();
  } finally { await context.close(); }
});

for (const [index, scenario] of ["delayed", "composition", "unfocused"].entries()) {
  const composition = scenario === "composition";
  test(`loading adopts native input: ${scenario}`, async ({ browser }) => {
    const { context, page } = await member(browser, scenario, 10 + index);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    try {
      const moduleRoute = await routeModule(page, "app/components/rich-text-editor.client.tsx", async route => { await gate; await route.continue(); });
      await newPost(page); await expect(body(page)).toBeVisible();
      await moduleRoute.assertHit();
      await body(page).fill("Typed while the module loaded.\n\nExact trailing space.  ");
      await body(page).focus();
      if (composition) await body(page).dispatchEvent("compositionstart", { data: "変換" });
      if (scenario === "unfocused") await page.locator('input[name="title"]').focus();
      const scroll = await page.evaluate(() => window.scrollY);
      release();
      if (composition) {
        await expect(page.locator(".ProseMirror")).toHaveCount(1);
        await expect(body(page)).toBeVisible(); await expect(body(page)).toBeFocused();
        await body(page).fill("Typed while composing. 確定。  ");
        await body(page).dispatchEvent("compositionend", { data: "確定" });
      }
      await expect(rich(page)).toBeVisible();
      await expect(scenario === "unfocused" ? page.locator('input[name="title"]') : rich(page)).toBeFocused();
      expect(await page.evaluate(() => window.scrollY)).toBeCloseTo(scroll, 0);
      await expect(body(page)).toHaveValue(composition ? "Typed while composing. 確定。  " : "Typed while the module loaded.\n\nExact trailing space.  ");
      if (scenario === "unfocused") await rich(page).click();
      await page.keyboard.insertText(" Continued typing.");
      await expect(rich(page)).toContainText("Continued typing.");
      await page.getByRole("toolbar").getByRole("button", { name: en.editor_undo, exact: true }).click();
      await expect(body(page)).toHaveValue(composition ? "Typed while composing. 確定。  " : "Typed while the module loaded.\n\nExact trailing space.  ");
      expect(await preference(page)).toBeNull();
    } finally { release?.(); await context.close(); }
  });
}

test("typed underscore and hyphen handles publish mention links and notify both recipients", async ({ browser }) => {
  const writer = await member(browser, "mention_writer", 6);
  const under = await member(browser, "mention_under", 7, "default_reader");
  const hyphen = await member(browser, "mention_hyphen", 8, "default-a_b");
  try {
    await newPost(writer.page); await expect(rich(writer.page)).toBeVisible();
    await rich(writer.page).pressSequentially("Hello @default_reader and @default-a_b.");
    const markdown = await body(writer.page).inputValue();
    expect(markdown).toContain("@default_reader"); expect(markdown).toContain("@default-a_b");
    await publish(writer.page, "Default editor mentions");
    await expect(writer.page.locator("[data-reading-body] a.mention").first()).toHaveText("@default_reader");
    await expect(writer.page.locator("[data-reading-body] a.mention").nth(1)).toHaveText("@default-a_b");
    for (const recipient of [under, hyphen]) {
      await recipient.page.goto("/notifications");
      await expect(recipient.page.getByRole("link", { name: messagePattern(en.notification_mention, { handle: "default_mention_writer", title: "Default editor mentions" }) })).toBeVisible();
    }
  } finally { await writer.context.close(); await under.context.close(); await hyphen.context.close(); }
});

test("Japanese default, explicit Markdown and empty image descriptions at both widths", async ({ browser }) => {
  const { context, page } = await member(browser, "screens", 9, "default_screens", true);
  const directory = path.join(process.cwd(), ".data/editor-default/screenshots");
  fs.mkdirSync(directory, { recursive: true });
  const png = await sharp({ create: { width: 600, height: 300, channels: 4, background: "#5786a1" } }).png().toBuffer();
  try {
    for (const width of [1366, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(key => localStorage.removeItem(key), EDITOR_MODE_STORAGE_KEY);
      // Leave the writer before clearing its device copy, so departure saving cannot restore the previous round.
      await page.goto("/latest"); await forgetLocalDrafts(page);
      await newPost(page); await expect(rich(page)).toBeVisible();
      await expect(page.getByRole("button", { name: ja.editor_mode_rich, exact: true })).toHaveAttribute("aria-pressed", "true");
      await expect(page.getByRole("button", { name: ja.media_insert, exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: ja.preview, exact: true })).toBeHidden();
      await captureScreenshot(page, { path: path.join(directory, `default-${width}.png`), fullPage: true, animations: "disabled" }, "e2e-editor-default");
      await rich(page).pressSequentially("画像の前の段落。");
      const chooser = page.waitForEvent("filechooser");
      await page.getByRole("button", { name: ja.media_insert, exact: true }).click();
      await (await chooser).setFiles({ name: "diagram.png", mimeType: "image/png", buffer: png });
      const alt = page.getByRole("textbox", { name: ja.media_alt_placeholder, exact: true });
      await expect(alt).toBeFocused(); await expect(alt).toHaveValue("");
      await expect(alt).toHaveAttribute("placeholder", ja.media_alt_placeholder);
      await captureScreenshot(page, { path: path.join(directory, `image-empty-alt-${width}.png`), fullPage: true, animations: "disabled" }, "e2e-editor-default");
      await alt.press("Enter");
      expect(await body(page).inputValue()).toMatch(/!\[\]\(\/media\//);
      await rich(page).locator("img[src]").click();
      await alt.fill("見本の図"); await alt.press("Enter");
      expect(await body(page).inputValue()).toContain("![見本の図](/media/");
      const margins = await rich(page).evaluate(element => {
        const image = element.querySelector("img[src]")!;
        return { top: getComputedStyle(image).marginTop, bottom: getComputedStyle(image).marginBottom,
          paragraphPadding: getComputedStyle(image.parentElement!).paddingTop };
      });
      expect(margins.top).toBe(margins.paragraphPadding);
      expect(margins.bottom).toBe(margins.paragraphPadding);
      await chooseEditorMode(page, ja.editor_mode_markdown);
      await expect(body(page)).toBeVisible();
      await expect(page.getByText(ja.writing_tips, { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: ja.preview, exact: true })).toBeVisible();
      await captureScreenshot(page, { path: path.join(directory, `markdown-${width}.png`), fullPage: true, animations: "disabled" }, "e2e-editor-default");
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      await expect(page.locator("[data-draft-autosave]")).toHaveAttribute("data-draft-autosave", "saved");
    }
  } finally { await context.close(); }
});
