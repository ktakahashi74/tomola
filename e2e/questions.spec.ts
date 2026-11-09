import { saveEditorDraft } from "./draft-autosave-helper";
import { expect, type BrowserContext, type Page } from "@playwright/test";
import { test } from "./editor-fixture";
import { useMember, enMessages, messagePattern, clientHeaders, state, messageTitleField as titleField, waitForFormReady } from "./helpers";

// Questions (topics asking for stances): create with "立場を聞く", question markers, ?asks=1 filtering, reply tags and filters, framing-objection panels and alternative questions.
// One-click stance choices are covered by e2e/stances.spec.ts. Share one server and DB and run serially, using earlier results.
test.describe.configure({ mode: "serial" });

const QUESTION = "フロンティアAIの開発は、いったん止めるべきである";
const OBJECTION = "I object: the word 'pause' is not defined.";

let quinnContext: BrowserContext;
let raviContext: BrowserContext;
let quinn: Page;
let ravi: Page;
let questionPath: string;
let altPath: string;

test.beforeAll(async ({ browser }) => {
  quinnContext = await browser.newContext({ extraHTTPHeaders: clientHeaders("10.6.0.1") });
  raviContext = await browser.newContext({ extraHTTPHeaders: clientHeaders("10.6.0.2") });
  quinn = await quinnContext.newPage();
  ravi = await raviContext.newPage();
});
test.afterAll(async () => {
  await quinnContext.close();
  await raviContext.close();
});

test("a member asks a question with the 'Ask for stances' switch: the page says so and folds the empty objection panel", async () => {
  await useMember(quinn, "quinn@example.com");
  await quinn.getByRole("link", { name: enMessages.nav_new_topic }).click();
  await waitForFormReady(quinn.locator("form", { has: titleField(quinn) }));
  await titleField(quinn).fill(QUESTION);
  await quinn.getByLabel(enMessages.field_body).fill("ここでの「止める」とは、新しい訓練を始めないことを指す。");
  await quinn.getByRole("checkbox", { name: enMessages.asks_stance_checkbox, exact: true }).check();
  await quinn.getByRole("button", { name: enMessages.submit_post, exact: true }).click();
  await expect(quinn.getByRole("heading", { level: 1, name: QUESTION })).toBeVisible();
  questionPath = new URL(quinn.url()).pathname;
  const article = quinn.locator("article").first();
  await expect(article.getByText(enMessages.question_badge, { exact: true })).toBeVisible();
  // An empty objection panel has one summary; its help and entry points are available on opening it.
  const panel = quinn.locator("#objections");
  await expect(panel.locator("summary")).toHaveText(enMessages.objections_title);
  await expect(panel.getByText(enMessages.objections_help)).toBeHidden();
  await panel.locator("summary").click();
  await expect(panel.getByText(enMessages.objections_help)).toBeVisible();
  await expect(panel.getByText(enMessages.objections_none)).toHaveCount(0);
  await expect(panel.getByRole("link", { name: enMessages.objections_write })).toBeVisible();
  await expect(panel.getByRole("link", { name: enMessages.objections_new_alt })).toBeVisible();
});

test("an ordinary topic has neither the badge nor the panel", async () => {
  await quinn.getByRole("link", { name: enMessages.nav_new_topic }).click();
  await waitForFormReady(quinn.locator("form", { has: titleField(quinn) }));
  await titleField(quinn).fill("ふつうの話題です");
  await quinn.getByLabel(enMessages.field_body).fill("本文です。");
  await quinn.getByRole("button", { name: enMessages.submit_post, exact: true }).click();
  await expect(quinn.getByRole("heading", { level: 1, name: "ふつうの話題です" })).toBeVisible();
  await expect(quinn.locator("#objections")).toHaveCount(0);
  await expect(quinn.locator("article").first().getByText(enMessages.question_badge, { exact: true })).toHaveCount(0);
  // Replies to ordinary topics have no tag selector.
  await expect(quinn.getByRole("group", { name: enMessages.stance_tag_label })).toHaveCount(0);
});

test("the list can be narrowed to the questions with ?asks=1, and the Markdown list carries the same filter", async () => {
  await quinn.goto("/latest");
  await expect(quinn.getByRole("link", { name: "ふつうの話題です" })).toBeVisible();
  await quinn.getByRole("navigation", { name: enMessages.list_filter_label }).getByRole("link", { name: enMessages.list_questions_only }).click();
  await expect(quinn).toHaveURL(/\/latest\?asks=1$/);
  await expect(quinn.getByRole("link", { name: QUESTION })).toBeVisible();
  await expect(quinn.getByText(enMessages.question_badge, { exact: true }).first()).toBeVisible();
  await expect(quinn.getByRole("link", { name: "ふつうの話題です" })).toHaveCount(0);
  await expect(quinn.getByRole("link", { name: /^Seed topic/ })).toHaveCount(0);
  await quinn.getByRole("navigation", { name: enMessages.list_filter_label }).getByRole("link", { name: enMessages.list_all_topics }).click();
  await expect(quinn).toHaveURL(/\/latest$/);
  const md = await quinn.request.get("/latest.md?asks=1");
  expect(md.status()).toBe(200);
  const text = await md.text();
  expect(text).toContain("asks_stance: true");
  expect(text).not.toContain("ふつうの話題です");
  // Question Markdown: frontmatter and the objection block at the end of page one.
  const thread = await (await quinn.request.get(`${questionPath}.md`)).text();
  expect(thread).toContain("asks_stance: true");
  expect(thread).toContain("objections: []");
});

test("another member writes a reply marked as an objection: the mark shows on the reply, the panel lists it, and the replies can be filtered by the mark", async () => {
  await useMember(ravi, "ravi@example.com");
  await ravi.goto(questionPath);
  const form = ravi.locator("#reply form");
  await form.getByLabel(enMessages.field_body).fill(OBJECTION);
  await form.getByRole("radio", { name: enMessages.stance_tag_objection, exact: true }).check();
  await form.getByRole("button", { name: enMessages.submit_reply, exact: true }).click();
  await expect(ravi).toHaveURL(/#c-\d+$/);
  const postedReplyId = new URL(ravi.url()).hash.slice(3);
  const reply = ravi.locator("article").nth(1);
  await expect(reply.getByText(OBJECTION)).toBeVisible();
  await expect(reply.getByText(enMessages.stance_tag_objection)).toBeVisible();
  // The objection-reply panel shows excerpts and links.
  const panel = ravi.locator("#objections");
  await expect(panel.getByRole("link", { name: OBJECTION })).toBeVisible();
  // Filter by tag using links, which also work without JavaScript.
  const filter = ravi.getByRole("navigation", { name: enMessages.replies_filter_label, exact: true });
  await filter.getByRole("link", { name: enMessages.replies_filter_agree, exact: true }).click();
  await expect(ravi).toHaveURL(url => url.pathname === questionPath && url.searchParams.get("posted") === postedReplyId && url.searchParams.get("tag") === "agree" && url.hash === "#replies");
  await expect(ravi.getByText(enMessages.replies_filter_empty)).toBeVisible();
  await expect(ravi.locator("#replies").getByText(OBJECTION)).toHaveCount(0);
  await ravi.getByRole("navigation", { name: enMessages.replies_filter_label, exact: true }).getByRole("link", { name: enMessages.replies_filter_objection }).click();
  await expect(ravi).toHaveURL(url => url.pathname === questionPath && url.searchParams.get("posted") === postedReplyId && url.searchParams.get("tag") === "objection" && url.hash === "#replies");
  await expect(ravi.locator("#replies").getByText(OBJECTION)).toBeVisible();
  // Authors can change the tag through editing, without changing the text.
  await ravi.goto(questionPath);
  await ravi.locator("article").nth(1).getByRole("link", { name: enMessages.edit }).click();
  await expect(ravi).toHaveURL(/\/c\/\d+\/edit$/);
  await expect(ravi.getByRole("heading", { level: 1, name: enMessages.edit_reply_title })).toBeVisible();
  await expect(ravi.locator('input[name="stanceTag"]')).toHaveValue("objection");
  await ravi.getByLabel(enMessages.stance_tag_label).click();
  await ravi.getByRole("listbox").getByRole("option", { name: enMessages.stance_tag_disagree, exact: true }).click();
  await ravi.getByRole("button", { name: enMessages.save_changes }).click();
  await expect(ravi.locator("article").nth(1).getByText(enMessages.stance_tag_disagree)).toBeVisible();
});

test("another way of asking is made from the panel, links back to the original, and is listed in the original's panel", async () => {
  await ravi.goto(questionPath);
  await ravi.locator("#objections summary").click();
  await ravi.locator("#objections").getByRole("link", { name: enMessages.objections_new_alt }).click();
  await expect(ravi).toHaveURL(/\/t\/new\?asks_stance=1&alt_of=\d+$/);
  await expect(ravi.getByText(messagePattern(enMessages.alt_of_label, { title: /.+/ }))).toBeVisible();
  // Alternative framings always ask for stances, so no checkbox is shown.
  await expect(ravi.getByRole("checkbox", { name: enMessages.asks_stance_checkbox, exact: true })).toHaveCount(0);
  await waitForFormReady(ravi.locator("form", { has: titleField(ravi) }));
  await titleField(ravi).fill("Frontier AI training should not start new runs for a year");
  await ravi.getByLabel(enMessages.field_body).fill("A narrower proposition: no new frontier training runs for twelve months.");
  await ravi.getByRole("button", { name: enMessages.submit_post, exact: true }).click();
  await expect(ravi.getByRole("heading", { level: 1, name: "Frontier AI training should not start new runs for a year" })).toBeVisible();
  altPath = new URL(ravi.url()).pathname;
  await expect(ravi.getByRole("link", { name: messagePattern(enMessages.alt_of_origin_link, { title: /.+/ }) })).toHaveAttribute("href", new RegExp(`${questionPath}(\\?.*)?$`));
  // Shown in the original question's panel with the author's name, and under "すべて見る".
  await ravi.goto(questionPath);
  const panel = ravi.locator("#objections");
  await expect(panel.getByRole("link", { name: "Frontier AI training should not start new runs for a year" })).toBeVisible();
  await panel.getByRole("link", { name: enMessages.objections_see_all }).click();
  await expect(ravi).toHaveURL(new RegExp(`${questionPath}/objections$`));
  await expect(ravi.getByRole("heading", { level: 1, name: enMessages.objections_page_title })).toBeVisible();
  await expect(ravi.getByRole("link", { name: "Frontier AI training should not start new runs for a year" })).toBeVisible();
  // The preceding test changed the reply tag to "反対の理由"; it is no longer an objection and disappears from that list.
  await expect(ravi.getByRole("link", { name: OBJECTION })).toHaveCount(0);
  // The original question's Markdown lists alternative framings in frontmatter.
  const md = await (await ravi.request.get(`${questionPath}.md`)).text();
  expect(md).toContain("alternatives:");
  expect(md).toContain(`p-${altPath.split("/").at(-1)}`);
});

test("the question cannot be edited into an ordinary topic, and its author still edits it while nobody has chosen a stance", async () => {
  await quinn.goto(`${questionPath}/edit`);
  await expect(quinn.getByText(enMessages.edit_lock_warning)).toBeVisible();
  await titleField(quinn).fill(`${QUESTION}（改）`);
  await quinn.getByRole("button", { name: enMessages.save_changes }).click();
  await expect(quinn.getByRole("heading", { level: 1, name: `${QUESTION}（改）` })).toBeVisible();
  // Editing has no "立場を聞く" toggle; it cannot be added or removed later.
  await quinn.goto(`${questionPath}/edit`);
  await expect(quinn.getByRole("checkbox", { name: enMessages.asks_stance_checkbox, exact: true })).toHaveCount(0);
});

test("a draft of another way of asking whose original question was deleted says why it cannot be published, and drops the link so that it can be", async () => {
  // quinn creates a question and ravi drafts an alternative framing. The previous test ended on an edit screen that also has Title; wait for navigation before filling it.
  await quinn.goto("/t/new");
  await expect(quinn.getByRole("heading", { level: 1, name: enMessages.topic_new_title })).toBeVisible();
  await waitForFormReady(quinn.locator("form", { has: titleField(quinn) }));
  await titleField(quinn).fill("すぐに消す問い");
  await quinn.getByLabel(enMessages.field_body).fill("本文です。");
  await quinn.getByRole("checkbox", { name: enMessages.asks_stance_checkbox, exact: true }).check();
  await quinn.getByRole("button", { name: enMessages.submit_post, exact: true }).click();
  await expect(quinn.getByRole("heading", { level: 1, name: "すぐに消す問い" })).toBeVisible();
  const gonePath = new URL(quinn.url()).pathname;
  await ravi.goto(`/t/new?asks_stance=1&alt_of=${gonePath.split("/").at(-1)}`);
  await waitForFormReady(ravi.locator("form", { has: titleField(ravi) }));
  await titleField(ravi).fill("Another way, written as a draft");
  await ravi.getByLabel(enMessages.field_body).fill("A draft that points at a question that is about to disappear.");
  await saveEditorDraft(ravi);
  await expect(ravi).toHaveURL(/\/drafts\/\d+(?:\?saved=1)?$/);
  const draftPath = new URL(ravi.url()).pathname;
  const remove = ravi.getByRole("button", { name: enMessages.draft_alt_remove });
  // While the original question is readable, show neither the explanation nor the unlink button.
  await expect(ravi.getByText(messagePattern(enMessages.alt_of_label, { title: /.+/ }))).toBeVisible();
  await expect(remove).toHaveCount(0);
  // The author deletes the question.
  await quinn.getByLabel(enMessages.entry_actions, { exact: true }).click();
  await quinn.getByText(enMessages.delete_summary).click();
  await quinn.getByRole("button", { name: enMessages.delete_confirm }).click();
  // Deleting a topic redirects to the home page; wait before ravi reads it.
  await expect(quinn).toHaveURL(/\/$/);
  // The draft screen explains why publication is blocked and offers unlinking. Publication is rejected.
  await ravi.goto(draftPath);
  await expect(ravi.getByText(enMessages.alt_of_origin_unreadable, { exact: true })).toBeVisible();
  await expect(ravi.getByText(enMessages.draft_alt_origin_unreadable_help)).toBeVisible();
  await ravi.getByRole("button", { name: enMessages.draft_publish, exact: true }).click();
  await expect(ravi.getByText(enMessages.error_invalid_alt_of)).toBeVisible();
  // Unlinking makes it an independent question draft; "立場を聞く" stays selected and the checkbox returns.
  await ravi.getByRole("button", { name: enMessages.draft_alt_remove }).click();
  await expect(ravi.getByText(enMessages.draft_alt_removed)).toBeVisible();
  await expect(remove).toHaveCount(0);
  await expect(ravi.getByRole("checkbox", { name: enMessages.asks_stance_checkbox, exact: true })).toBeChecked();
  await ravi.getByRole("button", { name: enMessages.draft_publish, exact: true }).click();
  await expect(ravi.getByRole("heading", { level: 1, name: "Another way, written as a draft" })).toBeVisible();
  await expect(ravi.locator("article").first().getByText(enMessages.question_badge, { exact: true })).toBeVisible();
  await expect(ravi.getByRole("link", { name: messagePattern(enMessages.alt_of_origin_link, { title: /.+/ }) })).toHaveCount(0);
});
