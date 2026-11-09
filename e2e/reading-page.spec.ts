import { readTopicTranslation } from "./helpers";
import fs from "node:fs";
import path from "node:path";
import { expect, type Locator, type Page } from "@playwright/test";
import { test } from "./editor-fixture";
import { captureScreenshot, useMember, formatMessage, messagePattern, clientHeaders, enMessages as en, state, waitForFormReady, escapeRegex } from "./helpers";


type Fixture = { topicId: number; englishId: number; placeholderId: number; replyId: number; invitation: string };
const fixture = (): Fixture => JSON.parse(fs.readFileSync(path.join(state().dir, "reading-page.json"), "utf8"));

async function selectPassage(page: Page, body: Locator, length: number) {
  // The quote button is drawn beside the selection, and only while the selection is on the screen: bring the start of the paragraph (a long one is taller than the screen) into view.
  await body.locator("p").first().evaluate(paragraph => { paragraph.scrollIntoView({ block: "start" }); window.scrollBy(0, -150); });
  await body.locator("p").first().evaluate((paragraph, size) => {
    const text = paragraph.firstChild!;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, Math.min(size, text.textContent!.length));
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  }, length);
  return page.evaluate(() => window.getSelection()!.toString().trim());
}

test("long originals and translations stay readable at desktop and phone widths", async ({ browser }) => {
  const f = fixture();
  const context = await browser.newContext({ extraHTTPHeaders: clientHeaders("10.57.0.1") });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  try {
    await useMember(page, "reading_member@example.com");
    for (const width of [1366, 1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/t/${f.topicId}?lang=en&orig=${f.topicId}`);
      const topic = page.locator(`#p-${f.topicId}`);
      const body = topic.locator("[data-reading-body]");
      const toc = topic.getByRole("navigation", { name: en.reading_toc });
      await expect(page.getByRole("button", { name: en.open_in_ai, exact: true })).toHaveCount(width >= 1024 ? 2 : 1);
      await expect(topic.locator("[data-reading-byline]").getByRole("button")).toHaveCount(0);
      await expect(page.locator("#reply [data-reply-heading]").getByRole("button", { name: en.open_in_ai, exact: true })).toBeVisible();
      for (const version of ["original", "translation"] as const) {
        await expect(body).toHaveAttribute("lang", version === "original" ? "ja" : "en");
        await expect(topic.locator("[data-article-signature]")).toContainText("@kim");
        // The language control is one name in the byline (what is read), after the title; it holds no row of its own above the title.
        const readingLanguage = topic.locator("[data-reading-byline] details.reading-lang-menu summary");
        await expect(readingLanguage).toBeVisible();
        expect(await readingLanguage.evaluate(summary => {
          const heading = summary.closest("article")?.querySelector("h1");
          return !!heading && !!(heading.compareDocumentPosition(summary) & Node.DOCUMENT_POSITION_FOLLOWING);
        })).toBe(true);
        await expect(topic.locator("[data-reading-tools] a[hreflang]")).toHaveCount(0);
        if (version === "translation") await expect(topic.locator("[data-reading-language]").getByRole("link", { name: en.show_original, exact: true })).toBeVisible();
        await expect(topic.locator("[data-reading-time]")).toBeVisible();
        await expect(toc).toHaveCount(1);
        if (await toc.locator("summary").isVisible() && !(await toc.locator("details").evaluate(details => (details as HTMLDetailsElement).open))) await toc.locator("summary").click();
        const first = toc.getByRole("link").first();
        await expect(first).toBeVisible();
        const visible = toc.getByRole("link");
        const expectedHeading = await body.locator("h2").first().innerText();
        await expect(first).toHaveText(expectedHeading);
        const href = await first.getAttribute("href");
        await first.click();
        expect(new URL(page.url()).hash).toBe(href);
        await expect(body.locator(href!)).toBeInViewport();
        expect(await visible.count()).toBe(6);
        await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
        if (process.env.E2E_EVIDENCE_DIR) {
          fs.mkdirSync(process.env.E2E_EVIDENCE_DIR, { recursive: true });
          await page.evaluate(() => window.scrollTo(0, 0));
          await captureScreenshot(page, { path: path.join(process.env.E2E_EVIDENCE_DIR, `${width}-${version}.png`), fullPage: false }, "e2e-reading-page");
          await body.locator("pre").scrollIntoViewIfNeeded();
          await captureScreenshot(page, { path: path.join(process.env.E2E_EVIDENCE_DIR, `${width}-${version}-blocks.png`), fullPage: false }, "e2e-reading-page");
        }
        if (version === "original") await readTopicTranslation(topic);
      }
      await topic.getByRole("link", { name: en.reading_show_older, exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`old=${f.topicId}(?:&|#|$)`));
      await expect(toc).toHaveCount(0);
      await expect(topic.locator("[data-reading-time]")).toHaveCount(0);
      await expect(body).toContainText("A short earlier translation.");
      await expect(topic.locator("[data-reading-language]")).toContainText(en.label_from_lang_human.replace("{lang}", en.language_name_ja));
      await expect(topic.getByRole("link", { name: en.show_original, exact: true })).toBeVisible();
      await page.goto(`/t/${f.englishId}`);
      await expect(page.locator("[data-reading-body]")).toHaveAttribute("lang", "en");
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
      if (process.env.E2E_EVIDENCE_DIR) await captureScreenshot(page, { path: path.join(process.env.E2E_EVIDENCE_DIR, `${width}-english-original.png`) }, "e2e-reading-page");
    }

    await page.goto(`/t/${f.topicId}?lang=en&tr=${f.topicId}&reply_to=`);
    const form = page.locator("#reply form");
    await waitForFormReady(form);
    const textarea = form.locator('textarea[name="body"]');
    await textarea.fill("A draft to keep.");
    const body = page.locator(`#p-${f.topicId} [data-reading-body]`);
    const passage = await selectPassage(page, body, 75);
    await page.getByRole("button", { name: en.quote_reply, exact: true }).click();
    // A quotation says where it comes from: a last line linking to the post (or reply) it was taken from.
    const source = (id: number, kind: "p" | "c") => `\\n>\\n> — \\[[^\\]\\n]+\\]\\(/t/${f.topicId}#${kind}-${id}\\)`;
    await expect(textarea).toHaveValue(new RegExp(`^A draft to keep\\.\\n\\n> ${escapeRegex(passage)}${source(f.topicId, "p")}\\n\\n$`));
    await expect(textarea).toBeFocused();
    await expect(form.locator('input[name="parentId"]')).toHaveValue("");
    const replyPassage = await selectPassage(page, page.locator(`#c-${f.replyId} [data-quote-entry]`), 100);
    await page.getByRole("button", { name: en.quote_reply, exact: true }).click();
    await expect(textarea).toHaveValue(new RegExp(`^A draft to keep\\.\\n\\n> ${escapeRegex(passage)}${source(f.topicId, "p")}\\n\\n\\n\\n> ${escapeRegex(replyPassage)}${source(f.replyId, "c")}\\n\\n$`));
    await expect(form.locator('input[name="parentId"]')).toHaveValue(String(f.replyId));
    await expect(form.getByText(formatMessage(en.reply_target_note, { handle: "kim" }), { exact: true })).toBeVisible();
    await expect(form.getByRole("link", { name: en.reply_target_link, exact: true })).toHaveAttribute("href", new RegExp(`#c-${f.replyId}$`));
    const targetHref = await form.getByRole("link", { name: en.reply_target_link, exact: true }).getAttribute("href");
    expect(new URL(targetHref!, page.url()).search).toBe(new URL(page.url()).search);
    // Quoting the topic again preserves the selected reply target.
    await selectPassage(page, body, 40);
    await page.getByRole("button", { name: en.quote_reply, exact: true }).click();
    await expect(form.locator('input[name="parentId"]')).toHaveValue(String(f.replyId));
    const draftBeforeClear = await textarea.inputValue();
    await form.getByRole("link", { name: en.reply_target_clear, exact: true }).click();
    await expect(form.getByText(formatMessage(en.reply_target_note, { handle: "kim" }), { exact: true })).toHaveCount(0);
    await expect(textarea).toHaveValue(draftBeforeClear);
    await selectPassage(page, page.locator(`#c-${f.replyId} [data-quote-entry]`), 100);
    await page.getByRole("button", { name: en.quote_reply, exact: true }).click();
    await expect(form.locator('input[name="parentId"]')).toHaveValue(String(f.replyId));

    await selectPassage(page, body, 1100);
    await expect(page.getByRole("button", { name: en.quote_reply, exact: true })).toBeHidden();
    await page.evaluate(({ topicId, replyId }) => {
      const range = document.createRange();
      range.setStart(document.querySelector(`#p-${topicId} [data-reading-body] p`)!.firstChild!, 0);
      range.setEnd(document.querySelector(`#c-${replyId} [data-quote-entry] p`)!.firstChild!, 5);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    }, f);
    await expect(page.getByRole("button", { name: en.quote_reply, exact: true })).toBeHidden();
    await page.getByRole("heading", { level: 1 }).evaluate(heading => {
      const range = document.createRange();
      range.selectNodeContents(heading);
      window.getSelection()!.removeAllRanges();
      window.getSelection()!.addRange(range);
    });
    await expect(page.getByRole("button", { name: en.quote_reply, exact: true })).toBeHidden();
    // A refused POST must keep the quote's target as well as the draft for retrying.
    const draftBeforeError = await textarea.inputValue();
    const invalidDraft = `---\ntype: topic\n---\n\n${draftBeforeError}`;
    await textarea.fill(invalidDraft);
    const refusal = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname.startsWith(`/t/${f.topicId}`));
    await page.getByRole("button", { name: en.submit_reply, exact: true }).click();
    expect((await refusal).status()).toBe(400);
    await expect(form.getByText(en.error_frontmatter_type, { exact: true })).toBeVisible();
    await expect(textarea).toHaveValue(invalidDraft);
    await expect(form.locator('input[name="parentId"]')).toHaveValue(String(f.replyId));
    await expect(form.getByText(formatMessage(en.reply_target_note, { handle: "kim" }), { exact: true })).toBeVisible();
    await form.getByRole("link", { name: en.reply_target_clear, exact: true }).click();
    await expect(form.getByText(formatMessage(en.reply_target_note, { handle: "kim" }), { exact: true })).toHaveCount(0);
    await expect(textarea).toHaveValue(invalidDraft);
    await textarea.fill(draftBeforeError);
    await selectPassage(page, page.locator(`#c-${f.replyId} [data-quote-entry]`), 100);
    await page.getByRole("button", { name: en.quote_reply, exact: true }).click();
    await expect(form.locator('input[name="parentId"]')).toHaveValue(String(f.replyId));
    await page.getByRole("button", { name: en.submit_reply, exact: true }).click();
    await expect(page).toHaveURL(url => url.pathname === `/t/${f.topicId}` && /^\d+$/.test(url.searchParams.get("posted") ?? "") && url.hash === `#c-${url.searchParams.get("posted")}`);
    const postedId = new URL(page.url()).hash;
    const posted = page.locator(postedId);
    await expect(page.locator(`[data-reply-branch="${f.replyId}"] #${new URL(page.url()).hash.slice(1)}`)).toBeVisible();
    await expect(posted.getByRole("link", { name: messagePattern(en.reply_parent_link, { handle: /[a-z0-9_]+/ }), exact: true })).toHaveCount(0);
    await expect(posted.locator("blockquote").first()).toContainText(passage);
    await expect(form.locator('textarea[name="body"]')).toBeEmpty();
    await page.goto(`/t/${f.placeholderId}`);
    await expect(page.getByText(en.entry_hidden_placeholder, { exact: true })).toBeVisible();
    await expect(page.locator("[data-reading-body]")).toHaveCount(0);
    await page.getByRole("button", { name: en.open_in_ai, exact: true }).click();
    await expect(page.getByRole("dialog", { name: en.open_in_ai_dialog_title })).toBeVisible();
    expect(errors).toEqual([]);
  } finally { await context.close(); }
});

test("public and no-JavaScript readers retain contents links and never get quote controls", async ({ browser }) => {

  const f = fixture();
  for (const javaScriptEnabled of [true, false]) {
    const context = await browser.newContext({ javaScriptEnabled, viewport: { width: 390, height: 844 }, extraHTTPHeaders: clientHeaders(javaScriptEnabled ? "10.57.0.3" : "10.57.0.4") });
    const page = await context.newPage();
    try {
      await page.goto(`/t/${f.topicId}?orig=${f.topicId}&lang=en`);
      const toc = page.getByRole("navigation", { name: en.reading_toc });
      await toc.locator("summary").click();
      const href = await toc.getByRole("link").first().getAttribute("href");
      await toc.getByRole("link").first().click();
      expect(new URL(page.url()).hash).toBe(href);
      await expect(page.locator(href!)).toBeInViewport();
      await readTopicTranslation(page.locator(`#p-${f.topicId}`));
      await expect(page.locator("[data-reading-body]")).toHaveAttribute("lang", "en");
      await expect(page.locator("[data-quote-entry]")).toHaveCount(0);
      await expect(page.getByRole("button", { name: en.quote_reply, exact: true })).toHaveCount(0);
      await page.goto(`/t/${f.placeholderId}`);
      await expect(page.getByText(en.entry_hidden_placeholder, { exact: true })).toBeVisible();
      await expect(page.locator("[data-reading-body]")).toHaveCount(0);
      await expect(page.locator("#reply").getByText(en.reply_closed_hidden, { exact: true })).toBeVisible();
      await expect(page.locator("#reply").getByText(en.public_reading_reply, { exact: true })).toHaveCount(0);
      await expect(page.locator("#reply").getByRole("link", { name: en.login_title, exact: true })).toHaveCount(0);
      const openInAi = page.getByRole("button", { name: en.open_in_ai, exact: true });
      if (javaScriptEnabled) {
        await openInAi.click();
        await expect(page.getByRole("dialog", { name: en.open_in_ai_dialog_title })).toBeVisible();
      } else await expect(openInAi).toHaveCount(0);
    } finally { await context.close(); }
  }
});
