import fs from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { enMessages as m, openVillageManagement, state, useMember, waitForClientRoute } from "./helpers";

// The villages are made in Japanese; the fake translation engine writes "[en] <text>", so a translated name is easy to tell from the original.
async function makeVillage(page: Page, slug: string, name: string, description: string) {
  await page.goto("/villages/new"); await waitForClientRoute(page);
  await page.getByLabel(m.village_kind_open_option, { exact: true }).check();
  await page.getByLabel(m.village_name_field, { exact: true }).fill(name);
  await page.getByLabel(m.village_slug_field, { exact: true }).fill(slug);
  await page.getByLabel(m.village_description_field, { exact: true }).fill(description);
  await page.getByRole("button", { name: m.village_create, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/v/${slug}$`));
}
const fromJapanese = m.label_from_lang_machine.replace("{lang}", "Japanese");

test("an English reader sees a village made in Japanese in English in the list and on its page, and reads the original one press away", async ({ page, browser }) => {
  await useMember(page, "vtr_list_author@example.com");
  await makeVillage(page, "vtr-kyoto", "京都の集い", "京都で集まります。");
  // The author reads the original in the language it was written in: no translation is offered.
  await expect(page.getByRole("heading", { name: "京都の集い", exact: true })).toBeVisible();
  await expect(page.getByText(fromJapanese)).toHaveCount(0);
  const context = await browser.newContext({ locale: "en-US" });
  try {
    const reader = await context.newPage();
    await useMember(reader, "vtr_list_reader@example.com", "/villages");
    // The translation is made by the worker after the village is saved.
    await expect(async () => {
      await reader.reload();
      await expect(reader.getByRole("link", { name: "[en] 京都の集い", exact: true })).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 45_000 });
    // The original name stays for the tooltip; no label or badge is added to a list row.
    await expect(reader.getByRole("link", { name: "[en] 京都の集い", exact: true })).toHaveAttribute("title", "京都の集い");
    await expect(reader.locator("main").getByText("[en] 京都で集まります。", { exact: true })).toBeVisible();
    await reader.getByRole("link", { name: "[en] 京都の集い", exact: true }).click();
    await expect(reader).toHaveURL(/\/v\/vtr-kyoto$/);
    await expect(reader.getByRole("heading", { name: "[en] 京都の集い", exact: true })).toBeVisible();
    await expect(reader.getByText(fromJapanese)).toBeVisible();
    await reader.getByRole("link", { name: m.show_original, exact: true }).click();
    await expect(reader).toHaveURL(/\?vorig=1$/);
    await expect(reader.getByRole("heading", { name: "京都の集い", exact: true })).toBeVisible();
    await expect(reader.locator("main").getByText("京都で集まります。", { exact: true })).toHaveAttribute("lang", "ja");
    await reader.getByRole("link", { name: m.show_translation, exact: true }).click();
    await expect(reader.getByRole("heading", { name: "[en] 京都の集い", exact: true })).toBeVisible();
    // Without JavaScript the same switch is a plain link.
    expect((await reader.request.get("/v/vtr-kyoto?vorig=1")).status()).toBe(200);
    expect(await (await reader.request.get("/v/vtr-kyoto?vorig=1")).text()).toContain("京都の集い");
    // The places drawer names the village in the reader's language too, once the reader has joined.
    await reader.getByRole("button", { name: m.village_join, exact: true }).click();
    await reader.goto("/villages"); await waitForClientRoute(reader);
    await expect(reader.getByRole("link", { name: "[en] 京都の集い", exact: true }).first()).toBeVisible();
  } finally { await context.close(); }
});

test("after the owner changes the name the original is read until the new translation is ready", async ({ page, browser }) => {
  await useMember(page, "vtr_edit_author@example.com");
  await makeVillage(page, "vtr-edit", "編集の集い", "編集の説明です。");
  const context = await browser.newContext({ locale: "en-US" });
  const held = path.join(state().dir, "fake-village-translation-hold");
  try {
    const reader = await context.newPage();
    await useMember(reader, "vtr_edit_reader@example.com", "/v/vtr-edit");
    await expect(async () => {
      await reader.reload();
      await expect(reader.getByRole("heading", { name: "[en] 編集の集い", exact: true })).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 45_000 });
    // Hold the next translation of the new name until the original has been observed.
    fs.writeFileSync(held, "編集後の集い");
    await openVillageManagement(page);
    await page.getByText(m.village_edit, { exact: true }).click();
    // The form holds the original, not the translation (the author reads Japanese, so the two are told apart by the reader's page below).
    await expect(page.getByLabel(m.village_name_field, { exact: true })).toHaveValue("編集の集い");
    await page.getByLabel(m.village_name_field, { exact: true }).fill("編集後の集い");
    await page.getByRole("button", { name: m.save_changes, exact: true }).click();
    await expect(page.getByRole("heading", { name: "編集後の集い", exact: true })).toBeVisible();
    await reader.reload(); await waitForClientRoute(reader);
    // Neither the old translation nor a half-made new one: the new original, with no label.
    await expect(reader.getByRole("heading", { name: "編集後の集い", exact: true })).toBeVisible();
    await expect(reader.getByText(fromJapanese)).toHaveCount(0);
    await expect(reader.getByRole("heading", { name: "[en] 編集の集い", exact: true })).toHaveCount(0);
    fs.rmSync(held, { force: true });
    await expect(async () => {
      await reader.reload();
      await expect(reader.getByRole("heading", { name: "[en] 編集後の集い", exact: true })).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 45_000 });
    await expect(reader.getByText(fromJapanese)).toBeVisible();
  } finally { fs.rmSync(held, { force: true }); await context.close(); }
});

test("the create form starts with the main language, and the owner can change it", async ({ page }) => {
  await useMember(page, "vtr_form_author@example.com", "/villages/new"); await waitForClientRoute(page);
  const language = page.getByLabel(m.village_source_lang_field, { exact: true });
  await expect(language).toHaveValue("ja");
  await language.selectOption("en");
  await page.getByLabel(m.village_name_field, { exact: true }).fill("Kyoto circle");
  await page.getByLabel(m.village_slug_field, { exact: true }).fill("vtr-form");
  await page.getByLabel(m.village_description_field, { exact: true }).fill("We meet in Kyoto.");
  await page.getByRole("button", { name: m.village_create, exact: true }).click();
  await expect(page).toHaveURL(/\/v\/vtr-form$/);
  // The form holds the language that was chosen, and the original texts.
  await openVillageManagement(page);
  await page.getByText(m.village_edit, { exact: true }).click();
  await expect(page.getByLabel(m.village_source_lang_field, { exact: true })).toHaveValue("en");
  await expect(page.getByLabel(m.village_name_field, { exact: true })).toHaveValue("Kyoto circle");
});
