import { expect, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { test } from "./editor-fixture";
import { useMember, enMessages, formatMessage, messagePattern, clientHeaders, state, messageTitleField as titleField, waitForFormReady, waitForHydration } from "./helpers";

// Basic stances: one-click choices on list items without navigation, a summary of three counts and "◯言語の人が答えています", viewing results first,
// stale-tab submissions, locking, personal history and deletion. Share one server and DB; run serially using earlier results.
// Find buttons by role and name, items by #q-<id>, so checks survive replacing the home with a post stream.
test.describe.configure({ mode: "serial" });

const QUESTION = "Frontier AI development should be paused";
// Native language names: stance controls and items must not show a language-name/count pair such as "日本語 3" or "English 2".
const LANGUAGE_NAMES = ["日本語", "English", "Français", "Deutsch", "繁體中文", "简体中文", "한국어", "ไทย", "Tiếng Việt"];

let sakiContext: BrowserContext;
let tomContext: BrowserContext;
let saki: Page;
let tom: Page;
let questionPath: string;
let questionId: string;

test.beforeAll(async ({ browser }) => {
  sakiContext = await browser.newContext({ extraHTTPHeaders: clientHeaders("10.7.0.1") });
  tomContext = await browser.newContext({ extraHTTPHeaders: clientHeaders("10.7.0.2") });
  saki = await sakiContext.newPage();
  tom = await tomContext.newPage();
});
test.afterAll(async () => {
  await sakiContext.close();
  await tomContext.close();
});

// No language-name/count pairs in stance controls.
async function expectNoLanguageNumberPairs(scope: Locator) {
  const text = await scope.innerText();
  for (const name of LANGUAGE_NAMES) expect(text, name).not.toMatch(new RegExp(`${name}\\s*[:：]?\\s*\\d`));
  expect(text).not.toMatch(/by language|per language|言語別|言語の別/i);
}

test("a member asks a question; the author's own stance does not lock it, and the author can still edit", async () => {
  await useMember(saki, "saki@example.com");
  await saki.getByRole("link", { name: enMessages.nav_new_topic }).click();
  await waitForFormReady(saki.locator("form", { has: titleField(saki) }));
  await titleField(saki).fill(QUESTION);
  await saki.getByLabel(enMessages.field_body).fill("Here, pausing means that no new training runs begin.");
  await saki.getByRole("checkbox", { name: enMessages.asks_stance_checkbox, exact: true }).check();
  await saki.getByRole("button", { name: enMessages.submit_post, exact: true }).click();
  await expect(saki.getByRole("heading", { level: 1, name: QUESTION })).toBeVisible();
  questionPath = new URL(saki.url()).pathname;
  questionId = questionPath.split("/").at(-1)!;
  const panel = saki.locator("#stance");
  // Before choosing: three unpressed buttons, "先に結果を見る", no distribution. Tell the author that their own stance alone does not lock the question.
  for (const name of [enMessages.stance_agree, enMessages.stance_disagree, enMessages.stance_neither]) await expect(panel.getByRole("button", { name, exact: true })).toHaveAttribute("aria-pressed", "false");
  await expect(panel.getByRole("link", { name: enMessages.stance_peek })).toBeVisible();
  await expect(panel.getByRole("list", { name: enMessages.stance_counts_label })).toHaveCount(0);
  await expect(panel.getByRole("note")).toHaveCount(0);
  await expect(panel.getByText(enMessages.stance_author_note)).toBeVisible();
  // View results first, before anyone has chosen.
  await panel.getByRole("link", { name: enMessages.stance_peek }).click();
  await expect(saki).toHaveURL(new RegExp(`${questionPath}\\?posted=${questionId}&peek=1#stance$`));
  await expect(saki.locator("#stance").getByText(enMessages.stance_none)).toBeVisible();
  await expect(panel.getByRole("note")).toHaveCount(1);
  expect(await (await saki.request.get(`${questionPath}/stances.md`)).text()).toMatch(/not.*conclusion.*forum/i);
  // Choose a stance on one's own question without navigating.
  await saki.evaluate(() => ((window as unknown as { __stay: boolean }).__stay = true));
  await saki.locator("#stance").getByRole("button", { name: enMessages.stance_agree, exact: true }).click();
  await expect(saki.locator("#stance").getByRole("button", { name: enMessages.stance_agree, exact: true })).toHaveAttribute("aria-pressed", "true");
  expect(await saki.evaluate(() => (window as unknown as { __stay?: boolean }).__stay)).toBe(true);
  await expect(saki.locator("#stance").getByText(formatMessage(enMessages.stance_langs, { langs: 1 }))).toBeVisible();
  // The author's stance alone does not lock editing; the edit screen still shows a form.
  await saki.goto(`${questionPath}/edit`);
  await expect(titleField(saki)).toBeVisible();
  await expect(saki.getByText(enMessages.edit_locked_title)).toHaveCount(0);
});

test("another member chooses a stance in a list in one tap, without leaving the page, and sees the summary: three numbers and how many languages answered", async () => {
  await useMember(tom, "tom@example.com", "/latest?asks=1");
  const item = tom.locator(`#q-${questionId}`);
  await expect(item.getByRole("link", { name: QUESTION })).toBeVisible();
  for (const name of [enMessages.stance_agree, enMessages.stance_disagree, enMessages.stance_neither]) await expect(item.getByRole("button", { name, exact: true })).toHaveAttribute("aria-pressed", "false");
  // Nothing chosen yet: no distribution, only the option to view results first.
  await expect(item.getByRole("list", { name: enMessages.stance_counts_label })).toHaveCount(0);
  await expect(item.getByRole("link", { name: enMessages.stance_peek })).toBeVisible();
  await item.getByRole("link", { name: enMessages.stance_peek }).click();
  await expect(item.getByRole("list", { name: enMessages.stance_counts_label })).toBeVisible();
  await expect(item.getByRole("note")).toHaveCount(0);
  // The peek link may navigate before hydration; the choice must use its client handler.
  await waitForHydration(tom);
  // One click without navigation; navigation would erase the marker on window.
  await tom.evaluate(() => ((window as unknown as { __stay: boolean }).__stay = true));
  const url = tom.url();
  const listIds = () => tom.locator("main li[id^=q-]").evaluateAll(rows => rows.map(row => row.id));
  const before = await listIds();
  await item.getByRole("button", { name: enMessages.stance_agree, exact: true }).click();
  // Once chosen, the row is one line: "You: Agree", the counts, the languages and "Change"; the three buttons wait behind "Change".
  const summary = item.locator("[data-stance-summary]");
  await expect(summary).toContainText(formatMessage(enMessages.stance_you, { position: enMessages.stance_agree }));
  await expect(item.getByRole("button", { name: enMessages.stance_disagree, exact: true })).toBeHidden();
  expect(tom.url()).toBe(url);
  expect(await listIds()).toEqual(before);
  expect(await tom.evaluate(() => (window as unknown as { __stay?: boolean }).__stay)).toBe(true);
  // Distribution summary: three counts (saki and tom both agree) and participation from two languages (ja and en).
  const counts = item.getByRole("list", { name: enMessages.stance_counts_label });
  await expect(counts.getByText(`${enMessages.stance_agree} 2`)).toBeVisible();
  await expect(counts.getByText(`${enMessages.stance_disagree} 0`)).toBeVisible();
  await expect(counts.getByText(`${enMessages.stance_neither} 0`)).toBeVisible();
  await expect(item.getByText(formatMessage(enMessages.stance_langs_short, { langs: "2" }), { exact: true })).toBeVisible();
  await expect(item.getByRole("note")).toHaveCount(0);
  await expect(item.getByRole("link", { name: enMessages.stance_peek })).toHaveCount(0);
  // "Change" opens the three buttons and the withdrawal.
  await item.locator("summary").filter({ hasText: enMessages.stance_change }).click();
  await expect(item.getByRole("button", { name: enMessages.stance_agree, exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(item.getByRole("button", { name: enMessages.stance_disagree, exact: true })).toHaveAttribute("aria-pressed", "false");
  await expect(item.getByRole("button", { name: enMessages.stance_withdraw })).toBeVisible();
  // Compact list items omit the disclosure line and language-name/count pairs.
  await expect(item.getByText(enMessages.stance_privacy_line)).toHaveCount(0);
  await expectNoLanguageNumberPairs(item);
  // The saved stance remains after reopening.
  await tom.reload();
  await expect(tom.locator(`#q-${questionId}`).locator("[data-stance-summary]")).toContainText(formatMessage(enMessages.stance_you, { position: enMessages.stance_agree }));
});

test("in a list row the keyboard focus is kept after a choice, after a change, and when the choice is refused", async ({ browser }) => {
  const context = await browser.newContext({ extraHTTPHeaders: clientHeaders("10.7.0.4") });
  try {
    const vera = await context.newPage();
    await useMember(vera, "uma@example.com", "/latest?asks=1");
    const item = vera.locator(`#q-${questionId}`);
    const button = (name: string) => item.getByRole("button", { name, exact: true });
    const you = item.locator("[data-stance-you]");
    // Refused: another tab chose first, so this row sends an old version. The answer is a conflict; the row shows the current stance and the keyboard focus stays in the row.
    const other = await context.newPage();
    await other.goto("/latest?asks=1");
    await other.bringToFront();
    // The key press below must reach the live page, not the browser's own form submission before the scripts have run.
    await waitForHydration(other);
    // Chosen with the keyboard: the buttons become the one line, and the focus goes to it.
    await other.locator(`#q-${questionId}`).getByRole("button", { name: enMessages.stance_agree, exact: true }).focus();
    await other.keyboard.press("Enter");
    await expect(other.locator(`#q-${questionId} [data-stance-you]`)).toContainText(formatMessage(enMessages.stance_you, { position: enMessages.stance_agree }));
    await expect(other.locator(`#q-${questionId} [data-stance-you]`)).toBeFocused();
    await vera.bringToFront();
    await button(enMessages.stance_disagree).focus();
    await vera.keyboard.press("Enter");
    await expect(item.getByText(enMessages.stance_conflict)).toBeVisible();
    await expect(item.locator(":focus")).toHaveCount(1);
    await expect(you).toContainText(formatMessage(enMessages.stance_you, { position: enMessages.stance_agree }));
    await other.close();
    await vera.bringToFront();
    // Changed from inside "Change": the panel is rebuilt when the answer comes, and the focus stays on the line.
    await item.locator("summary").filter({ hasText: enMessages.stance_change }).click();
    await button(enMessages.stance_disagree).focus();
    await vera.keyboard.press("Enter");
    await expect(you).toContainText(formatMessage(enMessages.stance_you, { position: enMessages.stance_disagree }));
    await expect(you).toBeFocused();
    await expect(item.getByRole("button", { name: enMessages.stance_agree, exact: true })).toBeHidden();
    // Leave the question's numbers as the later scenarios expect them.
    await item.locator("summary").filter({ hasText: enMessages.stance_change }).click();
    await item.getByRole("button", { name: enMessages.stance_withdraw }).click();
    await expect(item.locator("[data-stance-summary]")).toHaveCount(0);
    await expect(button(enMessages.stance_agree)).toHaveAttribute("aria-pressed", "false");
  } finally { await context.close(); }
});

test("the author of a question can no longer edit it once another member has chosen a stance: the page says so", async () => {
  await saki.goto(`${questionPath}/edit`);
  await expect(saki.getByRole("heading", { level: 1, name: enMessages.edit_locked_title })).toBeVisible();
  await expect(titleField(saki)).toHaveCount(0);
  await saki.goto(questionPath);
  await expect(saki.getByText(enMessages.edit_locked_notice)).toBeVisible();
  // Only the author sees the locked state; tom does not.
  await tom.goto(questionPath);
  await expect(tom.getByText(enMessages.edit_locked_notice)).toHaveCount(0);
});

test("the question page shows the summary after choosing, the anonymity line with the link to the settings, and the distribution as a Markdown twin", async () => {
  await tom.goto(questionPath);
  const panel = tom.locator("#stance");
  await expect(panel.getByRole("button", { name: enMessages.stance_agree, exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(panel.getByRole("list", { name: enMessages.stance_counts_label }).getByText(`${enMessages.stance_agree} 2`)).toBeVisible();
  await expect(panel.getByText(formatMessage(enMessages.stance_langs, { langs: "2" }))).toBeVisible();
  const note = panel.getByRole("note");
  await expect(note).toHaveCount(1);
  await expect(note).toBeVisible();
  expect(await note.evaluate(element => {
    const languages = element.previousElementSibling;
    const counts = languages?.previousElementSibling;
    return languages?.tagName === "P" && counts?.tagName === "UL" && !element.closest('[aria-hidden="true"]');
  })).toBe(true);
  await expect(panel.getByText(enMessages.stance_privacy_line)).toBeVisible();
  await expectNoLanguageNumberPairs(panel);
  await expect(panel.getByRole("link", { name: enMessages.stance_privacy_title })).toHaveAttribute("href", "/settings/stances#privacy");
  // Markdown distribution: totals and language count only, without the viewer's stance.
  const res = await tom.request.get(`${questionPath}/stances.md`);
  expect(res.status()).toBe(200);
  expect(res.headers()["cache-control"]).toBe("private, no-store");
  const text = await res.text();
  expect(text).toContain("type: stances");
  expect(text).toMatch(/total: 2\n/);
  expect(text).toMatch(/agree: 2/);
  expect(text).toContain("total_langs: 2");
  expect(text).toMatch(/not.*conclusion.*forum/i);
  expect(text).not.toMatch(/saki|@tom/);
  // Also available before choosing: fetching counts as the same explicit action as "先に結果を見る". saki has chosen a stance, but the thread Markdown still excludes distributions.
  const thread = await (await tom.request.get(`${questionPath}.md`)).text();
  expect(thread).not.toContain("total_langs");
});

test("a member who has not chosen can look at the results first, with a link that works without scripts", async () => {
  // A third member views results without choosing a stance.
  const umaContext = await sakiContext.browser()!.newContext({ extraHTTPHeaders: clientHeaders("10.7.0.3") });
  try {
    const uma = await umaContext.newPage();
    await useMember(uma, "uma@example.com");
    await uma.goto(questionPath);
    await expect(uma.locator("#stance").getByRole("list", { name: enMessages.stance_counts_label })).toHaveCount(0);
    await uma.locator("#stance").getByRole("link", { name: enMessages.stance_peek }).click();
    await expect(uma).toHaveURL(/\?peek=1#stance$/);
    await expect(uma.locator("#stance").getByRole("list", { name: enMessages.stance_counts_label }).getByText(`${enMessages.stance_agree} 2`)).toBeVisible();
    // Viewing alone does not choose a stance; every button stays unpressed.
    for (const name of [enMessages.stance_agree, enMessages.stance_disagree, enMessages.stance_neither]) await expect(uma.locator("#stance").getByRole("button", { name, exact: true })).toHaveAttribute("aria-pressed", "false");
    // On lists too, ?peek=<id> reveals only that question.
    await uma.goto(`/latest?asks=1&peek=${questionId}`);
    await expect(uma.locator(`#q-${questionId}`).getByText(formatMessage(enMessages.stance_langs, { langs: "2" }))).toBeVisible();
  } finally {
    await umaContext.close();
  }
});

test("a stale tab sends an old version: it is told that the stance was changed on another screen, and shows the current one", async () => {
  const other = await tomContext.newPage();
  await tom.goto(questionPath);
  await other.goto(questionPath);
  await expect(tom.locator("#stance").getByRole("button", { name: enMessages.stance_agree, exact: true })).toHaveAttribute("aria-pressed", "true");
  // Change to disagree in another tab.
  await other.locator("#stance").getByRole("button", { name: enMessages.stance_disagree, exact: true }).click();
  await expect(other.locator("#stance").getByRole("button", { name: enMessages.stance_disagree, exact: true })).toHaveAttribute("aria-pressed", "true");
  // Choose neither from the stale tab still showing the "賛成" version.
  await tom.locator("#stance").getByRole("button", { name: enMessages.stance_neither, exact: true }).click();
  await expect(tom.locator("#stance").getByText(enMessages.stance_conflict)).toBeVisible();
  await expect(tom.locator("#stance").getByRole("button", { name: enMessages.stance_disagree, exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(tom.locator("#stance").getByRole("button", { name: enMessages.stance_neither, exact: true })).toHaveAttribute("aria-pressed", "false");
  // The displayed version is now current, so the next submission succeeds.
  await tom.locator("#stance").getByRole("button", { name: enMessages.stance_neither, exact: true }).click();
  await expect(tom.locator("#stance").getByRole("button", { name: enMessages.stance_neither, exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(tom.locator("#stance").getByText(enMessages.stance_conflict)).toHaveCount(0);
  await other.close();
});

test("choose, withdraw, then look at the results first: the numbers show (the response of the withdrawal must not hide the page's distribution)", async () => {
  // saki is the author (her stance does not lock the question) and has chosen Agree; tom has chosen Neither. She chooses again and withdraws in the same page, without reloading.
  await saki.goto(questionPath);
  const panel = saki.locator("#stance");
  await panel.getByRole("button", { name: enMessages.stance_withdraw }).click();
  await expect(panel.getByRole("button", { name: enMessages.stance_agree, exact: true })).toHaveAttribute("aria-pressed", "false");
  await panel.getByRole("button", { name: enMessages.stance_disagree, exact: true }).click();
  await expect(panel.getByRole("button", { name: enMessages.stance_disagree, exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(panel.getByRole("list", { name: enMessages.stance_counts_label })).toBeVisible();
  await panel.getByRole("button", { name: enMessages.stance_withdraw }).click();
  await expect(panel.getByRole("list", { name: enMessages.stance_counts_label })).toHaveCount(0);
  await expect(panel.getByRole("link", { name: enMessages.stance_peek })).toBeVisible();
  // the link keeps the page (client-side navigation) and the loader hands over the distribution: tom's Neither only
  await panel.getByRole("link", { name: enMessages.stance_peek }).click();
  await expect(saki).toHaveURL(/\?peek=1#stance$/);
  const counts = saki.locator("#stance").getByRole("list", { name: enMessages.stance_counts_label });
  await expect(counts.getByText(`${enMessages.stance_agree} 0`, { exact: true })).toBeVisible();
  await expect(counts.getByText(`${enMessages.stance_disagree} 0`, { exact: true })).toBeVisible();
  await expect(counts.getByText(`${enMessages.stance_neither} 1`, { exact: true })).toBeVisible();
  await expect(saki.locator("#stance").getByText(formatMessage(enMessages.stance_langs, { langs: 1 }))).toBeVisible();
  // put her stance back for the tests that follow
  await saki.locator("#stance").getByRole("button", { name: enMessages.stance_agree, exact: true }).click();
  await expect(saki.locator("#stance").getByRole("button", { name: enMessages.stance_agree, exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(saki.locator("#stance").getByRole("list", { name: enMessages.stance_counts_label }).getByText(`${enMessages.stance_agree} 1`, { exact: true })).toBeVisible();
});

test("the member's own record: the privacy statement, the history in time order, and deleting one question's record takes the member out of the numbers", async () => {
  // Prepare the history this test reads: the earlier stale-tab test left Neither selected.
  await tom.goto(questionPath);
  await tom.locator("#stance").getByRole("button", { name: enMessages.stance_agree, exact: true }).click();
  await expect(tom.locator("#stance").getByRole("button", { name: enMessages.stance_agree, exact: true })).toHaveAttribute("aria-pressed", "true");
  await tom.locator("#stance").getByRole("button", { name: enMessages.stance_withdraw }).click();
  await expect(tom.locator("#stance").getByRole("button", { name: enMessages.stance_agree, exact: true })).toHaveAttribute("aria-pressed", "false");
  await tom.goto("/settings");
  await tom.locator("#settings-records").getByRole("link", { name: enMessages.settings_stances_link }).click();
  await expect(tom).toHaveURL(/\/settings\/stances$/);
  await expect(tom.getByRole("heading", { level: 1, name: enMessages.settings_stances_title })).toBeVisible();
  const privacy = tom.locator("#privacy");
  await expect(privacy.getByText(enMessages.stance_privacy_p1)).toBeVisible();
  await expect(privacy).not.toContainText(/anonymi[sz]ed/i);
  // History for this question, chronologically, from previous to next stance.
  const record = tom.locator(`#q-${questionId}`);
  await expect(record.getByRole("link", { name: QUESTION })).toBeVisible();
  await expect(record.getByText(enMessages.settings_stances_now_none)).toBeVisible();
  const history = record.getByRole("listitem");
  await expect(history.first()).toContainText(`${enMessages.settings_stances_none_label} → ${enMessages.stance_agree}`);
  await expect(history.last()).toContainText(`${enMessages.stance_agree} → ${enMessages.settings_stances_none_label}`);
  // Deletion requires confirmation. Confirmed deletion removes the stance from the distribution.
  await record.getByRole("button", { name: enMessages.settings_stances_delete }).click();
  await expect(record.getByRole("alert")).toBeVisible();
  await record.getByRole("checkbox", { name: enMessages.settings_stances_delete_confirm, exact: true }).check();
  await record.getByRole("button", { name: enMessages.settings_stances_delete }).click();
  await expect(tom.getByText(enMessages.settings_stances_deleted)).toBeVisible();
  await expect(tom.locator(`#q-${questionId}`)).toHaveCount(0);
  await tom.goto(questionPath);
  await tom.locator("#stance").getByRole("link", { name: enMessages.stance_peek }).click();
  await expect(tom.locator("#stance").getByRole("list", { name: enMessages.stance_counts_label }).getByText(`${enMessages.stance_agree} 1`)).toBeVisible();
  await expect(tom.locator("#stance").getByText(formatMessage(enMessages.stance_langs, { langs: 1 }))).toBeVisible();
  // Deleting the record does not unlock the question; the fact that its first stance was chosen remains.
  await saki.goto(`${questionPath}/edit`);
  await expect(saki.getByRole("heading", { level: 1, name: enMessages.edit_locked_title })).toBeVisible();
});

// Insightful, the reasons panel and "Reconsider my stance". saki (Japanese, the author) holds Agree; tom (English) has no stance (his record was deleted above).
const REASON = "I disagree: training runs are not the only risk.";

test("the daily reasons panel keeps its empty selection when a new tagged reply arrives, while the thread shows the reply", async () => {
  // tom writes a reply marked as a reason for disagreeing
  await tom.goto(questionPath);
  const form = tom.locator("#reply form");
  await form.getByLabel(enMessages.field_body).fill(REASON);
  await form.getByRole("radio", { name: enMessages.stance_tag_disagree, exact: true }).check();
  await form.getByRole("button", { name: enMessages.submit_reply, exact: true }).click();
  await expect(tom).toHaveURL(/#c-\d+$/);

  await saki.goto(questionPath);
  const panel = saki.locator("#reasons");
  await expect(panel.getByText(enMessages.reasons_empty_help)).toBeVisible();
  await expect(panel.locator("[data-position], details")).toHaveCount(0);
  await expect(panel.getByText(REASON)).toHaveCount(0);
  await expect(saki.locator("#replies").getByText(REASON)).toBeVisible();
  await expect(panel.locator("[id^='fn'], [id^='user-content-fn']")).toHaveCount(0);
  // With an empty daily draw the single entry opens the reply form without choosing a position.
  await panel.getByRole("link", { name: enMessages.reasons_write }).click();
  await expect(saki).toHaveURL(/#reply$/);
  await expect(saki.getByRole("group", { name: enMessages.stance_tag_label })).toBeInViewport();
  // no count per language and no language name next to a number in the panel
  await saki.goto(questionPath);
  await expectNoLanguageNumberPairs(saki.locator("#reasons"));
  // A member with no stance sees the same empty daily selection.
  await tom.goto(questionPath);
  await expect(tom.locator('#reasons [data-position="disagree"]').getByText(REASON)).toHaveCount(0);
  await expect(tom.locator("#replies").getByText(REASON)).toBeVisible();
  await expect(tom.locator("#reasons").getByText(enMessages.reasons_empty_help)).toBeVisible();
  await expect(tom.locator("#reasons [data-position]")).toHaveCount(0);
});

test("pressing Insightful on the new reply keeps the page and offers Reconsider my stance while the daily panel stays unchanged", async () => {
  await saki.goto(questionPath);
  const inPanel = saki.locator("#replies").getByRole("button", { name: enMessages.insightful_give, exact: true });
  const inList = saki.locator("#replies").getByRole("button", { name: enMessages.insightful_give, exact: true });
  await expect(inPanel).toHaveAttribute("aria-pressed", "false");
  await expect(saki.getByRole("link", { name: enMessages.insightful_review })).toHaveCount(0);
  await saki.evaluate(() => ((window as unknown as { __stay: boolean }).__stay = true));
  await inPanel.click();
  await expect(inPanel).toHaveAttribute("aria-pressed", "true");
  expect(await saki.evaluate(() => (window as unknown as { __stay?: boolean }).__stay)).toBe(true);
  // the page reads its data again after the press: the same reply in the list shows the same state and count (the panel is not re-drawn: it is the same for the whole day)
  await expect(inList).toHaveAttribute("aria-pressed", "true");
  for (const scope of [saki.locator("#replies")]) await expect(scope.getByText(formatMessage(enMessages.insightful_count_short, { total: 1, langs: 1 }), { exact: true })).toBeVisible();
  await expect(saki.locator("#reasons").getByText(REASON)).toHaveCount(0);
  // saki holds a stance (Agree), so the pressed reply offers the link; it carries no sentence that asks for a change
  const link = saki.locator("#replies").getByRole("link", { name: enMessages.insightful_review });
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute("href", /\?review=\d+#stance$/);
  await expect(saki.locator("#replies").getByRole("link", { name: enMessages.insightful_review })).toBeVisible();
  // a member who holds no stance (tom) pressing Insightful on the question gets no link
  await tom.goto(questionPath);
  const questionButton = tom.locator("article").first().getByRole("button", { name: enMessages.insightful_give, exact: true });
  await questionButton.click();
  await expect(questionButton).toHaveAttribute("aria-pressed", "true");
  await expect(tom.locator("article").first().getByText(formatMessage(enMessages.insightful_count_short, { total: 1, langs: 1 }), { exact: true })).toBeVisible();
  await expect(tom.getByRole("link", { name: enMessages.insightful_review })).toHaveCount(0);
});

test("changing the stance from 'Reconsider my stance' records the post as what prompted it, once: a later change from the same page has no such mark", async () => {
  await saki.goto(questionPath);
  await saki.locator("#replies").getByRole("link", { name: enMessages.insightful_review }).click();
  await expect(saki).toHaveURL(/\?review=\d+#stance$/);
  const panel = saki.locator("#stance");
  await expect(panel.getByRole("button", { name: enMessages.stance_agree, exact: true })).toHaveAttribute("aria-pressed", "true");
  await panel.getByRole("button", { name: enMessages.stance_disagree, exact: true }).click();
  await expect(panel.getByRole("button", { name: enMessages.stance_disagree, exact: true })).toHaveAttribute("aria-pressed", "true");
  // the URL still has ?review=, but the post prompted one change already: the next change from the same page (back to Agree) has no mark
  await expect(saki).toHaveURL(/\?review=\d+#stance$/);
  await panel.getByRole("button", { name: enMessages.stance_agree, exact: true }).click();
  await expect(panel.getByRole("button", { name: enMessages.stance_agree, exact: true })).toHaveAttribute("aria-pressed", "true");
  // the record: the first change was prompted by a post (the link to it), the second was not
  await saki.goto("/settings/stances");
  const record = saki.locator(`#q-${questionId}`);
  const items = record.getByRole("listitem");
  await expect(items.nth(-2)).toContainText(`${enMessages.stance_agree} → ${enMessages.stance_disagree}`);
  await expect(items.nth(-2).getByRole("link", { name: enMessages.settings_stances_trigger })).toBeVisible();
  await expect(items.last()).toContainText(`${enMessages.stance_disagree} → ${enMessages.stance_agree}`);
  await expect(items.last().getByRole("link", { name: enMessages.settings_stances_trigger })).toHaveCount(0);
  // the disclosure says what a watcher can infer: the two counts move at close times after Reconsider my stance, and the Insightful numbers can show the presser's language
  await expect(saki.locator("#privacy")).toContainText(enMessages.insightful_review);
  await expect(saki.locator("#privacy")).toContainText(enMessages.stance_privacy_insightful);
});

// A dedicated locked question for the unique operator typo-fix flow.
test.describe("operator correction of a locked question", () => {
  const TITLE_WITH_TYPO = "フロンティアAIの開発は、一時停止すべきてある";
  const TITLE_FIXED = "フロンティアAIの開発は、一時停止すべきである";
  const BODY = "ここでの「一時停止」とは、新しい訓練を始めないことを指す。";

  let rinaContext: BrowserContext;
  let benContext: BrowserContext;
  let opalContext: BrowserContext;
  let rina: Page;
  let ben: Page;
  let opal: Page;
  let path: string;

  test.beforeAll(async ({ browser }) => {
    rinaContext = await browser.newContext({ extraHTTPHeaders: clientHeaders("10.7.1.1") });
    benContext = await browser.newContext({ extraHTTPHeaders: clientHeaders("10.7.1.2") });
    opalContext = await browser.newContext({ extraHTTPHeaders: clientHeaders("10.7.1.3") });
    rina = await rinaContext.newPage();
    ben = await benContext.newPage();
    opal = await opalContext.newPage();
    await useMember(rina, "rina@example.com");
    await useMember(ben, "stance-ben@example.com");
    await rina.goto("/t/new");
    await waitForFormReady(rina.locator("form", { has: titleField(rina) }));
    await titleField(rina).fill(TITLE_WITH_TYPO);
    await rina.getByLabel(enMessages.field_body).fill(BODY);
    await rina.getByRole("checkbox", { name: enMessages.asks_stance_checkbox, exact: true }).check();
    await rina.getByRole("button", { name: enMessages.submit_post, exact: true }).click();
    await expect(rina).toHaveURL(/\/t\/\d+(?:\?.*)?$/);
    path = new URL(rina.url()).pathname;
    await ben.goto(path);
    await ben.locator("#stance").getByRole("button", { name: enMessages.stance_disagree, exact: true }).click();
    await expect(ben.locator("#stance").getByRole("button", { name: enMessages.stance_disagree, exact: true })).toHaveAttribute("aria-pressed", "true");

  });
  test.afterAll(async () => {
    await rinaContext.close();
    await benContext.close();
    await opalContext.close();
  });

  test("an operator fixes the typo of the locked question with a note; the author is notified and reads the fixed title; the metrics page has the new sections and no number of a single question", async () => {
    await useMember(opal, "opal@example.com");
    await opal.goto(`${path}/edit`);
    await expect(opal.getByRole("heading", { level: 1, name: enMessages.edit_fix_title })).toBeVisible();
    await opal.setViewportSize({ width: 390, height: 844 });
    await expect(opal.getByRole("group", { name: enMessages.editor_mode_label, exact: true })).toBeVisible();
    await expect(opal.locator("[data-post-settings]")).toHaveCount(0);
    expect(await opal.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await titleField(opal).fill(TITLE_FIXED);
    await opal.getByLabel(enMessages.mod_fix_note).fill("Fixed a typo in the last word.");
    await opal.getByRole("button", { name: enMessages.save_changes }).click();
    await expect(opal).toHaveURL(new RegExp(`${path}(?:\\?sl=[\\w-]+)?$`));
    // the author is told, and the title is the fixed one
    await rina.goto("/notifications");
    await expect(rina.getByText(enMessages.notification_moderation_fix).first()).toBeVisible();
    await rina.goto(path);
    await expect(rina.getByRole("heading", { level: 1, name: TITLE_FIXED })).toBeVisible();
    // no screen of the scenario has shown a language name with a number (checked on the stance panel and the list item above); the operator's metrics page has its sections
    await opal.goto("/admin/metrics");
    await expect(opal.getByRole("heading", { level: 1, name: enMessages.metrics_title })).toBeVisible();
    for (const heading of [
      enMessages.metrics_insight_title,
      enMessages.metrics_update_title,
      enMessages.metrics_active_title,
      enMessages.metrics_retention_title,
      enMessages.metrics_first_title,
      enMessages.metrics_dir_title,
      enMessages.metrics_distance_title,
      enMessages.metrics_first_stances_title,
      enMessages.metrics_langs_title,
    ]) {
      await expect(opal.getByRole("heading", { level: 2, name: heading }), heading).toBeVisible();
    }
    // the older weeks of a new database have no data: "Not observed"; this week has the stance update in the earlier Reconsider test (a post in another language prompted it)
    await expect(opal.getByText(enMessages.metrics_unobserved).first()).toBeVisible();
    const updates = opal.locator("section", { has: opal.getByRole("heading", { level: 2, name: enMessages.metrics_update_title }) });
    const thisWeek = updates.locator("tbody tr").last();
    await expect(thisWeek).not.toContainText(enMessages.metrics_unobserved);
    await expect(thisWeek).toContainText("%");
    // the operator-only note says the numbers are summed across questions, and the page has no title of a question next to a number by area
    await expect(opal.getByText(enMessages.metrics_small_numbers)).toBeVisible();
    await expect(opal.locator("main")).not.toContainText(TITLE_FIXED);
    await expect(opal.locator("main")).not.toContainText(QUESTION);
  });
});
