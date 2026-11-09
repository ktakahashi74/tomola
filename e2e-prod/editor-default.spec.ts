import { enMessages as en } from "../e2e/helpers";
import { EDITOR_MODE_STORAGE_KEY } from "../app/lib/rich-editor";
import { richEditorTest as test, expect, useMember, state, watchCsp } from "./helpers";


test("an unset preference opens rich text and publishes under the production CSP", async ({ browser }) => {
  const context = await browser.newContext({ baseURL: state().baseURL });
  const page = await context.newPage();
  const watch = await watchCsp(page);
  try {
    const email = "editor_default_prod@example.com";
    await useMember(page, email);
    await page.goto("/t/new");
    const rich = page.locator('[contenteditable="true"][role="textbox"]');
    await expect(rich).toBeVisible();
    expect(await page.evaluate(key => localStorage.getItem(key), EDITOR_MODE_STORAGE_KEY)).toBeNull();
    await rich.pressSequentially("Rich text under the production CSP.");
    await page.locator('input[name="title"]').fill("Default editor production");
    await page.getByRole("button", { name: en.submit_post, exact: true }).click();
    await expect(page).toHaveURL(/\/t\/\d+(?:\?.*)?$/);
    await expect(page.locator("[data-reading-body]").first()).toContainText("Rich text under the production CSP.");
    expect(watch.violations).toEqual([]);
    expect(watch.pageErrors).toEqual([]);
    expect(watch.hydrationWarnings).toEqual([]);
  } finally { await context.close(); }
});
