import { routeModule } from "./support/module-route";
import { enMessages, chooseEditorMode, openPostSettings } from "./helpers";
import fs from "node:fs";
import path from "node:path";
import { expect, type Page, type Browser, type Locator } from "@playwright/test";
import { richEditorTest as test } from "./editor-fixture";
import { LANG_LABELS } from "../app/lib/languages";
import { BODY_MAX_LENGTH } from "../app/lib/rich-editor";
import { waitForClientRoute, captureScreenshot, useMember, clientHeaders, enMessages as en, formatMessage, state, titleField, waitForFormReady } from "./helpers";

type Fixture = { invitations: Record<string, { email: string; invitation: string }>; body: string };
const fixture = (): Fixture => JSON.parse(fs.readFileSync(path.join(state().dir, "rich-editor.json"), "utf8"));
const body = (page: Page) => page.locator('textarea[name="body"]');
const rich = (page: Page) => page.locator('[contenteditable="true"][role="textbox"]');
const tool = (page: Page, label: string) => page.getByRole("toolbar").getByRole("button", { name: label, exact: true });

async function member(browser: Browser, name: string, index: number) {
  const context = await browser.newContext({ extraHTTPHeaders: clientHeaders(`10.78.0.${index}`) });
  const page = await context.newPage();
  const invitation = fixture().invitations[name];
  await useMember(page, invitation.email);
  return { context, page };
}
async function newPost(page: Page) {
  await page.goto("/t/new");
  await waitForFormReady(page.locator("form", { has: body(page) }));
  await expect(page.getByRole("button", { name: en.editor_mode_rich, exact: true })).toBeEnabled();
}
async function mode(page: Page, isRich: boolean) {
  await chooseEditorMode(page, isRich ? en.editor_mode_rich : en.editor_mode_markdown);
  if (isRich) await expect(rich(page)).toBeVisible();
  else await expect(body(page)).toBeVisible();
}
async function publish(page: Page, title: string) {
  await titleField(page).fill(title);
  await page.getByRole("button", { name: en.submit_post, exact: true }).click();
  await expect(page).toHaveURL(/\/t\/\d+(?:\?.*)?$/);
}
async function selectText(locator: Locator, text: string) {
  await locator.evaluate((element, text) => {
    (element as HTMLElement).focus();
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const index = node.textContent!.indexOf(text);
      if (index < 0) continue;
      const range = document.createRange();
      range.setStart(node, index); range.setEnd(node, index + text.length);
      const selection = window.getSelection()!;
      selection.removeAllRanges(); selection.addRange(range);
      element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      document.dispatchEvent(new Event("selectionchange"));
      return;
    }
    throw new Error("Text to select was not found");
  }, text);
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
async function screenshot(page: Page, name: string, width: number) {
  // The size the test was using is kept: on a narrow screen the toolbar folds its less used tools behind "…".
  const before = page.viewportSize();
  await page.setViewportSize({ width, height: 900 });
  await captureScreenshot(page, { path: path.join(process.cwd(), ".data/rich-editor/screenshots", `${name}-${width}.png`), fullPage: true }, "e2e-rich-editor");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  if (before) await page.setViewportSize(before);
}

test("Explicit Markdown mode persists; rich mode persists, synchronizes Markdown and publishes toolbar formatting", async ({ browser }) => {
  const { context, page } = await member(browser, "modes", 1);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  try {
    await newPost(page);
    await mode(page, false);
    await page.reload();
    await expect(body(page)).toBeVisible();
    expect(await page.evaluate(() => performance.getEntriesByType("resource").some(entry => entry.name.includes("rich-text-editor.client")))).toBe(false);
    for (const width of [1366, 390]) await screenshot(page, "new-markdown", width);
    await mode(page, true);
    for (const width of [1366, 390]) await screenshot(page, "new-rich", width);
    await page.reload();
    await expect(rich(page)).toBeVisible();
    await rich(page).focus();
    await page.keyboard.type("Heading words");
    await tool(page, en.editor_heading).click();
    await expect(rich(page).locator("h2")).toHaveText("Heading words");
    await expect(tool(page, en.editor_heading)).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("End"); await page.keyboard.press("Enter");
    await page.keyboard.type("Bold italic link words");
    await selectText(rich(page), "Bold"); await tool(page, en.editor_bold).click();
    await expect(rich(page).locator("strong")).toHaveText("Bold");
    await expect(tool(page, en.editor_bold)).toHaveAttribute("aria-pressed", "true");
    await selectText(rich(page), "italic"); await tool(page, en.editor_italic).click();
    await selectText(rich(page), "link"); await tool(page, en.editor_link).click();
    await page.getByRole("textbox", { name: en.editor_link_url, exact: true }).fill("https://example.com/first");
    await page.getByRole("button", { name: en.editor_link_apply, exact: true }).click();
    await expect(rich(page).locator("a")).toHaveAttribute("href", "https://example.com/first");
    await selectText(rich(page), "link"); await tool(page, en.editor_link).click();
    await expect(page.getByRole("textbox", { name: en.editor_link_url, exact: true })).toHaveValue("https://example.com/first");
    await page.getByRole("textbox", { name: en.editor_link_url, exact: true }).fill("https://example.com/changed");
    await page.getByRole("button", { name: en.editor_link_apply, exact: true }).click();
    await expect(rich(page).locator("a")).toHaveAttribute("href", "https://example.com/changed");
    await selectText(rich(page), "link"); await tool(page, en.editor_link).click();
    await page.getByRole("button", { name: en.editor_link_remove, exact: true }).click();
    await expect(rich(page).locator("a")).toHaveCount(0);
    await tool(page, en.editor_undo).click();
    await expect(rich(page).locator("a")).toHaveAttribute("href", "https://example.com/changed");
    await page.keyboard.press("Control+End");
    await rich(page).evaluate(() => document.dispatchEvent(new Event("selectionchange")));
    await page.keyboard.press("Enter");
    await page.keyboard.type("List item"); await tool(page, en.editor_bullet_list).click();
    await page.keyboard.press("End"); await page.keyboard.press("Enter"); await page.keyboard.press("Enter");
    await page.keyboard.type("Quoted words"); await tool(page, en.editor_quote).click();
    await expect(page.getByRole("button", { name: en.preview, exact: true })).toBeHidden();
    const markdown = await body(page).inputValue();
    await mode(page, false); await expect(body(page)).toHaveValue(markdown);
    await page.getByRole("button", { name: en.preview, exact: true }).click();
    const preview = page.getByRole("button", { name: en.preview, exact: true }).locator("..").locator(".longread");
    await expect(preview.locator("h2")).toHaveText("Heading words");
    await expect(preview.locator("strong")).toHaveText("Bold");
    await expect(preview.locator("em")).toHaveText("italic");
    await expect(preview.locator("a")).toHaveAttribute("href", "https://example.com/changed");
    await expect(preview.locator("ul li")).toContainText(["List item"]);
    await expect(preview.locator("blockquote")).toContainText("Quoted words");
    await mode(page, true); await expect(body(page)).toHaveValue(markdown);
    await openPostSettings(page);
    await page.getByRole("combobox", { name: en.field_lang, exact: true }).click();
    await page.getByRole("listbox").getByRole("option", { name: LANG_LABELS.ja, exact: true }).click();
    await expect(page.locator('.longread:has([contenteditable="true"])')).toHaveAttribute("lang", "ja");
    await expect(body(page)).toHaveValue(markdown);
    await openPostSettings(page);
    await page.getByRole("combobox", { name: en.field_lang, exact: true }).click();
    await page.getByRole("listbox").getByRole("option", { name: LANG_LABELS.en, exact: true }).click();
    await expect(page.getByRole("listbox")).not.toBeVisible();
    for (const width of [1366, 390]) await screenshot(page, "new-formatted", width);
    await publish(page, "Rich toolbar publication");
    const posted = page.locator("[data-reading-body]").first();
    await expect(posted.locator("h2")).toHaveText("Heading words");
    await expect(posted.locator("strong")).toHaveText("Bold");
    await expect(posted.locator("em")).toHaveText("italic");
    await expect(posted.locator("a")).toHaveAttribute("href", "https://example.com/changed");
    await expect(posted.locator("ul li")).toContainText(["List item"]);
    await expect(posted.locator("blockquote")).toContainText("Quoted words");
    expect(errors).toEqual([]);
  } finally { await context.close(); }
});

test("Docs and web HTML retain headings, marks, links, lists, quotes and tables, while pasted images are dropped", async ({ browser }) => {
  const { context, page } = await member(browser, "paste", 2);
  try {
    for (const [name, html] of [
      ["Docs", '<b style="font-weight:normal" id="docs-internal-guid-test"><h2>Paste heading</h2><p><span style="font-weight:700">Paste bold</span> <span style="font-style:italic">Paste italic</span> <a href="https://example.com/docs">Paste link</a></p><ul><li>Paste item</li></ul><ol><li>Ordered item</li></ol><blockquote><p>Paste quote</p></blockquote><div dir="ltr"><table><tbody><tr><td>Column</td><td>Value</td></tr><tr><td>Cell</td><td>42</td></tr></tbody></table></div><img src="https://example.com/image.png"></b>'],
      ["Web", '<h2>Paste heading</h2><p><strong>Paste bold</strong> <em>Paste italic</em> <a href="https://example.com/web">Paste link</a></p><ul><li>Paste item<ul><li>Nested item</li></ul></li></ul><ol><li>Ordered item</li></ol><blockquote>Paste quote</blockquote><table><thead><tr><th>Column</th><th>Value</th></tr></thead><tbody><tr><td>Cell</td><td>42</td></tr></tbody></table><img src="https://example.com/image.png">'],
    ]) {
      await newPost(page);
      if (!await rich(page).isVisible()) await mode(page, true);
      await paste(page, html);
      await expect(rich(page).locator("img")).toHaveCount(0);
      await publish(page, `${name} paste publication`);
      const posted = page.locator("[data-reading-body]").first();
      await expect(posted.locator("h2")).toHaveText("Paste heading");
      await expect(posted.locator("strong")).toHaveText("Paste bold");
      await expect(posted.locator("em")).toHaveText("Paste italic");
      await expect(posted.locator("a")).toHaveAttribute("href", `https://example.com/${name.toLowerCase()}`);
      await expect(posted.locator("ul").first()).toContainText("Paste item");
      await expect(posted.locator("ol li")).toHaveText("Ordered item");
      await expect(posted.locator("blockquote")).toContainText("Paste quote");
      await expect(posted.locator("table")).toContainText("Cell");
      await expect(posted.locator("img")).toHaveCount(0);
    }
  } finally { await context.close(); }
});

test("topic editing preserves untouched Markdown exactly; editing table and footnote text keeps their structure and mentions", async ({ browser }) => {
  const { context, page } = await member(browser, "edit", 3);
  try {
    const source = fixture().body;
    await newPost(page); await mode(page, false); await body(page).fill(source); await publish(page, "Table and footnote editor fixture");
    const editUrl = new URL(page.url()).pathname + "/edit";
    await page.goto(editUrl); await mode(page, true);
    await expect(rich(page).locator("table")).toBeVisible();
    await expect(body(page)).toHaveValue(source);
    for (const width of [1366, 390]) await screenshot(page, "edit-table-footnote", width);
    await mode(page, false); await expect(body(page)).toHaveValue(source); await mode(page, true);
    await page.getByRole("button", { name: en.save_changes, exact: true }).click();
    await expect(page).not.toHaveURL(/\/edit$/);
    await page.goto(editUrl); await expect(rich(page)).toBeVisible();
    await expect(body(page)).toHaveValue(source);
    await selectText(rich(page), "alpha"); await page.keyboard.type("alphA");
    await tool(page, en.editor_undo).click();
    await expect(body(page)).toHaveValue(source);
    await tool(page, en.editor_redo).click();
    await expect.poll(() => body(page).inputValue()).toContain("alphA");
    await selectText(rich(page), "Original note"); await page.keyboard.type("Changed note");
    await expect.poll(() => body(page).inputValue()).toContain("alphA");
    await mode(page, false);
    const edited = await body(page).inputValue();
    expect(edited).toContain("@a_b_c"); expect(edited).toContain("[^note]: Changed note");
    await page.getByRole("button", { name: en.save_changes, exact: true }).click();
    await expect(page).not.toHaveURL(/\/edit$/);
    const posted = page.locator("[data-reading-body]").first();
    await expect(posted.locator("table")).toContainText("alphA");
    await expect(posted.locator('[data-footnotes]')).toContainText("Changed note");
  } finally { await context.close(); }
});

test("math and frontmatter stay in Markdown; native validation and a literal frontmatter paste remain usable", async ({ browser }) => {
  const { context, page } = await member(browser, "fallback", 4);
  try {
    await newPost(page); await mode(page, false);
    for (const text of ["Formula $x\\,dx$.", "---\ntitle: Pasted title\nlang: en\n---\nPasted body"]) {
      await body(page).fill(text);
      await chooseEditorMode(page, en.editor_mode_rich);
      await expect(body(page)).toBeVisible(); await expect(body(page)).toHaveValue(text);
      await expect(page.getByRole("status").filter({ hasText: en.editor_mode_markdown_only })).toBeVisible();
    }
    await body(page).fill(""); await mode(page, true);
    await rich(page).focus(); await page.keyboard.type("Formula $");
    await expect(body(page)).toBeVisible();
    await expect(body(page)).toHaveValue("Formula $\n");
    await body(page).fill(""); await mode(page, true);
    await page.getByRole("button", { name: en.submit_post, exact: true }).click();
    // An empty body is told below the editor, which stays the way of editing (what was written is not turned into symbols), with the cursor in it.
    await expect(page.getByRole("alert").filter({ hasText: en.error_body })).toBeVisible();
    await expect(rich(page)).toBeFocused(); await expect(body(page)).toBeHidden();
    expect(await body(page).evaluate(element => (element as HTMLTextAreaElement).validity.valueMissing)).toBe(true);
    await paste(page, "", "x".repeat(BODY_MAX_LENGTH + 1));
    await page.getByRole("button", { name: en.submit_post, exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: en.error_body_too_long })).toBeVisible();
    await expect(rich(page)).toBeVisible(); await expect(body(page)).toBeHidden();
    // The count that is too many is said beside the field, and nothing was cut.
    await expect(page.getByRole("status").filter({ hasText: /characters too many/ })).toBeVisible();
    expect(await body(page).evaluate(element => (element as HTMLTextAreaElement).validationMessage)).toBe(en.error_body_too_long);
    await mode(page, false);
    await body(page).fill("");
    expect(await body(page).evaluate(element => (element as HTMLTextAreaElement).validity.customError)).toBe(false);
    await mode(page, true);
    const frontmatter = "---\ntitle: Literal pasted title\nlang: en\n---\nLiteral pasted body.";
    await paste(page, "", frontmatter);
    await expect(body(page)).toBeVisible(); await expect(body(page)).toHaveValue(frontmatter);
    await page.getByRole("button", { name: en.submit_post, exact: true }).click();
    await expect(page).toHaveURL(/\/t\/\d+(?:\?.*)?$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Literal pasted title");
    await expect(page.locator("[data-reading-body]").first()).toContainText("Literal pasted body.");
  } finally { await context.close(); }
});

test("native body edits before hydration survive switching to rich text", async ({ browser }) => {
  const { context, page } = await member(browser, "early", 5);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let paused = true;
  try {
    await page.route("**/*", async route => { if (paused && route.request().resourceType() === "script") await gate; await route.continue(); });
    await page.goto("/t/new", { waitUntil: "commit" });
    await body(page).fill("Typed before hydration, with @a_b_c.");
    paused = false; release();
    await waitForFormReady(page.locator("form", { has: body(page) }));
    await mode(page, true);
    await expect(rich(page)).toContainText("Typed before hydration, with @a_b_c.");
    await mode(page, false); await expect(body(page)).toHaveValue("Typed before hydration, with @a_b_c.");
  } finally { paused = false; release?.(); await context.close(); }
});

test("Markdown still works without JavaScript and after a failed editor import", async ({ browser }) => {
  const { context, page } = await member(browser, "failure", 6);
  try {
    const noJS = await browser.newContext({ javaScriptEnabled: false, storageState: await context.storageState(), extraHTTPHeaders: clientHeaders("10.78.0.7") });
    try {
      const native = await noJS.newPage(); await native.goto("/t/new");
      await expect(body(native)).toBeVisible();
      await body(native).fill("Native Markdown publication."); await publish(native, "No JavaScript editor");
    } finally { await noJS.close(); }
    // Intercept before navigation: automatic initialization can request the
    // optional module before the form is ready. Wait for its actual rejection
    // and completed fallback before typing, rather than a still-visible field.
    let rejected = 0;
    const moduleRoute = await routeModule(page, "app/components/rich-text-editor.client.tsx", route => { rejected++; return route.abort(); });
    await newPost(page);
    await moduleRoute.assertHit();
    expect(rejected).toBeGreaterThan(0);
    await waitForClientRoute(page);
    await waitForFormReady(page.locator("form", { has: body(page) }));
    await expect(page.locator("[data-rich-editor-pending]")).toHaveAttribute("data-rich-editor-pending", "false");
    await expect(body(page)).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem("tomola:editor-mode"))).toBeNull();
    await body(page).fill("Kept after failed loading.");
    await expect(body(page)).toHaveValue("Kept after failed loading.");
    await publish(page, "Editor loading failure");
  } finally { await context.close(); }
});
