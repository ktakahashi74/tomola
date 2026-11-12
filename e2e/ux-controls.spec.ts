import { routeModule } from "./support/module-route";
import { expect, type BrowserContext, type Page } from "@playwright/test";
import { test, richEditorTest } from "./editor-fixture";
import fs from "node:fs";
import path from "node:path";
import { useMember, waitForClientRoute, waitForFormReady, state, enMessages as m, openReplyMore } from "./helpers";
import { acceptSignedWrite, enableSigningAuthenticator } from "./signing-helper";

const body = (page: Page) => page.locator('textarea[name="body"]');
const post = (page: Page, url: string, text: string, lang = "en") => page.request.post(url, { form: { body: text, lang }, headers: { Origin: new URL(page.url()).origin } });
const fixture = (): { topicId: number; replyId: number; questionId: number } => JSON.parse(fs.readFileSync(path.join(state().dir, "ux-controls.json"), "utf8"));

test.describe("signing failure guidance", () => {
  let context: BrowserContext;
  test.beforeAll(async ({ browser }) => {
    context = await browser.newContext();
    const page = await context.newPage();
    await useMember(page, "ux_signer@example.com", "/settings");
    await page.locator("#settings-advanced > summary").click();
    if (!await page.getByRole("checkbox", { name: m.settings_sign_posts_label, exact: true }).isChecked()) {
      await enableSigningAuthenticator(page);
      await page.getByRole("button", { name: m.settings_passkeys_add, exact: true }).click();
      await expect(page.getByText(m.settings_passkeys_added, { exact: true })).toBeVisible();
      await page.getByRole("checkbox", { name: m.settings_sign_posts_label, exact: true }).check();
      await page.locator('form:has(input[name="intent"][value="sign-posts"])').getByRole("button", { name: m.save_changes, exact: true }).click();
      await acceptSignedWrite(page);
    }
    await expect(page.getByRole("checkbox", { name: m.settings_sign_posts_label, exact: true })).toBeChecked();
    await page.close();
  });
  test.afterAll(() => context?.close());
  for (const [kind, status, lacksPasskeys] of [["cancelled", 0, false], ["unsupported", 0, false], ["network_failed", 502, false], ["network_failed", 503, false], ["login_required", 401, false], ["network_failed", 502, true]] as const) {
    test(`explains a signing failure: ${kind} ${status}${lacksPasskeys ? " on unsupported device" : ""}`, async () => {
      const page = await context.newPage();
      try {
        await page.goto("/t/new");
        await waitForClientRoute(page);
        // Keep early input covered: recovery must not prepend earlier failed writing.
        await body(page).fill("Keep this text after the signing failure.");
        await waitForFormReady(page.locator("form", { has: body(page) }));
        await expect(page.locator('form[data-autosave="ready"]')).toHaveCount(1);
        await expect(body(page)).toHaveValue("Keep this text after the signing failure.");
        if (lacksPasskeys) await page.evaluate(() => Object.defineProperty(window, "PublicKeyCredential", { configurable: true, value: undefined }));
        if (kind === "network_failed" || kind === "login_required") {
          await page.route("**/signing", route => route.fulfill({ status, contentType: status === 503 ? "text/plain" : "text/html", body: "Temporarily unavailable" }));
        } else {
          await page.evaluate(kind => {
            if (kind === "unsupported") Object.defineProperty(window, "PublicKeyCredential", { configurable: true, value: undefined });
            else Object.defineProperty(navigator.credentials, "get", { configurable: true, value: () => Promise.reject(new DOMException("Cancelled", "NotAllowedError")) });
          }, kind);
        }
        await page.getByRole("button", { name: m.submit_post, exact: true }).click();
        if (kind === "cancelled" || kind === "unsupported") {
          await page.getByRole("dialog").getByRole("button", { name: m.signing_accept_post, exact: true }).click();
        }
        await expect(page.getByRole("alert")).toHaveText(m[`signing_${kind}`]);
        if (kind === "cancelled" || kind === "unsupported") {
          await expect(page.getByRole("dialog").getByRole("button", { name: m.signing_accept_post, exact: true })).toBeEnabled();
          await expect(page.getByRole("dialog").getByRole("button", { name: m.save_draft, exact: true })).toHaveCount(0);
          await page.getByRole("dialog").getByRole("button", { name: m.cancel, exact: true }).click();
          await expect(page.locator('[data-draft-autosave]')).toHaveAttribute("data-draft-autosave", "saved");
        }
        await expect(body(page)).toHaveValue("Keep this text after the signing failure.");
        if (kind === "login_required") await expect(page.getByRole("link", { name: m.login_title, exact: true })).toHaveAttribute("href", /\/login\?next=/);
      } finally { await page.close(); }
    });
  }
  for (const intent of ["preview", "challenge"]) test(`explains maintenance during signing ${intent} and keeps the text`, async () => {
    const page = await context.newPage();
    try {
      await page.goto("/t/new");
      await waitForClientRoute(page);
      await body(page).fill("Keep this text during maintenance.");
      await waitForFormReady(page.locator("form", { has: body(page) }));
      await expect(page.locator('form[data-autosave="ready"]')).toHaveCount(1);
      await expect(body(page)).toHaveValue("Keep this text during maintenance.");
      await page.route("**/signing", route => route.request().postDataJSON().intent === intent
        ? route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "maintenance_readonly", message: m.maintenance_readonly }) })
        : route.continue());
      await page.getByRole("button", { name: m.submit_post, exact: true }).click();
      if (intent === "challenge") await page.getByRole("dialog").getByRole("button", { name: m.signing_accept_post, exact: true }).click();
      await expect(page.getByRole("alert")).toHaveText(m.maintenance_readonly);
      await expect(body(page)).toHaveValue("Keep this text during maintenance.");
    } finally { await page.close(); }
  });
});

test("one press reports a translation, the title is reported on its own, and details update a report", async ({ browser }) => {
  const authorContext = await browser.newContext();
  const readerContext = await browser.newContext();
  try {
    const author = await authorContext.newPage();
    const page = await readerContext.newPage();
    await useMember(author, "ux_author@example.com");
    await useMember(page, "ux_reporter@example.com", `/t/${fixture().topicId}?lang=en`);
    const topic = page.locator(`#p-${fixture().topicId}`);
    const panel = topic.locator("details").filter({ hasText: m.report_optional_summary });
    const note = panel.locator('textarea[name="note"]');
    const saveDetails = async () => {
      const saved = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname.replace(/\.data$/, "") === `/t/${fixture().topicId}`);
      await panel.getByRole("button", { name: m.save_changes, exact: true }).click();
      expect((await saved).status()).toBe(200);
      await expect(panel.getByRole("button", { name: m.save_changes, exact: true })).toBeEnabled();
      await expect(topic.getByRole("status").filter({ hasText: m.report_thanks })).toBeVisible();
    };
    // Nothing but the two buttons before a report: one press for the body, one for the title.
    await expect(panel).toHaveCount(0);
    await expect(topic.getByRole("button", { name: m.report_title_button, exact: true })).toBeVisible();
    await topic.getByRole("button", { name: m.report_button, exact: true }).click();
    await expect(topic.getByRole("button", { name: m.report_reported, exact: true })).toBeDisabled();
    await expect(panel).toHaveAttribute("open", "");
    await expect(panel.getByRole("combobox")).toHaveCount(0);
    await note.fill("The last sentence has the opposite meaning.");
    await saveDetails();
    await page.reload();
    await expect(topic.getByRole("button", { name: m.report_reported, exact: true })).toBeDisabled();
    await expect(panel).not.toHaveAttribute("open", "");
    await panel.locator("summary").click();
    await expect(note).toHaveValue("The last sentence has the opposite meaning.");
    // The title is a report of its own (the body's report stays); only then is there a choice of which one the details are for.
    await topic.getByRole("button", { name: m.report_title_button, exact: true }).click();
    await expect(topic.getByRole("button", { name: m.report_reported, exact: true })).toHaveCount(2);
    await expect(panel).toHaveAttribute("open", "");
    // The panel is for the part just reported: the title, with its own empty note (not the body's).
    await expect(panel.getByRole("combobox", { name: m.report_field, exact: true })).toContainText(m.report_field_title);
    await expect(note).toHaveValue("");
    await note.fill("Unsaved title explanation.");
    await panel.getByRole("combobox", { name: m.report_field, exact: true }).click();
    await page.getByRole("option", { name: m.report_field_body, exact: true }).click();
    await expect(note).toHaveValue("The last sentence has the opposite meaning.");
    await panel.getByRole("combobox", { name: m.report_field, exact: true }).click();
    await page.getByRole("option", { name: m.report_field_title, exact: true }).click();
    await expect(note).toHaveValue("Unsaved title explanation.");
    await note.fill("The title has a different error.");
    await saveDetails();
    await page.reload();
    await panel.locator("summary").click();
    await expect(note).toHaveValue("The last sentence has the opposite meaning.");
    await panel.getByRole("combobox", { name: m.report_field, exact: true }).click();
    await page.getByRole("option", { name: m.report_field_title, exact: true }).click();
    await expect(note).toHaveValue("The title has a different error.");

    const replyReport = page.locator(`#c-${fixture().replyId}`);
    await expect(replyReport.locator("summary").filter({ hasText: m.report_optional_summary })).toHaveCount(0);
    await expect(replyReport.getByRole("button", { name: m.report_title_button, exact: true })).toHaveCount(0);
    await replyReport.getByRole("button", { name: m.report_button, exact: true }).click();
    await expect(replyReport.locator("details").filter({ hasText: m.report_optional_summary })).toHaveAttribute("open", "");
    await page.reload();
    await expect(replyReport.getByRole("button", { name: m.report_reported, exact: true })).toBeDisabled();
    await expect(replyReport.locator("details").filter({ hasText: m.report_optional_summary })).not.toHaveAttribute("open", "");
  } finally { await authorContext.close(); await readerContext.close(); }
});

test("reporting only the title makes no report of the body", async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await useMember(page, "ux_reply@example.com", `/t/${fixture().topicId}?lang=en`);
    const topic = page.locator(`#p-${fixture().topicId}`);
    await topic.getByRole("button", { name: m.report_title_button, exact: true }).click();
    await expect(topic.getByRole("button", { name: m.report_reported, exact: true })).toHaveCount(1);
    // The body's button stays open, and after a reload only the title is reported.
    await expect(topic.getByRole("button", { name: m.report_button, exact: true })).toBeEnabled();
    await page.reload();
    await expect(topic.getByRole("button", { name: m.report_reported, exact: true })).toHaveCount(1);
    await expect(topic.getByRole("button", { name: m.report_button, exact: true })).toBeEnabled();
    await expect(topic.getByRole("button", { name: m.report_title_button, exact: true })).toHaveCount(0);
    // Reporting the body afterwards is a report of its own; the two buttons are told apart for assistive technology.
    await topic.getByRole("button", { name: m.report_button, exact: true }).click();
    const reported = topic.getByRole("button", { name: m.report_reported, exact: true });
    await expect(reported).toHaveCount(2);
    await expect(reported.nth(0)).toHaveAccessibleDescription(m.report_field_body);
    await expect(reported.nth(1)).toHaveAccessibleDescription(m.report_field_title);
  } finally { await context.close(); }
});

test("reply AI saves a reply draft and imports text before publication", async ({ page, context }) => {
  await context.route(/^https:\/\/(chatgpt\.com|claude\.ai)\//, route => route.fulfill({ contentType: "text/html", body: "Mock AI" }));
  await useMember(page, "ux_reply@example.com", `/t/${fixture().questionId}`);
  await page.evaluate(() => localStorage.setItem("tomola.openInAi", JSON.stringify({ provider: "chatgpt" })));
  await waitForClientRoute(page);
  const topicPath = new URL(page.url()).pathname;
  await page.getByRole("link", { name: m.reply_to_button, exact: true }).first().click();
  await body(page).fill("My original reply.");
  // Asking the AI saves a draft and opens the AI in another tab; the reply screen is not left, and the reply is posted from here.
  await openReplyMore(page);
  await page.getByRole("button", { name: m.ai_write_button, exact: true }).click();
  await page.getByRole("button", { name: m.ai_help_ask, exact: true }).and(page.locator('button[type="button"]')).click();
  const linked = page.locator('input[name="fromDraft"]');
  await expect(linked).toHaveCount(1);
  const draftId = await linked.getAttribute("value");
  expect(new URL(page.url()).pathname).toBe(topicPath);
  await expect(body(page)).toHaveValue("My original reply.");
  await page.getByRole("textbox", { name: m.ai_write_candidate, exact: true }).fill("An AI suggestion.");
  await page.getByRole("button", { name: m.ai_write_apply, exact: true }).click();
  await expect(body(page)).toHaveValue("My original reply.\n\nAn AI suggestion.");
  await page.getByRole("button", { name: m.submit_reply, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${topicPath}.*#c-\\d+$`));
  // The draft that asking made went with the post.
  expect((await page.request.get(`/drafts/${draftId}`)).status()).toBe(404);
});

test("reply actions on a touch device are at least 44 pixels high", async ({ browser }) => {
  const context = await browser.newContext({ hasTouch: true, viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  try {
    const path = `/t/${fixture().topicId}?lang=en`;
    await useMember(page, "ux_author@example.com", path);
    await waitForClientRoute(page);
    const own = page.locator('article[id^="c-"]').first();
    const remove = own.locator("summary").filter({ hasText: m.delete_summary });
    expect((await remove.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await useMember(page, "ux_edit@example.com", path);
    for (const control of [page.getByRole("button", { name: m.insightful_give, exact: true }).last(), page.getByRole("link", { name: m.reply_to_button, exact: true }).last(), page.getByRole("button", { name: m.report_button, exact: true }).last(), page.locator('article[id^="c-"] summary').filter({ hasText: m.flag_summary }).last()]) {
      expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
  } finally { await context.close(); }
});

test("a failed AI tool module preserves the written reply", async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const moduleRoute = await routeModule(page, "app/components/ai-editor-tools-content.tsx", async route => { await held; await route.abort("failed"); });
  try {
    await useMember(page, "ux_reply@example.com", `/t/${fixture().topicId}`);
    await body(page).fill("Keep my reply while loading AI tools.");
  } finally { release(); }
  await openReplyMore(page);
  await moduleRoute.assertHit();
  await expect(page.getByRole("status").filter({ hasText: m.ai_tools_unavailable })).toBeVisible();
  await expect(body(page)).toHaveValue("Keep my reply while loading AI tools.");
});

for (const clearPastedTarget of [false, true]) test(`changing the reply target during an AI save starts the next draft at the new target${clearPastedTarget ? " after clearing a pasted target" : ""}`, async ({ page, context }) => {
  await context.route(/^https:\/\/(chatgpt\.com|claude\.ai)\//, route => route.fulfill({ contentType: "text/html", body: "Mock AI" }));
  await useMember(page, "ux_reply@example.com", `/t/${fixture().questionId}`);
  await page.evaluate(() => localStorage.setItem("tomola.openInAi", JSON.stringify({ provider: "chatgpt" })));
  await waitForClientRoute(page);
  const links = page.getByRole("link", { name: m.reply_to_button, exact: true });
  const firstHref = await links.nth(0).getAttribute("href");
  const firstTarget = new URL(firstHref!, page.url()).searchParams.get("reply_to")!.slice(2);
  if (!clearPastedTarget) await links.nth(0).click();
  const written = `${clearPastedTarget ? `---\ntype: reply\nreply_to: c-${firstTarget}\n---\n` : ""}A reply whose destination changes during saving.`;
  await body(page).fill(written);
  let release!: () => void;
  let saved!: () => void;
  let firstId = 0;
  const held = new Promise<void>(resolve => { release = resolve; });
  const received = new Promise<void>(resolve => { saved = resolve; });
  await page.route("**/drafts/ai-write", async route => {
    const response = await route.fetch();
    firstId = (await response.json()).id;
    saved();
    await held;
    await route.fulfill({ response });
  });
  await openReplyMore(page);
  const ask = page.getByRole("button", { name: m.ai_help_ask, exact: true }).and(page.locator('button[type="button"]'));
  try {
    await page.getByRole("button", { name: m.ai_write_button, exact: true }).click();
    await ask.click();
    await received;
    await links.nth(1).click();
    if (clearPastedTarget) await page.getByRole("link", { name: m.reply_target_clear, exact: true }).click();
    await expect(page.locator('input[name="parentId"]')).not.toHaveValue(firstTarget);
  } finally { release(); }
  await expect(page.getByRole("alert")).toHaveText(m.ai_write_edited);
  await page.unroute("**/drafts/ai-write");
  await ask.click();
  // The next draft is a new one, for the new target: the draft that travels with the form is not the first.
  await expect(page.locator('input[name="fromDraft"]')).not.toHaveValue(String(firstId));
  // The writing screen is not left, so the field still holds what was written (the pasted header included).
  await expect(body(page)).toHaveValue(written);
});

for (const kind of ["topic", "reply"] as const) {
  test(`imports AI text in an author ${kind} edit and changes the original only on Save`, async ({ page }) => {
    await useMember(page, "ux_edit@example.com");
    const topic = await post(page, "/t/new", "Original editing text.");
    const topicPath = new URL(topic.url()).pathname;
    const reply = kind === "reply" ? await post(page, topicPath, "Original editing text.") : null;
    const editPath = reply ? `/c/${new URL(reply.url()).hash.slice(3)}/edit` : `${topicPath}/edit`;
    await page.goto(editPath);
    await waitForClientRoute(page);
    await page.getByRole("button", { name: m.ai_write_import, exact: true }).click();
    await page.getByRole("textbox", { name: m.ai_write_candidate, exact: true }).fill("An editing suggestion.");
    await page.getByRole("button", { name: m.ai_write_apply, exact: true }).click();
    await expect(body(page)).toHaveValue("Original editing text.\n\nAn editing suggestion.");
    expect(await (await page.request.get(`${topicPath}.md`)).text()).not.toContain("An editing suggestion.");
    await page.getByRole("button", { name: m.save_changes, exact: true }).click();
    await expect(page).toHaveURL(url => url.pathname === topicPath);
    expect(await (await page.request.get(`${topicPath}.md`)).text()).toContain("An editing suggestion.");
  });
}

richEditorTest("AI import updates a rich author editor before saving", async ({ page }) => {
  await useMember(page, "ux_edit@example.com");
  const topic = await post(page, "/t/new", "Original rich editing text.");
  await page.goto(`${new URL(topic.url()).pathname}/edit`);
  const rich = page.locator('[contenteditable="true"][role="textbox"]');
  await expect(rich).toContainText("Original rich editing text.");
  await page.getByRole("button", { name: m.ai_write_import, exact: true }).click();
  await page.getByRole("textbox", { name: m.ai_write_candidate, exact: true }).fill("A rich editing suggestion.");
  await page.getByRole("button", { name: m.ai_write_apply, exact: true }).click();
  await expect(rich).toContainText("A rich editing suggestion.");
  await expect(body(page)).toHaveValue("Original rich editing text.\n\nA rich editing suggestion.");
  await page.getByRole("button", { name: m.ai_write_undo, exact: true }).click();
  await expect(rich).not.toContainText("A rich editing suggestion.");
  await expect(body(page)).toHaveValue("Original rich editing text.");
  await page.getByRole("textbox", { name: m.ai_write_candidate, exact: true }).fill("Keep $x$ literal.");
  await page.getByRole("button", { name: m.ai_write_apply, exact: true }).click();
  await expect(rich).toHaveCount(0);
  await expect(body(page)).toHaveValue("Original rich editing text.\n\nKeep $x$ literal.");
});
