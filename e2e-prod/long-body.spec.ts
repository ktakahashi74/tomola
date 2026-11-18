import { enMessages as en } from "../e2e/helpers";
import { EDITOR_MODE_STORAGE_KEY } from "../app/lib/rich-editor";
import { test, expect, signUp, state } from "./helpers";

test("counts mixed-width topic text and preserves it when the limit is exceeded", async ({ browser }) => {
  const context = await browser.newContext({ baseURL: state().baseURL });
  const page = await context.newPage();
  try {
    await signUp(page, "long_body_limits@example.com", { handle: "long_body_limits", mainLang: "en" });
    await page.evaluate(key => localStorage.setItem(key, "markdown"), EDITOR_MODE_STORAGE_KEY);
    await page.goto("/t/new");
    const body = page.locator('textarea[name="body"]');
    await expect(page.getByText(en.error_topic_body_too_long, { exact: true })).toBeVisible();
    const exact = "a".repeat(20_000) + "あ".repeat(40_000);
    await body.fill(exact);
    await expect(page.getByRole("status").filter({ hasText: "0 characters left" })).toBeVisible();
    expect(await body.evaluate(element => (element as HTMLTextAreaElement).checkValidity())).toBe(true);
    await body.fill(exact + "b");
    await expect(page.getByRole("status").filter({ hasText: en.topic_body_count_over.replace("{count}", "1") })).toBeVisible();
    expect(await body.evaluate(element => (element as HTMLTextAreaElement).validationMessage)).toBe(en.error_topic_body_too_long);
    await page.getByRole("button", { name: en.submit_post, exact: true }).click();
    await expect(page).toHaveURL(/\/t\/new/);
    await expect(body).toHaveValue(exact + "b");
    await body.fill(exact.slice(0, -1));
    await expect(page.getByRole("status").filter({ hasText: "2 characters left" })).toBeVisible();
    expect(await body.evaluate(element => (element as HTMLTextAreaElement).checkValidity())).toBe(true);
    // NFC combines the two code points into one wide character before counting.
    await body.fill("a".repeat(99_998) + "か\u3099");
    await expect(page.getByRole("status").filter({ hasText: "0 characters left" })).toBeVisible();
    await body.fill("𝄞".repeat(65_536) + "a");
    await expect(page.getByRole("status").filter({ hasText: en.error_topic_body_too_long })).toBeVisible();
    expect(await body.evaluate(element => (element as HTMLTextAreaElement).checkValidity())).toBe(false);
    await body.fill("Mixed-width text. ");
    await page.getByRole("button", { name: en.editor_mode_rich, exact: true }).click();
    const rich = page.locator('[contenteditable="true"][role="textbox"]');
    await expect(rich).toBeVisible();
    await rich.focus();
    await rich.press("ControlOrMeta+End");
    await rich.evaluate((element, text) => {
      const data = new DataTransfer(); data.setData("text/plain", text);
      element.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    }, exact + "b");
    await expect(page.getByRole("status").filter({ hasText: /characters too many/ })).toBeVisible();
    await page.getByRole("button", { name: en.submit_post, exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: en.error_topic_body_too_long })).toBeVisible();
    await expect(rich).toBeVisible();
    await expect(body).toBeHidden();
  } finally { await context.close(); }
});
