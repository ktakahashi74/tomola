import { expect, type Page } from "@playwright/test";
import { test } from "./editor-fixture";
import { baseOf } from "../app/lib/local-draft";
import { beforeHydration } from "./support/prehydration";
import { captureScreenshot, enMessages as m, state, useMember as restoreWritingMember, waitForClientRoute, waitForFormReady } from "./helpers";
import { acceptSignedWrite, enableSigningAuthenticator } from "./signing-helper";
import { pressAcrossHydration } from "./support/early-actions";

const body = (page: Page) => page.locator('textarea[name="body"]').first();
const form = (page: Page) => page.locator("form", { has: body(page) }).first();
const saved = (page: Page) => expect(page.locator("[data-draft-autosave]")).toHaveAttribute("data-draft-autosave", "saved");
const navigate = (page: Page, path: string) => page.evaluate(path => {
  void (window as unknown as { __reactRouterDataRouter: { navigate(path: string): Promise<void> } }).__reactRouterDataRouter.navigate(path);
}, path);
async function open(page: Page, scenario: string, path = "/t/new") {
  await restoreWritingMember(page, `zwrite_${scenario}@example.com`, path);
  await waitForFormReady(form(page));
  await expect(form(page)).toHaveAttribute("data-autosave", "ready");
}
async function putRecovery(page: Page, fields: [string, string][] = []) {
  await page.evaluate(({ fields, base }) => {
    const key = Object.keys(sessionStorage).find(key => key.includes(":topic-new:") && key.endsWith(`:${history.state.draftEditorId}`));
    const owner = key?.split(":")[2];
    if (!owner) throw new Error("Missing editor identity");
    localStorage.setItem(`tomola:draft:${owner}:topic-new:::`, JSON.stringify({ title: "Recovered", body: "Recovered writing", base, savedAt: Date.now(), fields: JSON.stringify([["title", "Recovered"], ["body", "Recovered writing"], ...fields]), pending: true }));
  }, { fields, base: baseOf("", "") });
}
async function prepareRecovery(page: Page) {
  // A failed request gives the test an owned, unsent device record.
  await page.route("**/drafts/autosave**", route => route.abort());
  await body(page).fill("Device setup");
  await expect(page.locator("[data-draft-autosave]")).toHaveAttribute("data-draft-autosave", "failed");
  await page.evaluate(() => window.dispatchEvent(new Event("tomola:discard-unsaved")));
}
async function screenshots(page: Page, screen: string) {
  for (const width of [1280, 1100, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await captureScreenshot(page, { path: `${screen}-${width}.png`, fullPage: true, animations: "disabled" }, "writing-recovery");
  }
}

test("discarding recovered writing restores language, question, introduction and destination controls", async ({ page, context }) => {
  await open(page, "discard");
  expect((await page.request.post("/v/ja", { form: { intent: "join" }, headers: { Origin: state().baseURL }, maxRedirects: 0 })).ok()).toBe(true);
  await prepareRecovery(page);
  await putRecovery(page, [["lang", "ja"], ["asksStance", "1"], ["intro", "1"], ["village", "ja"], ["villageExplicit", "1"]]);
  await page.close();
  const fresh = await context.newPage();
  await fresh.route("**/drafts/autosave**", route => route.abort());
  await fresh.goto("/t/new");
  await expect(body(fresh)).toHaveValue("Recovered writing");
  await expect(fresh.locator('input[name="village"]')).toHaveValue("ja");
  await fresh.getByRole("button", { name: m.local_draft_discard, exact: true }).click();
  await expect(body(fresh)).toHaveValue("");
  await expect(fresh.getByRole("checkbox", { name: m.asks_stance_checkbox, exact: true })).not.toBeChecked();
  await expect(fresh.locator('input[name="village"]')).toHaveValue("@zwrite_discard");
  await expect(fresh.locator('input[name="villageExplicit"]')).toHaveValue("0");
  await expect.poll(() => form(fresh).evaluate(form => Object.fromEntries(new FormData(form as HTMLFormElement)))).toMatchObject({ lang: "" });
  expect(await form(fresh).evaluate(form => new FormData(form as HTMLFormElement).has("asksStance"))).toBe(false);
  expect(await form(fresh).evaluate(form => new FormData(form as HTMLFormElement).get("intro"))).not.toBe("1");
  await screenshots(fresh, "discarded");
});

test("held activation cannot overwrite a recovered server link with early keystrokes", async ({ page, context }) => {
  await open(page, "held");
  await body(page).fill("Original saved writing"); await saved(page);
  const id = await page.locator('input[name="fromDraft"]').inputValue();
  await prepareRecovery(page);
  await page.close();
  const fresh = await context.newPage();
  await beforeHydration(fresh, "/t/new", async () => {
    await body(fresh).fill("Early replacement writing");
    const box = await body(fresh).boundingBox();
    await fresh.mouse.move(box!.x + 10, box!.y + 10);
    await fresh.mouse.down();
    // Track the held pointer before the keeper decides, then edit after it has
    // mounted but while the activation guard still owns the old record.
  }, async () => {
    await waitForFormReady(form(fresh));
    await body(fresh).fill("Early replacement writing continued");
    await fresh.waitForTimeout(1200);
    await fresh.mouse.up();
    await waitForClientRoute(fresh);
  });
  await saved(fresh);
  expect(await fresh.locator('input[name="fromDraft"]').inputValue()).not.toBe(id);
  expect(await (await fresh.request.get(`/drafts/${id}`)).text()).toContain("Original saved writing");
  await expect(fresh.getByRole("button", { name: m.local_draft_open, exact: true })).toBeVisible();
});

test("opening older writing preserves the last unsaved edits and controls for recovery", async ({ page }) => {
  await open(page, "older");
  await prepareRecovery(page);
  await page.evaluate(({ base }) => {
    const key = Object.keys(localStorage).find(key => key.includes(":topic-new:") && !key.endsWith("~older") && !key.includes("~older:"))!;
    localStorage.setItem(`${key}~older`, JSON.stringify({ title: "Older", body: "Older offered writing", base, savedAt: Date.now() }));
  }, { base: baseOf("", "") });
  await page.reload();
  await expect(page.getByRole("button", { name: m.local_draft_open, exact: true })).toBeVisible();
  await body(page).fill("Final keystrokes before opening");
  await page.getByRole("button", { name: m.local_draft_open, exact: true }).click();
  await expect(body(page)).toHaveValue("Older offered writing");
  expect(await page.evaluate(() => {
    return Object.keys(localStorage).filter(key => key.includes(":topic-new:") && key.includes("~older:"))
      .map(key => JSON.parse(localStorage.getItem(key)!)).find(record => record.body === "Final keystrokes before opening");
  })).toMatchObject({ body: "Final keystrokes before opening", pending: true });
  await page.reload();
  await expect(body(page)).toHaveValue("Older offered writing");
  await page.getByRole("button", { name: m.local_draft_open, exact: true }).click();
  await expect(body(page)).toHaveValue("Final keystrokes before opening");
});

test("a fresh new-post navigation clears a hash-only editor while hash links keep writing", async ({ page }) => {
  await open(page, "hash");
  await body(page).fill("Writing on this history entry"); await saved(page);
  const id = await page.locator('input[name="fromDraft"]').inputValue();
  await navigate(page, "#note");
  await expect(page).toHaveURL(/#note$/);
  await expect(body(page)).toHaveValue("Writing on this history entry");
  await navigate(page, "/t/new");
  await expect(page).toHaveURL(/\/t\/new$/);
  await expect(body(page)).toHaveValue("");
  await expect(page.locator('input[name="fromDraft"]')).toHaveCount(0);
  expect(await (await page.request.get(`/drafts/${id}`)).text()).toContain("Writing on this history entry");
});

test("topic editing shows its fixed destination above the title without changing placement", async ({ page }) => {
  await open(page, "edit");
  await body(page).fill("Owned topic to edit"); await saved(page);
  await page.getByRole("button", { name: m.submit_post, exact: true }).click();
  await expect(page).toHaveURL(/\/t\/\d+\?posted=/);
  const path = new URL(page.url()).pathname;
  await page.goto(`${path}/edit`);
  await waitForFormReady(form(page));
  await screenshots(page, "topic-edit");
  const destination = page.locator("[data-village-target]");
  await expect(destination).toContainText(m.field_village);
  await expect(destination.getByRole("button")).toHaveCount(0);
  await expect(form(page).locator('input[name="village"]')).toHaveCount(0);
  expect(await destination.evaluate((element) => Boolean(element.compareDocumentPosition(document.querySelector('input[name="title"]')!) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
  await body(page).fill("Edited writing in the same place");
  await page.getByRole("button", { name: m.save_changes, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${path}\\?edited=`));
  expect(await (await page.request.get(`${path}.md`)).text()).toMatch(/^village: ["']?@zwrite_edit["']?$/m);
});

test("each rejected destination submission returns focus and a new signing review clears stale errors", async ({ page }) => {
  await open(page, "errors");
  await body(page).fill("---\nvillage: missing-destination\n---\nWriting needing a destination.");
  const submit = page.getByRole("button", { name: m.submit_post, exact: true });
  const destination = page.locator("[data-village-target]");
  for (let attempt = 0; attempt < 2; attempt++) {
    await submit.click();
    await expect(destination.getByRole("alert")).toHaveText(m.village_required);
    await expect(destination.getByRole("button")).toBeFocused();
  }
  await body(page).fill("");
  await enableSigningAuthenticator(page);
  await page.goto("/settings");
  await page.getByRole("button", { name: m.settings_passkeys_add, exact: true }).click();
  await expect(page.getByText(m.settings_passkeys_added, { exact: true })).toBeVisible();
  await page.locator("#settings-advanced > summary").click();
  await page.getByRole("checkbox", { name: m.settings_sign_posts_label, exact: true }).check();
  await page.locator('form', { has: page.locator('input[name="intent"][value="sign-posts"]') }).getByRole("button", { name: m.save_changes, exact: true }).click();
  await acceptSignedWrite(page);
  await expect(page).toHaveURL(/saved=sign-posts/);
  await page.goto("/t/new"); await waitForFormReady(form(page));
  await body(page).fill("---\nvillage: missing-destination\n---\nSigned writing needing a destination.");
  await submit.click();
  await expect(destination.getByRole("alert")).toHaveText(m.village_required);
  await page.route("**/signing", route => route.fulfill({ status: 400, json: { error: "body_too_complex" } }));
  await body(page).fill("A different review failure.");
  await submit.click();
  await expect(destination.getByRole("alert")).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(1);
});

test("an unavailable initial destination leaves the writer's focus alone", async ({ page }) => {
  await open(page, "focus");
  await beforeHydration(page, "/t/new?village=missing-destination", async () => { await body(page).focus(); });
  await waitForFormReady(form(page));
  await expect(page.locator("[data-village-target]").getByRole("alert")).toHaveText(m.village_required);
  await expect(body(page)).toBeFocused();
});

test("the top destination accepts a press spanning hydration", async ({ page }) => {
  await open(page, "top_press");
  await pressAcrossHydration(page, "/t/new", () => page.locator("[data-village-target]").getByRole("button"));
  await expect(page.getByRole("menu")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("[data-village-target]").getByRole("button")).toBeFocused();
});
