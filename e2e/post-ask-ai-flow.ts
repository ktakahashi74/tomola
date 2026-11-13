import fs from "node:fs";
import { expect, type Page } from "@playwright/test";
import { captureScreenshot, formatMessage, messageTitleField, uiMessages, waitForClientRoute, waitForFormReady } from "./helpers";
import type { AiQuestionResponse } from "../app/lib/ai-questions";
import { RETENTION } from "../app/lib/retention";

export async function createQuestionTopic(page: Page, title: string): Promise<string> {
  await page.goto("/t/new");
  await waitForClientRoute(page);
  await waitForFormReady(page.locator('form[method="post"]').first());
  const messages = await uiMessages(page);
  await messageTitleField(page, messages).fill(title);
  await page.locator('textarea[name="body"]').fill("The word evidence refers to a passage that supports a reading. The writer describes only the supplied text.");
  await page.getByRole("button", { name: messages.submit_post, exact: true }).click();
  await expect(page).toHaveURL(url => /^\/t\/\d+$/.test(url.pathname));
  await waitForClientRoute(page);
  return new URL(page.url()).pathname;
}

async function sendQuestion(page: Page, question: string): Promise<AiQuestionResponse> {
  const messages = await uiMessages(page);
  await page.getByLabel(messages.post_ask_question, { exact: true }).fill(question);
  const [response] = await Promise.all([
    page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname.endsWith("/ask/action")),
    page.getByRole("button", { name: messages.post_ask_submit, exact: true }).click(),
  ]);
  expect(response.status()).toBe(200);
  expect(response.headers()["cache-control"]).toContain("no-store");
  const answer = await response.json() as AiQuestionResponse;
  await expect(page.locator("[data-ai-question-answer]")).toBeVisible();
  return answer;
}

export async function postAskFlow(page: Page, options: {
  locale?: "en" | "ja"; logFile: string;
  afterAnswer?: (data: { topicPath: string; question: string; response: AiQuestionResponse }) => Promise<void>;
}) {
  const locale = options.locale ?? "en";
  const topicPath = await createQuestionTopic(page, `Private question flow ${locale}`);
  await page.context().addCookies([{ name: "PARAGLIDE_LOCALE", value: locale, url: new URL(page.url()).origin }]);
  await page.goto(`${topicPath}?lang=${locale}`);
  await waitForClientRoute(page);
  if (locale === "ja") await expect(page.locator('article[id^="p-"]')).toContainText("[ja]", { timeout: 60_000 });
  const messages = await uiMessages(page);
  await page.getByRole("link", { name: messages.post_ask_entry, exact: true }).click();
  await expect(page).toHaveURL(url => url.pathname === `${topicPath}/ask`);
  await waitForClientRoute(page);
  await expect(page.locator("html")).toHaveAttribute("lang", locale);
  const question = locale === "ja" ? "ここで証拠とは、どのような意味でしょうか。PRIVATE_ASK_JA_972ab" : "How should I read the word evidence here? PRIVATE_ASK_EN_972ab";
  const response = await sendQuestion(page, question);
  const labels = await uiMessages(page);
  await expect(page.getByRole("heading", { name: labels.post_ask_reading, exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: labels.post_ask_original, exact: true })).toHaveAttribute("href", /\?orig=\d+.*#p-\d+:~:text=/);
  if (locale === "ja") await expect(page.getByRole("link", { name: labels.post_ask_translation, exact: true })).toBeVisible();
  expect(page.url()).not.toContain("PRIVATE_ASK_");
  expect(JSON.stringify(await page.context().storageState())).not.toContain(question);
  expect(await page.evaluate(() => JSON.stringify(Object.entries(sessionStorage)))).not.toContain(question);
  expect(fs.readFileSync(options.logFile, "utf8")).not.toContain(question);
  await options.afterAnswer?.({ topicPath, question, response });
  for (const width of [1366, 390]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
    await captureScreenshot(page, { path: `question-${locale}-${width}.png`, fullPage: true, animations: "disabled" }, "post-ask-ai");
  }
  await page.goto(topicPath);
  await page.goBack();
  await waitForClientRoute(page);
  await expect(page.getByLabel(labels.post_ask_question, { exact: true })).toHaveValue("");
  await expect(page.locator("[data-ai-question-answer]")).toHaveCount(0);
  await page.reload();
  await waitForClientRoute(page);
  await expect(page.getByLabel(labels.post_ask_question, { exact: true })).toHaveValue("");
  await expect(page.locator("[data-ai-question-answer]")).toHaveCount(0);
  await sendQuestion(page, question);
  await expect(page.getByRole("button", { name: labels.post_ask_report_send, exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: labels.post_ask_report, exact: true }).click();
  const consent = page.getByRole("checkbox", { name: formatMessage(labels.post_ask_report_consent, { days: RETENTION.aiQuestionReportDays }), exact: true });
  await expect(consent).not.toBeChecked();
  await expect(page.getByRole("button", { name: labels.post_ask_report_send, exact: true })).toBeDisabled();
  await consent.check();
  await page.getByRole("button", { name: labels.post_ask_report_send, exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: labels.post_ask_reported })).toBeVisible();
  await page.getByRole("button", { name: labels.post_ask_to_author, exact: true }).click();
  await expect(page).toHaveURL(url => /^\/drafts\/\d+$/.test(url.pathname));
  await waitForClientRoute(page);
  const body = page.locator('textarea[name="body"]');
  await expect(body).toHaveValue(question);
  expect(await (await page.request.get(topicPath)).text()).not.toContain(question);
  const draftMessages = await uiMessages(page);
  const form = page.locator("form", { has: body });
  await waitForFormReady(form);
  await form.getByRole("button", { name: draftMessages.draft_publish, exact: true }).click();
  await expect(page).toHaveURL(url => url.pathname === topicPath);
  await expect(page.locator('article[id^="c-"]')).toContainText(question);
  return topicPath;
}
