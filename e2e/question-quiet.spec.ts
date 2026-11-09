import { expect, type BrowserContext, type Page } from "@playwright/test";
import { test } from "./editor-fixture";
import { captureScreenshot, useMember, clientHeaders, enMessages as en, jaMessages as ja, formatMessage, logSize, magicLinkFor, state, waitForFormReady  } from "./helpers";

test.describe.configure({ mode: "serial" });
let context: BrowserContext;
let page: Page;
let emptyPath: string;
let populatedPath: string;

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext({ locale: "en-US", extraHTTPHeaders: clientHeaders("10.26.68.1") });
  page = await context.newPage();
  await useMember(page, "question_quiet@example.com");
  const headers = { origin: state().baseURL };
  const create = async (title: string) => {
    const response = await context.request.post("/t/new", { headers, form: { title, body: "A question for discussion.", lang: "en", asksStance: "1" }, maxRedirects: 0 });
    expect(response.status()).toBe(302);
    return new URL(response.headers().location, state().baseURL).pathname;
  };
  emptyPath = await create("A question with an empty daily selection");
  populatedPath = await create("A question with a selected reason");
  // Add the reason before the first GET: the first daily draw then contains it.
  for (const stanceTag of ["agree", "objection"]) {
    const response = await context.request.post(populatedPath, { headers, form: { body: `A reply marked ${stanceTag}.`, lang: stanceTag === "agree" ? "fr" : "en", stanceTag }, maxRedirects: 0 });
    expect(response.status()).toBe(302);
  }
});
test.afterAll(() => context?.close());

for (const lang of ["en", "ja"] as const) {
  const messages = lang === "ja" ? ja : en;
  for (const width of [1280, 390]) {
    test(`empty panels, selection help and named-reply explanation work in ${lang} at width ${width}`, async ({}, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${emptyPath}?lang=${lang}`);
      const reasons = page.locator("#reasons");
      await expect(reasons.getByText(messages.reasons_empty_help)).toBeVisible();
      await expect(reasons.locator("[data-position], details")).toHaveCount(0);
      await expect(reasons.getByRole("link", { name: messages.reasons_write })).toHaveAttribute("href", `${emptyPath}?lang=${lang}#reply`);
      const objections = page.locator("#objections");
      await expect(objections.getByText(messages.objections_help)).toBeHidden();
      await objections.locator("summary").click();
      await expect(objections.getByText(messages.objections_help)).toBeVisible();
      await expect(objections.getByRole("link", { name: messages.objections_write })).toBeVisible();
      await expect(objections.getByRole("link", { name: messages.objections_new_alt })).toBeVisible();
      await objections.locator("summary").click();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await captureScreenshot(page, { path: testInfo.outputPath(`empty-${lang}-${width}.png`), fullPage: true }, "e2e-question-quiet");

      await reasons.getByRole("link", { name: messages.reasons_write }).click();
      const form = page.locator("#reply form");
      await waitForFormReady(form);
      // The tags are a short row of radio buttons above the reply field; the explanation appears once one is chosen.
      const selector = form.getByRole("radio", { name: messages.stance_tag_agree, exact: true });
      await selector.check();
      const help = form.getByText(messages.stance_tag_help, { exact: true });
      // Allow a sub-pixel edge: the help must be on screen, and rounding can leave 0.9997 of it inside.
      await expect(help).toBeInViewport({ ratio: 0.99 });
      expect(await help.evaluate(element => getComputedStyle(element).fontFamily)).toBe(await form.evaluate(element => getComputedStyle(element).fontFamily));
      await expect(selector).toHaveAttribute("aria-describedby", await help.getAttribute("id") as string);
      await captureScreenshot(page, { path: testInfo.outputPath(`reply-${lang}-${width}.png`) }, "e2e-question-quiet");

      await expect(async () => {
        await page.goto(`${populatedPath}?lang=${lang}`);
        await expect(page.locator("#reasons").getByText(formatMessage(messages.label_from_lang_machine, { lang: messages.language_name_fr }), { exact: true })).toBeVisible({ timeout: 1_000 });
      }).toPass({ timeout: 30_000 });
      await expect(page.locator("#reasons [data-position]")).toHaveCount(3);
      await expect(page.locator("#reasons [id^='reason-']")).toHaveCount(1);
      const rule = page.locator("#reasons details");
      await expect(rule.locator("summary")).toHaveText(messages.reasons_rule_summary);
      await expect(rule.getByText(messages.reasons_rule)).toBeHidden();
      await rule.locator("summary").click();
      await expect(rule.getByText(messages.reasons_rule)).toBeVisible();
      await rule.locator("summary").click();
      await expect(page.locator("#objections details")).toHaveCount(0);
      await expect(page.locator("#objections").getByRole("heading", { name: messages.objections_title, exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await captureScreenshot(page, { path: testInfo.outputPath(`populated-${lang}-${width}.png`), fullPage: true }, "e2e-question-quiet");
    });
  }
}
