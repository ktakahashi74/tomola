import { readTopicTranslation } from "./helpers";
import fs from "node:fs";
import path from "node:path";
import { expect } from "@playwright/test";
import { test, richEditorTest } from "./editor-fixture";
import { clientHeaders, state, useMember, waitForClientRoute, waitForHydration, enMessages as m } from "./helpers";

const navigate = (page: import("@playwright/test").Page, path: string) => page.evaluate(path => {
  void (window as unknown as { __reactRouterDataRouter: { navigate(path: string): Promise<void> } }).__reactRouterDataRouter.navigate(path);
}, path);

test("route announcements focus a changed path and preserve query-only focus", async ({ page }) => {
  await useMember(page, "a11y_navigation@example.com", "/latest");
  await waitForClientRoute(page);
  const announcement = page.locator("#route-announcement");
  await expect(announcement).toHaveText("");
  await expect(page.locator("main")).not.toBeFocused();
  await navigate(page, "/following");
  await expect(page).toHaveURL(/\/following$/);
  await expect(page.locator("main")).toBeFocused();
  await expect(announcement).toHaveText(await page.title());
  const link = page.locator('header a[href="/notifications"]');
  await link.focus();
  await navigate(page, "/following?order=new");
  await waitForClientRoute(page);
  await expect(link).toBeFocused();
  await expect(announcement).toHaveText(await page.title());

  const principles = page.locator('footer a[href="/principles"]');
  await principles.focus();
  await page.keyboard.press("Enter");
  const main = page.locator("main");
  await expect(main).toBeFocused();
  expect(await main.evaluate(element => getComputedStyle(element).outlineStyle)).toBe("none");
  // Click the start of the last item, away from any link it contains (an operator may put a contact link there).
  const lastItem = main.locator("article li").last();
  await lastItem.click({ position: { x: 2, y: 2 } });
  await expect(main).not.toBeFocused();
  await expect(main).not.toHaveAttribute("tabindex");
  await page.keyboard.press("Tab");
  // Tab continues from the clicked point: the item's own link if it has one, otherwise the footer.
  const itemLink = lastItem.locator("a");
  await expect((await itemLink.count()) ? itemLink.first() : page.locator("footer a").first()).toBeFocused();
});

test("submission errors announce and describe the responsible writing field", async ({ page }) => {
  await useMember(page, "a11y_errors@example.com", "/t/new");
  const body = page.locator('textarea[name="body"]');
  await body.fill('---\ntitle: [invalid]\n---\nA retained body.');
  await page.getByRole("button", { name: m.submit_post, exact: true }).click();
  const alert = page.getByRole("alert").filter({ hasText: m.error_frontmatter });
  await expect(alert).toBeVisible();
  await expect(body).toHaveAttribute("aria-invalid", "true");
  expect((await body.getAttribute("aria-describedby"))?.split(" ")).toContain(await alert.getAttribute("id"));
  await expect(body).toHaveAttribute("dir", "auto");
  await expect(page.locator('input[name="title"]')).not.toHaveAttribute("aria-invalid", "true");
});

test("AI import keeps its controlled panel and restores focus after Undo", async ({ page }) => {
  await useMember(page, "a11y_import@example.com", "/t/new");
  const saved = await page.request.post("/t/new", { form: { intent: "draft", body: "Original body.", lang: "en" }, headers: { Origin: new URL(page.url()).origin } });
  expect(saved.ok()).toBe(true);
  await page.goto(new URL(saved.url()).pathname);
  const toggle = page.getByRole("button", { name: m.ai_write_button, exact: true });
  const help = page.locator(`[id="${await toggle.getAttribute("aria-controls")}"]`);
  await expect(help).toHaveCount(1);
  await expect(help).toBeHidden();
  await toggle.click();
  // The pasting part of the opened AI panel.
  const panel = help.locator("[data-ai-paste]");
  await panel.getByRole("textbox", { name: m.ai_write_candidate, exact: true }).fill("Imported text.");
  const status = panel.getByRole("status");
  await expect(status).toHaveText("");
  const apply = panel.getByRole("button", { name: m.ai_write_apply, exact: true });
  await apply.click();
  await expect(apply).toBeFocused();
  await expect(apply).toHaveAttribute("aria-disabled", "true");
  await expect(status).toHaveText(m.ai_write_applied);
  await panel.getByRole("button", { name: m.ai_write_undo, exact: true }).click();
  await expect(apply).toBeFocused();
  await expect(page.locator('textarea[name="body"]')).toHaveValue("Original body.");
});

test("AI settings autosave keeps choice focus and forgetting focuses the heading", async ({ page }) => {
  await useMember(page, "a11y_settings@example.com", "/settings");
  const section = page.locator("#settings-ai-choice");
  const provider = section.getByRole("radio").first();
  await provider.check();
  await expect(section.getByRole("status")).toHaveText(m.settings_ai_saved);
  await expect(provider).toBeFocused();
  await section.getByRole("button", { name: m.settings_ai_forget, exact: true }).click();
  await expect(section.getByRole("heading", { name: m.settings_ai_heading, exact: true })).toBeFocused();
});

richEditorTest("toolbar roves with arrows and restores editor focus after link Escape", async ({ page }) => {
  await useMember(page, "a11y_toolbar@example.com", "/t/new");
  const editor = page.getByRole("textbox", { name: m.field_body, exact: true });
  await expect(page.locator('[contenteditable="true"]')).toBeVisible();
  const toolbar = page.getByRole("toolbar", { name: m.editor_toolbar, exact: true });
  const first = toolbar.getByRole("button", { name: m.editor_heading, exact: true });
  await first.focus();
  await page.keyboard.press("ArrowRight");
  await expect(toolbar.getByRole("button", { name: m.editor_subheading, exact: true })).toBeFocused();
  await page.keyboard.press("Home");
  await expect(first).toBeFocused();
  await page.keyboard.press("End");
  const active = page.locator(":focus");
  await expect(active).toHaveAttribute("tabindex", "0");
  await expect(toolbar.locator('button[tabindex="0"]')).toHaveCount(1);
  await toolbar.getByRole("button", { name: m.editor_link, exact: true }).click();
  await expect(page.getByRole("textbox", { name: m.editor_link_url, exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(editor).toBeFocused();
  await expect(editor).toHaveAttribute("dir", "auto");
});

test("preview announces progress without including the rendered post", async ({ page }) => {
  await useMember(page, "a11y_preview@example.com", "/t/new");
  await page.locator('textarea[name="body"]').fill("A preview that must not be a live region.");
  await page.getByRole("button", { name: m.preview, exact: true }).click();
  const preview = page.locator(".longread").filter({ hasText: "A preview that must not be a live region." });
  await expect(preview).toBeVisible();
  expect(await preview.evaluate(element => element.closest('[aria-live], [role="status"]') !== null)).toBe(false);
  await expect(preview).toHaveAttribute("dir", "auto");
});


test("translation switches retain focus on the replacement link", async ({ page }) => {
  const { topicId } = JSON.parse(fs.readFileSync(path.join(state().dir, "ux-controls.json"), "utf8"));
  await useMember(page, "a11y_translation@example.com", `/t/${topicId}?lang=en`);
  await waitForHydration(page);
  const topic = page.locator(`#p-${topicId}`);
  await topic.getByRole("link", { name: m.show_original, exact: true }).click();
  await expect(topic.locator("details.reading-lang-menu summary")).toBeFocused();
  await readTopicTranslation(topic);
  await expect(topic.getByRole("link", { name: m.show_original, exact: true })).toBeFocused();
  await expect(topic.locator("[data-reading-body]")).toHaveAttribute("dir", "auto");
});

test("passkey actions retain busy focus, reject duplicates and recover after Later", async ({ page }) => {
  await useMember(page, "a11y_passkey@example.com");
  await page.getByRole("button", { name: m.passkey_prompt_later, exact: true }).click();
  await expect(page.locator("main")).toBeFocused();
  expect(await page.locator("main").evaluate(element => getComputedStyle(element).outlineStyle)).toBe("none");
  await page.keyboard.press("Tab");
  await expect(page.locator("main")).not.toHaveAttribute("tabindex");
  await page.goto("/settings");
  await page.locator("#settings-advanced > summary").click();
  let requests = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/passkeys", async route => {
    requests++; await gate;
    await route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "passkey_failed" }) });
  });
  const add = page.getByRole("button", { name: m.settings_passkeys_add, exact: true });
  try {
    await add.click();
    await expect(add).toHaveAttribute("aria-disabled", "true");
    await expect(add).toBeFocused();
    await add.evaluate(button => (button as HTMLButtonElement).click());
    await expect.poll(() => requests).toBe(1);
  } finally { release(); }
  await expect(page.getByRole("alert")).toContainText(m.settings_passkeys_error_generic);
  await expect(add).toBeFocused();
});

test("email and login code failures expose their alerts to the input", async ({ page }) => {
  await page.setExtraHTTPHeaders(clientHeaders("10.91.0.1"));
  await page.goto("/login");
  const email = page.getByRole("textbox", { name: m.login_email, exact: true });
  await email.fill("incomplete");
  await email.evaluate(input => { (input as HTMLInputElement).form!.noValidate = true; });
  await page.getByRole("button", { name: m.login_submit, exact: true }).click();
  const emailAlert = page.getByRole("alert").filter({ hasText: m.login_invalid_email });
  await expect(emailAlert).toBeVisible();
  await expect(email).toHaveAttribute("aria-invalid", "true");
  expect(await email.getAttribute("aria-describedby")).toBe(await emailAlert.getAttribute("id"));
  await email.fill("a11y_code@example.com");
  await page.getByRole("button", { name: m.login_submit, exact: true }).click();
  const code = page.getByRole("textbox", { name: m.login_code_label, exact: true });
  await expect(code).toBeFocused();
  await code.fill("000000");
  await page.getByRole("button", { name: m.login_code_submit, exact: true }).click();
  const codeAlert = page.getByRole("alert").filter({ hasText: m.login_code_invalid });
  await expect(codeAlert).toBeVisible();
  await expect(code).toHaveAttribute("aria-invalid", "true");
  expect(await code.getAttribute("aria-describedby")).toBe(await codeAlert.getAttribute("id"));
});
