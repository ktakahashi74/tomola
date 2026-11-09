import fs from "node:fs";
import path from "node:path";
import { expect, type Page, type Locator } from "@playwright/test";
import { richEditorTest as test } from "./editor-fixture";
import { enMessages as en, useMember, titleField, waitForFormReady, chooseEditorMode, openPostSettings } from "./helpers";
import { LANG_LABELS, type Lang } from "../app/lib/languages";

const body = (page: Page) => page.locator('textarea[name="body"]');
const rich = (page: Page) => page.locator('[contenteditable="true"][role="textbox"]');
const tool = (page: Page, name: string) => page.getByRole("toolbar").getByRole("button", { name, exact: true });
const samples = [
  ["ja", "これは", "「強調」", "です"], ["en", "This is ", '"important"', " here"],
  ["fr", "l'", "« important »", "est ici"], ["de", "Das ist ", "„wichtig“", " hier"],
  ["zh-Hant", "這是", "「重點」", "內容"], ["zh-Hans", "这是", "“重点”", "内容"],
  ["ko", "이것은 ", '"강조"', "입니다"], ["th", "นี่คือ", '"คำสำคัญ"', "ในประโยค"],
  ["vi", "Đây là ", "“quan trọng”", " nhé"],
];

async function newPost(page: Page) {
  await page.goto("/t/new");
  await waitForFormReady(page.locator("form", { has: body(page) }));
  await expect(rich(page)).toBeVisible();
}
async function selectText(locator: Locator, text: string, last = false) {
  await locator.evaluate((element, { text, last }) => {
    (element as HTMLElement).focus();
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const matches: { node: Node; offset: number }[] = [];
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const offset = node.textContent!.indexOf(text);
      if (offset >= 0) matches.push({ node, offset });
    }
    const found = last ? matches.at(-1) : matches[0];
    if (!found) throw new Error("Text to select was not found");
    const range = document.createRange();
    range.setStart(found.node, found.offset); range.setEnd(found.node, found.offset + text.length);
    const selection = window.getSelection()!;
    selection.removeAllRanges(); selection.addRange(range);
    element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    document.dispatchEvent(new Event("selectionchange"));
  }, { text, last });
}
async function pasteText(page: Page, text: string) {
  await rich(page).focus();
  await rich(page).evaluate((element, text) => {
    const data = new DataTransfer(); data.setData("text/plain", text);
    element.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  }, text);
}
async function publish(page: Page, title: string) {
  await titleField(page).fill(title);
  await page.getByRole("button", { name: en.submit_post, exact: true }).click();
  await expect(page).toHaveURL(/\/t\/\d+(?:\?.*)?$/);
}
async function evidence(page: Page, name: string, markdown: string) {
  const dir = process.env.E2E_EVIDENCE_DIR;
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify({ markdown, html: await page.locator("[data-reading-body]").first().innerHTML() }, null, 2));
}

for (const [lang, before, target, after] of samples.filter(([lang]) => ["ja", "th", "fr"].includes(lang))) {
  test(`toolbar attention publishes and remains editable in ${lang}`, async ({ page }) => {
    await useMember(page, `markdown_cjk_${lang.toLowerCase()}@example.com`);
    await newPost(page);
    await openPostSettings(page);
    await page.getByRole("combobox", { name: en.field_lang, exact: true }).click();
    await page.getByRole("listbox").getByRole("option", { name: LANG_LABELS[lang as Lang], exact: true }).click();
    const text = before + target + after;
    await pasteText(page, text + "\n\n" + text);
    await selectText(rich(page), target); await tool(page, en.editor_bold).click();
    await selectText(rich(page), target, true);
    await expect(tool(page, en.editor_bold)).toHaveAttribute("aria-pressed", "false");
    await tool(page, en.editor_italic).click();
    await expect(rich(page).locator("strong")).toHaveText(target);
    await expect(rich(page).locator("em")).toHaveText(target);
    const markdown = await body(page).inputValue();
    await publish(page, `Attention round trip ${lang}`);
    const posted = page.locator("[data-reading-body]").first();
    await expect(posted.locator("strong")).toHaveText(target);
    await expect(posted.locator("em")).toHaveText(target);
    await expect(posted).toContainText(text);
    await evidence(page, lang, markdown);
    const editUrl = new URL(page.url()).pathname + "/edit";
    await page.goto(editUrl); await expect(rich(page)).toBeVisible();
    await expect(rich(page).locator("strong")).toHaveText(target);
    await expect(rich(page).locator("em")).toHaveText(target);
    await rich(page).focus(); await page.keyboard.press("ControlOrMeta+End"); await page.keyboard.insertText("!");
    await page.getByRole("button", { name: en.save_changes, exact: true }).click();
    await expect(page).not.toHaveURL(/\/edit$/);
    await expect(posted.locator("strong")).toHaveText(target);
    await expect(posted.locator("em")).toHaveText(target);
    await expect(posted).toContainText(after + "!");
  });
}

test("text immediately before toolbar attention remains literal after publication", async ({ page }) => {
  await useMember(page, "markdown_cjk_escaping@example.com"); await newPost(page);
  const paragraphs = ["10~20人、30~40人 太字", "12. Oktober 2026", "2026. 10. 12. 월요일", "use <div> here"];
  await rich(page).focus();
  for (const [index, paragraph] of paragraphs.entries()) {
    if (index) await page.keyboard.press("Enter");
    // Multiline clipboard text is Markdown input. Insert literal prose here
    // so this scenario tests the writer's text nodes before toolbar attention.
    await page.keyboard.insertText(paragraph);
  }
  await expect(rich(page).locator("ol, del, div")).toHaveCount(0);
  for (const target of ["太字", "Oktober", "월요일", "here"]) {
    await selectText(rich(page), target);
    await expect(tool(page, en.editor_bold)).toHaveAttribute("aria-pressed", "false");
    await tool(page, en.editor_bold).click();
  }
  await expect(rich(page).locator("strong")).toHaveText(["太字", "Oktober", "월요일", "here"]);
  const markdown = await body(page).inputValue();
  await publish(page, "Literal text before attention");
  const posted = page.locator("[data-reading-body]").first();
  await expect(posted.locator("strong")).toHaveText(["太字", "Oktober", "월요일", "here"]);
  await expect(posted.locator("ol, del, div")).toHaveCount(0);
  for (const part of ["10~20人、30~40人", "12. Oktober 2026", "2026. 10. 12. 월요일", "use <div> here"]) await expect(posted).toContainText(part);
  await evidence(page, "escaping", markdown);
});

test("typing starts an ordered list only with 1 and single tildes stay literal", async ({ page }) => {
  await useMember(page, "markdown_cjk_typing@example.com"); await newPost(page);
  await rich(page).focus(); await page.keyboard.type("12. Oktober 2026");
  await expect(rich(page).locator("ol")).toHaveCount(0);
  await expect(body(page)).toHaveValue(/12\\\. Oktober/);
  await page.keyboard.press("Enter"); await page.keyboard.press("Enter");
  await page.keyboard.type("1. "); await expect(rich(page).locator("ol")).toHaveCount(1);
  await page.keyboard.type("item");
  await page.keyboard.press("Enter"); await page.keyboard.press("Enter");
  await page.keyboard.type("10~20"); await page.keyboard.insertText("人、"); await page.keyboard.type("30~40"); await page.keyboard.insertText("人");
  await expect(rich(page).locator("del")).toHaveCount(0);
  await page.keyboard.press("Enter"); await page.keyboard.type("~~a~b~~");
  await expect(rich(page).locator("del")).toHaveText("a~b");
  await page.keyboard.press("Enter"); await page.keyboard.insertText("日本語_"); await page.keyboard.type("italic_"); await page.keyboard.insertText("の後ろ");
  const italics = await rich(page).locator("em").allTextContents();
  await publish(page, "Typed list and range");
  const posted = page.locator("[data-reading-body]").first();
  await expect(posted.locator("ol li")).toHaveText("item");
  await expect(posted.locator("del")).toHaveText("a~b");
  await expect(posted.locator("em")).toHaveText(italics);
  await expect(posted.locator("p").filter({ hasText: "12. Oktober 2026" })).toHaveCount(1);
  await expect(posted).toContainText("10~20人、30~40人");
});

test("typed query URL preserves its destination after publication", async ({ page }) => {
  await useMember(page, "markdown_cjk_url_query@example.com"); await newPost(page);
  const url = "https://g.com/h?i=1&j=2";
  await rich(page).focus(); await page.keyboard.insertText(`see ${url} ok`);
  await expect(body(page)).toHaveValue(/https\\:\/\/g\.com\/h\?i=1\\&j=2/);
  const markdown = await body(page).inputValue();
  await publish(page, "Query URL round trip");
  const posted = page.locator("[data-reading-body]").first();
  await expect(posted.locator("a")).toHaveAttribute("href", url);
  await expect(posted.locator("a")).toHaveText(url);
  await evidence(page, "url-query", markdown);
});

test("opening handwritten Markdown uses the reading grammar for attention and links", async ({ page }) => {
  await useMember(page, "markdown_cjk_reparse@example.com"); await newPost(page);
  await chooseEditorMode(page, en.editor_mode_markdown);
  const source = "これは**「強調」**です。これは*（補足）*です。これは~~「削除」~~です。\n\n日本語_斜体_の後ろ 日本語__強調__の後ろ 10~20人、30~40人\n\n[https://example.com/a](https://example.com/a)。次の文\n\n详见[https://example.com/b](https://example.com/b)，然后继续";
  await body(page).fill(source);
  await chooseEditorMode(page, en.editor_mode_rich);
  await expect(rich(page).locator("strong")).toHaveText("「強調」");
  await expect(rich(page).locator("em")).toHaveText("（補足）");
  await expect(rich(page).locator("del")).toHaveText("「削除」");
  await expect(rich(page).locator('a[href="https://example.com/a"]')).toHaveText("https://example.com/a");
  await expect(rich(page).locator('a[href="https://example.com/b"]')).toHaveText("https://example.com/b");
  await rich(page).focus(); await page.keyboard.press("ControlOrMeta+End"); await page.keyboard.insertText("!");
  await publish(page, "Shared handwritten grammar");
  const posted = page.locator("[data-reading-body]").first();
  await expect(posted.locator("strong")).toHaveText("「強調」");
  await expect(posted.locator("em")).toHaveText("（補足）");
  await expect(posted.locator("del")).toHaveText("「削除」");
  await expect(posted.locator('a[href="https://example.com/a"]')).toHaveText("https://example.com/a");
  await expect(posted.locator('a[href="https://example.com/b"]')).toHaveText("https://example.com/b");
  await expect(posted).toContainText("日本語_斜体_の後ろ 日本語__強調__の後ろ 10~20人、30~40人");
});
