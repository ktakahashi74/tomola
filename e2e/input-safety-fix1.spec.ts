import { expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { test, richEditorTest } from "./editor-fixture";
import { useMember, waitForClientRoute, waitForFormReady, openUserMenu, state, visitListRow, enMessages as m } from "./helpers";

const body = (page: Page) => page.locator('textarea[name="body"]');
const navigate = (page: Page, path: string) => page.evaluate(path => {
  void (window as unknown as { __reactRouterDataRouter: { navigate(path: string): Promise<void> } }).__reactRouterDataRouter.navigate(path);
}, path);

test("reply targets and pagination retain text without asking to leave", async ({ page }) => {
  await useMember(page, "safety_fix_topic@example.com");
  // Other suites add topics to the home list: find the fixture through the pages rather than assuming it is on the first.
  const fixture = page.getByRole("link", { name: "Latest question fixture", exact: true }).first();
  await visitListRow(page, "/", fixture);
  await fixture.click();
  await waitForClientRoute(page);
  await body(page).fill("Keep this reply while choosing its destination.");
  const dialogs: string[] = [];
  page.on("dialog", async dialog => { dialogs.push(dialog.type()); await dialog.dismiss(); });
  await page.getByRole("link", { name: m.reply_to_button, exact: true }).first().click();
  await expect(page).toHaveURL(/reply_to=c-\d+#reply$/);
  await expect(body(page)).toHaveValue("Keep this reply while choosing its destination.");
  await page.getByRole("link", { name: m.reply_target_clear, exact: true }).click();
  await expect(page).toHaveURL(/reply_to=#reply$/);
  await page.getByRole("link", { name: m.page_next, exact: true }).first().click();
  await expect(page).toHaveURL(/page=2#replies$/);
  await expect(body(page)).toHaveValue("Keep this reply while choosing its destination.");
  expect(dialogs).toEqual([]);
  await navigate(page, "/latest");
  await expect.poll(() => dialogs.length).toBe(1);
  await expect(body(page)).toHaveValue("Keep this reply while choosing its destination.");
});

test("native publication refusal keeps the saved version usable for the next publication", async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  try {
    await useMember(page, "safety_fix_native@example.com", "/t/new?asks_stance=1");
    await body(page).fill("The saved question text.");
    await page.getByRole("button", { name: m.save_draft, exact: true }).click();
    await expect(page).toHaveURL(/\/drafts\/\d+(?:\?saved=1)?$/);
    // Native clients can submit invalid fields; exercise the server refusal, not HTML validation.
    await page.locator("form").filter({ has: body(page) }).evaluate(form => form.setAttribute("novalidate", ""));
    await page.getByRole("button", { name: m.draft_publish, exact: true }).click();
    await expect(page.locator('input[name="version"]')).toHaveValue("2");
    await expect(body(page)).toHaveValue("The saved question text.");
    await page.locator('input[name="title"]').fill("A question ready to publish");
    await page.getByRole("button", { name: m.draft_publish, exact: true }).click();
    await expect(page).toHaveURL(/\/t\/\d+/);
    await expect(page.getByRole("heading", { name: "A question ready to publish", exact: true })).toBeVisible();
  } finally { await context.close(); }
});

for (const [name, newline] of [["LF", "\n"], ["CRLF", "\r\n"]] as const) {
  test(`an untouched ${name} edit is clean`, async ({ page }) => {
    await useMember(page, "safety_fix_edit@example.com");
    const text = `First line.${newline}Second line.`;
    let path: string;
    if (name === "CRLF") {
      // Native form parsing already normalizes newlines. Model a stored source from another write path.
      const fixture = JSON.parse(fs.readFileSync(pathModule(), "utf8"));
      path = `/t/${fixture.crlfId}`;
    } else {
      const response = await page.request.post("/t/new", { form: { body: text, lang: "en" }, headers: { Origin: new URL(page.url()).origin } });
      expect(response.ok()).toBe(true);
      path = new URL(response.url()).pathname;
    }
    const exported = await (await page.request.get("/settings/export")).json();
    expect(exported.entries.find((entry: { id: number }) => entry.id === Number(path.split("/").at(-1))).body).toBe(text);
    await page.goto(`${path}/edit`);
    await waitForClientRoute(page);
    const dialogs: string[] = [];
    page.on("dialog", async dialog => { dialogs.push(dialog.type()); await dialog.dismiss(); });
    await navigate(page, "/latest");
    await expect(page).toHaveURL(/\/latest$/);
    expect(dialogs).toEqual([]);
  });
}

function pathModule() { return path.join(state().dir, "input-safety.json"); }

test("moderating another reply retains the unsent reply without a departure prompt", async ({ browser }) => {
  const authorContext = await browser.newContext();
  const operatorContext = await browser.newContext();
  const author = await authorContext.newPage();
  const page = await operatorContext.newPage();
  try {
    await useMember(author, "safety_fix_topic@example.com");
    const send = (url: string, body: string) => author.request.post(url, { form: { body, lang: "en" }, headers: { Origin: new URL(author.url()).origin } });
    const topic = await send("/t/new", "A topic for retained moderation input.");
    const topicPath = new URL(topic.url()).pathname;
    const reply = await send(topicPath, "A reply for moderation.");
    const replyId = new URL(reply.url()).hash.slice(3);
    await useMember(page, "navigation_operator@example.com", topicPath);
    await body(page).fill("The operator's unsent reply.");
    const dialogs: string[] = [];
    page.on("dialog", async dialog => { dialogs.push(dialog.type()); await dialog.dismiss(); });
    const row = page.locator(`#c-${replyId}`);
    await row.getByText(m.mod_panel_summary, { exact: true }).click();
    const panel = row.locator('form[action="/mod"]');
    const refusal = await page.request.post("/mod", { form: { intent: "delete", entryId: replyId, returnTo: topicPath, reason: "other" }, headers: { Origin: new URL(page.url()).origin } });
    expect(refusal.status()).toBe(400);
    expect(await refusal.text()).toContain(m.mod_error_confirm);
    await expect(panel.getByRole("checkbox")).not.toBeChecked();
    await panel.getByRole("button", { name: m.mod_delete, exact: true }).click();
    await expect(panel.getByRole("alert")).toHaveText(m.mod_error_confirm);
    await expect(body(page)).toHaveValue("The operator's unsent reply.");
    expect(dialogs).toEqual([]);
    await panel.getByRole("button", { name: m.mod_hide, exact: true }).click();
    await expect(panel.getByRole("alert")).toHaveText(m.mod_error_note_required);
    await expect(body(page)).toHaveValue("The operator's unsent reply.");
    expect(dialogs).toEqual([]);
    await panel.locator('textarea[name="note"]').fill("An explanation for this moderation action.");
    await panel.getByRole("button", { name: m.mod_hide, exact: true }).click();
    await expect(row.getByRole("button", { name: m.mod_unhide, exact: true })).toBeVisible();
    await expect(panel.getByRole("alert")).toHaveCount(0);
    await expect(body(page)).toHaveValue("The operator's unsent reply.");
    expect(dialogs).toEqual([]);
  } finally { await authorContext.close(); await operatorContext.close(); }
});

test("outer whitespace does not count as unsent title or body", async ({ page }) => {
  await page.route("**/drafts/autosave", route => route.abort());
  await useMember(page, "safety_fix_prefill@example.com", "/t/new");
  await waitForFormReady(page.locator("form", { has: body(page) }));
  const title = page.locator('input[name="title"]');
  const dialogs: string[] = [];
  page.on("dialog", async dialog => { dialogs.push(dialog.type()); await dialog.dismiss(); });
  await title.fill(" \t ");
  await body(page).fill(" \n\t ");
  expect(await page.evaluate(() => !window.dispatchEvent(new Event("beforeunload", { cancelable: true })))).toBe(false);
  await navigate(page, "/latest");
  await expect(page).toHaveURL(/\/latest$/);
  expect(dialogs).toEqual([]);

  await page.goto("/t/new?url=https%3A%2F%2Fexample.org%2Fshared&title=Shared%20page");
  await waitForFormReady(page.locator("form", { has: body(page) }));
  const originalTitle = await title.inputValue();
  const original = await body(page).inputValue();
  await title.fill(`  ${originalTitle}  `);
  await body(page).fill(` \n${original}\n\t `);
  await expect(title).toHaveValue(`  ${originalTitle}  `);
  await expect(body(page)).toHaveValue(` \n${original}\n\t `);
  expect(await page.evaluate(() => !window.dispatchEvent(new Event("beforeunload", { cancelable: true })))).toBe(false);
  await navigate(page, "/latest");
  await expect(page).toHaveURL(/\/latest$/);
  expect(dialogs).toEqual([]);

  await page.goto("/t/new?url=https%3A%2F%2Fexample.org%2Fshared&title=Shared%20page");
  await waitForFormReady(page.locator("form", { has: body(page) }));
  const innerChange = original.replace("Shared page", "Shared  page");
  await body(page).fill(innerChange);
  await navigate(page, "/latest");
  await expect.poll(() => dialogs.length).toBe(1);
  await expect(body(page)).toHaveValue(innerChange);
  await body(page).fill(original);
  await title.fill("A real title.");
  await navigate(page, "/latest");
  await expect.poll(() => dialogs.length).toBe(2);
  await expect(title).toHaveValue("A real title.");
});

test("shared text is a clean starting point and later edits are protected", async ({ page }) => {
  await page.route("**/drafts/autosave", route => route.abort());
  const path = "/t/new?url=https%3A%2F%2Fexample.org%2Fshared&title=Shared%20page";
  await useMember(page, "safety_fix_prefill@example.com", path);
  await waitForFormReady(page.locator("form", { has: body(page) }));
  const original = await body(page).inputValue();
  expect(original).toContain("https://example.org/shared");
  const dialogs: string[] = [];
  page.on("dialog", async dialog => { dialogs.push(dialog.type()); await dialog.dismiss(); });
  await navigate(page, "/latest");
  await expect(page).toHaveURL(/\/latest$/);
  expect(dialogs).toEqual([]);
  await page.goto(path);
  await waitForFormReady(page.locator("form", { has: body(page) }));
  await body(page).fill(original + "My added comment.");
  await navigate(page, "/latest");
  await expect.poll(() => dialogs.length).toBe(1);
  await expect(body(page)).toHaveValue(original + "My added comment.");
});

test("refusing a language change keeps its cookie and accepting asks once before reloading", async ({ page }) => {
  await page.route("**/drafts/autosave", route => route.abort());
  await useMember(page, "safety_fix_locale@example.com", "/t/new");
  await waitForFormReady(page.locator("form", { has: body(page) }));
  await body(page).fill("Keep my interface language too.");
  const cookies = () => page.context().cookies().then(cookies => cookies.filter(cookie => cookie.name === "PARAGLIDE_LOCALE"));
  const before = await cookies();
  const dialogs: string[] = [];
  let accept = false;
  page.on("dialog", async dialog => { dialogs.push(dialog.type()); if (accept) await dialog.accept(); else await dialog.dismiss(); });
  const switchLanguage = async () => {
    const menu = await openUserMenu(page);
    await menu.getByRole("menuitem", { name: m.nav_language, exact: true }).click();
    await page.getByRole("menuitemradio", { name: "日本語", exact: true }).click();
  };
  await switchLanguage();
  await expect.poll(() => dialogs.length).toBe(1);
  expect(await cookies()).toEqual(before);
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(body(page)).toHaveValue("Keep my interface language too.");
  expect(dialogs).toEqual(["confirm"]);
  accept = true;
  await switchLanguage();
  await expect(page.locator("html")).toHaveAttribute("lang", "ja");
  expect(dialogs).toEqual(["confirm", "confirm"]);
});

test("accepting a client departure removes its document-unload guard", async ({ page }) => {
  await page.route("**/drafts/autosave", route => route.abort());
  await useMember(page, "safety_fix_prefill@example.com", "/t/new");
  await waitForFormReady(page.locator("form", { has: body(page) }));
  await body(page).fill("Leave this text explicitly.");
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/latest.data*", async route => { await held; await route.continue(); });
  const dialogs: string[] = [];
  page.on("dialog", async dialog => { dialogs.push(dialog.type()); await dialog.accept(); });
  try {
    const request = page.waitForRequest(request => request.url().includes("/latest.data"));
    await navigate(page, "/latest");
    await request;
    expect(await page.evaluate(() => !window.dispatchEvent(new Event("beforeunload", { cancelable: true })))).toBe(false);
    expect(dialogs).toEqual(["confirm"]);
  } finally { release(); }
  await expect(page).toHaveURL(/\/latest$/);
});

richEditorTest("rich edits guard modified text and allow leaving an unchanged editor", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const rich = page.locator('[contenteditable="true"][role="textbox"]');
  try {
    await useMember(page, "safety_fix_rich@example.com", "/t/new");
    await rich.fill("Text from the rich editor.");
    await page.getByRole("button", { name: m.submit_post, exact: true }).click();
    await expect(page).toHaveURL(/\/t\/\d+/);
    const path = new URL(page.url()).pathname;
    await page.goto(`${path}/edit`);
    await expect(rich).toHaveText("Text from the rich editor.");
    await waitForClientRoute(page);
    const dialogs: string[] = [];
    page.on("dialog", async dialog => { dialogs.push(dialog.type()); await dialog.dismiss(); });
    await navigate(page, "/latest");
    await expect(page).toHaveURL(/\/latest$/);
    expect(dialogs).toEqual([]);
    await page.goto(`${path}/edit`);
    await rich.fill("Modified in the rich editor.");
    await navigate(page, "/latest");
    await expect.poll(() => dialogs.length).toBe(1);
    await page.evaluate(() => window.location.reload());
    await expect.poll(() => dialogs.length).toBe(2);
    await expect(rich).toHaveText("Modified in the rich editor.");
  } finally { await context.close(); }
});
