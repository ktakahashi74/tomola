import { readTopicTranslation } from "./helpers";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import { expect } from "@playwright/test";
import { test } from "./editor-fixture";
import { captureScreenshot, clientHeaders, enMessages as en, state, useMember, waitForHydration } from "./helpers";
import { captureLogomarkPreviews } from "./logomark-preview";

const fixture = (): Record<string, { topicId: number; nextId: number }> => JSON.parse(fs.readFileSync(path.join(state().dir, "share-card.json"), "utf8"));

// Node's HTTP client sends no Accept-Language, cookies or member session.
function anonymousGet(pathname: string): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  const url = new URL(`${state().baseURL}${pathname}`);
  return new Promise((resolve, reject) => {
    const onResponse = (response: http.IncomingMessage) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", chunk => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode!, body, headers: response.headers }));
    };
    // The build server is behind a local proxy with a self-signed certificate.
    const request = url.protocol === "https:" ? https.get(url, { rejectUnauthorized: false }, onResponse) : http.get(url, onResponse);
    request.on("error", reject);
  });
}

test("public preview requests use source or hinted language and serve the fallback image anonymously", async ({ page }, info) => {
  const { topicId } = fixture().guest;
  for (const suffix of ["", "?sl=en"]) {
    const response = await anonymousGet(`/t/${topicId}${suffix}`);
    expect(response.status).toBe(200);
    const og = response.body.match(/<meta\b[^>]*(?:property="og:|name="twitter:)[^>]*>/g) ?? [];
    await info.attach(suffix ? "hinted-og" : "bare-og", { body: og.join("\n"), contentType: "text/plain" });
    expect(og).toContain(`<meta property="og:locale" content="${suffix ? "en_US" : "ja_JP"}"/>`);
    expect(og).toContain(`<meta property="og:url" content="${state().baseURL}/t/${topicId}${suffix}"/>`);
    expect(og).toContain(`<meta property="og:image" content="${state().baseURL}/icons/share-default.png"/>`);
    expect(og).toContain('<meta name="twitter:card" content="summary"/>');
  }
  const image = await anonymousGet("/icons/share-default.png");
  expect(image.status).toBe(200);
  expect(image.headers["content-type"]).toContain("image/png");
  await page.goto(`/t/${topicId}`);
  const preview = await page.evaluate(() => {
    const read = (property: string) => document.querySelector<HTMLMetaElement>(`meta[property="og:${property}"]`)!.content;
    return { title: read("title"), description: read("description"), image: read("image") };
  });
  await waitForHydration(page);
  await captureScreenshot(page, { path: "share-source-article.png", fullPage: true }, "logomark");
  await captureLogomarkPreviews(page, preview);
});

test("guest address hints follow the body without navigation, scroll changes or extra history", async ({ browser }) => {
  const context = await browser.newContext({ locale: "en-US", extraHTTPHeaders: clientHeaders("10.97.13.1") });
  // Capture every address-only replacement, including its before/after state and history length.
  await context.addInitScript(() => {
    const replace = history.replaceState.bind(history);
    (window as any).addressReplacements = [];
    history.replaceState = (data, unused, url) => {
      const before = { state: history.state, length: history.length, scroll: scrollY };
      replace(data, unused, url);
      if (url) (window as any).addressReplacements.push({ before, after: { state: history.state, length: history.length, scroll: scrollY } });
    };
  });
  const page = await context.newPage();
  const { topicId, nextId } = fixture().guest;
  try {
    const navigations: string[] = [];
    page.on("request", request => { if (request.isNavigationRequest() || new URL(request.url()).pathname.endsWith(".data")) navigations.push(request.url()); });
    await page.goto(`/t/${topicId}?sl=ja&page=1#p-${topicId}`);
    await waitForHydration(page);
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(page.locator("[data-reading-body]").first()).toHaveAttribute("lang", "en");
    await expect.poll(() => new URL(page.url()).searchParams.get("sl")).toBe("en");
    expect(new URL(page.url()).searchParams.get("page")).toBe("1");
    expect(new URL(page.url()).hash).toBe(`#p-${topicId}`);
    const requestCount = navigations.length;
    const length = await page.evaluate(() => history.length);
    await page.getByRole("link", { name: en.show_original, exact: true }).click();
    await expect(page.locator("[data-reading-body]").first()).toHaveAttribute("lang", "ja");
    await expect.poll(() => new URL(page.url()).searchParams.has("sl")).toBe(false);
    await readTopicTranslation(page);
    await expect.poll(() => new URL(page.url()).searchParams.get("sl")).toBe("en");
    expect(navigations).toHaveLength(requestCount);
    expect(await page.evaluate(() => history.length)).toBe(length);
    const replacements = await page.evaluate(() => (window as any).addressReplacements);
    expect(replacements.length).toBeGreaterThanOrEqual(3);
    for (const replacement of replacements) expect(replacement.after).toEqual(replacement.before);
    // Links to another page do not carry this page's preview language.
    const leaked = await page.locator("a[href]").evaluateAll(links => links.map(link => new URL((link as HTMLAnchorElement).href)).filter(url => url.pathname !== location.pathname && url.searchParams.has("sl")).map(url => url.href));
    expect(leaked).toEqual([]);
    await page.locator(`[data-reading-body] a[href="/t/${nextId}"]`).click();
    await expect(page).toHaveURL(new RegExp(`/t/${nextId}$`));
    await page.goBack();
    await expect.poll(() => new URL(page.url()).searchParams.get("sl")).toBe("en");
    await page.goForward();
    await expect(page).toHaveURL(new RegExp(`/t/${nextId}$`));
    await page.goto(`/t/${topicId}?lang=en&sl=ja`);
    await expect.poll(() => new URL(page.url()).searchParams.has("sl")).toBe(false);
    expect(new URL(page.url()).searchParams.get("lang")).toBe("en");
    const japanese = await browser.newContext({ locale: "ja-JP", extraHTTPHeaders: clientHeaders("10.97.13.4") });
    try {
      const original = await japanese.newPage();
      await original.goto(`/t/${topicId}?sl=en`);
      await expect(original.locator("html")).toHaveAttribute("lang", "ja");
      await expect(original.locator("[data-reading-body]").first()).toHaveAttribute("lang", "ja");
      await expect.poll(() => new URL(original.url()).searchParams.has("sl")).toBe(false);
    } finally { await japanese.close(); }
  } finally { await context.close(); }
});

for (const scenario of ["member", "source"]) {
  test(`member preview hints preserve reading preferences: ${scenario}`, async ({ page }) => {
    await page.setExtraHTTPHeaders(clientHeaders(scenario === "member" ? "10.97.13.2" : "10.97.13.3"));
    await useMember(page, `card_${scenario}@example.com`);
    const { topicId } = fixture()[scenario];
    const cookies = (await page.context().cookies()).filter(cookie => cookie.name === "PARAGLIDE_LOCALE");
    await page.goto(`/t/${topicId}?sl=ja`);
    await waitForHydration(page);
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(page.locator("[data-reading-body]").first()).toHaveAttribute("lang", scenario === "member" ? "en" : "ja");
    await expect.poll(() => new URL(page.url()).searchParams.get("sl")).toBe(scenario === "member" ? "en" : null);
    expect((await page.context().cookies()).filter(cookie => cookie.name === "PARAGLIDE_LOCALE")).toEqual(cookies);
  });
}
