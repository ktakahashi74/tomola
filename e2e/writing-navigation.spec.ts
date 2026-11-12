import fs from "node:fs";
import path from "node:path";
import { expect, type Page } from "@playwright/test";
import { test } from "./editor-fixture";
import { chooseEditorMode, enMessages as en, state, useMember, waitForClientRoute, waitForFormReady } from "./helpers";

const body = (page: Page) => page.locator('textarea[name="body"]');
const title = (page: Page) => page.locator('input[name="title"]');
const create = (page: Page) => page.locator("header").getByRole("link", { name: en.nav_new_topic, exact: true });
const saved = (page: Page) => expect(page.locator("[data-draft-autosave]")).toHaveAttribute("data-draft-autosave", "saved");
async function open(page: Page, scenario: string) {
  await useMember(page, `writing_${scenario}@example.com`, "/t/new");
  await waitForFormReady(page.locator("form", { has: body(page) }));
  await expect(page.locator('form[data-autosave="ready"]')).toHaveCount(1);
}

for (const mode of ["md", "rich"]) test(`the header retains title-only and body writing before and after saving in ${mode}`, async ({ page }) => {
  await open(page, `new_${mode}`);
  if (mode === "rich") await chooseEditorMode(page, en.editor_mode_rich);
  await title(page).fill("A title in progress");
  const key = await page.evaluate(() => history.state.key);
  await create(page).click();
  expect(await page.evaluate(() => history.state.key)).toBe(key);
  await expect(title(page)).toHaveValue("A title in progress");
  const editor = mode === "rich" ? page.locator('[contenteditable="true"][role="textbox"]') : body(page);
  await editor.fill("Writing kept in its current editor.");
  await saved(page);
  const id = await page.locator('input[name="fromDraft"]').inputValue();
  await create(page).click();
  expect(await page.evaluate(() => history.state.key)).toBe(key);
  await expect(body(page)).toHaveValue(/Writing kept in its current editor/);
  await page.goto(`/drafts/${id}`);
  await waitForFormReady(page.locator("form", { has: body(page) }));
  await saved(page);
  await create(page).click();
  await expect(page).toHaveURL(new RegExp(`/drafts/${id}$`));
  await expect(body(page)).toHaveValue(/Writing kept in its current editor/);
  await editor.fill("A further edit before saving.");
  await create(page).click();
  await expect(page).toHaveURL(new RegExp(`/drafts/${id}$`));
  await expect(body(page)).toHaveValue(/A further edit before saving/);
});

test("empty new-post and cleared draft editors still open a fresh new-post screen", async ({ page }) => {
  await open(page, "empty");
  const key = await page.evaluate(() => history.state.key);
  await create(page).click();
  await expect.poll(() => page.evaluate(() => history.state.key)).not.toBe(key);
  await expect(body(page)).toHaveValue("");
  await body(page).fill("A draft retained when its editor is cleared.");
  await saved(page);
  const id = await page.locator('input[name="fromDraft"]').inputValue();
  await page.goto(`/drafts/${id}`);
  await waitForFormReady(page.locator("form", { has: body(page) }));
  await body(page).fill("");
  page.once("dialog", dialog => dialog.accept());
  await create(page).click();
  await expect(page).toHaveURL(/\/t\/new$/);
  await expect(body(page)).toHaveValue("");
  await expect(page.locator('main a[href="/drafts"]')).toBeVisible();
});

test("unchanged response, share and proposal starters can be left while authored writing stays", async ({ page }) => {
  await open(page, "prefill");
  const source = JSON.parse(fs.readFileSync(path.join(state().dir, "writing-language.json"), "utf8")) as { id: number };
  for (const query of [
    `respond=${source.id}`,
    new URLSearchParams({ url: "https://example.com/shared", title: "A shared page", text: "A shared excerpt" }).toString(),
    "propose_term=1&from=en&to=ja",
  ]) {
    const destination = new URL(`/t/new?${query}`, state().baseURL).href;
    await page.goto(destination);
    await waitForFormReady(page.locator("form", { has: body(page) }));
    const initialBody = await body(page).inputValue();
    expect(initialBody.trim()).not.toBe("");
    await create(page).click();
    await expect(page).toHaveURL(new URL("/t/new", state().baseURL).href);
    await expect(title(page)).toHaveValue("");
    await expect(body(page)).toHaveValue("");

    await page.goto(destination);
    await waitForFormReady(page.locator("form", { has: body(page) }));
    const edited = initialBody + "An owned addition to the starter.";
    await body(page).fill(edited);
    await saved(page);
    const key = await page.evaluate(() => history.state.key);
    await create(page).click();
    await expect(page).toHaveURL(destination);
    expect(await page.evaluate(() => history.state.key)).toBe(key);
    await expect(body(page)).toHaveValue(edited);
  }
});

test("leaving a published-post editor exposes the earlier saved draft and a path to its writing", async ({ page }) => {
  await open(page, "departure");
  const text = "Writing saved before leaving the new-post screen.";
  await body(page).fill(text);
  await saved(page);
  const id = await page.locator('input[name="fromDraft"]').inputValue();
  await page.locator("header").getByRole("link", { name: en.site_name, exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await waitForClientRoute(page);
  await create(page).click();
  await expect(page).toHaveURL(/\/t\/new$/);
  await expect(body(page)).toHaveValue("");
  await body(page).fill("A separate post while the earlier draft stays saved.");
  await page.getByRole("button", { name: en.submit_post, exact: true }).click();
  await expect(page).toHaveURL(/\/t\/\d+\?posted=/);
  await page.goto(new URL(page.url()).pathname + "/edit");
  await waitForFormReady(page.locator("form", { has: body(page) }));
  await create(page).click();
  await expect(page).toHaveURL(/\/t\/new$/);
  await expect(body(page)).toHaveValue("");
  await page.locator('main a[href="/drafts"]').click();
  await page.locator(`main a[href="/drafts/${id}"]`).click();
  await expect(body(page)).toHaveValue(text);
});

test("published-post editing retains the unsaved departure confirmation", async ({ page }) => {
  await open(page, "edit");
  await body(page).fill("An original published post.");
  await page.getByRole("button", { name: en.submit_post, exact: true }).click();
  await expect(page).toHaveURL(/\/t\/\d+\?posted=/);
  await page.goto(new URL(page.url()).pathname + "/edit");
  await waitForFormReady(page.locator("form", { has: body(page) }));
  await body(page).fill("Unsubmitted changes to the published post.");
  const dialog = page.waitForEvent("dialog");
  const clicking = create(page).click();
  await (await dialog).dismiss();
  await clicking;
  await expect(page).toHaveURL(/\/edit$/);
  await expect(body(page)).toHaveValue("Unsubmitted changes to the published post.");
  page.once("dialog", dialog => dialog.accept());
  await create(page).click();
  await expect(page).toHaveURL(/\/t\/new$/);
});
