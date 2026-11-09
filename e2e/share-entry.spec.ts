import { saveEditorDraft } from "./draft-autosave-helper";
import { expect, type BrowserContext, type Page } from "@playwright/test";
import { test } from "./editor-fixture";
import { clientHeaders, enMessages as en, requestMagicLink, confirmMagicLink, messageTitleField as titleField } from "./helpers";

test.describe.configure({ mode: "serial" });
let context: BrowserContext;
let page: Page;
test.beforeAll(async ({ browser }) => {
  context = await browser.newContext({ locale: "en-US", extraHTTPHeaders: clientHeaders("10.8.52.1") });
  page = await context.newPage();
});
test.afterAll(() => context?.close());

test("an anonymous share survives the login confirmation and waits for the member to post", async () => {
  const query = new URLSearchParams({ url: "https://example.org/a?q=1&b=2", title: "Example", text: "A shared quote" });
  const path = `/t/new?${query}`;
  await page.goto(path);
  await expect(page).toHaveURL(/\/login\?next=/);
  const link = await requestMagicLink(page, "share_login@example.com");
  expect(new URL(link).searchParams.has("next")).toBe(false);
  expect(link).not.toContain("example.org");
  expect(link).not.toContain("shared");
  await confirmMagicLink(page, link);
  await expect(page).toHaveURL(new URL(path, page.url()).href);
  await expect(titleField(page)).toHaveValue("");
  await expect(page.getByLabel(en.field_body, { exact: true })).toHaveValue("[Example](https://example.org/a?q=1&b=2)\n\n> A shared quote\n\n");
  await expect(page.getByText(en.share_prefill_notice, { exact: true })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: en.asks_stance_checkbox, exact: true })).not.toBeChecked();
});

test("Android text becomes a link and quote, and the existing draft flow preserves the member's note", async () => {
  await page.goto(`/t/new?${new URLSearchParams({ text: "Read this https://example.org/a" })}`);
  const body = page.getByLabel(en.field_body, { exact: true });
  await expect(body).toHaveValue("[https://example.org/a](https://example.org/a)\n\n> Read this\n\n");
  await body.fill(`${await body.inputValue()}My note.`);
  await saveEditorDraft(page);
  await expect(page).toHaveURL(/\/drafts\/\d+(?:\?saved=1)?$/);
  await expect(page.getByLabel(en.field_body, { exact: true })).toHaveValue("[https://example.org/a](https://example.org/a)\n\n> Read this\n\nMy note.");
});
