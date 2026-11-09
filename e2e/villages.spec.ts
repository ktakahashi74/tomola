import { saveEditorDraft } from "./draft-autosave-helper";
import fs from "node:fs";
import path from "node:path";
import { expect } from "@playwright/test";
import { test } from "./editor-fixture";
import { allListIds, captureScreenshot, clientHeaders, enMessages as m, state, useMember, waitForClientRoute } from "./helpers";

const name = (lang: string) => m.village_language_name.replace("{language}", new Intl.DisplayNames(["en"], { type: "language", languageDisplay: "standard" }).of(lang)!);

test("villages show public reading, placement, ordering and member join/leave", async ({ browser }) => {
  test.setTimeout(180_000);
  const fixture = JSON.parse(fs.readFileSync(path.join(state().dir, "villages.json"), "utf8")) as { topics: { id: number; title: string }[] };
  const context = await browser.newContext({ locale: "en-US", extraHTTPHeaders: clientHeaders("192.0.2.181") });
  const guest = await browser.newContext({ locale: "en-US", extraHTTPHeaders: clientHeaders("192.0.2.182") });
  try {
    const page = await context.newPage();
    const publicPage = await guest.newPage();
    await publicPage.goto("/villages");
    await expect(publicPage.getByRole("heading", { name: m.villages_title, exact: true })).toBeVisible();
    await expect(publicPage.getByRole("link", { name: name("en"), exact: true })).toBeVisible();
    await expect(publicPage.getByRole("button", { name: m.village_join, exact: true })).toHaveCount(0);
    const directory = await publicPage.request.get("/villages.md");
    expect(directory.status()).toBe(200);
    expect(await directory.text()).not.toMatch(/members:|joined:|village_id:/);
    expect(await (await publicPage.request.get("/villages.txt")).text()).toBe(await directory.text());
    await useMember(page, "villages_member@example.com", "/villages");
    // The villages the member has joined are listed under their own heading.
    await expect(page.getByRole("heading", { name: m.villages_joined_heading, exact: true })).toBeVisible();
    await page.locator("main").getByRole("link", { name: name("en"), exact: true }).click();
    await expect(page.getByRole("button", { name: m.village_leave, exact: true })).toBeVisible();
    const owned = fixture.topics.map(topic => topic.id);
    for (const [order, expected] of [["created", [owned[2], owned[1], owned[0]]], ["activity", [owned[0], owned[2], owned[1]]], ["insightful", [owned[1], owned[2], owned[0]]]] as const) {
      expect((await allListIds(page, `/v/en?order=${order}`)).filter(id => owned.includes(id))).toEqual(expected);
      expect((await allListIds(publicPage, `/v/en?order=${order}`)).filter(id => owned.includes(id))).toEqual(expected);
    }
    await page.goto("/v/ja");
    for (const topic of fixture.topics) await expect(page.locator(`#q-${topic.id}`)).toHaveCount(0);
    await page.getByRole("button", { name: m.village_join, exact: true }).click();
    await expect(page.getByRole("button", { name: m.village_leave, exact: true })).toBeVisible();
    await page.getByRole("button", { name: m.village_leave, exact: true }).click();
    await expect(page.getByRole("button", { name: m.village_join, exact: true })).toBeVisible();
    expect((await publicPage.request.get("/v/absent-village")).status()).toBe(404);
    expect((await publicPage.request.get("/v/zh-Hans.md")).status()).toBe(200);
    const topicMd = await (await publicPage.request.get(`/t/${owned[1]}.md?lang=en`)).text();
    expect(topicMd).toMatch(/village: ["']?en/);
    const villageMd = await (await publicPage.request.get("/v/en.md?order=activity")).text();
    expect(villageMd).toMatch(/title: ["']?en/);
    expect(villageMd).toContain(`p-${owned[1]}`);
    await page.goto(`/t/${owned[1]}?lang=en`);
    await expect(page.locator('[data-article-details]').getByRole("link", { name: name("en"), exact: true })).toHaveCount(0);
    const screenshots = path.join(state().dir, "village-screenshots");
    fs.mkdirSync(screenshots, { recursive: true });
    for (const [label, url] of [["villages", "/villages"], ["village", "/v/en"], ["topic", `/t/${owned[1]}?lang=en`]]) {
      await page.goto(url);
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 900 });
        await waitForClientRoute(page);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await captureScreenshot(page, { path: path.join(screenshots, `${label}-${width}.png`), animations: "disabled" }, "villages-base");
      }
    }
  } finally { await context.close(); await guest.close(); }
});

test("a member can use a personal destination without joining another village", async ({ page }) => {
  await useMember(page, "villages_other@example.com", "/t/new");
  await waitForClientRoute(page);
  await expect(page.locator('input[name="village"]')).toHaveValue("@villages_other");
  await page.locator('textarea[name="body"]').fill("An owned post without shared village membership.");
  await page.getByRole("button", { name: m.submit_post, exact: true }).click();
  await expect(page).toHaveURL(/\/t\/\d+/);
  const twin = await page.request.get(page.url().replace(/(\/t\/\d+).*/, "$1.md"));
  expect(await twin.text()).toMatch(/village: ["']?@villages_other/);
  await page.goto("/v/en");
  await page.getByRole("button", { name: m.village_join, exact: true }).click();
  await page.getByRole("button", { name: m.village_leave, exact: true }).click();
  await expect(page.getByRole("button", { name: m.village_join, exact: true })).toBeVisible();
});

test("hidden topic village metadata follows the reader's screen visibility", async ({ page }) => {
  const { hiddenId, hiddenPlace } = JSON.parse(fs.readFileSync(path.join(state().dir, "villages.json"), "utf8"));
  const url = `/t/${hiddenId}?lang=en`;
  await page.goto(url);
  await expect(page.locator('[data-article-details]').getByRole("link", { name: hiddenPlace.name, exact: true })).toHaveCount(0);
  expect(await (await page.request.get(`/t/${hiddenId}.md`)).text()).not.toContain("village:");
  await useMember(page, "villages_member@example.com");
  await page.goto(url);
  await expect(page.locator('[data-article-details]').getByRole("link", { name: hiddenPlace.name, exact: true })).toBeVisible();
  const markdown = await (await page.request.get(`/t/${hiddenId}.md`)).text();
  expect(markdown).toContain(`village: ${hiddenPlace.slug}`);
  expect(markdown).not.toContain("Hidden village content.");
});

test("a topic draft with no explicit destination publishes into its personal default", async ({ page }) => {
  await useMember(page, "villages_drafter@example.com", "/t/new");
  await waitForClientRoute(page);
  await page.locator('textarea[name="body"]').fill("An owned village draft.");
  await saveEditorDraft(page);
  await expect(page).toHaveURL(/\/drafts\/\d+/);
  await page.getByRole("button", { name: m.draft_publish, exact: true }).click();
  await expect(page).toHaveURL(/\/t\/\d+/);
  const twin = await page.request.get(page.url().replace(/(\/t\/\d+).*/, "$1.md"));
  expect(await twin.text()).toMatch(/village: ["']?@villages_drafter/);
});
