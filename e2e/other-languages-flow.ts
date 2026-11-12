import { expect, type Page } from "@playwright/test";
import { enMessages as en, jaMessages as ja, formatMessage, waitForClientRoute, waitForFormReady, openPostSettings } from "./helpers";

export const greekReply = "Αυτή είναι μια συζήτηση για τη γλώσσα και την επικοινωνία μεταξύ των ανθρώπων.";

export async function writeOtherLanguageReply(page: Page, locale: "en" | "ja") {
  const messages = locale === "ja" ? ja : en;
  await page.goto("/t/new");
  await waitForClientRoute(page);
  await page.getByRole("textbox", { name: messages.field_title, exact: true }).fill("Source language scenario");
  await page.locator('textarea[name="body"]').fill("A topic for our language example and the conversation about writing.");
  await page.getByRole("button", { name: messages.submit_post, exact: true }).click();
  await expect(page).toHaveURL(url => /^\/t\/\d+$/.test(url.pathname));
  const topicPath = new URL(page.url()).pathname;
  await waitForClientRoute(page);
  const form = page.locator("form", { has: page.locator('textarea[name="body"]') });
  await waitForFormReady(form);
  await form.locator('textarea[name="body"]').fill(greekReply);
  await openPostSettings(page);
  await page.getByRole("combobox", { name: messages.field_lang_reply, exact: true }).click();
  await expect(page.getByRole("option", { name: messages.source_language_other, exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await form.getByRole("button", { name: messages.submit_reply, exact: true }).click();
  const greek = new Intl.DisplayNames([locale], { type: "language" }).of("el")!;
  await expect(page.getByRole("status").filter({ hasText: formatMessage(messages.posted_reply_language, { lang: greek }) })).toBeVisible();
  await expect(page.locator('article[id^="c-"]').last()).toContainText(`[${locale}]`, { timeout: 60_000 });
  await expect(page.getByRole("status").filter({ hasText: formatMessage(messages.posted_reply_language, { lang: greek }) }).getByRole("link", { name: messages.posted_fix_lang, exact: true })).toHaveAttribute("href", /^\/c\/\d+\/edit$/);
  await page.goto("/languages");
  await expect(page.getByRole("heading", { name: messages.languages_writing_title, exact: true })).toBeVisible();
  await expect(page.getByText(messages.languages_writing_help, { exact: true })).toBeVisible();
  return topicPath;
}
