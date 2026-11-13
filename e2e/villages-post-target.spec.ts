import { saveEditorDraft } from "./draft-autosave-helper";
import fs from "node:fs";
import path from "node:path";
import { expect, type Page } from "@playwright/test";
import { acceptSignedWrite, enableSigningAuthenticator } from "./signing-helper";
import { test } from "./editor-fixture";
import { localizedLanguageLabel } from "../app/lib/language-label";
import { captureScreenshot, enMessages as m, openUserMenu, openPlaces, state, useMember, waitForClientRoute, waitForFormReady, chooseEditorMode, openPostSettings, uiMessages, formatMessage } from "./helpers";


const name = (lang: string) => m.village_language_name.replace("{language}", new Intl.DisplayNames(["en"], { type: "language", languageDisplay: "standard" }).of(lang)!);
// The visible destination is named by its label and current village.
const destination = (page: Page, label = m.field_village) => page.getByRole("button", { name: new RegExp(`^${label}\\b`) });
async function select(page: Page, slug: string, label = m.field_village) {
  await destination(page, label).click();
  await page.getByRole("menuitemradio", { name: name(slug), exact: true }).click();
  // The popup's accessible name follows the selected value, not the field
  // label. Wait for its exit animation before resizing or checking overflow.
  await expect(page.locator('[data-slot="dropdown-menu-content"]')).toHaveCount(0);
  await expect(page.locator('input[name="village"]')).toHaveValue(slug);
  await expect(destination(page, label)).toHaveAccessibleName(`${label} ${name(slug)}`);
}
async function placement(page: Page, slug: string) {
  await expect(page).toHaveURL(/\/t\/\d+/);
  await expect(page.locator("[data-article-details]").getByRole("link", { name: name(slug), exact: true })).toHaveCount(0);
  const markdown = await page.request.get(page.url().replace(/(\/t\/\d+).*/, "$1.md"));
  expect(markdown.status()).toBe(200);
  expect(await markdown.text()).toMatch(new RegExp(`^village: ["']?${slug}["']?$`, "m"));
}

async function joinJapaneseVillage(page: Page) {
  const response = await page.request.post("/v/ja", { form: { intent: "join" }, headers: { Origin: state().baseURL }, maxRedirects: 0 });
  expect(response.status()).toBe(200);
  await page.reload();
  await waitForClientRoute(page);
}

async function captureDestination(page: Page, screen: string, locale: string) {
  if (!process.env.E2E_EVIDENCE_DIR) return;
  for (const width of [1280, 1100, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await captureScreenshot(page, { path: `${screen}-${locale}-${width}.png`, fullPage: true, animations: "disabled" }, "post-target-top-resume");
  }
}

test("switches the destination in Markdown and rich writing without changing language", async ({ page }) => {
  for (const actor of ["switch", "rich"]) {
    await useMember(page, `vtarget_${actor}@example.com`, "/t/new"); await waitForClientRoute(page);
    await select(page, "ja");
    if (actor === "rich") {
      await chooseEditorMode(page, m.editor_mode_rich);
      await page.locator('[contenteditable="true"]').fill("An owned rich destination.");
    } else await page.locator('textarea[name="body"]').fill("An owned Markdown destination.");
    await page.getByRole("button", { name: m.submit_post, exact: true }).click();
    await placement(page, "ja");
  }
});

test("joins through post-here and opens that village as the explicit destination", async ({ page }) => {
  await useMember(page, "vtarget_join@example.com", "/v/ja");
  // Joining is the one main action of a village that has not been joined; writing follows from the joined village's own button.
  await page.getByRole("button", { name: m.village_join, exact: true }).click();
  await page.getByRole("link", { name: m.village_post_here, exact: true }).click();
  await expect(page).toHaveURL(/\/t\/new\?village=ja/);
  await expect(page.locator('input[name="village"]')).toHaveValue("ja");
  await page.locator('textarea[name="body"]').fill("An owned post-here destination.");
  await page.getByRole("button", { name: m.submit_post, exact: true }).click();
  await placement(page, "ja");
});

test("saves a default destination and keeps the village list in the main navigation", async ({ page }) => {
  await useMember(page, "vtarget_settings@example.com", "/settings"); await waitForClientRoute(page);
  await page.getByRole("combobox", { name: m.settings_default_village, exact: true }).selectOption("ja");
  await expect(page.locator("#settings-village").getByRole("status")).toHaveText(m.settings_saved);
  await page.goto("/t/new"); await waitForClientRoute(page);
  await expect(page.locator('input[name="village"]')).toHaveValue("ja");
  const menu = await openUserMenu(page);
  await expect(page.getByRole("menuitem", { name: m.villages_title, exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(menu).not.toBeVisible();
  await expect((await openPlaces(page)).getByRole("link", { name: m.nav_all_villages, exact: true })).toHaveAttribute("href", "/villages");
});

test("shows a draft target in Markdown and approval, and publishes a changed target", async ({ page }) => {
  const { draftId } = JSON.parse(fs.readFileSync(path.join(state().dir, "village-target.json"), "utf8"));
  await useMember(page, "vtarget_draft@example.com");
  await page.goto(`/drafts/${draftId}`); await waitForClientRoute(page);
  expect(await (await page.request.get(`/drafts/${draftId}.md`)).text()).toMatch(/village: ["']?en/);
  await select(page, "ja");
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await captureScreenshot(page, { path: `draft-${width}.png`, animations: "disabled" }, "villages-post-target");
  }
  await page.getByRole("button", { name: m.draft_publish, exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText(name("ja"), { exact: false })).toBeVisible();
  await expect(dialog.getByText(m.village_public_reach, { exact: true })).toBeVisible();
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await captureScreenshot(page, { path: `approval-${width}.png`, animations: "disabled" }, "villages-post-target");
  }
  await dialog.getByRole("button", { name: m.confirm_publish, exact: true }).click();
  await placement(page, "ja");
});

test("pasted frontmatter chooses a village until a manual selection overrides it; invalid targets preserve the body", async ({ page }) => {
  await useMember(page, "vtarget_frontmatter@example.com", "/t/new"); await waitForClientRoute(page);
  const body = page.locator('textarea[name="body"]');
  await body.fill("---\nvillage: ja\n---\nAn owned frontmatter destination.");
  await openPostSettings(page);
  await expect(destination(page)).toContainText(name("ja"));
  await page.getByRole("button", { name: m.submit_post, exact: true }).click(); await placement(page, "ja");
  await page.goto("/t/new"); await waitForClientRoute(page);
  await body.fill("---\nvillage: missing-target\n---\nAn owned unavailable destination.");
  await page.getByRole("button", { name: m.submit_post, exact: true }).click();
  await expect(page.getByText(m.village_required, { exact: false })).toBeVisible();
  await expect(body).toHaveValue(/village: missing-target/);
  await select(page, "en");
  await page.getByRole("button", { name: m.submit_post, exact: true }).click(); await placement(page, "en");
  // Selecting the already displayed default must still be an explicit choice and close the menu.
  await page.goto("/t/new"); await waitForClientRoute(page);
  await select(page, "en");
  await body.fill("---\nvillage: ja\n---\nAn owned explicit default destination.");
  await openPostSettings(page);
  await expect(destination(page)).toContainText(name("en"));
  await page.getByRole("button", { name: m.submit_post, exact: true }).click(); await placement(page, "en");
});

test("destination controls fit desktop and mobile widths", async ({ page }) => {
  await useMember(page, "vtarget_screens@example.com");
  const dir = path.join(state().dir, "village-target-screenshots"); fs.mkdirSync(dir, { recursive: true });
  for (const width of [1280, 390]) for (const [label, url] of [["write", "/t/new"], ["settings", "/settings"], ["village", "/v/ja"]]) {
    await page.setViewportSize({ width, height: 900 }); await page.goto(url); await waitForClientRoute(page);
    if (label === "settings") await page.locator("#settings-village").scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await captureScreenshot(page, { path: path.join(dir, `${label}-${width}.png`), animations: "disabled" }, "villages-post-target");
  }
});

test("unrecognized village syntax returns the resolved destination before an unsigned post", async ({ page }) => {
  await useMember(page, "vtarget_recheck@example.com");
  for (const declaration of ['"village": ja']) {
    await page.goto("/t/new"); await waitForClientRoute(page);
    const body = `---\n${declaration}\n---\nAn owned reviewed browser destination.`;
    await page.locator('textarea[name="body"]').fill(body);
    await expect(page.locator('input[name="villageDisplayed"]')).toHaveValue("en");
    await page.getByRole("button", { name: m.submit_post, exact: true }).click();
    await expect(page).toHaveURL(/\/t\/new$/);
    await expect(page.getByText(m.village_changed, { exact: true })).toBeVisible();
    await openPostSettings(page);
    await expect(destination(page)).toContainText(name("ja"));
    await expect(page.locator('textarea[name="body"]')).toHaveValue(body);
    await expect(page.locator('input[name="villageDisplayed"]')).toHaveValue("ja");
    await page.getByRole("button", { name: m.submit_post, exact: true }).click(); await placement(page, "ja");
  }
  // Duplicate YAML keys are ordinary body text; an eager display hint must yield to that server decision too.
  await page.goto("/t/new"); await waitForClientRoute(page);
  const body = "---\nvillage: ja\n\"village\": en\n---\nAn owned literal header.";
  await page.locator('textarea[name="body"]').fill(body);
  await expect(page.locator('input[name="villageDisplayed"]')).toHaveValue("ja");
  await page.getByRole("button", { name: m.submit_post, exact: true }).click();
  await expect(page.getByText(m.village_changed, { exact: true })).toBeVisible();
  await openPostSettings(page);
  await expect(destination(page)).toContainText(name("en"));
  await expect(page.locator('input[name="villageDisplayed"]')).toHaveValue("en");
  await page.getByRole("button", { name: m.submit_post, exact: true }).click(); await placement(page, "en");
});

test("a conflict copy retains its destination and saves do not reset an open destination menu", async ({ page }) => {
  await page.clock.install();
  const save = async () => { await page.clock.fastForward(3000); await saveEditorDraft(page); };
  await useMember(page, "vtarget_conflict@example.com", "/t/new"); await waitForClientRoute(page);
  await page.locator('textarea[name="body"]').fill("Original owned draft.");
  await save();
  await expect(page).toHaveURL(/\/drafts\/\d+/); await waitForClientRoute(page);
  const response = await page.request.post(page.url(), { form: { intent: "save", body: "Another tab's latest draft.", lang: "en", village: "ja", version: "1" }, headers: { Origin: new URL(page.url()).origin } });
  expect(response.status()).toBe(200);
  await page.locator('textarea[name="body"]').fill("My retained draft, with its own destination.");
  await save();
  await expect(page.locator('[data-draft-autosave]')).toContainText(m.draft_autosave_copied);
  await expect(page.locator('textarea[name="body"]')).toHaveValue("My retained draft, with its own destination.");
  // Hold the real save response until the destination menu is open. The saved
  // version, unlike the earlier "Draft saved." notice, proves this save landed.
  const version = page.locator('input[name="version"]');
  for (const chooseWhileSaving of [false, true]) {
    const savedTarget = chooseWhileSaving ? "ja" : "en";
    const nextTarget = chooseWhileSaving ? "en" : "ja";
    await select(page, savedTarget);
    const before = await version.inputValue();
    let release!: () => void, captured = false;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const saveUrl = (url: URL) => url.pathname === "/drafts/autosave";
    await page.route(saveUrl, async route => {
      if (route.request().method() !== "POST") return route.continue();
      const response = await route.fetch(); captured = true;
      await gate;
      await route.fulfill({ response });
    });
    try {
      await page.clock.fastForward(3000);
      await expect.poll(() => captured).toBe(true);
      await openPostSettings(page);
      await destination(page).click();
      if (chooseWhileSaving) await page.getByRole("menuitemradio", { name: name(nextTarget), exact: true }).click();
      release();
      await expect(version).not.toHaveValue(before);
      await expect(page.locator('[data-draft-autosave]')).toHaveAttribute("data-draft-autosave", "saved");
      if (!chooseWhileSaving) {
        await expect(page.getByRole("menuitemradio", { name: name(savedTarget), exact: true })).toBeChecked();
        await page.getByRole("menuitemradio", { name: name(nextTarget), exact: true }).click();
      }
      await expect(page.locator('input[name="village"]')).toHaveValue(nextTarget);
      await expect(page.locator('input[name="villageDisplayed"]')).toHaveValue(nextTarget);
      await expect(destination(page)).toHaveAccessibleName(`${m.field_village} ${name(nextTarget)}`);
    } finally {
      release();
      await page.unroute(saveUrl);
    }
  }
  await select(page, "ja");
  await page.getByRole("button", { name: m.draft_publish, exact: true }).click();
  await placement(page, "ja");
});

test("a stale browser publication adopts the latest contents and destination before publishing", async ({ page }) => {
  await useMember(page, "vtarget_stale@example.com", "/t/new");
  await waitForFormReady(page.locator("form", { has: page.locator('textarea[name="body"]') }));
  await page.locator('textarea[name="body"]').fill("Initial destination draft");
  await select(page, "en"); await saveEditorDraft(page);
  const path = new URL(page.url()).pathname;
  const version = await page.locator('input[name="version"]').inputValue();
  await page.route("**/drafts/autosave", route => route.abort());
  const changed = await page.request.post(path, { form: { intent: "save", version, body: "Latest draft in another village", lang: "en", village: "ja", villageExplicit: "1" }, headers: { Origin: state().baseURL } });
  expect(changed.status()).toBe(200);
  await page.locator('textarea[name="body"]').fill("My retained unsaved wording");
  const posting = page.waitForResponse(res => res.request().method() === "POST" && new URL(res.url()).pathname === `${path}.data`);
  await page.getByRole("button", { name: m.draft_publish, exact: true }).click();
  expect((await posting).status()).toBe(409);
  await expect(page.locator('textarea[name="body"]')).toHaveValue("My retained unsaved wording");
  await page.getByRole("button", { name: m.ai_write_use_latest, exact: true }).click();
  await waitForFormReady(page.locator("form", { has: page.locator('textarea[name="body"]') }));
  await expect(page.locator('textarea[name="body"]')).toHaveValue("Latest draft in another village");
  await expect(page.locator('input[name="version"]')).toHaveValue(String(Number(version) + 1));
  await openPostSettings(page);
  await expect(destination(page)).toContainText(name("ja"));
  await expect(page.locator('input[name="village"]')).toHaveValue("ja");
  await expect(page.getByRole("textbox", { name: m.ai_write_retained, exact: true })).toHaveValue("My retained unsaved wording");
  await page.unroute("**/drafts/autosave");
  await page.getByRole("button", { name: m.draft_publish, exact: true }).click();
  await placement(page, "ja");
});

test("native forms review changed destinations and resubmit the saved draft version without JavaScript", async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  try {
    const page = await context.newPage();
    await useMember(page, "vtarget_recheck_nojs@example.com", "/t/new");
    await page.locator('textarea[name="body"]').fill('---\n"village": ja\n---\nAn owned native destination.');
    await page.getByRole("button", { name: m.submit_post, exact: true }).click();
    await expect(page.getByText(m.village_changed, { exact: true })).toBeVisible();
    await expect(page.locator('input[name="villageDisplayed"]')).toHaveValue("ja");
    await page.getByRole("button", { name: m.submit_post, exact: true }).click(); await placement(page, "ja");
    await page.goto("/t/new?village=ja");
    await page.locator('textarea[name="body"]').fill("An owned native draft.");
    await page.getByRole("button", { name: m.save_draft, exact: true }).click();
    await expect(page).toHaveURL(/\/drafts\/\d+/);
    // Emulate an older cached form that did not carry the displayed destination.
    await page.locator('input[name="villageDisplayed"]').evaluate(element => element.remove());
    await page.getByRole("button", { name: m.draft_publish, exact: true }).click();
    await expect(page.getByText(m.village_changed, { exact: true })).toBeVisible();
    await expect(page.locator('input[name="version"]')).toHaveValue("2");
    await expect(page.locator('input[name="villageDisplayed"]')).toHaveValue("ja");
    await page.getByRole("button", { name: m.draft_publish, exact: true }).click(); await placement(page, "ja");
  } finally { await context.close(); }
});

test("frontmatter stays in Markdown through destination review and rich editing requests", async ({ page }) => {
  await useMember(page, "vtarget_serialized@example.com");
  for (const declaration of ['"village": ja', 'village: ja\n"village": en']) {
    await page.goto("/t/new"); await waitForClientRoute(page);
    await chooseEditorMode(page, m.editor_mode_markdown);
    const body = `---\n${declaration}\n---\nOwned literal header with **emphasis**.`;
    const input = page.locator('textarea[name="body"]');
    await input.fill(body);
    await chooseEditorMode(page, m.editor_mode_rich);
    await expect(page.getByText(m.editor_mode_markdown_only, { exact: true })).toBeVisible();
    await expect(page.locator('[contenteditable="true"]')).toHaveCount(0);
    await expect(input).toHaveValue(body);
    await page.getByRole("button", { name: m.submit_post, exact: true }).click();
    await expect(page.getByText(m.village_changed, { exact: true })).toBeVisible();
    await chooseEditorMode(page, m.editor_mode_rich);
    await expect(page.locator('[contenteditable="true"]')).toHaveCount(0);
    await expect(input).toHaveValue(body);
    await page.getByRole("button", { name: m.submit_post, exact: true }).click();
    await placement(page, declaration.includes('"village": en') ? "en" : "ja");
  }
});

test("signed frontmatter conflicts update the displayed village before the second submission", async ({ page }) => {
  await useMember(page, "vtarget_signed_review@example.com", "/settings"); await waitForClientRoute(page);
  await enableSigningAuthenticator(page);
  await page.getByRole("button", { name: m.settings_passkeys_add, exact: true }).click();
  await expect(page.getByText(m.settings_passkeys_added, { exact: true })).toBeVisible();
  let challenges = 0;
  page.on("request", request => { if (new URL(request.url()).pathname === "/signing" && request.postDataJSON()?.intent === "challenge") challenges++; });
  for (const declaration of ['"village": ja', 'village: ja\n"village": en']) {
    await page.goto("/t/new"); await waitForClientRoute(page);
    await expect(page.locator('form[data-ready="true"]')).toBeVisible();
    const body = `---\n${declaration}\n---\nAn owned signed destination.`;
    const input = page.locator('textarea[name="body"]');
    await input.fill(body);
    const expected = declaration.includes('"village": en') ? "en" : "ja";
    const previousChallenges = challenges;
    const response = page.waitForResponse(response => new URL(response.url()).pathname === "/signing" && response.request().postDataJSON()?.intent === "preview");
    await page.getByRole("button", { name: m.submit_post, exact: true }).click();
    const rejected = await response;
    expect(rejected.status()).toBe(409);
    expect(await rejected.json()).toEqual({ error: "village_changed", village: expected });
    await expect(page.getByText(m.village_changed, { exact: true })).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.locator('input[name="villageDisplayed"]')).toHaveValue(expected);
    await expect(page.locator('input[name="village"]')).toHaveValue(expected);
    await expect(page.locator('input[name="villageExplicit"]')).toHaveValue("0");
    await openPostSettings(page);
    await expect(destination(page)).toContainText(name(expected));
    await expect(input).toHaveValue(body);
    expect(challenges).toBe(previousChallenges);
    await input.dispatchEvent("input");
    await expect(page.locator('input[name="villageDisplayed"]')).toHaveValue(expected);
    await page.getByRole("button", { name: m.submit_post, exact: true }).click();
    await expect(page.getByRole("dialog").locator("[data-signing-village]")).toContainText(name(expected));
    await acceptSignedWrite(page);
    await placement(page, expected);
    expect(challenges).toBe(previousChallenges + 1);
  }
  // A late destination correction must not overwrite text edited while previewing.
  await page.goto("/t/new"); await waitForClientRoute(page);
  const input = page.locator('textarea[name="body"]');
  await input.fill('---\n"village": ja\n---\nA pending reviewed body.');
  let release!: () => void, captured = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/signing", async route => {
    if (route.request().postDataJSON()?.intent !== "preview") return route.continue();
    const response = await route.fetch(); captured = true;
    await gate;
    await route.fulfill({ response });
  });
  try {
    await page.getByRole("button", { name: m.submit_post, exact: true }).click();
    await expect.poll(() => captured).toBe(true);
    await input.fill("A new body entered while previewing.");
  } finally { release(); }
  await expect(page.getByText(m.signing_changed, { exact: true })).toBeVisible();
  await expect(input).toHaveValue("A new body entered while previewing.");
  await expect(page.locator('input[name="villageDisplayed"]')).toHaveValue("en");
  await page.unroute("**/signing");
  await page.getByRole("button", { name: m.submit_post, exact: true }).click();
  await acceptSignedWrite(page);
  await placement(page, "en");

  // An unavailable destination fails during the signature preview too. Keep its
  // error on the destination, without starting a passkey challenge.
  await page.goto("/t/new"); await waitForClientRoute(page);
  await input.fill("---\nvillage: missing-target\n---\nAn owned unavailable signed destination.");
  const previousChallenges = challenges;
  await page.getByRole("button", { name: m.submit_post, exact: true }).click();
  const target = page.locator("[data-village-target]");
  await expect(target.getByRole("alert")).toHaveText(m.village_required);
  await expect(target.getByRole("button")).toBeFocused();
  await expect(target.getByRole("button")).toHaveAccessibleDescription(`${m.village_public_reach} ${m.village_required}`);
  await expect(page.getByRole("alert")).toHaveCount(1);
  await expect(page.locator('input[name="villageDisplayed"]')).toHaveValue("missing-target");
  expect(challenges).toBe(previousChallenges);
  await select(page, "en");
  await page.getByRole("button", { name: m.submit_post, exact: true }).click();
  await acceptSignedWrite(page);
  await placement(page, "en");
});

for (const locale of ["en", "ja"] as const) test(`keeps the destination above writing and out of settings in ${locale}`, async ({ page }) => {
  await page.context().addCookies([{ name: "PARAGLIDE_LOCALE", value: locale, domain: "localhost", path: "/" }]);
  await useMember(page, `target_top_${locale}@example.com`, "/t/new");
  await waitForClientRoute(page);
  await joinJapaneseVillage(page);
  const text = await uiMessages(page);
  const target = page.locator("[data-village-target]");
  const button = target.getByRole("button");
  const summary = page.locator("[data-post-settings] > summary");
  const assertTop = async () => {
    await expect(target).toHaveCount(1);
    await expect(button).toBeVisible();
    await expect(target.getByText(text.field_village, { exact: true })).toBeVisible();
    await expect(button).toHaveAccessibleDescription(text.village_public_reach);
    await expect(page.locator("[data-post-settings] [data-village-target]")).toHaveCount(0);
    expect(await target.evaluate(element => {
      const title = element.closest("form")!.querySelector('input[name="title"]')!;
      const question = element.closest("form")!.querySelector('input[name="asksStance"]')!;
      return Boolean(element.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING)
        && Boolean(title.compareDocumentPosition(question) & Node.DOCUMENT_POSITION_FOLLOWING);
    })).toBe(true);
  };
  await assertTop();
  await expect(button).toContainText(text.village_personal);
  await expect(summary).toHaveText(`${text.post_summary_lang_auto}·${text.post_settings_change}`);
  await captureDestination(page, "new", locale);
  await page.locator('textarea[name="body"]').fill("An owned post in my own village.");
  await page.getByRole("button", { name: text.submit_post, exact: true }).click();
  await expect(page).toHaveURL(/\/t\/\d+/);
  await expect(page.getByRole("status").filter({ hasText: formatMessage(text.posted_topic_public, { place: text.village_personal, lang: localizedLanguageLabel("en", locale) }) })).toBeVisible();
  await captureDestination(page, "posted-personal", locale);
  await page.goto("/t/new");
  await waitForClientRoute(page);
  await assertTop();
  await button.click();
  const languageVillage = text.village_language_name.replace("{language}", new Intl.DisplayNames([locale], { type: "language", languageDisplay: "standard" }).of("ja")!);
  await page.getByRole("menuitemradio", { name: languageVillage, exact: true }).click();
  await expect(button).toContainText(languageVillage);
  await expect(summary).toContainText(text.post_summary_lang_auto);
  await page.locator('textarea[name="body"]').fill("An owned post with a visible destination.");
  await saveEditorDraft(page);
  await expect(page).toHaveURL(/\/drafts\/\d+/);
  await waitForClientRoute(page);
  await assertTop();
  await expect(button).toContainText(languageVillage);
  await expect(summary).not.toContainText(languageVillage);
  await captureDestination(page, "draft", locale);
  await page.getByRole("button", { name: text.draft_publish, exact: true }).click();
  await expect(page).toHaveURL(/\/t\/\d+/);
  await expect(page.getByRole("status").filter({ hasText: formatMessage(text.posted_topic_public, { place: languageVillage, lang: localizedLanguageLabel("en", locale) }) })).toBeVisible();
  await captureDestination(page, "posted-village", locale);
  const markdown = await page.request.get(page.url().replace(/(\/t\/\d+).*/, "$1.md"));
  expect(await markdown.text()).toMatch(/^village: ["']?ja["']?$/m);
});

test("shows destination errors beside the visible control, focuses it and keeps language settings closed", async ({ page }) => {
  await useMember(page, "target_top_error@example.com", "/t/new");
  await waitForClientRoute(page);
  await joinJapaneseVillage(page);
  const target = page.locator("[data-village-target]");
  const button = target.getByRole("button");
  const body = page.locator('textarea[name="body"]');
  for (const [header, message] of [["village: missing-target", m.village_required], ['"village": ja', m.village_changed]]) {
    await body.fill(`---\n${header}\n---\nAn owned destination error.`);
    await page.getByRole("button", { name: m.submit_post, exact: true }).click();
    await expect(target.getByRole("alert")).toHaveText(message);
    await expect(button).toHaveAttribute("aria-invalid", "true");
    await expect(button).toHaveAccessibleDescription(`${m.village_public_reach} ${message}`);
    await expect(button).toBeFocused();
    await expect(page.locator("[data-post-settings]")).not.toHaveAttribute("open");
    await expect(page.getByRole("alert")).toHaveCount(1);
  }
  await select(page, "en");
  await page.getByRole("button", { name: m.submit_post, exact: true }).click();
  await placement(page, "en");
});

test("keeps draft destination errors at the top after a refused publication", async ({ page }) => {
  await useMember(page, "target_top_draft@example.com", "/t/new?village=ja");
  await waitForClientRoute(page);
  await joinJapaneseVillage(page);
  await page.locator('textarea[name="body"]').fill("An owned draft destination review.");
  await saveEditorDraft(page);
  await expect(page).toHaveURL(/\/drafts\/\d+/);
  await waitForClientRoute(page);
  await page.locator('input[name="villageDisplayed"]').evaluate(element => { (element as HTMLInputElement).value = "en"; });
  await page.getByRole("button", { name: m.draft_publish, exact: true }).click();
  const target = page.locator("[data-village-target]");
  await expect(target.getByRole("alert")).toHaveText(m.village_changed);
  await expect(target.getByRole("button")).toBeFocused();
  await expect(target.getByRole("button")).toHaveAccessibleDescription(`${m.village_public_reach} ${m.village_changed}`);
  await expect(page.getByRole("alert")).toHaveCount(1);
  await expect(page.locator("[data-post-settings]")).not.toHaveAttribute("open");
});

test("wraps a long destination without horizontal overflow and keeps ordinary destinations on one row", async ({ page }) => {
  await useMember(page, "target_top_long@example.com", "/t/new");
  await waitForClientRoute(page);
  const name = `Destination ${"x".repeat(100)}`;
  const created = await page.request.post("/villages/new", { form: { slug: "target-top-long", name, kind: "open", sourceLang: "en", description: "" }, headers: { Origin: state().baseURL }, maxRedirects: 0 });
  expect(created.status()).toBe(302);
  try {
    await page.goto("/t/new");
    await waitForClientRoute(page);
    const target = page.locator("[data-village-target]");
    const button = target.getByRole("button");
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      const label = await target.getByText(m.field_village, { exact: true }).boundingBox();
      const value = await button.boundingBox();
      expect(label!.y + label!.height / 2).toBeGreaterThanOrEqual(value!.y);
      expect(label!.y + label!.height / 2).toBeLessThanOrEqual(value!.y + value!.height);
    }
    await button.click();
    await page.getByRole("menuitemradio", { name, exact: true }).click();
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(button).toContainText(name);
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await captureScreenshot(page, { path: `long-destination-${width}.png`, animations: "disabled" }, "post-target-top");
    }
  } finally {
    const ended = await page.request.post("/v/target-top-long", { form: { intent: "end", confirm: "end" }, headers: { Origin: state().baseURL }, maxRedirects: 0 });
    expect(ended.status()).toBe(302);
  }
});
