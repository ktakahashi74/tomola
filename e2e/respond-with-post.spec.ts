import { expect, type Page } from "@playwright/test";
import { richEditorTest, test } from "./editor-fixture";
import { EDITOR_MODE_STORAGE_KEY } from "../app/lib/rich-editor";
import { captureScreenshot, chooseEditorMode, enMessages, messagePattern, state, uiMessages, useMember, waitForFormReady } from "./helpers";

const body = (page: Page) => page.locator('textarea[name="body"]').first();
const ready = (page: Page) => waitForFormReady(page.locator("form", { has: body(page) }).first());
async function publish(page: Page, text: string, title = "") {
  await ready(page);
  await page.locator('input[name="title"]').fill(title);
  await body(page).fill(text);
  await page.getByRole("button", { name: (await uiMessages(page)).submit_post, exact: true }).click();
  await expect(page).toHaveURL(/\/t\/\d+\?posted=/);
  return new URL(page.url()).pathname;
}
async function pictures(page: Page, locale: string, screen: string) {
  if (!process.env.E2E_EVIDENCE_DIR) return;
  for (const width of [390, 1100, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    if (screen === "entry") await page.locator("#reply").scrollIntoViewIfNeeded();
    await captureScreenshot(page, { path: `respond-${locale}-${screen}-${width}.png`, fullPage: true }, "respond-with-post");
  }
}

for (const locale of ["en", "ja"] as const) test(`responds with an ordinary post in ${locale} and links both discussions`, async ({ page, browser }) => {
  await page.context().addCookies([{ name: "PARAGLIDE_LOCALE", value: locale, url: state().baseURL }]);
  await useMember(page, `zrespond_author_${locale}@example.com`, "/t/new");
  const sourceTitle = `Source title ${locale}`;
  const source = await publish(page, "The source material for a longer response.", sourceTitle);
  await useMember(page, `zrespond_writer_${locale}@example.com`, source);
  const messages = await uiMessages(page);
  const entry = page.locator("#reply").getByRole("button", { name: messages.respond_with_post, exact: true });
  await expect(entry).toHaveAttribute("formaction", `/t/new?respond=${source.split("/").at(-1)}`);
  const hint = page.locator("#respond-with-post-hint");
  await expect(hint).toBeVisible();
  await expect(entry).toHaveAccessibleDescription(await hint.innerText());
  await pictures(page, locale, "entry");
  await entry.click();
  await expect(page).toHaveURL(/\/t\/new\?respond=\d+$/);
  await ready(page);
  const pattern = messagePattern(messages.response_post_prefill, { title: sourceTitle, handle: /[^\n]+/, url: source });
  await expect(body(page)).toHaveValue(new RegExp(`^${pattern.source}\n\n$`));
  const initial = await body(page).inputValue();
  await expect(page.locator('input[name="title"]')).toBeEmpty();
  await pictures(page, locale, "composer");
  const response = await publish(page, initial + "A response published in the writer's chosen place.");
  await expect(page.locator(`#related [data-related-topic="${source.split("/").at(-1)}"]`)).toBeVisible();
  await page.goto(source);
  await expect(page.locator(`#related [data-related-topic="${response.split("/").at(-1)}"]`)).toBeVisible();
  await useMember(page, `zrespond_author_${locale}@example.com`, "/notifications");
  const notice = page.getByRole("link", { name: messagePattern(messages.notification_response_to_topic, { handle: `zrespond_writer_${locale}`, title: /.+/ }) });
  await expect(notice).toBeVisible();
  await expect(notice).toContainText(sourceTitle);
  const excerpt = page.getByRole("listitem").filter({ has: notice }).locator("p");
  await expect(excerpt).toContainText("A response published in the writer's chosen place.");
  await expect(excerpt).not.toContainText(sourceTitle);
  if (process.env.E2E_EVIDENCE_DIR) await captureScreenshot(page, { path: `response-notice-${locale}.png`, fullPage: true }, "respond-with-post");
  await notice.click();
  await expect(page).toHaveURL(new RegExp(`${response}$`));
  await useMember(page, `zrespond_writer_${locale}@example.com`, response);
  const deleted = await page.request.post(response, { headers: { Origin: state().baseURL }, form: { intent: "delete", entryId: response.split("/").at(-1)!, confirm: "1" }, maxRedirects: 0 });
  expect(deleted.status()).toBe(302);
  await useMember(page, `zrespond_author_${locale}@example.com`, "/notifications");
  await expect(page.getByText(messages.notification_content_unavailable, { exact: true })).toBeVisible();
  await expect(notice).toHaveCount(0);
  if (process.env.E2E_EVIDENCE_DIR) await captureScreenshot(page, { path: `response-notice-unavailable-${locale}.png`, fullPage: true }, "respond-with-post");

  if (test.info().config.metadata.publicReading) {
    const anonymous = await browser.newContext();
    try {
      const reader = await anonymous.newPage();
      await reader.goto(source);
      await expect(reader.locator("#reply")).toBeVisible();
      await expect(reader.locator('#reply button[formaction*="respond="]')).toHaveCount(0);
    } finally { await anonymous.close(); }
  }
});

test("carries long reply writing to a new post and retains the local reply copy", async ({ page, browser }) => {
  await useMember(page, "zrespond_transfer@example.com", "/t/new");
  if (test.info().config.metadata.publicReading) {
    const destination = await page.request.post("/v/en", { headers: { Origin: state().baseURL }, form: { intent: "post-here" }, maxRedirects: 0 });
    expect(destination.status()).toBe(302);
    await page.goto("/t/new?village=en");
  }
  const source = await publish(page, "A source for transferred writing.");
  const writing = "Unfinished reply\n\n" + "Paragraph text. ".repeat(1000);
  await ready(page);
  await body(page).fill(writing);
  await page.getByRole("button", { name: (await uiMessages(page)).respond_with_post, exact: true }).click();
  await expect(page).toHaveURL(/\/t\/new\?respond=\d+$/);
  await expect(body(page)).toHaveValue(new RegExp(`\\n\\n${writing.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
  expect(page.url()).not.toContain("Paragraph");
  await page.goBack();
  await expect(body(page)).toHaveValue(writing);
  if (test.info().config.metadata.publicReading) {
    await page.getByRole("button", { name: (await uiMessages(page)).respond_with_post, exact: true }).click();
    await expect(page).toHaveURL(/\/t\/new\?respond=\d+$/);
    await ready(page);
    await expect(page.locator('input[name="village"]')).toHaveValue("en");
    await publish(page, await body(page).inputValue());
  }
  const native = await browser.newContext({ javaScriptEnabled: false, storageState: await page.context().storageState() });
  try {
    const plain = await native.newPage();
    await plain.goto(source);
    await body(plain).fill(writing);
    await plain.getByRole("button", { name: (await uiMessages(page)).respond_with_post, exact: true }).click();
    await expect(body(plain)).toHaveValue(new RegExp(`\\n\\n${writing.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
    await expect(plain).toHaveURL(/\/t\/new\?respond=\d+$/);
  } finally { await native.close(); }
});

richEditorTest("round-trips the opening source link through the default rich editor without creating a mention", async ({ page }) => {
  await useMember(page, "zrespond_rich_author@example.com", "/t/new");
  await page.evaluate(key => localStorage.removeItem(key), EDITOR_MODE_STORAGE_KEY);
  await page.reload();
  await ready(page);
  const rich = () => page.locator('[contenteditable="true"][role="textbox"]');
  await expect(rich()).toBeVisible();
  await rich().fill("Source material");
  await page.locator('input[name="title"]').fill("Rich opening @zrespond_rich_author");
  await page.getByRole("button", { name: (await uiMessages(page)).submit_post, exact: true }).click();
  await expect(page).toHaveURL(/\/t\/\d+\?posted=/);
  const source = new URL(page.url()).pathname;
  await useMember(page, "zrespond_rich_writer@example.com", source);
  const messages = await uiMessages(page);
  await page.getByRole("button", { name: messages.respond_with_post, exact: true }).click();
  await expect(rich()).toBeVisible();
  await expect(rich().locator(`a[href="${source}"]`)).toHaveCount(1);
  // The trailing blank line in the prefill is a separate typing paragraph.
  await expect(rich().locator("p")).toHaveCount(2);
  await rich().locator("p").last().click();
  await page.keyboard.insertText("A separate response paragraph.");
  await expect(body(page)).toHaveValue(/\n\nA separate response paragraph\./);
  await chooseEditorMode(page, messages.editor_mode_markdown);
  await chooseEditorMode(page, messages.editor_mode_rich);
  await expect(rich().locator(`a[href="${source}"]`)).toHaveCount(1);
  await page.getByRole("button", { name: messages.submit_post, exact: true }).click();
  await expect(page).toHaveURL(/\/t\/\d+\?posted=/);
  await expect(page.locator(`[data-reading-body] a[href="${source}"]`)).toHaveCount(1);
  await expect(page.locator("[data-reading-body] a.mention")).toHaveCount(0);
  const markdown = await (await page.request.get(`${new URL(page.url()).pathname}.md`)).text();
  expect(markdown).not.toContain("\\\n");
  expect(markdown).toContain("\n\nA separate response paragraph.");
  await useMember(page, "zrespond_rich_author@example.com", "/notifications");
  await expect(page.getByRole("link", { name: messagePattern(messages.notification_mention, { handle: "zrespond_rich_writer", title: /.+/ }) })).toHaveCount(0);
  await expect(page.getByRole("link", { name: messagePattern(messages.notification_response_to_topic, { handle: "zrespond_rich_writer", title: "Rich opening @zrespond_rich_author" }) })).toHaveCount(1);
});

richEditorTest("omits the untouched trailing typing paragraph after editing response and share openings", async ({ page }) => {
  await useMember(page, "zrespond_opening_edit@example.com", "/t/new");
  await chooseEditorMode(page, (await uiMessages(page)).editor_mode_markdown);
  const source = await publish(page, "Source material for an opening-only edit.", "Opening title");
  await page.evaluate(key => localStorage.removeItem(key), EDITOR_MODE_STORAGE_KEY);
  const paths = [
    `/t/new?respond=${source.split("/").at(-1)}`,
    `/t/new?${new URLSearchParams({ url: "https://example.org/opening-edit", title: "Shared title", text: "A shared paragraph." })}`,
  ];
  for (const path of paths) await test.step(path.includes("respond=") ? "response" : "share", async () => {
    await page.goto(path);
    await ready(page);
    const rich = page.locator('[contenteditable="true"][role="textbox"]');
    await expect(rich.locator(":scope > p").last()).toBeEmpty();
    const link = rich.locator("p").first().locator("a").first();
    const label = await link.innerText();
    await link.evaluate(element => {
      (element.closest('[contenteditable="true"]') as HTMLElement).focus();
      window.getSelection()!.setPosition(element.firstChild!, 0);
    });
    await page.keyboard.press("Delete");
    await expect(link).toHaveText(label.slice(1));
    await page.getByRole("button", { name: (await uiMessages(page)).submit_post, exact: true }).click();
    await expect(page).toHaveURL(/\/t\/\d+\?posted=/);
    await expect(page.locator('[data-reading-body] a').first()).toHaveText(label.slice(1));
    const markdown = await (await page.request.get(`${new URL(page.url()).pathname}.md`)).text();
    expect.soft(markdown).not.toMatch(/<br\b/i);
    expect.soft(markdown).not.toContain("\\\n");
    if (!path.includes("respond=")) expect(markdown).toContain("\n\n> A shared paragraph.");
  });
});

richEditorTest("keeps transferred reply paragraphs separate while editing and publishing", async ({ page }) => {
  await useMember(page, "zrespond_rich_transfer@example.com", "/t/new");
  await chooseEditorMode(page, (await uiMessages(page)).editor_mode_markdown);
  const source = await publish(page, "A source for rich transferred writing.");
  await ready(page);
  await body(page).fill("First reply paragraph.\n\nSecond reply paragraph.");
  await page.evaluate(key => localStorage.removeItem(key), EDITOR_MODE_STORAGE_KEY);
  await page.getByRole("button", { name: (await uiMessages(page)).respond_with_post, exact: true }).click();
  const rich = page.locator('[contenteditable="true"][role="textbox"]');
  await expect(rich.locator("p")).toHaveCount(3);
  await rich.locator("p").last().click();
  await page.keyboard.press("Control+End");
  await page.keyboard.insertText(" Continued.");
  await page.getByRole("button", { name: (await uiMessages(page)).submit_post, exact: true }).click();
  await expect(page).toHaveURL(/\/t\/\d+\?posted=/);
  const markdown = await (await page.request.get(`${new URL(page.url()).pathname}.md`)).text();
  expect(markdown).not.toContain("\\\n");
  expect(markdown).toContain("\n\nFirst reply paragraph.\n\nSecond reply paragraph. Continued.");
});

test("restores local and server writing without reinserting the source link", async ({ page }) => {
  await useMember(page, "zrespond_recovery@example.com", "/t/new");
  const source = await publish(page, "A short source without a title.");
  const destination = `/t/new?respond=${source.split("/").at(-1)}`;
  await page.goto(destination);
  await ready(page);
  await expect(body(page)).toHaveValue(new RegExp(source));
  const untouched = "My draft replaces the whole opening line.";
  await page.route("**/drafts/autosave", route => route.abort());
  await body(page).fill(untouched);
  await expect.poll(() => page.evaluate(() => Object.keys(localStorage).some(key => key.startsWith("tomola:draft:") && JSON.parse(localStorage.getItem(key)!).body === "My draft replaces the whole opening line."))).toBe(true);
  await page.reload();
  await expect(body(page)).toHaveValue(untouched);
  // A different interface language changes the initial sentence, while the
  // response's stored writing stays reachable through the existing recovery UI.
  await page.context().addCookies([{ name: "PARAGLIDE_LOCALE", value: "ja", url: state().baseURL }]);
  await page.reload();
  await page.getByRole("button", { name: (await uiMessages(page)).local_draft_open, exact: true }).click();
  await expect(body(page)).toHaveValue(untouched);
  await page.unroute("**/drafts/autosave");
  await body(page).fill("Saved server writing without a source link.");
  await expect(page.locator("[data-draft-autosave]")).toHaveAttribute("data-draft-autosave", "saved");
  const draftId = await page.locator('input[name="fromDraft"]').inputValue();
  await page.reload();
  await expect(body(page)).toHaveValue("Saved server writing without a source link.");
  await page.goto(`/drafts/${draftId}?respond=${source.split("/").at(-1)}`);
  await expect(body(page)).toHaveValue("Saved server writing without a source link.");
  await expect(page.locator('input[name="title"]')).toBeEmpty();
});

test("reads a Japanese response in English using the original post's saved title translation", async ({ page }) => {
  await page.context().addCookies([{ name: "PARAGLIDE_LOCALE", value: "ja", url: state().baseURL }]);
  await useMember(page, "zresponse_line@example.com", "/t/new");
  const source = await publish(page, "論考の本文です。言葉の意味について考えます。", "論考の題");
  const sourceId = source.split("/").at(-1)!;
  await page.goto(`/t/new?respond=${sourceId}`);
  await ready(page);
  const opening = await body(page).inputValue();
  const response = await publish(page, opening + "元の論考に応えて、自分の考えを書きます。", "応答の論考");
  const responseId = response.split("/").at(-1)!;
  await page.context().addCookies([{ name: "PARAGLIDE_LOCALE", value: "en", url: state().baseURL }]);
  await useMember(page, "zresponse_line_reader@example.com", `${source}?lang=en&tr=${sourceId}`);
  await expect(page.locator(`#p-${sourceId} .longread`)).toHaveAttribute("lang", "en", { timeout: 45_000 });
  const translatedTitle = await page.locator("h1").innerText();
  await page.goto(`${response}?lang=en&tr=${responseId}`);
  const article = page.locator(`#p-${responseId} .longread`);
  await expect(article).toHaveAttribute("lang", "en", { timeout: 45_000 });
  const first = article.locator(":scope > p").first();
  const expectedText = enMessages.response_post_prefill.replace(/\[([^\n]+)\]\(\{url\}\)/, "$1")
    .replace("{title}", translatedTitle).replace("{handle}", "zresponse_line");
  await expect(first).toHaveText(expectedText);
  await expect(first.locator(`a[href="${source}"]`)).toHaveCount(1);
  await expect(first.locator('a[href^="/u/"], [data-mention]')).toHaveCount(0);
  for (const width of [1280, 1100, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await captureScreenshot(page, { path: `ja-response-en-${width}.png`, fullPage: true }, "response-line-i18n");
  }
});
