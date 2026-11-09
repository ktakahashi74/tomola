import fs from "node:fs";
import { expect, type BrowserContext, type Page } from "@playwright/test";
import { test } from "./editor-fixture";
import { useMember, jaMessages, enMessages, formatMessage, messagePattern, escapeRegex, clientHeaders, state, messageTitleField as titleField, waitForFormReady } from "./helpers";

const reviewConfirmationName = () => new RegExp([
  messagePattern(enMessages.glossary_bulk_confirm_selected, { count: /\d+/, lang: /.+/ }).source,
  messagePattern(enMessages.glossary_bulk_confirm_all, { count: /\d+/, lang: /.+/ }).source,
].join("|"));

// The public glossary, the history of changes, the proposal template and the download. The server and the database are single and each test uses the result of the one before,
// so they run in order. Seed (e2e/seed.ts): three entries last changed by kim on 2026-01-02 (two with the target language ja, one with en). gwen is an operator (OPERATOR_EMAILS).
test.describe.configure({ mode: "serial" });

let gwenContext: BrowserContext;
let akiContext: BrowserContext;
let modContext: BrowserContext;
let gwen: Page;
let aki: Page;
let mod: Page;
let proposalPath: string;

test.beforeAll(async ({ browser }) => {
  gwenContext = await browser.newContext({ extraHTTPHeaders: clientHeaders("10.7.0.1") });
  akiContext = await browser.newContext({ extraHTTPHeaders: clientHeaders("10.7.0.2") });
  modContext = await browser.newContext({ extraHTTPHeaders: clientHeaders("10.7.0.3") });
  gwen = await gwenContext.newPage();
  aki = await akiContext.newPage();
  mod = await modContext.newPage();
});
test.afterAll(async () => {
  await gwenContext.close();
  await akiContext.close();
  await modContext.close();
});

async function invite(page: Page, email: string): Promise<string> {
  await page.goto("/invites/new");
  await page.getByLabel(enMessages.invites_email).fill(email);
  await page.getByRole("button", { name: enMessages.invites_submit }).click();
  return await page.locator("code").innerText();
}

test("the operator invites a member and a moderator of Japanese, and appoints the moderator", async () => {
  await useMember(gwen, "gwen@example.com");


  await useMember(aki, "aki@example.com");
  await useMember(mod, "mod@example.com");
  await gwen.goto("/admin/roles?q=modo");
  await gwen.getByRole("button", { name: formatMessage(enMessages.admin_roles_grant, { lang: "日本語" }) }).click();
  await expect(gwen.getByText(enMessages.admin_roles_granted)).toBeVisible();
});

test("a member opens the glossary from the header: the entries, the last editor and date, the history, and no link to edit", async () => {
  await aki.getByRole("link", { name: enMessages.nav_glossary, exact: true }).click();
  await expect(aki).toHaveURL(/\/glossary$/);
  await expect(aki.getByRole("heading", { level: 1, name: enMessages.glossary_title })).toBeVisible();
  // The English interface selects English despite the member's Japanese main/read language.
  await expect(aki.getByRole("combobox", { name: enMessages.glossary_target, exact: true }).locator('[data-slot="select-value"]')).toHaveText(enMessages.language_name_en);
  await expect(aki.getByRole("search").locator("input[name=to]")).toHaveValue("en");
  await expect(aki.locator("li[id^=\'g-\']").filter({ hasText: "整合性" })).toContainText("alignment");
  await expect(aki.getByText("corrigibility", { exact: true })).toHaveCount(0);
  // Select Japanese for the entry/history/proposal workflow independently of the interface.
  await aki.getByRole("combobox", { name: enMessages.glossary_target, exact: true }).click();
  await aki.getByRole("listbox").getByRole("option", { name: "日本語", exact: true }).click();
  await aki.getByRole("button", { name: enMessages.glossary_filter_apply, exact: true }).click();
  await expect(aki).toHaveURL(/\/glossary\?from=&to=ja$/);
  const entry = aki.locator("li[id^=\'g-\']").filter({ hasText: "corrigibility" });
  await expect(entry).toContainText("修正可能性、コリジビリティ");
  await expect(entry).toContainText(formatMessage(enMessages.glossary_pair, { from: "English", to: "日本語" }));
  await expect(entry).toContainText(formatMessage(enMessages.glossary_last_edited, { who: "@kim", date: "2026-01-02" }));
  await expect(aki.locator("li[id^=\'g-\']").filter({ hasText: "reward hacking" })).toContainText(enMessages.glossary_keep);
  await expect(aki.getByText("整合性")).toHaveCount(0);
  await entry.getByText(formatMessage(enMessages.glossary_history, { count: "1" })).click();
  await expect(entry).toContainText(`2026-01-02 · @kim · ${enMessages.glossary_change_created}`);
  // No link to edit for a member without a role, and no list of proposals, counts or people in charge
  await expect(aki.getByRole("link", { name: enMessages.glossary_edit_link, exact: true })).toHaveCount(0);
  await expect(aki.getByRole("link", { name: enMessages.glossary_edit_all })).toHaveCount(0);
  // The page says that it is a recommendation, what a change does, and that stances do not decide
  await expect(aki.getByText(enMessages.glossary_intro)).toBeVisible();
  await expect(aki.getByText(enMessages.glossary_scope_note)).not.toBeVisible();
  await aki.getByText(enMessages.glossary_scope_label, { exact: true }).click();
  await expect(aki.getByText(enMessages.glossary_scope_note)).toBeVisible();
  await expect(aki.getByText(enMessages.glossary_decide_note)).toBeVisible();
  // The filter: the target language English shows the entry of the other direction
  await aki.getByRole("combobox", { name: enMessages.glossary_target, exact: true }).click();
  await aki.getByRole("listbox").getByRole("option", { name: enMessages.language_name_en, exact: true }).click();
  await aki.getByRole("button", { name: enMessages.glossary_filter_apply }).click();
  await expect(aki).toHaveURL(/\/glossary\?from=&to=en$/);
  await expect(aki.locator("li[id^=\'g-\']").filter({ hasText: "整合性" })).toContainText("alignment");
  await expect(aki.getByText("corrigibility")).toHaveCount(0);
  await aki.goto("/glossary?to=fr");
  const orphan = aki.locator("li[id^='g-']").filter({ hasText: "orphan" });
  await expect(orphan).toContainText("orphelin");
  await expect(orphan).toContainText(formatMessage(enMessages.glossary_last_edited, { who: enMessages.glossary_editor_unknown, date: "2026-01-03" }));
  await orphan.getByText(formatMessage(enMessages.glossary_history, { count: "1" })).click();
  await expect(orphan.locator("details")).toContainText(`2026-01-03 · ${enMessages.glossary_editor_unknown} · ${enMessages.glossary_change_created}`);
});

test("a member proposes a translation for an entry: the new-topic screen opens with the template and 'Ask for stances' on, and posts an ordinary question", async () => {
  await aki.goto("/glossary?to=ja");
  await aki.locator("li[id^=\'g-\']").filter({ hasText: "corrigibility" }).getByRole("link", { name: enMessages.glossary_propose_entry }).click();
  await expect(aki).toHaveURL(/\/t\/new\?asks_stance=1&propose_term=1&entry=\d+$/);
  await expect(titleField(aki)).toHaveValue(formatMessage(jaMessages.proposal_title_entry, { term: "corrigibility", target: "日本語" }));
  await expect(aki.getByRole("checkbox", { name: enMessages.asks_stance_checkbox, exact: true })).toBeChecked();
  const body = aki.getByLabel(enMessages.field_body);
  await expect(body).toHaveValue(new RegExp([
    formatMessage(jaMessages.proposal_body_term, { term: "`corrigibility`" }),
    formatMessage(jaMessages.proposal_body_term_lang, { lang: "英語（en）" }),
    formatMessage(jaMessages.proposal_body_target_lang, { lang: "日本語（ja）" }),
    formatMessage(jaMessages.proposal_body_current, { candidates: "`修正可能性`、`コリジビリティ`" }),
    jaMessages.proposal_body_proposed, jaMessages.proposal_body_reason,
  ].map(escapeRegex).join("\\n")));
  // Like any topic, the title and the body can be rewritten freely
  const template = await body.inputValue();
  await waitForFormReady(aki.locator("form", { has: titleField(aki) }));
  await titleField(aki).fill("「corrigibility」を日本語で「矯正可能性」と訳す");
  await body.fill(template.replace(jaMessages.proposal_body_proposed, jaMessages.proposal_body_proposed.replace("` `", "`矯正可能性`")).replace(jaMessages.proposal_body_reason, jaMessages.proposal_body_reason + "人が止められる性質を指すから"));
  await aki.getByRole("button", { name: enMessages.submit_post, exact: true }).click();
  await expect(aki.getByRole("heading", { level: 1, name: "「corrigibility」を日本語で「矯正可能性」と訳す" })).toBeVisible();
  await expect(aki.locator("article").first().getByText(enMessages.question_badge, { exact: true })).toBeVisible();
  proposalPath = new URL(aki.url()).pathname;
  // The link for a new term opens the blank template with the languages of the page
  await aki.goto("/glossary?to=ja");
  await aki.getByRole("link", { name: enMessages.glossary_propose_new, exact: true }).click();
  await expect(aki).toHaveURL(/\/t\/new\?asks_stance=1&propose_term=1&to=ja$/);
  await expect(titleField(aki)).toHaveValue(formatMessage(jaMessages.proposal_title_new, { target: "日本語" }));
  await expect(aki.getByLabel(enMessages.field_body)).toHaveValue(new RegExp([
    formatMessage(jaMessages.proposal_body_term, { term: "` `" }),
    formatMessage(jaMessages.proposal_body_term_lang, { lang: "" }),
    formatMessage(jaMessages.proposal_body_target_lang, { lang: "日本語（ja）" }),
  ].map(escapeRegex).join("\\n")));
  // The ordinary new-topic screen is as it was: no template
  await aki.goto("/t/new");
  await expect(titleField(aki)).toHaveValue("");
  await expect(aki.getByRole("checkbox", { name: enMessages.asks_stance_checkbox, exact: true })).not.toBeChecked();
});

test("a moderator of Japanese edits an entry whose target is Japanese, naming the proposal post; an entry whose target is English is not in the list", async () => {
  await mod.goto("/glossary?to=ja");
  await expect(mod.getByRole("link", { name: enMessages.glossary_edit_all })).toBeVisible();
  await mod.locator("li[id^=\'g-\']").filter({ hasText: "corrigibility" }).getByRole("link", { name: enMessages.glossary_edit_link, exact: true }).click();
  await expect(mod).toHaveURL(/\/admin\/glossary\?to=ja&from=en#g-\d+$/);
  const form = mod.locator(`#${new URL(mod.url()).hash.slice(1)}`);
  await expect(form.getByLabel(enMessages.glossary_term, { exact: true })).toHaveValue("corrigibility");
  // The pair of languages is text, not a choice
  await expect(form).toContainText(formatMessage(enMessages.glossary_pair, { from: "English", to: "日本語" }));
  await expect(form.getByLabel(enMessages.glossary_lang)).toHaveCount(0);
  await form.getByLabel(enMessages.glossary_candidates).fill("矯正可能性\n修正可能性");
  // A bad proposal is refused on the row, and the input stays
  await form.getByLabel(enMessages.glossary_proposal_field).fill("https://evil.example/t/1");
  await form.getByRole("button", { name: enMessages.glossary_save }).click();
  await expect(mod.getByText(enMessages.glossary_error_proposal)).toBeVisible();
  const again = mod.locator("form[id^='g-']").filter({ hasText: enMessages.glossary_error_proposal });
  await expect(again.getByLabel(enMessages.glossary_candidates)).toHaveValue("矯正可能性\n修正可能性");
  await again.getByLabel(enMessages.glossary_proposal_field).fill(`${state().baseURL}${proposalPath}`);
  await again.getByRole("button", { name: enMessages.glossary_save }).click();
  await expect(mod).toHaveURL(/\/admin\/glossary\?to=ja&from=en#g-\d+$/);
  await expect(mod.locator(`#${new URL(mod.url()).hash.slice(1)}`).getByLabel(enMessages.glossary_candidates)).toHaveValue("矯正可能性\n修正可能性");
  // The entry of the other direction (the target is English) is not in the list of a Japanese moderator, with or without a filter
  const terms = () => mod.locator("form[id^='g-'] input[name='term']").evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value).sort());
  await mod.goto("/admin/glossary");
  await expect(mod.locator("form[id^='g-']")).toHaveCount(2);
  expect(await terms()).toEqual(["corrigibility", "reward hacking"]);
  await mod.goto("/admin/glossary?to=en");
  await expect(mod.getByText(enMessages.glossary_empty)).toBeVisible();
  expect(await terms()).toEqual([]);
  // A member who is not a moderator gets 404
  expect((await aki.goto("/admin/glossary"))?.status()).toBe(404);
});

test("the member sees the new candidates, the new last editor and the history with the before and after and the link to the proposal", async () => {
  await aki.goto("/glossary?to=ja");
  const entry = aki.locator("li[id^=\'g-\']").filter({ hasText: "corrigibility" });
  await expect(entry).toContainText("矯正可能性、修正可能性");
  await expect(entry).toContainText(messagePattern(enMessages.glossary_last_edited, { who: "@modo", date: /\d{4}-\d{2}-\d{2}/ }));
  await entry.getByText(formatMessage(enMessages.glossary_history, { count: "2" })).click();
  const first = entry.getByRole("listitem").first();
  await expect(first).toContainText(`@modo · ${enMessages.glossary_change_updated}`);
  await expect(first).toContainText(enMessages.glossary_before);
  await expect(first).toContainText("修正可能性、コリジビリティ");
  await expect(first).toContainText(enMessages.glossary_after);
  await expect(first).toContainText("矯正可能性、修正可能性");
  const link = first.getByRole("link", { name: messagePattern(enMessages.glossary_proposal_link, { id: /\d+/ }) });
  await expect(link).toHaveAttribute("href", proposalPath);
  await link.click();
  await expect(aki).toHaveURL(new RegExp(`${proposalPath}$`));
  await expect(aki.getByRole("heading", { level: 1, name: "「corrigibility」を日本語で「矯正可能性」と訳す" })).toBeVisible();
  // The Markdown twin says the same
  const md = await (await aki.request.get("/glossary.md?to=ja")).text();
  expect(md).toContain("type: glossary");
  expect(md).toContain("last_edited_by: \"@modo\"");
  expect(md).toContain(`proposal: ${state().baseURL}${proposalPath}`);
});

test("a moderator deletes an entry: it leaves the list, stays in the deleted entries with its history, and adding it again brings the same entry back with the history continued", async () => {
  await mod.goto("/admin/glossary?to=ja&from=en");
  const form = mod.locator("form[id^='g-']").filter({ has: mod.locator("input[name='term'][value='reward hacking']") });
  mod.once("dialog", (dialog) => void dialog.accept());
  await form.getByRole("button", { name: enMessages.glossary_delete }).click();
  await expect(mod).toHaveURL(/\/admin\/glossary\?to=ja&from=en$/);
  await expect(mod.locator("form[id^='g-']")).toHaveCount(1);
  // The member's list no longer has it; the deleted entries do, with who deleted it and the history
  await aki.goto("/glossary?to=ja");
  await expect(aki.locator("li[id^='g-']").filter({ hasText: "reward hacking" })).toHaveCount(0);
  await aki.getByRole("link", { name: enMessages.glossary_show_deleted }).click();
  await expect(aki).toHaveURL(/\/glossary\?to=ja&deleted=1$/);
  const deleted = aki.locator("li[id^='g-']").filter({ hasText: "reward hacking" });
  await expect(deleted).toContainText(messagePattern(enMessages.glossary_deleted_at, { who: "@modo", date: /\d{4}-\d{2}-\d{2}/ }));
  await expect(deleted.getByRole("link", { name: enMessages.glossary_propose_term })).toBeVisible();
  await deleted.getByText(formatMessage(enMessages.glossary_history, { count: "2" })).click();
  await expect(deleted).toContainText(`@modo · ${enMessages.glossary_change_deleted}`);
  await expect(deleted).toContainText(`@kim · ${enMessages.glossary_change_created}`);
  // Adding the same pair again (a term, from English, into Japanese) brings the same entry back
  await mod.goto("/admin/glossary?to=ja&from=en");
  const add = mod.getByRole("heading", { name: enMessages.glossary_add }).locator("..");
  await add.getByLabel(enMessages.glossary_term, { exact: true }).fill("reward hacking");
  await add.getByLabel(enMessages.glossary_candidates).fill("報酬ハッキング\n報酬の悪用");
  await add.getByRole("button", { name: enMessages.glossary_add }).click();
  await expect(mod).toHaveURL(/\/admin\/glossary\?to=ja&from=en#g-\d+$/);
  await aki.goto("/glossary?to=ja&deleted=1");
  await expect(aki.locator("li[id^='g-']").filter({ hasText: "reward hacking" })).toHaveCount(0);
  await aki.goto("/glossary?to=ja");
  const back = aki.locator("li[id^='g-']").filter({ hasText: "reward hacking" });
  await expect(back).toContainText("報酬ハッキング、報酬の悪用");
  await back.getByText(formatMessage(enMessages.glossary_history, { count: "3" })).click();
  await expect(back.locator("ol > li")).toHaveCount(3);
  await expect(back.locator("ol > li").first()).toContainText(`@modo · ${enMessages.glossary_change_created}`);
  await expect(back.locator("ol > li").nth(1)).toContainText(`@modo · ${enMessages.glossary_change_deleted}`);
  await expect(back.locator("ol > li").nth(2)).toContainText(`@kim · ${enMessages.glossary_change_created}`);
});

test("the download is a YAML file with the changed candidates, named with the date", async () => {
  await aki.goto("/glossary?to=ja");
  const [download] = await Promise.all([aki.waitForEvent("download"), aki.getByRole("link", { name: enMessages.glossary_download }).click()]);
  expect(download.suggestedFilename()).toMatch(/^tomola-glossary-\d{4}-\d{2}-\d{2}\.yaml$/);
  const text = fs.readFileSync((await download.path())!, "utf8");
  expect(text).toContain('format: "tomola-glossary"');
  expect(text).toContain("rows:");
  expect(text).toContain('candidates: ["矯正可能性", "修正可能性"]');
  expect(text).toContain('term: "整合性"');
  expect(text).not.toMatch(/@modo|kim/);
});

test("a moderator of French filters by the target language, selects two entries and marks them as reviewed after a confirmation: the badge goes and the history says who did it", async () => {
  // gwen appoints modo for French too (seed: four entries that target French and need review)
  await gwen.goto("/admin/roles?q=modo");
  await gwen.getByRole("button", { name: formatMessage(enMessages.admin_roles_grant, { lang: "Français" }) }).click();
  await expect(gwen.getByText(enMessages.admin_roles_granted)).toBeVisible();

  await mod.goto("/admin/glossary");
  // Without a target language there is no "all N of …": the page says to choose one
  await expect(mod.getByText(enMessages.glossary_bulk_need_language)).toBeVisible();
  await expect(mod.getByRole("heading", { name: enMessages.glossary_bulk_heading })).toHaveCount(0);
  const filter = mod.getByRole("search");
  await filter.getByRole("combobox", { name: enMessages.glossary_target, exact: true }).click();
  await mod.getByRole("listbox").getByRole("option", { name: "Français", exact: true }).click();
  await filter.getByRole("checkbox", { name: enMessages.glossary_filter_review, exact: true }).check();
  await filter.getByRole("button", { name: enMessages.glossary_filter_apply }).click();
  await expect(mod).toHaveURL(/\/admin\/glossary\?from=&to=fr&review=1$/);
  await expect(mod.getByRole("heading", { name: enMessages.glossary_bulk_heading })).toBeVisible();
  await expect(mod.getByText(formatMessage(enMessages.glossary_bulk_count, { lang: "Français", count: "4" }))).toBeVisible();
  await expect(mod.locator("form[id^='g-']")).toHaveCount(4);

  // Two rows are selected; the question says which, and a cancel writes nothing
  await mod.getByRole("checkbox", { name: 'Select "fine-tuning"' }).check();
  await mod.getByRole("checkbox", { name: 'Select "red teaming"' }).check();
  await mod.getByRole("button", { name: enMessages.glossary_bulk_selected_button }).click();
  const confirm = mod.getByRole("group", { name: reviewConfirmationName() });
  await expect(confirm).toContainText(formatMessage(enMessages.glossary_bulk_confirm_selected, { count: "2", lang: "Français" }));
  await expect(confirm).toBeFocused();
  await expect(confirm).toContainText("fine-tuning");
  await expect(confirm).toContainText("red teaming");
  await expect(confirm).not.toContainText("interpretability");
  await confirm.getByRole("link", { name: enMessages.cancel }).click();
  await expect(confirm).toHaveCount(0);
  await expect(mod.getByText(formatMessage(enMessages.glossary_bulk_count, { lang: "Français", count: "4" }))).toBeVisible();

  // Selected again and confirmed: the two are marked, the other two still need review, and the filters and the page stay
  await mod.getByRole("checkbox", { name: 'Select "fine-tuning"' }).check();
  await mod.getByRole("checkbox", { name: 'Select "red teaming"' }).check();
  await mod.getByRole("button", { name: enMessages.glossary_bulk_selected_button }).click();
  await confirm.getByRole("button", { name: enMessages.glossary_bulk_confirm_yes }).click();
  await expect(mod.getByRole("status").filter({ hasText: formatMessage(enMessages.glossary_bulk_done, { changed: "2", lang: "Français" }) })).toBeVisible();
  await expect(mod.getByText(formatMessage(enMessages.glossary_bulk_count, { lang: "Français", count: "2" }))).toBeVisible();
  await expect(mod).toHaveURL(/\/admin\/glossary\?(?:from=&)?to=fr&review=1$/);
  await expect(mod.locator("form[id^='g-']")).toHaveCount(2);
  expect(await mod.locator("form[id^='g-'] input[name='term']").evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value).sort())).toEqual(["interpretability", "scaling law"]);

  // The public page: no badge on the two, the badge on the others, and the history names the reviewer
  await aki.goto("/glossary?to=fr");
  const marked = aki.locator("li[id^='g-']").filter({ hasText: "fine-tuning" });
  await expect(marked).toContainText("ajustement fin");
  await expect(marked.locator("span.border-notice-strong")).toHaveCount(0);
  await expect(marked).toContainText(messagePattern(enMessages.glossary_last_edited, { who: "@modo", date: /\d{4}-\d{2}-\d{2}/ }));
  await marked.getByText(formatMessage(enMessages.glossary_history, { count: "2" })).click();
  const latest = marked.locator("ol > li").first();
  await expect(latest).toContainText(new RegExp(`\\d{4}-\\d{2}-\\d{2} · @modo · ${escapeRegex(enMessages.glossary_change_reviewed)}`));
  await expect(latest).toContainText(enMessages.glossary_before);
  await expect(latest.getByText(enMessages.glossary_needs_review_badge)).toHaveCount(1);
  await expect(marked.locator("ol > li").nth(1)).toContainText(`@kim · ${enMessages.glossary_change_created}`);
  await expect(aki.locator("li[id^='g-']").filter({ hasText: "interpretability" }).locator("span.border-notice-strong")).toHaveCount(1);
  // The Markdown twin carries the change too
  const md = await (await aki.request.get("/glossary.md?to=fr")).text();
  expect(md).toContain("last_edited_by: \"@modo\"");
});

test("the page selects every entry by a link, asks before it writes, and marks all the entries of the language that need review after a confirmation that states the number", async ({ browser }) => {
  const plain = await browser.newContext({ storageState: await modContext.storageState(), extraHTTPHeaders: clientHeaders("10.7.0.3") });
  const page = await plain.newPage();
  try {
    await page.goto("/admin/glossary?to=fr&review=1");
    await expect(page.getByText(formatMessage(enMessages.glossary_bulk_count, { lang: "Français", count: "2" }))).toBeVisible();
    // "Select all on this page" is a link: the boxes come back checked
    await page.getByRole("link", { name: enMessages.glossary_bulk_select_all }).click();
    await expect(page).toHaveURL(/select=all/);
    await expect(page.locator("input[name='ids']:checked")).toHaveCount(2);
    await page.getByRole("button", { name: enMessages.glossary_bulk_selected_button }).click();
    const confirm = page.getByRole("group", { name: reviewConfirmationName() });
    await expect(confirm).toContainText(formatMessage(enMessages.glossary_bulk_confirm_selected, { count: "2", lang: "Français" }));
    await expect(page).not.toHaveURL(/select=all/);
    await confirm.getByRole("link", { name: enMessages.cancel }).click();
    await expect(page.locator("input[name='ids']:checked")).toHaveCount(0);
    // All of the language: the question states the number and the language, and nothing is written until it is confirmed
    await page.getByRole("button", { name: formatMessage(enMessages.glossary_bulk_all_button, { count: "2", lang: "Français" }) }).click();
    await expect(confirm).toContainText(formatMessage(enMessages.glossary_bulk_confirm_all, { count: 2, lang: "Français" }));
    await expect(page.getByText(formatMessage(enMessages.glossary_bulk_count, { lang: "Français", count: "2" }))).toBeVisible();
    await confirm.getByRole("button", { name: enMessages.glossary_bulk_confirm_yes }).click();
    await expect(page.getByRole("status").filter({ hasText: formatMessage(enMessages.glossary_bulk_done, { changed: "2", lang: "Français" }) })).toBeVisible();
    await expect(page.getByText(formatMessage(enMessages.glossary_bulk_count, { lang: "Français", count: "0" }))).toBeVisible();
    await expect(page.getByText(enMessages.glossary_empty)).toBeVisible();
    // The page and the filters are the same after the post
    await expect(page).toHaveURL(/\/admin\/glossary\?to=fr&review=1/);
  } finally {
    await plain.close();
  }
  await aki.goto("/glossary?to=fr");
  await expect(aki.locator("li[id^='g-'] span.border-notice-strong")).toHaveCount(0);
});
