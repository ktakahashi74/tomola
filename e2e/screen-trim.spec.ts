import fs from "node:fs";
import path from "node:path";
import { expect, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { test } from "./editor-fixture";
import { LANG_LABELS } from "../app/lib/languages";
import { captureScreenshot, useMember, clientHeaders, jaMessages as ja, state, waitForFormReady, openPostSettings, openReplyMore } from "./helpers";

test.describe.configure({ mode: "serial" });
let context: BrowserContext, page: Page;
const posted: string[] = [];
const directory = path.join(process.cwd(), ".data/screen-trim/screenshots");
// A question is an option on the post.
const stance = (target = page) => target.getByRole("checkbox", { name: ja.asks_stance_checkbox, exact: true });
const tips = (target = page) => target.locator("details[data-writing-tips]");
const snapshot = async (name: string, width: number) => {
  await page.evaluate(() => window.scrollTo(0, 0));
  await captureScreenshot(page, { path: path.join(directory, `${name}-${width}.png`), fullPage: true }, "e2e-screen-trim");
};
async function italic(emphasis: Locator) {
  await expect(emphasis).toBeVisible();
  expect(await emphasis.evaluate(element => getComputedStyle(element).fontStyle)).toBe("italic");
  expect(await emphasis.evaluate(element => getComputedStyle(element).fontFamily)).toBe(await emphasis.locator("..").evaluate(element => getComputedStyle(element).fontFamily));
}

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext({ locale: "ja-JP", extraHTTPHeaders: clientHeaders("203.0.113.181") });
  page = await context.newPage();
  const fixture = JSON.parse(fs.readFileSync(path.join(state().dir, "screen-trim.json"), "utf8"));
  await useMember(page, "screen_trimmer@example.com");
  fs.mkdirSync(directory, { recursive: true });
});
test.afterAll(async () => {
  if (!context) return;
  for (const url of posted) await context.request.post(url, { headers: { Origin: state().baseURL }, form: { intent: "delete", entryId: url.split("/").at(-1)!, confirm: "1" }, maxRedirects: 0 });
  await context.close();
});
test("new-post explanations follow the question choice and introduction entry point", async () => {
  for (const width of [1366, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/t/new"); await waitForFormReady(page.locator("form", { has: page.locator('textarea[name="body"]') }));
    await expect(page.getByRole("button", { name: ja.media_insert, exact: true })).toBeVisible();
    await expect(page.locator('input[name="intro"]')).toHaveCount(0);
    expect(await page.locator("main form").evaluate(form => new FormData(form as HTMLFormElement).has("intro"))).toBe(false);
    // The title is named by its placeholder (no label or help text drawn); what only a question needs is said once a question is chosen.
    await expect(page.locator('input[name="title"]')).toHaveAttribute("placeholder", ja.field_title);
    await expect(page.getByText(ja.media_help, { exact: true })).not.toBeVisible();
    expect(await page.locator("main").ariaSnapshot()).not.toContain(ja.asks_stance_help);
    await snapshot("new-normal", width);
    await page.getByRole("checkbox", { name: ja.asks_stance_checkbox, exact: true }).check();
    await expect(page.getByText(ja.asks_stance_help, { exact: true })).toBeVisible();
    await expect(page.locator('input[name="title"]')).toHaveAttribute("placeholder", ja.field_title_placeholder_question);
    await snapshot("new-question", width);
    await page.getByRole("checkbox", { name: ja.asks_stance_checkbox, exact: true }).uncheck();
    await expect(page.getByText(ja.asks_stance_help, { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: ja.media_insert, exact: true })).toBeVisible();
    await tips().locator("summary").click();
    await expect(tips().getByText(ja.media_help, { exact: true })).toBeVisible();
    await snapshot("new-writing-tips", width);
    await page.goto("/t/new?intro=1");
    await expect(page.getByRole("checkbox", { name: ja.intro_checkbox, exact: true })).toBeChecked();
    await expect(page.getByRole("button", { name: ja.media_insert, exact: true })).toBeVisible();
    await snapshot("new-introduction", width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
});

test("question explanations and a refused introduction preserve inputs with JavaScript", async ({ browser }) => {
  const native = await browser.newContext({ locale: "ja-JP", javaScriptEnabled: true, storageState: await context.storageState(), extraHTTPHeaders: clientHeaders("203.0.113.182") });
  try {
    const target = await native.newPage();
    await target.goto("/t/new");
    await waitForFormReady(target.locator("form", { has: target.locator('textarea[name="body"]') }));
    await expect(target.locator('input[name="intro"]')).toHaveCount(0);
    await expect(target.getByText(ja.asks_stance_help, { exact: true })).not.toBeVisible();
    await expect(target.locator('input[name="title"]')).toHaveAttribute("placeholder", ja.field_title);
    await stance(target).check();
    await expect(stance(target)).toBeChecked();
    await expect(target.locator('input[name="title"]')).toHaveAttribute("placeholder", ja.field_title_placeholder_question);
    await expect(target.getByText(ja.asks_stance_help, { exact: true })).toBeVisible();
    await target.getByRole("checkbox", { name: ja.asks_stance_checkbox, exact: true }).uncheck();
    await expect(target.getByText(ja.asks_stance_help, { exact: true })).not.toBeVisible();
    expect(await target.locator("main").ariaSnapshot()).not.toContain(ja.asks_stance_help);
    await target.goto("/t/new?intro=1");
    await waitForFormReady(target.locator("form", { has: target.locator('textarea[name="body"]') }));
    await expect(target.locator('input[name="intro"]')).toBeChecked();
    await target.locator('input[name="title"]').fill("Introduction refusal fixture");
    await target.locator('textarea[name="body"]').fill("Keep the introduction after refusal.");
    await stance(target).check();
    // Submit an invalid combination to exercise server refusal beyond the UI guard.
    await target.locator('input[name="intro"]').evaluate(element => { (element as HTMLInputElement).checked = true; });
    await target.getByRole("button", { name: ja.submit_post, exact: true }).click();
    await expect(target.getByText(ja.intro_error_invalid, { exact: true })).toBeVisible();
    // The JavaScript guard keeps a question out of the introduction category.
    await expect(stance(target)).toBeChecked();
    await expect(target.locator('input[name="intro"]')).not.toBeChecked();
    await expect(target.locator('input[name="title"]')).toHaveValue("Introduction refusal fixture");
    await expect(target.locator('textarea[name="body"]')).toHaveValue("Keep the introduction after refusal.");
  } finally { await native.close(); }
});

test("CJK emphasis slants in articles, replies and previews without changing its font", async () => {
  const bodies = { ja: "まわりの文字と *強調する文字* を読む。", "zh-Hans": "阅读周围文字与 *强调的文字*。", ko: "주변 글자와 *강조한 글자* 를 읽는다." };
  for (const lang of ["ja", "zh-Hans", "ko"] as const) {
    const response = await context.request.post("/t/new", { headers: { Origin: state().baseURL }, form: { lang, title: `Emphasis fixture ${lang}`, body: bodies[lang] }, maxRedirects: 0 });
    expect(response.status()).toBe(302);
    const url = new URL(response.headers().location, state().baseURL).pathname; posted.push(url);
    const id = url.split("/").at(-1)!;
    expect((await context.request.post(url, { headers: { Origin: state().baseURL }, form: { lang, body: bodies[lang] }, maxRedirects: 0 })).status()).toBe(302);
    await page.goto(`${url}?lang=${lang}&orig=${id}`);
    await italic(page.locator("[data-reading-body] em").first());
    await italic(page.locator('[id^="c-"] .longread em').first());
    if (lang === "ja") for (const width of [1366, 390]) { await page.setViewportSize({ width, height: 900 }); await snapshot("article-italic", width); }
    await page.goto("/t/new");
    await waitForFormReady(page.locator("main form"));
    await page.locator('textarea[name="body"]').fill(bodies[lang]);
    await openPostSettings(page);
    await page.getByRole("combobox", { name: ja.field_lang, exact: true }).click();
    await page.getByRole("option", { name: LANG_LABELS[lang], exact: true }).click();
    await page.getByRole("button", { name: ja.preview, exact: true }).click();
    await expect(page.locator("main form .longread")).toHaveAttribute("lang", lang);
    await italic(page.locator("main form .longread em"));
    await page.goto(`${url}/edit`);
    await expect(page.getByRole("button", { name: ja.media_insert, exact: true })).toBeVisible();
    await expect(page.getByText(ja.media_help, { exact: true })).not.toBeVisible();
    await tips().locator("summary").click();
    await expect(tips().getByText(ja.media_help, { exact: true })).toBeVisible();
    await page.goto(url);
    await openReplyMore(page);
    await expect(page.locator("#reply").getByText(ja.media_help, { exact: true })).toHaveCount(0);
  }
});
