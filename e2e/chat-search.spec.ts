import fs from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { captureScreenshot, enMessages as m, state, useMember, waitForClientRoute } from "./helpers";

const fixtures = () => JSON.parse(fs.readFileSync(path.join(state().dir, "chat-search.json"), "utf8")) as Record<string, { first: string; deleted: string }>;
async function search(page: Page, phrase: string) {
  await page.getByRole("search", { name: m.chat_search_title, exact: true }).getByRole("searchbox").fill(phrase);
  const request = page.waitForRequest(request => request.method() === "POST" && new URL(request.url()).pathname.includes("/chat/search"));
  await page.getByRole("search", { name: m.chat_search_title, exact: true }).getByRole("button", { name: m.search_button, exact: true }).click();
  const sent = await request;
  expect(new URL(sent.url()).searchParams.has("q")).toBe(false);
  expect(new URLSearchParams(sent.postData()!).get("q")).toBe(phrase);
  expect((await sent.response())!.headers()["cache-control"]).toBe("private, no-store");
  await expect(page.getByRole("heading", { name: m.chat_search_results, exact: true })).toBeVisible();
  await expect(page.getByRole("search", { name: m.chat_search_title, exact: true }).getByRole("button", { name: m.search_button, exact: true })).toBeEnabled();
}

test("searches original and translated words with safe excerpts and jumps to an older highlighted message", async ({ page, browser }) => {
  const fixture = fixtures().basic;
  await useMember(page, "cs_basic_reader@example.com", "/v/chat-search-basic/chat"); await waitForClientRoute(page);
  await expect(page.locator(`#chat-${fixture.first}`)).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("link", { name: m.chat_search_title, exact: true }).click(); await waitForClientRoute(page);
  await search(page, "<script>");
  const results = page.getByRole("list", { name: m.chat_search_results, exact: true });
  await expect(results.locator("mark")).toHaveText("<script>"); await expect(results.locator("script")).toHaveCount(0);
  await expect(results).toContainText(m.search_match_original);
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await captureScreenshot(page, { path: `chat-search-${width}.png`, fullPage: true, animations: "disabled" }, "chat-search");
  }
  await search(page, "translated-only-needle");
  await expect(results).toContainText(m.chat_search_match_translation);
  await results.getByRole("link").click(); await waitForClientRoute(page);
  const target = page.locator(`#chat-${fixture.first}`);
  await expect(target).toBeInViewport(); await expect(page.locator(":target")).toHaveAttribute("id", `chat-${fixture.first}`);
  await page.goto("/v/chat-search-basic/chat/search"); await waitForClientRoute(page);
  await search(page, "unrecorded-query-marker");
  await expect(page.getByText(m.chat_search_empty, { exact: true })).toBeVisible();
  expect(fs.readFileSync(state().logFile, "utf8")).not.toContain("unrecorded-query-marker");
  expect(page.url()).not.toContain("unrecorded-query-marker");
  await search(page, "translated-only-needle");
  const context = await browser.newContext({ locale: "en-US" });
  try {
    const author = await context.newPage(); await useMember(author, "cs_basic_author@example.com", "/v/chat-search-basic/chat");
    const deletion = await author.request.post("/v/chat-search-basic/chat", { form: { intent: "delete", id: fixture.first }, headers: { Origin: new URL(author.url()).origin } });
    expect(deletion.ok()).toBe(true);
    await results.getByRole("link").click();
    await expect(page.getByText(m.chat_search_message_unavailable, { exact: true })).toBeVisible();
    await expect(page.locator('[data-chat-message]')).toHaveCount(0);
  } finally { await context.close(); }
});

test("continues older matches during arrivals and deletion and rechecks membership before the next page", async ({ page, browser }) => {
  const fixture = fixtures().paging;
  await useMember(page, "cs_paging_reader@example.com", "/v/chat-search-paging/chat/search"); await waitForClientRoute(page);
  await search(page, "paging-search-phrase");
  const results = page.getByRole("list", { name: m.chat_search_results, exact: true });
  const first = await results.getByRole("link").evaluateAll(elements => elements.map(element => element.getAttribute("href")));
  expect(first).toHaveLength(20);
  const context = await browser.newContext({ locale: "en-US" });
  try {
    const author = await context.newPage(); await useMember(author, "cs_paging_author@example.com", "/v/chat-search-paging/chat"); await waitForClientRoute(author);
    await author.getByLabel(m.village_chat_body, { exact: true }).fill("paging-search-phrase new arrival");
    await author.getByRole("button", { name: m.village_chat_send, exact: true }).click();
    await expect(author.getByLabel(m.village_chat_body, { exact: true })).toHaveValue("");
    expect((await author.request.post("/v/chat-search-paging/chat", { form: { intent: "delete", id: fixture.deleted }, headers: { Origin: new URL(author.url()).origin } })).ok()).toBe(true);
    await page.getByRole("button", { name: m.chat_search_more, exact: true }).click();
    await expect(results.getByRole("link").first()).not.toHaveAttribute("href", first[0]!);
    await expect(results.getByRole("link")).toHaveCount(20);
    const second = await results.getByRole("link").evaluateAll(elements => elements.map(element => element.getAttribute("href")));
    expect(second.some(href => first.includes(href))).toBe(false);
    expect(second.some(href => href!.includes(fixture.deleted))).toBe(false);
    await expect(results).not.toContainText("new arrival");
    await page.getByRole("button", { name: m.chat_search_more, exact: true }).click();
    await expect(results.getByRole("link")).toHaveCount(4);
    await expect(page.getByRole("button", { name: m.chat_search_more, exact: true })).toHaveCount(0);
    await search(page, "paging-search-phrase");
    await expect(results.getByRole("link")).toHaveCount(20);
    const departure = await page.request.post("/v/chat-search-paging", { form: { intent: "leave" }, headers: { Origin: new URL(page.url()).origin } });
    expect(departure.ok()).toBe(true);
    await page.getByRole("button", { name: m.chat_search_more, exact: true }).click();
    await expect(page.getByText(m.chat_search_message_unavailable, { exact: true })).toBeVisible();
    await expect(results).toHaveCount(0);
  } finally { await context.close(); }
});

test("does not expose an entrance or search results without current consent or membership", async ({ page }) => {
  await useMember(page, "cs_gate_noagree@example.com", "/v/chat-search-gate/chat"); await waitForClientRoute(page);
  await expect(page.getByRole("link", { name: m.chat_search_title, exact: true })).toHaveCount(0);
  expect((await page.goto("/v/chat-search-gate/chat/search"))!.status()).toBe(404);
  await expect(page.getByText(m.chat_search_message_unavailable, { exact: true })).toBeVisible();
  await useMember(page, "cs_gate_outsider@example.com", "/v/chat-search-gate/chat/search");
  await expect(page.getByText(m.chat_search_message_unavailable, { exact: true })).toBeVisible();
  await expect(page.getByRole("search", { name: m.chat_search_title, exact: true })).toHaveCount(0);
});

test("supports native POST search and jumping without JavaScript", async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false, locale: "en-US" });
  try {
    const page = await context.newPage(); await useMember(page, "cs_native_reader@example.com", "/v/chat-search-native/chat");
    await page.getByRole("link", { name: m.chat_search_title, exact: true }).click();
    await page.getByRole("searchbox", { name: m.chat_search_title, exact: true }).fill("native-search-phrase"); await page.getByRole("search", { name: m.chat_search_title, exact: true }).getByRole("button", { name: m.search_button, exact: true }).click();
    await page.getByRole("list", { name: m.chat_search_results, exact: true }).getByRole("link").click();
    await expect(page.locator(`#chat-${fixtures().native.first}`)).toBeVisible();
    expect(page.url()).not.toContain("native-search-phrase");
  } finally { await context.close(); }
});
