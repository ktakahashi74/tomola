import fs from "node:fs";
import path from "node:path";
import { expect } from "@playwright/test";
import { richEditorTest as test } from "./editor-fixture";
import { enMessages as en, useMember, titleField, waitForFormReady, chooseEditorMode } from "./helpers";

test("typed URL punctuation preserves link boundaries through publication and editing", async ({ page }) => {
  await useMember(page, "url_links_writer@example.com");
  await page.goto("/t/new");
  const body = page.locator('textarea[name="body"]');
  const rich = page.locator('[contenteditable="true"][role="textbox"]');
  await waitForFormReady(page.locator("form", { has: body }));
  await expect(rich).toBeVisible();
  await rich.focus();
  await page.keyboard.insertText("a\tb ");
  await page.keyboard.type("https://g.com/h?i=1&j=2");
  await page.keyboard.insertText("。次の文、");
  await page.keyboard.type("https://b.com");
  await page.keyboard.insertText("。終わり");
  await expect(body).toHaveValue("a\tb https\\://g.com/h?i=1\\&j=2。次の文、https\\://b.com。終わり\n");
  // Typed prose is serialized as escaped text. Reopen it with the editor's
  // parser to compare the same saved source against the reading parser.
  const source = await body.inputValue();
  await chooseEditorMode(page, en.editor_mode_markdown);
  await chooseEditorMode(page, en.editor_mode_rich);
  await expect(rich.locator("a")).toHaveText(["https://g.com/h?i=1&j=2", "https://b.com"]);
  await expect(rich.locator("a").first()).toHaveAttribute("href", "https://g.com/h?i=1&j=2");
  await expect(body).toHaveValue(source);
  await titleField(page).fill("URL punctuation round trip");
  await page.getByRole("button", { name: en.submit_post, exact: true }).click();
  await expect(page).toHaveURL(/\/t\/\d+(?:\?.*)?$/);
  const posted = page.locator("[data-reading-body]").first();
  await expect(posted.locator("a")).toHaveText(["https://g.com/h?i=1&j=2", "https://b.com"]);
  await expect(posted.locator("a").first()).toHaveAttribute("href", "https://g.com/h?i=1&j=2");
  await expect(posted).toHaveText("a\tb https://g.com/h?i=1&j=2。次の文、https://b.com。終わり");
  const directory = process.env.E2E_EVIDENCE_DIR;
  if (directory) {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "url-links.json"), JSON.stringify({ markdown: source, html: await posted.innerHTML() }, null, 2));
  }
  await page.goto(new URL(page.url()).pathname + "/edit");
  await expect(rich).toBeVisible();
  await expect(rich.locator("a")).toHaveText(["https://g.com/h?i=1&j=2", "https://b.com"]);
  await expect(body).toHaveValue(source);
});
