import { expect, type BrowserContext, type Page } from "@playwright/test";
import { test } from "./editor-fixture";
import { useMember, clientHeaders, enMessages as en, relatedInvitations, titleField, uiMessages, waitForFormReady } from "./helpers";

test.describe.configure({ mode: "serial" });
let writerContext: BrowserContext, readerContext: BrowserContext;
let writer: Page, reader: Page;
let hub: string, target: number, readerSource: string;
const references: string[] = [];
const panel = (page: Page) => page.locator("#related");
async function post(page: Page, title: string, body: string) {
  await page.goto("/t/new");
  await waitForFormReady(page.locator("form", { has: titleField(page) }));
  await page.getByText(en.writing_tips, { exact: true }).click();
  await expect(page.getByText(en.related_link_help, { exact: true })).toBeVisible();
  await titleField(page).fill(title);
  await page.getByLabel(en.field_body, { exact: true }).fill(body);
  await page.getByRole("button", { name: en.submit_post, exact: true }).click();
  await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
  return new URL(page.url()).pathname;
}
async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}
test.beforeAll(async ({ browser }) => {
  const invites = relatedInvitations();
  writerContext = await browser.newContext({ extraHTTPHeaders: clientHeaders("10.43.0.1"), viewport: { width: 390, height: 844 } });
  readerContext = await browser.newContext({ extraHTTPHeaders: clientHeaders("10.43.0.2"), viewport: { width: 390, height: 844 } });
  writer = await writerContext.newPage(); reader = await readerContext.newPage();
  await useMember(writer, "related_browser_writer@example.com");
  await useMember(reader, "related_browser_reader@example.com");
  hub = await post(writer, "Related browser hub", "Discussion at the center of these references.");
  await waitForFormReady(writer.locator("#reply form"));
  await writer.getByLabel(en.field_body, { exact: true }).fill("A specific reply to refer to.");
  await writer.getByRole("button", { name: en.submit_reply, exact: true }).click();
  await expect(writer.getByText("A specific reply to refer to.", { exact: true })).toBeVisible();
  target = Number(new URL(writer.url()).hash.slice(3));
  for (let i = 1; i <= 5; i++) references.push(await post(writer, `Related browser reference ${i}`, `Explanation ${i}: [related reply](${hub}.md?lang=ja&k=fixture-secret#c-${target})`));
});
test.afterAll(async () => { await writerContext?.close(); await readerContext?.close(); });

test("one author contributes one inline row, all five remain accessible, after replies and the editor", async () => {
  await reader.goto(hub);
  await expect(panel(reader).locator("[data-related-topic]")).toHaveCount(1);
  await expect(panel(reader).getByText(en.related_help, { exact: true })).toHaveCount(0);
  await expect(panel(reader).getByRole("link", { name: "Related browser reference 5", exact: true })).toHaveAttribute("href", `${references[4]}#p-${references[4].split("/").at(-1)}`);
  await expect(panel(reader).getByText(en.related_incoming, { exact: true })).toBeVisible();
  expect(await panel(reader).evaluate(node => !!(document.getElementById("reply")!.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
  await noOverflow(reader);
  await panel(reader).getByRole("link", { name: en.related_all, exact: true }).click();
  await expect(reader.getByRole("heading", { name: en.related_title, exact: true })).toBeVisible();
  await expect(reader.locator("[data-related-topic]")).toHaveCount(5);
  await noOverflow(reader);
});

test("both discussions lead to the source explanation and the exact target reply, with language carried", async () => {
  await reader.goto(`${references[4]}?lang=ja`);
  // A shared ?lang= link also sets the interface language for a visitor without a language cookie.
  const ui = await uiMessages(reader);
  await expect(panel(reader).getByText(ui.related_outgoing, { exact: true })).toBeVisible();
  const link = panel(reader).getByRole("link").filter({ hasText: "Related browser hub" });
  await expect(link).toHaveAttribute("href", `${hub}?lang=ja#c-${target}`);
  expect(await panel(reader).innerHTML()).not.toContain("fixture-secret");
  await link.click();
  await expect(reader).toHaveURL(new RegExp(`\\?lang=ja#c-${target}$`));
  await panel(reader).getByRole("link", { name: ui.related_source, exact: true }).click();
  await expect(reader).toHaveURL(new RegExp(`${references[4]}\\?lang=ja#p-\\d+$`));
  await expect(reader.getByText("Explanation 5:", { exact: false }).first()).toBeVisible();
  await noOverflow(reader);
});

test("removing a link removes both related rows after reloading", async () => {
  readerSource = await post(reader, "Another related browser author", `My explanation: [discussion](${hub}#c-${target})`);
  await reader.goto(hub);
  await expect(panel(reader).locator("[data-related-topic]")).toHaveCount(2);
  await reader.goto(`${readerSource}/edit`);
  await waitForFormReady(reader.locator("form", { has: titleField(reader) }));
  await reader.getByLabel(en.field_body, { exact: true }).fill("My explanation no longer links to another discussion.");
  await reader.getByRole("button", { name: en.save_changes, exact: true }).click();
  await expect(reader).toHaveURL(new RegExp(`${readerSource}(?:[?#].*)?$`));
  await expect(panel(reader)).toHaveCount(0);
  await reader.goto(hub);
  await expect(panel(reader).locator("[data-related-topic]")).toHaveCount(1);
  await expect(panel(reader).getByText(en.related_help, { exact: true })).toHaveCount(0);
  await expect(panel(reader).getByRole("link", { name: "Another related browser author", exact: true })).toHaveCount(0);
  await noOverflow(reader);
});
