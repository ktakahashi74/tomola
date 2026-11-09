import { test, expect, useMember, watchCsp } from "./helpers";
import { enMessages as en, messagePattern, waitForFormReady } from "../e2e/helpers";
import { baseOf, localDraftKey, olderLocalDraftKey } from "../app/lib/local-draft";

test.use({ serviceWorkers: "block" });

test("independent and legacy set-asides can be selected and opened under the production CSP", async ({ page }) => {
  const watch = await watchCsp(page);
  await useMember(page, "older_keep_prod@example.com");
  await page.route("**/drafts/autosave**", route => route.abort());
  await page.goto("/t/new");
  const body = page.locator('textarea[name="body"]').first(), form = page.locator("form", { has: body }).first();
  await waitForFormReady(form);
  await expect(form).toHaveAttribute("data-draft-recovery", "ready");
  const owner = await page.evaluate(() => sessionStorage.getItem("tomola:draft-owner"));
  expect(owner).toBeTruthy();
  const key = localDraftKey(owner!, "topic-new:::");
  await page.evaluate(({ key, legacy, base }) => {
    localStorage.setItem(legacy, JSON.stringify({ body: "Legacy writing", base, savedAt: 1000 }));
    localStorage.setItem(`${legacy}:independent`, JSON.stringify({ body: "Independent writing", title: "Stored title", fields: '[["lang","en"]]', base, savedAt: 2000 }));
  }, { key, legacy: olderLocalDraftKey(key), base: baseOf("", "") });
  await page.reload();
  await waitForFormReady(form);
  await expect(form).toHaveAttribute("data-draft-recovery", "ready");
  await expect(page.getByText(messagePattern(en.local_draft_count, { count: 2 }))).toBeVisible();
  await body.fill("Live writing to preserve");
  await page.getByRole("button", { name: en.local_draft_next, exact: true }).click();
  await page.getByRole("button", { name: en.local_draft_next, exact: true }).click();
  await page.getByRole("button", { name: en.local_draft_open, exact: true }).click();
  await expect(body).toHaveValue("Independent writing");
  const writing = await page.evaluate(key => Object.keys(localStorage).filter(name => name.startsWith(key)).map(name => JSON.parse(localStorage.getItem(name)!).body), key);
  expect(writing).toEqual(expect.arrayContaining(["Legacy writing", "Independent writing", "Live writing to preserve"]));
  expect(watch.violations).toEqual([]);
  expect(watch.pageErrors).toEqual([]);
  expect(watch.hydrationWarnings).toEqual([]);
});
