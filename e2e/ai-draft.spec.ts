import { aiDraftMember } from "./member-fixtures";
import { saveEditorDraft } from "./draft-autosave-helper";
import { waitForClientRoute, enMessages } from "./helpers";
import fs from "node:fs";
import { expect, type BrowserContext, type Page } from "@playwright/test";
import { test } from "./editor-fixture";
import { captureScreenshot, formatMessage, openPostSettings, openReplyMore, useMember, clientHeaders, enMessages as en, messageTitleField as titleField, waitForFormReady, state } from "./helpers";
import { acceptSignedWrite, enableSigningAuthenticator } from "./signing-helper";

// Each case owns its draft and resets the shared editor in beforeEach.
// Default ordering permits a retry of the annotated case without rerunning its siblings.
let context: BrowserContext;
let page: Page;
const external: Array<{ url: string; headers: Record<string, string> }> = [];
const body = (target = page) => target.locator('textarea[name="body"]');
// "Write with AI" opens a panel in the page; "Ask the AI" inside it saves the draft and opens the chosen AI in another tab. The writing screen is not left.
const write = () => page.getByRole("button", { name: en.ai_write_button, exact: true });
// The choice dialog has a button of the same name (type submit); this is the one in the panel.
const ask = () => page.getByRole("button", { name: en.ai_help_ask, exact: true }).and(page.locator('button[type="button"]'));
async function openHelp() {
  if ((await write().getAttribute("aria-expanded")) !== "true") await write().click();
  await expect(page.getByRole("link", { name: en.connect_draft_link, exact: true })).toHaveAttribute("href", "/connect");
}
async function start() { await openHelp(); await ask().click(); }
// The draft that asking made from a screen that is not a draft screen travels with the form (and is removed when the form is posted).
const linkedDraft = async () => { const field = page.locator('input[name="fromDraft"]'); await expect(field).toHaveCount(1); return `/drafts/${await field.getAttribute("value")}`; };
const candidate = () => page.getByRole("textbox", { name: en.ai_write_candidate, exact: true });
const latestPrompt = () => new URL(external.at(-1)!.url).searchParams.get("q")!;
const evidence = process.env.E2E_EVIDENCE_DIR;

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext({ locale: "en-US", extraHTTPHeaders: clientHeaders("10.8.81.1") });
  // Capture every AI navigation before a network request can reach a service.
  await context.route(/^https:\/\/(chatgpt\.com|claude\.ai|ai\.example)(\/|\?)/, async route => {
    external.push({ url: route.request().url(), headers: await route.request().allHeaders() });
    await route.fulfill({ contentType: "text/html", body: "<title>Mock AI</title><p>Mock AI destination</p>" });
  });
  page = await context.newPage();
  await useMember(page, aiDraftMember(test.info().repeatEachIndex).email);
  await page.evaluate(() => localStorage.setItem("tomola.openInAi", JSON.stringify({ provider: "chatgpt" })));
});
test.afterAll(() => context?.close());
test.beforeEach(async () => {
  external.length = 0;
  for (const tab of context.pages()) if (tab !== page) await tab.close();
  if (page.url().startsWith("http")) await page.evaluate(() => {
    document.querySelector('form:has(textarea[name="body"])')?.dispatchEvent(new Event("tomola:form-discarded"));
    for (const key of Object.keys(localStorage)) if (key.startsWith("tomola:draft:")) localStorage.removeItem(key);
    window.history.replaceState({ ...window.history.state, draftEditorId: undefined }, "");
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  // Each scenario explicitly starts over; only its setup navigation discards unsent text.
  const discard = async (dialog: import("@playwright/test").Dialog) => {
    if (dialog.type() === "beforeunload") await dialog.accept(); else await dialog.dismiss();
  };
  page.once("dialog", discard);
  try { await page.goto("/t/new"); } finally { page.off("dialog", discard); }
  await waitForFormReady(page.locator('form[method="post"]').first());
});
test.afterEach(async () => {
  // Only this suite's member owns these drafts. Clean them even after an assertion fails.
  const response = await context.request.get("/drafts");
  expect(response.status()).toBe(200);
  const ids = new Set([...((await response.text()).matchAll(/href="\/drafts\/(\d+)"/g))].map(match => match[1]));
  for (const id of ids) {
    const deleted = await context.request.post(`/drafts/${id}`, { form: { intent: "delete" }, headers: { Origin: state().baseURL }, maxRedirects: 0 });
    expect(deleted.status()).toBe(302);
  }
  expect(await (await context.request.get("/drafts")).text()).not.toMatch(/href="\/drafts\/\d+"/);
});

test("shared input makes one private draft, imports once, and posts the reviewed body with its source and later notes", async () => {
  await page.evaluate(() => localStorage.removeItem("tomola.openInAi"));
  await page.goto(`/t/new?${new URLSearchParams({ url: "https://example.org/a", title: "Article", text: "Shared excerpt" })}`);
  await waitForFormReady(page.locator('form[method="post"]').first());
  const original = `${await body().inputValue()}この記事について考えたい。`;
  await body().fill(original);
  await openHelp();
  await ask().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  for (const name of [en.open_in_ai_chatgpt, en.open_in_ai_claude]) await expect(dialog.getByText(formatMessage(en.open_in_ai_provider_login, { name }), { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: en.ai_help_ask, exact: true }).click();
  const path = await linkedDraft();
  await expect.poll(() => external.length).toBe(1);
  const prompt = latestPrompt();
  expect(prompt).toContain(original);
  expect(prompt).toContain(`Language: ja`);
  expect(prompt).toContain(new URL(path, page.url()).href);
  expect(prompt).not.toMatch(/(?:\?|&)(?:k|token|key)=/);
  expect(external[0].url.length).toBeLessThanOrEqual(2000);
  expect(external[0].headers.referer).toBeUndefined();
  const popup = context.pages().find(tab => tab !== page)!;
  expect(await popup.evaluate(() => window.opener === null)).toBe(true);
  await expect(titleField(page)).toHaveValue("");
  await expect(body()).toHaveValue(original);
  await body().fill(`${original}\n\nMy later note.`);
  await ask().click();
  await expect.poll(() => external.length).toBe(2);
  // The same draft is reused, and the writing screen was never left.
  expect(await linkedDraft()).toBe(path);
  await expect(page).toHaveURL(/\/t\/new(?:\?|$)/);
  expect(latestPrompt()).toContain("My later note.");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const imported = `AI introduction. @${aiDraftMember(test.info().repeatEachIndex).handle}`;
  await candidate().fill(imported);
  await expect(page.getByText(en.ai_write_not_posted, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: en.ai_write_apply, exact: true }).evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
  const combined = `${original}\n\nMy later note.\n\n${imported}`;
  await expect(body()).toHaveValue(combined);
  await expect(page.getByRole("button", { name: en.ai_write_apply, exact: true })).toBeDisabled();
  await page.getByRole("button", { name: en.preview, exact: true }).click();
  await expect(page.locator(".longread")).toContainText("AI introduction.");
  if (evidence) {
    fs.mkdirSync(evidence, { recursive: true });
    await captureScreenshot(page, { path: `${evidence}/desktop-import.png`, fullPage: true }, "e2e-ai-draft");
    await page.setViewportSize({ width: 390, height: 844 });
    await candidate().scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await captureScreenshot(page, { path: `${evidence}/mobile-import.png`, fullPage: true }, "e2e-ai-draft");
  }
  await saveEditorDraft(page);
  await expect(page.getByText(en.draft_autosave_saved, { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/drafts\/\d+(?:\?saved=1)?$/);
  await page.reload();
  await expect(body()).toHaveValue(combined);
  await page.getByRole("button", { name: en.draft_publish, exact: true }).click();
  await expect(page).toHaveURL(/\/t\/\d+\?posted=/);
  const posted = new URL(page.url()).pathname;
  await expect(page.locator(".longread").first()).toContainText("My later note.");
  const markdown = await context.request.get(`${posted}.md`);
  expect(markdown.status()).toBe(200);
  expect(await markdown.text()).toContain(combined);
  // Remove the published fixture from the stream after checking it.
  await context.request.post(posted, { form: { intent: "delete", entryId: posted.split("/").at(-1)!, confirm: "1" }, headers: { Origin: state().baseURL } });
});

test("the dedicated editor and a narrowed handoff use current inputs without leaking excluded text or title", async () => {
  await page.goto("/t/new");
  const form = page.locator('form[action="/t/new"]');
  await waitForFormReady(form);
  await body().fill("https://example.org/a\n\nA private note excluded from AI");
  await openHelp();
  await form.getByText(en.ai_write_send, { exact: true }).click();
  await expect(page.getByLabel(en.ai_write_task, { exact: true })).toHaveValue("introduce");
  await page.getByLabel(en.ai_write_text, { exact: true }).fill("Only this excerpt");
  await expect(page.getByLabel(en.ai_write_task, { exact: true })).toHaveValue("introduce");
  await page.getByLabel(en.ai_write_task, { exact: true }).selectOption("translate");
  await ask().focus();
  await page.keyboard.press("Enter");
  await linkedDraft();
  await expect.poll(() => external.length).toBe(1);
  expect(latestPrompt()).toContain("Only this excerpt");
  expect(latestPrompt()).not.toContain("private note");
  expect(latestPrompt()).not.toContain("example.org/a");
  await expect(body()).toHaveValue("https://example.org/a\n\nA private note excluded from AI");
});

test("the check-how-it-reads task offers no pasting or draft handoff, and the guidance follows the task that was sent while the writing and the pasted text stay", async () => {
  await page.evaluate(() => localStorage.setItem("tomola.openInAi", JSON.stringify({ provider: "chatgpt" })));
  await body().fill("A draft that is still being written.");
  await openHelp();
  const task = page.getByLabel(en.ai_write_task, { exact: true });
  const apply = page.getByRole("button", { name: en.ai_write_apply, exact: true });
  const intro = page.getByText(en.ai_help_intro, { exact: true });
  const pasted = "Text pasted from an AI before changing the task";
  await candidate().fill(pasted);
  await expect(apply).toBeVisible();
  await expect(intro).toBeVisible();
  await task.selectOption("question");
  await expect(task.locator("option:checked")).toHaveText(en.ai_write_question);
  // Nothing to paste into, no button that would bring the answer into the body, and no promise about a draft address or importing.
  await expect(candidate()).toBeHidden();
  await expect(apply).toBeHidden();
  await expect(page.getByRole("button", { name: en.ai_write_undo, exact: true })).toBeHidden();
  await expect(intro).toHaveCount(0);
  await ask().click();
  await expect.poll(() => external.length).toBe(1);
  const prompt = latestPrompt();
  expect(prompt).toContain("A draft that is still being written.");
  expect(prompt).toContain("Do not write a replacement for my text");
  expect(prompt).not.toContain("Return one short Markdown body");
  expect(prompt).not.toMatch(/\/drafts\/\d+/);
  // Background saving is independent; this task sends no draft address to the AI.
  await expect(page.getByText(en.ai_write_question_help, { exact: true })).toBeVisible();
  await expect(page.getByText(en.ai_write_return_help, { exact: true })).toHaveCount(0);
  // Back to a writing task: the pasting part returns with what was in it, the body was never touched, and the guidance stays that of what was sent.
  await task.selectOption("revise");
  await expect(candidate()).toBeVisible();
  await expect(candidate()).toHaveValue(pasted);
  await expect(body()).toHaveValue("A draft that is still being written.");
  await expect(page.getByText(en.ai_write_question_help, { exact: true })).toBeVisible();
  await expect(page.getByText(en.ai_write_return_help, { exact: true })).toHaveCount(0);
  await expect(intro).toBeVisible();
  // Send a writing task, then choose the notes-only task: the guidance is still the one for the writing task that was sent (its text comes back to be pasted).
  await ask().click();
  await linkedDraft();
  await expect.poll(() => external.length).toBe(2);
  await expect(page.getByText(en.ai_write_return_help, { exact: true })).toBeVisible();
  await task.selectOption("question");
  await expect(candidate()).toBeHidden();
  await expect(page.getByText(en.ai_write_return_help, { exact: true })).toBeVisible();
  await expect(page.getByText(en.ai_write_question_help, { exact: true })).toHaveCount(0);
});

test("the check-how-it-reads task refuses an empty text without opening the AI", async () => {
  // An earlier test's writing may be restored from the browser's own copy of an unsent draft: discard it so that the body is empty.
  const discard = page.getByRole("button", { name: en.local_draft_discard, exact: true });
  await discard.waitFor({ timeout: 5_000 }).then(() => discard.click(), () => undefined);
  await body().fill("");
  await page.evaluate(() => localStorage.setItem("tomola.openInAi", JSON.stringify({ provider: "chatgpt" })));
  await openHelp();
  await page.getByLabel(en.ai_write_task, { exact: true }).selectOption("question");
  await ask().click();
  await expect(page.getByRole("alert").filter({ hasText: en.error_body })).toBeVisible();
  expect(external).toHaveLength(0);
  await expect(page.locator('input[name="fromDraft"]')).toHaveCount(0);
});

test("the check-how-it-reads task with a text too long for an address says to copy the request, and offers the copy and the plain open link", async () => {
  await page.evaluate(() => localStorage.setItem("tomola.openInAi", JSON.stringify({ provider: "chatgpt" })));
  const discard = page.getByRole("button", { name: en.local_draft_discard, exact: true });
  await discard.waitFor({ timeout: 5_000 }).then(() => discard.click(), () => undefined);
  const long = `${"A long text that cannot fit in an address. ".repeat(60)}`;
  await body().fill(long);
  await openHelp();
  await page.getByLabel(en.ai_write_task, { exact: true }).selectOption("question");
  await ask().click();
  // Nothing was opened: the address would be too long. The guidance says what to do instead, and the way to do it is there.
  const guidance = page.getByText(en.ai_write_question_help, { exact: true });
  await expect(guidance).toBeVisible();
  expect(en.ai_write_question_help).toMatch(/copy the request/i);
  await expect(page.getByRole("button", { name: en.ai_write_copy, exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: en.ai_write_open, exact: true })).toBeVisible();
  expect(external).toHaveLength(0);
  await expect(body()).toHaveValue(long);
});

test("save failures, suspension, throttling and expired login retain input and never send it to AI", async () => {
  const text = "https://example.org/a\n\nRetain this note";
  await body().fill(text);
  for (const [status, error] of [[500, "save_failed"], [429, "rate_limited"], [403, "suspended"], [401, "login_required"]] as const) {
    await page.route(/\/drafts\/(?:ai-write|autosave)$/, route => route.fulfill({ status, contentType: status === 401 ? "text/plain" : "application/json", body: status === 401 ? "Sign in" : JSON.stringify({ error }) }));
    await start();
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(ask()).toBeEnabled();
    await expect(body()).toHaveValue(text);
    expect(external).toHaveLength(0);
    if (status === 403) await expect(page.getByRole("link", { name: en.ai_write_login_link, exact: true })).toHaveCount(0);
    await page.unroute(/\/drafts\/(?:ai-write|autosave)$/);
  }
  const login = page.getByRole("link", { name: en.ai_write_login_link, exact: true });
  await expect(login).toHaveAttribute("target", "_blank");
  expect(await login.getAttribute("href")).toBe("/login?next=%2Ft%2Fnew");
});

test("edits during save stop the handoff, and retry uses the saved ID once with the latest text", async () => {
  await body().fill("https://example.org/a\n\nInitial text");
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let firstId = 0;
  let count = 0;
  let received = false;
  await page.route(/\/drafts\/(?:ai-write|autosave)$/, async route => {
    count++;
    const response = await route.fetch();
    if (count === 1) {
      firstId = (await response.json()).id;
      received = true;
      await gate;
    }
    await route.fulfill({ response });
  });
  await start();
  await expect.poll(() => received).toBe(true);
  await body().fill("https://example.org/a\n\nInitial text\n\nAdded while saving");
  await ask().evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
  release();
  await expect(page.getByText(en.ai_write_edited, { exact: true })).toBeVisible();
  expect(count).toBe(1);
  expect(external).toHaveLength(0);
  await expect(body()).toHaveValue(/Added while saving/);
  await ask().click();
  expect(await linkedDraft()).toBe(`/drafts/${firstId}`);
  await expect.poll(() => external.length).toBe(1);
  expect(count).toBe(2);
  expect(latestPrompt()).toContain("Added while saving");
  await page.unroute(/\/drafts\/(?:ai-write|autosave)$/);
});

test("long Japanese input and denied clipboard access expose all instructions without truncating", async () => {
  const text = "長い日本語の本文。".repeat(600);
  await body().fill(text);
  await page.evaluate(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: () => Promise.reject(new Error("denied")) } }));
  await start();
  await linkedDraft();
  expect(external).toHaveLength(0);
  await page.evaluate(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: () => Promise.reject(new Error("denied")) } }));
  await page.getByRole("button", { name: en.ai_write_copy, exact: true }).click();
  const instructions = page.getByRole("textbox", { name: en.ai_write_instructions, exact: true });
  await expect(instructions).toBeVisible();
  expect(await instructions.inputValue()).toContain(text);
  await instructions.focus();
  await expect(instructions).toHaveJSProperty("selectionStart", 0);
  await expect(instructions).toHaveJSProperty("selectionEnd", (await instructions.inputValue()).length);
  await expect(body()).toHaveValue(text);
  await expect(page.getByRole("link", { name: en.ai_write_open, exact: true })).toHaveAttribute("href", "https://chatgpt.com/?q=");
});

test("a blocked popup still saves and offers a detached link plus copying", async () => {
  await body().fill("https://example.org/a\n\nShort note");
  await page.evaluate(() => { window.open = () => null; });
  await start();
  await linkedDraft();
  const link = page.getByRole("link", { name: en.ai_write_open, exact: true });
  await expect(link).toHaveAttribute("rel", "noreferrer noopener");
  await expect(link).toHaveAttribute("referrerpolicy", "no-referrer");
  expect(new URL((await link.getAttribute("href"))!).searchParams.get("q")).toContain("Short note");
  expect(external).toHaveLength(0);
});

test("import preserves frontmatter as body text, rejects overflow, and undo cannot erase later edits", async () => {
  await body().fill("[Source](https://example.org/a)\n\nOriginal comment");
  await saveEditorDraft(page);
  await expect(page).toHaveURL(/\/drafts\/\d+(?:\?saved=1)?$/);
  await page.getByRole("button", { name: en.preview, exact: true }).click();
  await expect(page.locator(".longread")).toContainText("Original comment");
  await titleField(page).fill("My title");
  await openHelp();
  const ai = "---\ntitle: AI title\nlang: fr\n---\n```md\nAI text\n```";
  await candidate().fill(ai);
  await page.getByRole("button", { name: en.ai_write_apply, exact: true }).click();
  await expect(page.locator(".longread")).toHaveCount(0);
  await expect(titleField(page)).toHaveValue("My title");
  await openPostSettings(page);
  await expect(page.getByRole("combobox", { name: en.field_lang, exact: true })).toContainText("日本語");
  await expect(page.locator('input[name="lang"]')).toHaveValue("ja");
  await expect(body()).toHaveValue(`[Source](https://example.org/a)\n\nOriginal comment\n\n${ai}`);
  await page.getByRole("button", { name: en.ai_write_undo, exact: true }).click();
  await expect(body()).toHaveValue("[Source](https://example.org/a)\n\nOriginal comment");
  await page.getByRole("button", { name: en.ai_write_apply, exact: true }).click();
  await body().fill(`${await body().inputValue()}\n\nAfter import`);
  await page.getByRole("button", { name: en.ai_write_undo, exact: true }).click();
  await expect(page.getByText(en.ai_write_undo_changed, { exact: true })).toBeVisible();
  await expect(body()).toHaveValue(/After import$/);
  await body().fill("x".repeat(49999));
  await candidate().fill("Keep this candidate");
  await page.getByRole("button", { name: en.ai_write_apply, exact: true }).click();
  await expect(page.getByText(en.error_body_too_long, { exact: true })).toBeVisible();
  await expect(body()).toHaveValue("x".repeat(49999));
  await expect(candidate()).toHaveValue("Keep this candidate");
});

test("two screens preserve an imported candidate in a conflict copy and publish only the copy", async () => {
  await body().fill("Initial draft");
  await saveEditorDraft(page);
  const original = new URL(page.url()).pathname;
  const other = await context.newPage();
  await other.goto(original);
  await waitForFormReady(other.locator('form[method="post"]').first());
  await body(other).fill("Saved on another screen");
  await saveEditorDraft(other);
  await openHelp();
  await candidate().fill("Candidate stays here");
  await page.getByRole("button", { name: en.ai_write_apply, exact: true }).click();
  await saveEditorDraft(page);
  // The copied notice can be replaced by a subsequent successful autosave.
  // The new draft identity and retained writing are the durable result.
  await expect(page).toHaveURL(url => url.pathname !== original);
  expect(new URL(page.url()).pathname).not.toBe(original);
  await expect(body()).toHaveValue("Initial draft\n\nCandidate stays here");
  await expect(candidate()).toHaveValue("Candidate stays here");
  await body().fill("Edited after making the copy");
  await saveEditorDraft(page);
  expect(await (await context.request.get(original)).text()).toContain("Saved on another screen");
  await page.getByRole("button", { name: en.draft_publish, exact: true }).click();
  await expect(page).toHaveURL(/\/t\/\d+\?posted=/);
  expect((await context.request.get(original)).status()).toBe(200);
});

test("a stale browser publication returns a conflict and adopting the latest retains writing and the candidate", async () => {
  await body().fill("Initial body");
  await saveEditorDraft(page);
  const path = new URL(page.url()).pathname;
  const other = await context.newPage();
  await other.goto(path);
  await waitForFormReady(other.locator("form", { has: body(other) }));
  await body(other).fill("Latest stored body");
  await saveEditorDraft(other);
  await page.route("**/drafts/autosave", route => route.abort());
  await body().fill("Unsaved source and comment");
  await openHelp(); await candidate().fill("Candidate remains available");
  const response = page.waitForResponse(res => res.request().method() === "POST" && new URL(res.url()).pathname === `${path}.data`);
  await page.getByRole("button", { name: en.draft_publish, exact: true }).click();
  expect((await response).status()).toBe(409);
  await expect(page.getByRole("button", { name: en.ai_write_use_latest, exact: true })).toBeVisible();
  await expect(body()).toHaveValue("Unsaved source and comment");
  await page.getByRole("button", { name: en.ai_write_use_latest, exact: true }).click();
  await waitForFormReady(page.locator("form", { has: body() }));
  await expect(body()).toHaveValue("Latest stored body");
  await expect(page.getByRole("textbox", { name: en.ai_write_retained, exact: true })).toHaveValue("Unsaved source and comment");
  await openHelp(); await expect(candidate()).toHaveValue("Candidate remains available");
  await page.unroute("**/drafts/autosave");
});

test("a deleted draft cannot silently become a new one and keeps input plus the candidate on screen", async () => {
  await body().fill("Original draft");
  await saveEditorDraft(page);
  await expect(page).toHaveURL(/\/drafts\/\d+(?:\?saved=1)?$/);
  const path = new URL(page.url()).pathname;
  await openHelp();
  await candidate().fill("Keep the candidate");
  await body().fill("Keep my unsaved text");
  const deleted = await context.request.post(path, { form: { intent: "delete" }, headers: { Origin: state().baseURL }, maxRedirects: 0 });
  expect(deleted.status()).toBe(302);
  await expect(page.locator('[data-draft-autosave]')).toHaveAttribute("data-draft-autosave", "missing");
  await expect(page.getByText(en.ai_write_gone, { exact: true })).toBeVisible();
  await expect(body()).toHaveValue("Keep my unsaved text");
  await expect(candidate()).toHaveValue("Keep the candidate");
  await expect(page).toHaveURL(new URL(path, page.url()).href);
});

test("imported text is reviewed and signed only when the member chooses to publish", async () => {
  await enableSigningAuthenticator(page);
  await page.goto("/settings");
  await page.getByRole("button", { name: en.settings_passkeys_add, exact: true }).click();
  await expect(page.getByText(en.settings_passkeys_added, { exact: true })).toBeVisible();
  async function preference(enabled: boolean) {
    if (!(await page.locator("#settings-advanced").evaluate(element => (element as HTMLDetailsElement).open))) await page.locator("#settings-advanced > summary").click();
    await page.getByRole("checkbox", { name: en.settings_sign_posts_label, exact: true }).setChecked(enabled);
    await page.locator('form', { has: page.locator('input[name="intent"][value="sign-posts"]') }).getByRole("button", { name: en.save_changes, exact: true }).click();
    await acceptSignedWrite(page);
    await expect(page).toHaveURL(url => url.pathname === "/settings" && url.searchParams.get("saved") === "sign-posts" && url.hash === "#settings-signing");
  }
  await preference(true);
  try {
    await page.goto("/t/new");
    await waitForFormReady(page.locator('form[method="post"]').first());
    const original = "https://example.org/a\n\nMy signed comment";
    await body().fill(original);
    await start();
    await linkedDraft();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await candidate().fill("Reviewed AI text");
    await page.getByRole("button", { name: en.ai_write_apply, exact: true }).click();
    const combined = `${original}\n\nReviewed AI text`;
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.getByRole("button", { name: en.submit_post, exact: true }).click();
    const review = page.getByRole("dialog", { name: en.signing_heading, exact: true });
    await expect(review.getByText(combined, { exact: true })).toBeVisible();
    await acceptSignedWrite(page);
    await expect(page).toHaveURL(/\/t\/\d+\?posted=/);
    const posted = new URL(page.url()).pathname;
    // Retry only a reset connection on this idempotent read; HTTP failures and writes are unchanged.
    expect(await (await context.request.get(`${posted}.md`, { maxRetries: 1 })).text()).toContain(combined);
    await context.request.post(posted, { form: { intent: "delete", entryId: posted.split("/").at(-1)!, confirm: "1" }, headers: { Origin: state().baseURL } });
  } finally {
    await page.goto("/settings");
    await waitForClientRoute(page);
    await preference(false);
    // This passkey belongs only to the disposable member; teardown removes the temporary database.
  }
});

test("reply and edit previews retain their existing behavior while an AI draft clears stale body and language previews", async () => {
  await titleField(page).fill("Preview behavior topic");
  await body().fill("Published body for preview");
  await page.getByRole("button", { name: en.submit_post, exact: true }).click();
  await expect(page).toHaveURL(/\/t\/\d+\?posted=/);
  const posted = new URL(page.url()).pathname;
  try {
    const reply = page.locator("form", { has: body() });
    await waitForFormReady(reply);
    await body().fill("Original reply preview");
    await openReplyMore(page);
    await reply.getByRole("button", { name: en.preview, exact: true }).click();
    await expect(reply.locator(".longread")).toContainText("Original reply preview");
    await body().fill("Edited reply input");
    await reply.locator("[data-post-settings]").evaluate(element => { (element as HTMLDetailsElement).open = true; });
    await reply.getByRole("combobox", { name: en.field_lang_reply, exact: true }).click();
    await page.getByRole("option", { name: enMessages.language_name_en, exact: true }).click();
    await expect(reply.locator(".longread")).toContainText("Original reply preview");
    await page.goto(`${posted}/edit`);
    await waitForFormReady(page.locator("form", { has: body() }));
    await page.getByRole("button", { name: en.preview, exact: true }).click();
    await expect(page.locator(".longread")).toContainText("Published body for preview");
    await body().fill("Edited topic input");
    await expect(page.locator(".longread")).toContainText("Published body for preview");
  } finally {
    await context.request.post(posted, { form: { intent: "delete", entryId: posted.split("/").at(-1)!, confirm: "1" }, headers: { Origin: state().baseURL } });
  }
  await page.goto("/t/new");
  await waitForFormReady(page.locator("form", { has: body() }));
  await body().fill("Draft preview body");
  await saveEditorDraft(page);
  await expect(page).toHaveURL(/\/drafts\/\d+(?:\?saved=1)?$/);
  await page.getByRole("button", { name: en.preview, exact: true }).click();
  await expect(page.locator(".longread")).toContainText("Draft preview body");
  await body().fill("Updated draft body");
  await expect(page.locator(".longread")).toHaveCount(0);
  await page.getByRole("button", { name: en.preview, exact: true }).click();
  await expect(page.locator(".longread")).toContainText("Updated draft body");
  await openPostSettings(page);
  await page.getByRole("combobox", { name: en.field_lang, exact: true }).click();
  await page.getByRole("option", { name: enMessages.language_name_en, exact: true }).click();
  await expect(page.locator(".longread")).toHaveCount(0);
});

test("unavailable browser storage still permits a choice and reuses it on the same draft", async () => {
  await page.goto("/t/new?intro=1");
  await waitForFormReady(page.locator('form[method="post"]').first());
  await page.getByRole("checkbox", { name: en.intro_checkbox, exact: true }).uncheck();
  await body().fill("https://example.org/a\n\nKeep my note");
  await page.evaluate(() => {
    const read = Storage.prototype.getItem;
    const write = Storage.prototype.setItem;
    Storage.prototype.getItem = function (key) { if (key === "tomola.openInAi") throw new Error("unavailable"); return read.call(this, key); };
    Storage.prototype.setItem = function (key, value) { if (key === "tomola.openInAi") throw new Error("unavailable"); return write.call(this, key, value); };
  });
  // Reloading the editor would reset the mock; remount by switching introduction mode.
  await page.getByRole("checkbox", { name: en.intro_checkbox, exact: true }).check();
  await page.getByRole("checkbox", { name: en.intro_checkbox, exact: true }).uncheck();
  await openHelp();
  await ask().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: en.ai_help_ask, exact: true }).click();
  const path = await linkedDraft();
  await expect.poll(() => external.length).toBe(1);
  await expect(dialog).toHaveCount(0);
  await ask().click();
  await expect.poll(() => external.length).toBe(2);
  expect(await linkedDraft()).toBe(path);
  await expect(page.getByRole("dialog")).toHaveCount(0);
});
