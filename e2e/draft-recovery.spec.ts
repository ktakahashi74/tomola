import { autosaveState } from "./autosave-clock";
import { expect } from "@playwright/test";
import { test } from "./editor-fixture";
import { captureScreenshot, enMessages as m, state, useMember, waitForFormReady } from "./helpers";

test.beforeEach(async ({ page }) => { await page.clock.install(); });

for (const gone of ["deleted", "published"] as const) test(`explicitly saves writing from a ${gone} draft as a new draft`, async ({ page }) => {
  await useMember(page, `draft_recovery_${gone}@example.com`, "/t/new");
  const body = page.locator('textarea[name="body"]').first();
  const status = page.locator("[data-draft-autosave]");
  const ids = async () => [...(await (await page.request.get("/drafts")).text()).matchAll(/href="\/drafts\/(\d+)"/g)].map(match => Number(match[1]));
  await waitForFormReady(page.locator("form", { has: body }).first());
  await body.fill("A saved beginning.");
  await autosaveState(page, "saved");
  const original = Number(await page.locator('input[name="fromDraft"]').inputValue());
  await page.goto(`/drafts/${original}`);
  const form = page.locator("form", { has: body }).first();
  await waitForFormReady(form);
  await expect(form).toHaveAttribute("data-autosave", "ready");
  const fields = await form.evaluate(form => Object.fromEntries(new FormData(form as HTMLFormElement)));
  const response = await page.request.post(`/drafts/${original}`, { headers: { Origin: state().baseURL }, form: { ...fields as Record<string, string>, intent: gone === "deleted" ? "delete" : "publish" } });
  expect(response.ok()).toBe(true);
  const failedSave = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === "/drafts/autosave");
  await body.fill("Keep the writing entered after the original disappeared.");
  await page.clock.fastForward(3000);
  expect((await failedSave).status()).toBe(404);
  await expect(status).toHaveAttribute("data-draft-autosave", "missing");
  expect(await ids()).toEqual([]);
  if (process.env.E2E_EVIDENCE_DIR) for (const width of [1280, 1100, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await captureScreenshot(page, { path: `draft-${gone}-missing-${width}.png`, fullPage: true }, process.env.TRIAL_POLICY_BEFORE ? "before" : "after");
  }
  await page.getByRole("button", { name: m.save_draft_as_new, exact: true }).click();
  await autosaveState(page, "saved");
  const [replacement] = await ids();
  expect(replacement).toBeGreaterThan(0);
  expect(replacement).not.toBe(original);
  await expect(page).toHaveURL(new RegExp(`/drafts/${replacement}$`));
  await expect(body).toHaveValue("Keep the writing entered after the original disappeared.");
  await body.fill("Continued on the replacement draft.");
  await autosaveState(page, "saved");
  if (gone === "deleted") {
    await page.getByRole("button", { name: m.draft_publish, exact: true }).click();
    await expect(page).toHaveURL(/\/t\/\d+\?posted=/);
    expect(await ids()).toEqual([]);
    return;
  }
  await page.reload();
  await expect(body).toHaveValue("Continued on the replacement draft.");
  expect(await ids()).toEqual([replacement]);
  expect((await page.request.get(`/drafts/${original}`)).status()).toBe(404);
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: m.draft_delete, exact: true }).click();
  await expect(page).toHaveURL(/\/drafts$/);
  expect(await ids()).toEqual([]);
});
