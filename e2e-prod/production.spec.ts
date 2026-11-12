import { enableSigningAuthenticator } from "../e2e/signing-helper";
import { enMessages, formatMessage, messagePattern, openPostSettings, waitForFormReady } from "../e2e/helpers";
import fs from "node:fs";
import path from "node:path";
import { request as playwrightRequest, type BrowserContext, type Page } from "@playwright/test";
import { waitForClientRoute, openUserMenu, openAdminMenu, expect, mailCount, signUp, state, test, watchCsp, type CspWatch  } from "./helpers";

// Exercise the production build (node server.ts, NODE_ENV=production) with production settings in a browser: security headers (nonce-bearing scripts execute without CSP console violations),
// signup, posts (KaTeX, footnotes, external images), replies, worker translations, semantic search, Markdown twins, operator screens, passkeys, UI language switching and access-log secret removal.
// One server and database are shared; tests run serially and use earlier results. global-setup.ts handles setup and verifies graceful SIGTERM shutdown.
test.describe.configure({ mode: "serial" });

let bossContext: BrowserContext;
let mikaContext: BrowserContext;
let boss: Page;
let mika: Page;
let bossCsp: CspWatch;
let mikaCsp: CspWatch;
let topicId: string;
let questionId: string;
let composerTopicId: string;
// The question of the stance tests (made by boss in "a question, a reply marked as an objection ...").
let questionPath = "";
let external: string[] = [];

test.beforeAll(async ({ browser }) => {
  bossContext = await browser.newContext();
  mikaContext = await browser.newContext();
  boss = await bossContext.newPage();
  mika = await mikaContext.newPage();
  bossCsp = await watchCsp(boss);
  mikaCsp = await watchCsp(mika);
  // Record and abort requests to the external image hosts; none should be made.
  external = [];
  for (const ctx of [bossContext, mikaContext]) {
    await ctx.route(/cdn\.example\.net|tracker\.example\.net/, (route) => {
      external.push(route.request().url());
      return route.abort();
    });
  }
});
test.afterAll(async () => {
  await bossContext.close();
  await mikaContext.close();
});

// Every screen must have no CSP violations or page errors.
function expectClean(...watches: CspWatch[]) {
  for (const w of watches) {
    expect(w.violations, "CSP violations in the console").toEqual([]);
    expect(w.pageErrors, "uncaught errors in the page").toEqual([]);
    expect(w.hydrationWarnings, "hydration warnings in the console").toEqual([]);
  }
}

test("every response carries the headers, and the page's inline scripts run under the nonce of its CSP", async ({ request }) => {
  const watch = await watchCsp(boss);
  const res = await boss.goto("/login");
  expect(res!.status()).toBe(200);
  const h = res!.headers();
  const nonce = /script-src 'self' 'nonce-([A-Za-z0-9+/]{22}==)'/.exec(h["content-security-policy"])?.[1];
  expect(nonce, "a nonce in the CSP").toBeDefined();
  expect(h["content-security-policy"]).toBe(
    `default-src 'self'; script-src 'self' 'nonce-${nonce}'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; worker-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`,
  );
  expect(h["strict-transport-security"]).toBe("max-age=31536000");
  expect(h["x-content-type-options"]).toBe("nosniff");
  // Login and the other authorization pages leave the opener intact for pop-up OAuth clients; ordinary pages isolate it.
  expect(h["cross-origin-opener-policy"]).toBeUndefined();
  expect((await request.get("/principles")).headers()["cross-origin-opener-policy"]).toBe("same-origin");
  expect(h["referrer-policy"]).toBe("strict-origin-when-cross-origin");
  expect(h["vary"]).toMatch(/Accept-Language/i);
  expect(h["vary"]).toMatch(/Cookie/i);
  expect(h["permissions-policy"]).toContain("camera=()");
  // Documents containing a nonce must not enter shared caches; this is the default for routes without Cache-Control.
  expect(h["cache-control"]).toBe("private, no-cache");
  expect(h["permissions-policy"]).toContain("publickey-credentials-get=(self)");
  // Every inline script without src (React Router data transfer and streaming) carries this nonce. Read the property because browsers hide the attribute value.
  await waitForClientRoute(boss);
  const nonces = await boss.evaluate(() => [...document.scripts].filter((s) => !s.src).map((s) => s.nonce));
  expect(nonces.length).toBeGreaterThan(0);
  expect(new Set(nonces)).toEqual(new Set([nonce]));
  // JavaScript runs and hydration is complete: React Router client state exists.
  expect(await boss.evaluate(() => "__reactRouterContext" in window)).toBe(true);
  // Each request gets a different nonce.
  const again = await request.get("/login");
  const nonce2 = /'nonce-([^']+)'/.exec(again.headers()["content-security-policy"])?.[1];
  expect(nonce2).toBeDefined();
  expect(nonce2).not.toBe(nonce);
  // 404 responses, static files and Markdown guidance also carry the headers.
  const missing = await request.get("/no-such-page", { headers: { "Accept-Language": "ja-JP" } });
  expect(missing.status()).toBe(404);
  expect(missing.headers()["content-security-policy"]).toContain("nonce-");
  expect(missing.headers()["x-content-type-options"]).toBe("nosniff");
  expect(missing.headers()["cache-control"]).toBe("private, no-cache");
  const missingHtml = await missing.text();
  expect(missingHtml).toContain('<html lang="ja"');
  // The error screen is a real page (a title ending in the site name, one h1, the code), whatever its wording.
  expect(missingHtml).toMatch(/<title>[^<]+ · tomola<\/title>/);
  expect(missingHtml.match(/<h1[ >]/g) ?? []).toHaveLength(1);
  expect(missingHtml).toMatch(/>404<\/p>/);
  const asset = new URL(await boss.evaluate(() => document.querySelector<HTMLLinkElement>('link[rel="modulepreload"]')?.href ?? ""), state().baseURL).pathname;
  expect(asset).toMatch(/^\/assets\/.+\.js$/);
  const assetRes = await request.get(asset);
  expect(assetRes.status()).toBe(200);
  expect(assetRes.headers()["cache-control"]).toBe("public, max-age=31536000, immutable");
  expect(assetRes.headers()["x-content-type-options"]).toBe("nosniff");
  expect(assetRes.headers()["strict-transport-security"]).toBe("max-age=31536000");
  const llms = await request.get("/llms.txt");
  expect(llms.status()).toBe(200);
  expect(llms.headers()["x-content-type-options"]).toBe("nosniff");
  expect(llms.headers()["strict-transport-security"]).toBe("max-age=31536000");
  // Health check for the proxy and Docker; does not touch the database.
  expect((await request.get("/healthz")).status()).toBe(200);
  expectClean(watch);
});


test("an invited operator logs in with a magic link from the mail server and sets up a profile", async () => {
  await signUp(boss, "boss@example.com", { handle: "boss", mainLang: "ja", read: ["日本語", "English"] }, async (link) => {
    const binding = (await bossContext.cookies()).find(c => c.name === "__Host-tomola.magic-link-browser");
    expect(binding).toMatchObject({ httpOnly: true, secure: true, sameSite: "Lax", path: "/" });
    // A real victim browser clicks an unused valid link but cannot enter the
    // operator's account. The requesting browser can still consume it below.
    await mika.goto(link);
    await expect(mika.getByRole("heading", { level: 1, name: enMessages.confirm_unusable_heading, exact: true })).toBeVisible();
    await expect(mika.getByRole("button", { name: enMessages.confirm_submit, exact: true })).toHaveCount(0);
    await mika.goto("/");
    await expect(mika).toHaveURL(/\/login$/);
  });
  expectClean(bossCsp);
  // The magic-link email reached fake SMTP, not stdout. The signed-in operator can see the operator links.
  await openAdminMenu(boss);
  await expect(boss.getByRole("menuitem", { name: enMessages.nav_usage, exact: true })).toBeVisible();
});

test("a topic with math, a footnote and an external image: the preview and the post render under the CSP, and the image is a link that is never fetched", async () => {
  await boss.goto("/t/new");
  await waitForFormReady(boss.locator("form", { has: boss.getByLabel(enMessages.report_field_title) }));
  await boss.getByLabel(enMessages.report_field_title).fill("共生と協力について");
  await boss.locator('textarea[name="body"]').fill(
    [
      "人間とAIの共生のためには、協力が欠かせない。$x^2 + y^2$ を考える。[^1]",
      "",
      "[^1]: 脚注の本文。",
      "",
      "![外部の画像](https://cdn.example.net/tracker.png)",
      "",
      "[![リンクの画像](https://tracker.example.net/b.png)](https://example.org/page)",
    ].join("\n"),
  );
  await openPostSettings(boss);
  await boss.getByLabel(enMessages.field_lang).click();
  await boss.getByRole("listbox").getByRole("option", { name: "日本語", exact: true }).click();
  // Preview fetches the server render through JavaScript (connect-src 'self'); external images become links.
  await expect(async () => {
    await boss.getByRole("button", { name: enMessages.preview }).click();
    await expect(boss.locator("div.longread .katex").first()).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 30_000 });
  await expect(boss.locator("div.longread").getByRole("link", { name: "外部の画像" })).toHaveAttribute("href", "https://cdn.example.net/tracker.png");
  await boss.getByRole("button", { name: enMessages.submit_post, exact: true }).click();
  await expect(boss.getByRole("heading", { level: 1, name: "共生と協力について" })).toBeVisible();
  topicId = new URL(boss.url()).pathname.split("/").at(-1)!;
  const article = boss.locator("article").first();
  // KaTeX: style-src 'unsafe-inline' permits style attributes; font-src allows 'self' or data: fonts.
  await expect(article.locator(".katex").first()).toBeVisible();
  // External images become links (nofollow noopener noreferrer), not images; the browser must not request their hosts.
  await expect(article.locator("[data-reading-body] img")).toHaveCount(0);
  const link = article.getByRole("link", { name: "外部の画像" });
  await expect(link).toHaveAttribute("href", "https://cdn.example.net/tracker.png");
  await expect(link).toHaveAttribute("rel", "nofollow noopener noreferrer");
  // An image inside a link becomes text, avoiding nested links.
  await expect(article.getByRole("link", { name: "リンクの画像" })).toHaveAttribute("href", "https://example.org/page");
  // The footnote heading for screen readers uses the body's language, Japanese.
  await expect(article.locator("[data-footnotes] h2")).toHaveText("脚注");
  expect(external, "no request to the external image hosts").toEqual([]);
  expectClean(bossCsp);
});

test("a second member in another language area reads the translation made by the worker, replies, and finds the topic by search", async () => {
  await signUp(mika, "mika@example.com", { handle: "mika", mainLang: "en" });
  // The server worker produces translations with a fake engine. Reload until ready.
  await expect(async () => {
    await mika.goto(`/t/${topicId}`);
    await expect(mika.getByRole("heading", { level: 1, name: "[en] 共生と協力について" })).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 60_000 });
  // Reply through a JavaScript form submission; posting navigates to the reply anchor.
  const form = mika.locator("#reply form");
  await form.locator('textarea[name="body"]').fill("Cooperation matters.");
  await form.getByRole("button", { name: enMessages.submit_reply, exact: true }).click();
  await expect(mika).toHaveURL(/#c-\d+$/);
  // Semantic search: the English query cooperation finds a Japanese topic; the worker generates post embeddings.
  await expect(async () => {
    await mika.goto("/");
    const box = mika.getByRole("search").getByRole("searchbox");
    await box.fill("cooperation");
    await box.press("Enter");
    await expect(mika).toHaveURL(/\/search\?q=cooperation$/);
    await expect(mika.getByRole("link", { name: /共生と協力について/ }).first()).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 60_000 });
  expectClean(mikaCsp);
});

test("the handle suggestions for an @mention and the preview member link work under the CSP", async () => {
  await boss.goto("/t/new");
  await waitForFormReady(boss.locator("form", { has: boss.getByLabel(enMessages.report_field_title) }));
  const body = boss.locator('textarea[name="body"]');
  await body.click();
  // The suggestions are a fetch to the same origin (connect-src 'self'); the list is not an inline script or style.
  await body.pressSequentially("Ask @mi");
  const list = boss.getByRole("listbox", { name: enMessages.mention_suggestions_label });
  await expect(list.getByRole("option", { name: "@mika" })).toBeVisible();
  await body.press("Enter");
  await expect(body).toHaveValue("Ask @mika ");
  await openPostSettings(boss);
  await boss.getByLabel(enMessages.field_lang).click();
  await boss.getByRole("listbox").getByRole("option", { name: enMessages.language_name_en, exact: true }).click();
  await expect(async () => {
    await boss.getByRole("button", { name: enMessages.preview }).click();
    await expect(boss.locator("div.longread a.mention")).toHaveText(["@mika"], { timeout: 5_000 });
  }).toPass({ timeout: 30_000 });
  await expect(boss.locator("div.longread a.mention")).toHaveAttribute("href", /^\/u\/id\/[a-z0-9]{12}$/);
  expectClean(bossCsp);
  // A visitor without a session is refused with 401 (not the login page), and the answer is not cached.
  const ok = await boss.request.get("/mentions/suggest?q=mi");
  expect(ok.status()).toBe(200);
  expect(ok.headers()["cache-control"]).toBe("private, no-store");
  expect(await ok.json()).toEqual({ handles: ["mika"], names: { mika: { displayName: null, displayNameLatin: null, label: null } } });
  // This shared page should not carry the unsubmitted preview into the next scenario.
  await body.fill("");
});

test("the Markdown twin answers 401 without credentials and 200 with the session, with the security headers", async ({ request }) => {
  const anonymous = await request.get(`/t/${topicId}.md`);
  expect(anonymous.status()).toBe(401);
  expect(anonymous.headers()["x-content-type-options"]).toBe("nosniff");
  const withSession = await mika.request.get(`/t/${topicId}.md`);
  expect(withSession.status()).toBe(200);
  expect(withSession.headers()["content-type"]).toMatch(/^text\/(markdown|plain)/);
  expect(withSession.headers()["x-content-type-options"]).toBe("nosniff");
  expect(withSession.headers()["strict-transport-security"]).toBe("max-age=31536000");
  const search = await mika.request.get("/search.md?q=cooperation");
  expect(search.status()).toBe(200);
  expect(await search.text()).toContain(`id: p-${topicId}`);
});

test("a question, a reply marked as an objection, the objection panel, another way of asking and the ?asks=1 list render under the CSP", async () => {
  await boss.goto("/t/new");
  await waitForFormReady(boss.locator("form", { has: boss.getByLabel(enMessages.report_field_title) }));
  await boss.getByLabel(enMessages.report_field_title).fill("フロンティアAIの訓練は止めるべきである");
  await boss.locator('textarea[name="body"]').fill("ここでの「止める」とは、新しい訓練を始めないことを指す。");
  await openPostSettings(boss);
  await boss.getByLabel(enMessages.field_lang).click();
  await boss.getByRole("listbox").getByRole("option", { name: "日本語", exact: true }).click();
  await boss.getByRole("checkbox", { name: enMessages.asks_stance_checkbox, exact: true }).check();
  await boss.getByRole("button", { name: enMessages.submit_post, exact: true }).click();
  await expect(boss.getByRole("heading", { level: 1, name: "フロンティアAIの訓練は止めるべきである" })).toBeVisible();
  questionPath = new URL(boss.url()).pathname;
  questionId = questionPath.split("/").at(-1)!;
  await expect(boss.locator("#objections summary")).toHaveText(enMessages.objections_title);
  await expect(boss.locator("#objections").getByText(enMessages.objections_help)).toBeHidden();
  // Another member posts a reply tagged as an objection through a JavaScript form submission.
  await mika.goto(questionPath);
  const form = mika.locator("#reply form");
  await form.locator('textarea[name="body"]').fill("I object to the word '止める'.");
  await form.getByRole("radio", { name: enMessages.stance_tag_objection, exact: true }).check();
  await form.getByRole("button", { name: enMessages.submit_reply, exact: true }).click();
  await expect(mika).toHaveURL(/#c-\d+$/);
  await expect(mika.locator("#objections").getByRole("link", { name: "I object to the word '止める'." })).toBeVisible();
  // An alternative framing, "すべて見る", questions-only lists, and filtering by reply tag.
  await mika.locator("#objections").getByRole("link", { name: enMessages.objections_new_alt }).click();
  await waitForFormReady(mika.locator("form", { has: mika.getByLabel(enMessages.report_field_title) }));
  await mika.getByLabel(enMessages.report_field_title).fill("Frontier AI should not start new training runs for a year");
  await mika.locator('textarea[name="body"]').fill("A narrower proposition.");
  await mika.getByRole("button", { name: enMessages.submit_post, exact: true }).click();
  await expect(mika.getByRole("link", { name: new RegExp(`^${messagePattern(enMessages.alt_of_origin_link, { title: /.+/ }).source}`) })).toBeVisible();
  await mika.goto(`${questionPath}/objections`);
  await expect(mika.getByRole("heading", { level: 1, name: enMessages.objections_page_title })).toBeVisible();
  await mika.goto("/latest?asks=1");
  await expect(mika.getByText(enMessages.question_badge, { exact: true }).first()).toBeVisible();
  await mika.goto(`${questionPath}?tag=objection#replies`);
  await expect(mika.locator("#replies").getByText("I object to the word '止める'.")).toBeVisible();
  const md = await mika.request.get(`${questionPath}.md`);
  expect(md.status()).toBe(200);
  // One-click stances (fetcher), distribution summaries, questions-only list items, Markdown distributions and personal records work under CSP.
  await mika.goto(questionPath);
  const panel = mika.locator("#stance");
  await panel.getByRole("button", { name: enMessages.replies_filter_agree, exact: true }).click();
  await expect(mika).toHaveURL(/\/settings\/stances\?.*#consent$/);
  await mika.getByRole("checkbox", { name: enMessages.stance_consent_agree, exact: true }).check();
  await mika.getByRole("button", { name: enMessages.stance_consent_continue, exact: true }).click();
  // Agreeing returns to the stance section of the question it was opened from.
  await expect(mika).toHaveURL(url => url.pathname === questionPath && url.hash === "#stance");
  await panel.getByRole("button", { name: enMessages.replies_filter_agree, exact: true }).click();
  await expect(panel.getByRole("button", { name: enMessages.replies_filter_agree, exact: true })).toHaveAttribute("aria-pressed", "true");
  const answerLanguages = new RegExp(`^(?:${[
    messagePattern(enMessages.stance_langs, { langs: /\d+/ }).source,
  ].join("|")})$`);
  await expect(panel.getByText(answerLanguages)).toBeVisible();
  await mika.goto("/latest?asks=1");
  const item = mika.locator(`#q-${questionPath.split("/").at(-1)}`);
  // A chosen stance is one line in a list row; the buttons are behind "Change".
  await expect(item.locator("[data-stance-summary]")).toContainText(formatMessage(enMessages.stance_you, { position: enMessages.stance_agree }));
  const stances = await mika.request.get(`${questionPath}/stances.md`);
  expect(stances.status()).toBe(200);
  await mika.goto("/settings/stances");
  await expect(mika.getByRole("heading", { level: 1, name: enMessages.settings_stances_title })).toBeVisible();
  await expect(mika.locator("#privacy")).toBeVisible();
  expectClean(bossCsp, mikaCsp);
});

test("home rows show translated titles and times under the CSP without body controls or private caches", async () => {
  await mika.goto("/");
  await waitForClientRoute(mika);
  await expect.poll(() => mika.evaluate(() => navigator.serviceWorker.controller?.scriptURL ?? null)).toBe(`${state().baseURL}/sw.js`);
  const row = mika.locator(`#q-${topicId}`);
  await expect(row.locator(":scope > a")).toHaveAttribute("lang", "en");
  await expect(row.locator(".longread, button")).toHaveCount(0);
  await expect(mika.locator("main textarea")).toHaveCount(0);
  expectOnlyShell(await readCaches(mika));
  expectClean(mikaCsp);
});

test("the dedicated editor suggests a mention and publishes a titleless post under the CSP", async () => {
  await mika.goto("/t/new");
  const form = mika.locator("form", { has: mika.getByLabel(enMessages.field_body, { exact: true }) });
  await waitForFormReady(form);
  const body = form.getByLabel(enMessages.field_body, { exact: true });
  const language = form.getByRole("combobox", { name: enMessages.field_lang, exact: true });
  await openPostSettings(mika);
  await language.click();
  await expect(mika.getByRole("listbox").getByRole("option").first()).toBeVisible();
  await mika.keyboard.press("Escape");
  await expect(language).toHaveAttribute("aria-expanded", "false");
  await expect(language).toBeFocused();
  await body.click();
  await expect(body).toBeFocused();
  await body.pressSequentially("Production shell-only post @bo");
  const suggestions = form.getByRole("listbox", { name: enMessages.mention_suggestions_label });
  await expect(suggestions.getByRole("option", { name: "@boss", exact: true })).toBeVisible();
  await suggestions.getByRole("option", { name: "@boss", exact: true }).click();
  await expect(body).toHaveValue("Production shell-only post @boss ");
  await body.pressSequentially("under CSP.");
  await form.getByRole("button", { name: enMessages.submit_post, exact: true }).click();
  await expect(mika).toHaveURL(/\/t\/(\d+)\?posted=\1$/);
  composerTopicId = new URL(mika.url()).pathname.split("/").at(-1)!;
  const post = mika.locator(`#p-${composerTopicId}`);
  await expect(post.locator("a.mention")).toHaveText(["@boss"]);
  await expect(post.locator("a.mention")).toHaveAttribute("href", /^\/u\/id\/[a-z0-9]{12}$/);
  await mika.goto("/");
  await expect(mika.locator("main li[id^='q-']").first()).toHaveAttribute("id", `q-${composerTopicId}`);
  expectOnlyShell(await readCaches(mika));
  expectClean(mikaCsp);
});

test("a stance on a home question row changes in place under the CSP", async () => {
  await mika.goto("/");
  const row = mika.locator(`#q-${questionId}`);
  await expect(row.locator("[data-stance-summary]")).toContainText(formatMessage(enMessages.stance_you, { position: enMessages.stance_agree }));
  await row.locator("summary").filter({ hasText: enMessages.stance_change }).click();
  await expect(row.getByRole("button", { name: enMessages.stance_agree, exact: true })).toHaveAttribute("aria-pressed", "true");
  const url = mika.url();
  const order = await mika.locator("main li[id^='q-']").evaluateAll(rows => rows.map(row => row.id));
  await row.getByRole("button", { name: enMessages.stance_disagree, exact: true }).click();
  await expect(row.locator("[data-stance-summary]")).toContainText(formatMessage(enMessages.stance_you, { position: enMessages.stance_disagree }));
  await row.locator("summary").filter({ hasText: enMessages.stance_change }).click();
  await expect(row.getByRole("button", { name: enMessages.stance_disagree, exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(row.getByRole("button", { name: enMessages.stance_agree, exact: true })).toHaveAttribute("aria-pressed", "false");
  expect(mika.url()).toBe(url);
  expect(await mika.locator("main li[id^='q-']").evaluateAll(rows => rows.map(row => row.id))).toEqual(order);
  expectOnlyShell(await readCaches(mika));
  expectClean(mikaCsp);
});

test("following and language lists use rows, with following controls on the topic page", async () => {
  await mika.goto("/following?all=1");
  const row = mika.locator(`#q-${topicId}`);
  await expect(row).toBeVisible();
  await expect(row.getByRole("button", { name: enMessages.follow_unfollow, exact: true })).toHaveCount(0);
  await row.locator(":scope > a").click();
  // The button shows the new state while the request is still on its way; a navigation before the answer would drop it.
  const followAnswer = () => mika.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname.startsWith("/follow"));
  let answered = followAnswer();
  await mika.getByRole("button", { name: enMessages.follow_unfollow, exact: true }).click();
  await answered;
  await expect(mika.getByRole("button", { name: enMessages.follow_button, exact: true })).toBeVisible();
  await mika.goto("/following?all=1");
  await expect(row).toHaveCount(0);
  await mika.goto(`/t/${topicId}`);
  answered = followAnswer();
  await mika.getByRole("button", { name: enMessages.follow_button, exact: true }).click();
  await answered;
  await expect(mika.getByRole("button", { name: enMessages.follow_unfollow, exact: true })).toBeVisible();
  await mika.goto("/a/ja");
  await expect(mika.locator(`#q-${topicId}`).locator("time")).toBeVisible();
  await expect(mika.locator(`#q-${topicId}`).getByRole("button", { name: enMessages.insightful_give, exact: true })).toHaveCount(0);
  expectOnlyShell(await readCaches(mika));
  expectClean(mikaCsp);
});

test("a stance, a reason, Insightful, Reconsider my stance, the history, the operator metrics and the exports work under the CSP", async () => {
  const before = await (await boss.request.get("/settings/export")).json() as { stance_changes: Array<{ trigger_entry_id: number | null }> };
  // boss (the author, Japanese) chooses a stance on the question; mika (English; she already holds a stance) writes a reply marked as a reason for disagreeing
  await boss.goto(questionPath);
  await boss.locator("#stance").getByRole("button", { name: enMessages.replies_filter_agree, exact: true }).click();
  // A stance is recorded only after the separate consent; agreeing returns to the stance section of the question.
  await expect(boss).toHaveURL(/\/settings\/stances\?.*#consent$/);
  await boss.getByRole("checkbox", { name: enMessages.stance_consent_agree, exact: true }).check();
  await boss.getByRole("button", { name: enMessages.stance_consent_continue, exact: true }).click();
  await expect(boss).toHaveURL(url => url.pathname === questionPath && url.hash === "#stance");
  await boss.locator("#stance").getByRole("button", { name: enMessages.replies_filter_agree, exact: true }).click();
  await expect(boss.locator("#stance").getByRole("button", { name: enMessages.replies_filter_agree, exact: true })).toHaveAttribute("aria-pressed", "true");
  await mika.goto(questionPath);
  const form = mika.locator("#reply form");
  const reason = "I disagree: pausing training does not address deployment.";
  await form.locator('textarea[name="body"]').fill(reason);
  await form.getByRole("radio", { name: enMessages.stance_tag_disagree, exact: true }).check();
  await form.getByRole("button", { name: enMessages.submit_reply, exact: true }).click();
  await expect(mika).toHaveURL(/#c-\d+$/);
  // boss reads the reply in the reasons panel and presses Insightful (a fetcher: the page stays, the count is "Insightful 1 (1 language)")
  await boss.goto(questionPath);
  // The day's draw was already fixed before this reply existed. It stays unchanged.
  await expect(boss.locator("#reasons").getByText(reason)).toHaveCount(0);
  const panel = boss.locator(new URL(mika.url()).hash);
  await expect(panel.getByText(reason)).toBeVisible();
  const press = panel.getByRole("button", { name: enMessages.metrics_dir_insightful, exact: true });
  await press.click();
  await expect(press).toHaveAttribute("aria-pressed", "true");
  // Reconsider my stance, then the change; the history shows the post that prompted it
  // Wait for the post-Insightful loader revalidation: an optimistic button update alone would miss a link rebuilt from the single-fetch .data URL.
  await waitForClientRoute(boss);
  await expect(panel.getByRole("link", { name: enMessages.insightful_review })).toHaveAttribute("href", new RegExp(`^${questionPath}\\?review=\\d+#stance$`));
  await panel.getByRole("link", { name: enMessages.insightful_review }).click();
  await expect(boss).toHaveURL(/\?review=\d+#stance$/);
  await boss.locator("#stance").getByRole("button", { name: enMessages.replies_filter_disagree, exact: true }).click();
  await expect(boss.locator("#stance").getByRole("button", { name: enMessages.replies_filter_disagree, exact: true })).toHaveAttribute("aria-pressed", "true");
  await boss.goto("/settings/stances");
  const items = boss.locator(`#q-${questionPath.split("/").at(-1)}`).getByRole("listitem");
  await expect(items.last()).toContainText(`${enMessages.stance_agree} → ${enMessages.stance_disagree}`);
  await expect(items.last().getByRole("link", { name: enMessages.settings_stances_trigger })).toBeVisible();
  // the operator's metrics page: the new sections, the matrix and the cross-question tables render under the CSP; this week has the update that the reply prompted
  await boss.goto("/admin/metrics");
  await expect(boss.getByRole("heading", { level: 2, name: enMessages.metrics_dir_title })).toBeVisible();
  await expect(boss.getByRole("heading", { level: 2, name: enMessages.metrics_distance_title })).toBeVisible();
  const updates = boss.locator("section", { has: boss.getByRole("heading", { level: 2, name: enMessages.metrics_update_title }) });
  await expect(updates.locator("tbody tr").last()).not.toContainText(enMessages.metrics_unobserved);
  // the exports: the member's own stances and their history, and the operators' questions with the totals only
  const mine = await boss.request.get("/settings/export");
  expect(mine.status()).toBe(200);
  const own = (await mine.json()) as { version: number; stances: unknown[]; stance_changes: Array<{ trigger_entry_id: number | null }>; insightful: unknown[]; follows: Array<{ thread_id: number; state: string }> };
  expect(own.stance_changes.slice(0, before.stance_changes.length)).toEqual(before.stance_changes);
  expect(own.stance_changes.slice(before.stance_changes.length).map((c) => c.trigger_entry_id !== null)).toEqual([false, true]);
  expect(own.follows).toEqual(expect.arrayContaining([expect.objectContaining({ thread_id: Number(questionPath.split("/").at(-1)), state: "following" })]));
  const observed = (await (await boss.request.get("/admin/export")).json()) as { version: number; questions: Array<{ distribution: Record<string, unknown> }> };
  expect(Object.keys(observed.questions[0].distribution).sort()).toEqual(["as_of", "counts", "langs", "total"]);
  expectClean(bossCsp, mikaCsp);
});

test("the operator's pages open, the other member gets 404, and the exports download", async () => {
  for (const [route, heading] of [
    ["/admin/usage", /LLM usage and budget/],
    ["/admin/metrics", /Observation metrics/],
    ["/admin/observation", /^Observation: divergences, diversity/],
    ["/admin/glossary", /./],
    ["/admin/invitations", /./],
    ["/admin/roles", /./],
    ["/mod", /./],
    ["/moderation", /./],
    ["/settings", /./],
  ] as const) {
    const res = await boss.goto(route);
    expect(res!.status(), route).toBe(200);
    await expect(boss.getByRole("heading", { level: 1 }).first(), route).toHaveText(heading);
  }
  expect((await mika.goto("/admin/usage"))?.status()).toBe(404);
  const exported = await boss.request.get("/admin/export");
  expect(exported.status()).toBe(200);
  expect(exported.headers()["cache-control"]).toBe("no-store");
  const memberExport = await mika.request.get("/settings/export");
  expect(memberExport.status()).toBe(200);
  expect(memberExport.headers()["cache-control"]).toBe("private, no-store");
  expect(memberExport.headers()["content-disposition"]).toMatch(/^attachment; filename="tomola-my-data-\d{4}-\d{2}-\d{2}\.json"$/);
  await mika.goto("/settings");
  await mika.locator("#settings-advanced > summary").click();
  const [download] = await Promise.all([mika.waitForEvent("download"), mika.getByRole("link", { name: messagesOf("en").settings_export_link, exact: true }).click()]);
  expect(download.suggestedFilename()).toMatch(/^tomola-my-data-\d{4}-\d{2}-\d{2}\.json$/);
  const exportedMember = JSON.parse(fs.readFileSync((await download.path())!, "utf8"));
  expect(exportedMember.profile.handle).toBe("mika");
  expect(exportedMember.entries.some((entry: { body: string }) => entry.body === "Cooperation matters.")).toBe(true);
  expectOnlyShell(await readCaches(mika));
  expectClean(bossCsp, mikaCsp);
});

test("the glossary opens for every member under the CSP, and the YAML download is an attachment that is not stored", async () => {
  for (const [page, name] of [[boss, "boss"], [mika, "mika"]] as const) {
    await page.goto("/");
    await page.getByRole("link", { name: enMessages.nav_glossary, exact: true }).click();
    await expect(page, name).toHaveURL(/\/glossary$/);
    await expect(page.getByRole("heading", { level: 1, name: enMessages.nav_glossary }), name).toBeVisible();
    await waitForClientRoute(page);
    // The filter keeps the enabled languages and submits through the ordinary form.
    const target = page.getByRole("combobox", { name: enMessages.glossary_target, exact: true });
    await expect(target, name).toBeVisible();
    await target.click();
    await target.press("Escape");
    await expect(page.getByRole("link", { name: enMessages.glossary_download }), name).toBeVisible();
  }
  expect((await boss.goto("/glossary?to=en&from=ja"))?.status()).toBe(200);
  const yaml = await mika.request.get("/glossary.yaml");
  expect(yaml.status()).toBe(200);
  expect(yaml.headers()["content-disposition"]).toMatch(/^attachment; filename="tomola-glossary-\d{4}-\d{2}-\d{2}\.yaml"$/);
  expect(yaml.headers()["cache-control"]).toBe("private, no-store");
  expect(yaml.headers()["content-type"]).toBe("text/yaml; charset=utf-8");
  expect(await yaml.text()).toContain('format: "tomola-glossary"');
  const md = await mika.request.get("/glossary.md");
  expect(md.status()).toBe(200);
  expect(await md.text()).toContain("type: glossary");
  // With the service worker in control of the page, the download link is left to the network: it is a real attachment of the server (name, text), and nothing of the glossary
  // (the page, the twins, the file) ends up in the Cache Storage.
  await boss.goto("/glossary");
  await waitForClientRoute(boss);
  await expect.poll(() => boss.evaluate(() => navigator.serviceWorker.controller?.scriptURL ?? null)).toBe(`${state().baseURL}/sw.js`);
  const [download] = await Promise.all([boss.waitForEvent("download"), boss.getByRole("link", { name: enMessages.glossary_download }).click()]);
  expect(download.suggestedFilename()).toMatch(/^tomola-glossary-\d{4}-\d{2}-\d{2}\.yaml$/);
  expect(fs.readFileSync((await download.path())!, "utf8")).toContain('format: "tomola-glossary"');
  const dump = await readCaches(boss);
  expectOnlyShell(dump);
  // (a built chunk such as /assets/glossary-<hash>.js is code of the app, and is the shell)
  expect(dump.entries.map((e) => e.url).filter((u) => /glossary/.test(u) && !u.startsWith("/assets/"))).toEqual([]);
  expectClean(bossCsp, mikaCsp);
});

test("an optional passkey logs in under CSP and the last key cannot be removed", async () => {
  const { client: cdp, authenticatorId } = await enableSigningAuthenticator(boss);
  await boss.goto("/settings");
  await boss.getByRole("button", { name: enMessages.settings_passkeys_add, exact: true }).click();
  await expect(boss.getByRole("status").filter({ hasText: enMessages.settings_passkeys_added })).toBeVisible();
  expect((await cdp.send("WebAuthn.getCredentials", { authenticatorId })).credentials).toHaveLength(1);
  await openUserMenu(boss);
  await boss.getByRole("menuitem", { name: enMessages.nav_logout }).click();
  await expect(boss).toHaveURL(/\/login$/);
  const mailsBefore = mailCount();
  await boss.getByRole("button", { name: enMessages.login_passkey }).click();
  await expect(boss.locator('[data-member-menu-trigger][title="@boss"]')).toBeVisible();
  expect(mailCount()).toBe(mailsBefore);
  await boss.goto("/settings");
  await expect(boss.getByRole("button", { name: enMessages.settings_passkeys_remove, exact: true })).toBeDisabled();
  expectClean(bossCsp);
});

// The interface language (the site runs with ENABLED_LANGS=ja,en; e2e-prod/global-setup.ts): the switcher offers the enabled languages only (日本語 and English); choosing one stores a
// cookie and reloads. The texts are those of messages/<language>.json. A browser in a language that is not enabled (de, zh-TW) gets English, with no hydration warning (the server decides
// and the browser reads <html lang>).
const messagesOf = (locale: string): Record<string, string> => {
  const read = (lang: string) => JSON.parse(fs.readFileSync(path.join(process.cwd(), "messages", `${lang}.json`), "utf8")) as Record<string, string>;
  return locale === "en" || locale === "ja" ? read(locale) : { ...read("en"), ...read(locale) };
};
test("the interface language switcher offers only the enabled languages, and the page keeps working under the CSP", async () => {
  await boss.goto("/");
  await waitForClientRoute(boss);
  // The name of the switcher is a message of the interface language, so it differs per language. Only the enabled languages are listed, by their own names.
  let current = "en";
  await openUserMenu(boss);
  const switcher = () => boss.getByRole("menuitem", { name: messagesOf(current).nav_language, exact: true });
  await switcher().click();
  await expect(boss.getByRole("menuitemradio")).toHaveText(["日本語", "English"]);
  await boss.keyboard.press("Escape");
  await boss.keyboard.press("Escape");
  for (const locale of ["ja", "en"]) {
    const messages = messagesOf(locale);
    await expect(async () => {
      await openUserMenu(boss);
      await switcher().click();
      await boss.getByRole("menuitemradio", { name: locale === "ja" ? "日本語" : "English", exact: true }).click();
      await expect(boss.locator("html")).toHaveAttribute("lang", locale, { timeout: 5_000 });
    }).toPass({ timeout: 30_000 });
    current = locale;
    await expect(boss.locator("header").getByRole("link", { name: messages.site_name, exact: true })).toBeVisible();
    await expect(boss.locator('header a[href="/latest"]')).toHaveCount(0);
    await expect(boss.getByRole("link", { name: messages.nav_new_topic, exact: true })).toBeVisible();
    expectClean(bossCsp);
  }
  // The footnotes of a Japanese topic stay in the language of the text (Japanese) whatever the interface language.
  await boss.goto(`/t/${topicId}?lang=ja`);
  await expect(boss.locator("[data-footnotes] h2").first()).toHaveText("脚注");
});

test("the cookie, query and browser language decide the interface language among the enabled languages, with no hydration warning", async ({ browser }) => {
  // Representative browser fallback, saved preference and temporary query;
  // the full decision table is covered by tests/locale.test.ts.
  const cases: Array<{ name: string; locale: string; cookie?: string; query?: string; expected: string }> = [
    { name: "a disabled browser language falls back to English", locale: "de-DE", expected: "en" },
    { name: "an enabled cookie wins over the query", locale: "en-US", cookie: "ja", query: "en", expected: "ja" },
    { name: "a disabled cookie allows an enabled query", locale: "ja-JP", cookie: "de", query: "en", expected: "en" },
  ];
  for (const c of cases) {
    const context = await browser.newContext({ locale: c.locale });
    try {
      if (c.cookie) await context.addCookies([{ name: "PARAGLIDE_LOCALE", value: c.cookie, url: state().baseURL }]);
      const p = await context.newPage();
      const watch = await watchCsp(p);
      const messages: string[] = [];
      p.on("console", (msg) => {
        if (msg.type() === "error" || msg.type() === "warning") messages.push(msg.text());
      });
      const res = await p.goto(c.query ? `/login?lang=${c.query}` : "/login");
      await expect(p.locator("html"), c.name).toHaveAttribute("lang", c.expected);
      await expect(p.getByRole("heading", { name: messagesOf(c.expected).login_title })).toBeVisible();
      // The server sets no cookie for the interface language (the confirm page stays free of cookies).
      expect((await res!.allHeaders())["set-cookie"] ?? "", c.name).toBe("");
      await waitForClientRoute(p);
      expect(messages.filter((m) => /hydrat/i.test(m)), `hydration warnings: ${c.name}`).toEqual([]);
      const cookie = (await context.cookies()).find((item) => item.name === "PARAGLIDE_LOCALE");
      if (c.cookie) expect(cookie?.value, `${c.name}: the existing preference is not overwritten`).toBe(c.cookie);
      else expect(cookie, `${c.name}: inferred language is not persisted`).toBeUndefined();
      expectClean(watch);
      await p.reload();
      await expect(p.locator("html"), `${c.name} after a reload`).toHaveAttribute("lang", c.expected);
      await waitForClientRoute(p);
      expect((await context.cookies()).find((item) => item.name === "PARAGLIDE_LOCALE")?.value, `${c.name}: preference after reload`).toBe(c.cookie);
      expectClean(watch);
    } finally {
      await context.close();
    }
  }
});

test("a shared topic language preserves the member's saved interface without setting a language cookie", async ({ browser }) => {
  const saved = await mikaContext.storageState();
  const context = await browser.newContext({ locale: "ja-JP", storageState: { ...saved, cookies: saved.cookies.filter(c => c.name !== "PARAGLIDE_LOCALE") } });
  try {
    const page = await context.newPage();
    const watch = await watchCsp(page);
    const response = await page.goto(`/t/${topicId}?lang=ja`);
    expect(response!.status()).toBe(200);
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(page.getByRole("heading", { level: 1, name: "共生と協力について", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: enMessages.nav_new_topic, exact: true })).toBeVisible();
    await expect(page.getByRole("contentinfo").getByRole("link", { name: enMessages.footer_why, exact: true })).toBeVisible();
    expect((await response!.allHeaders())["set-cookie"] ?? "").not.toContain("PARAGLIDE_LOCALE=");
    await waitForClientRoute(page);
    expect((await context.cookies()).find(c => c.name === "PARAGLIDE_LOCALE")).toBeUndefined();
    expectClean(watch);
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await waitForClientRoute(page);
    // A new document without the query retains the saved interface before the browser preference.
    await page.goto(`/t/${topicId}`);
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(page.getByRole("link", { name: enMessages.nav_new_topic, exact: true })).toBeVisible();
    await waitForClientRoute(page);
    expect((await context.cookies()).find(c => c.name === "PARAGLIDE_LOCALE")).toBeUndefined();
    expectClean(watch);
  } finally {
    await context.close();
  }
});

test("an explicit interface choice saves a secure SameSite cookie, reloads, and survives a restored browser state", async ({ browser }) => {
  const context = await browser.newContext({ locale: "de-DE" });
  let resumed: BrowserContext | undefined;
  try {
    const page = await context.newPage();
    const watch = await watchCsp(page);
    await page.goto("/login");
    await waitForClientRoute(page);
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    expect((await context.cookies()).find((cookie) => cookie.name === "PARAGLIDE_LOCALE")).toBeUndefined();
    const loaded = page.waitForEvent("load");
    await page.getByRole("combobox", { name: messagesOf("en").language_select, exact: true }).click();
    await page.getByRole("option", { name: "日本語", exact: true }).click();
    await loaded;
    await expect(page.locator("html")).toHaveAttribute("lang", "ja");
    await expect(page.getByRole("heading", { name: messagesOf("ja").login_title })).toBeVisible();
    const preference = (await context.cookies()).find((cookie) => cookie.name === "PARAGLIDE_LOCALE");
    expect(preference).toMatchObject({ value: "ja", path: "/", sameSite: "Lax", secure: true, httpOnly: false });
    expect(preference!.expires).toBeGreaterThan(Date.now() / 1000);
    await waitForClientRoute(page);
    expectClean(watch);
    resumed = await browser.newContext({ locale: "de-DE", storageState: await context.storageState() });
    const restored = await resumed.newPage();
    const restoredWatch = await watchCsp(restored);
    await restored.goto("/login");
    await expect(restored.locator("html")).toHaveAttribute("lang", "ja");
    await expect(restored.getByRole("heading", { name: messagesOf("ja").login_title })).toBeVisible();
    await waitForClientRoute(restored);
    expect((await resumed.cookies()).find((cookie) => cookie.name === "PARAGLIDE_LOCALE")?.value).toBe("ja");
    expectClean(restoredWatch);
  } finally {
    await resumed?.close();
    await context.close();
  }
});

// A browser's page translation (or an extension) rewrites <html lang> after hydration. The interface language is read from the attribute once, before hydration, so the page keeps its language:
// no message call throws (it would take the root ErrorBoundary down too), and the next client-side render still speaks the original language.
test("rewriting <html lang> after hydration (a page translation) neither throws nor changes the language of the next client-side render", async ({ browser }) => {
  const context = await browser.newContext({ locale: "en-US" });
  try {
    const p = await context.newPage();
    const watch = await watchCsp(p);
    // "es": a language the site does not have (Paraglide throws on it); "th": a language the site has (it must not switch the strings to that language)
    for (const rewritten of ["es", "th"]) {
      await p.goto("/login");
      if (await p.getByRole("button", { name: messagesOf("en").login_restart, exact: true }).count()) await p.getByRole("button", { name: messagesOf("en").login_restart, exact: true }).click();
      await waitForClientRoute(p);
      await expect(p.getByRole("heading", { name: messagesOf("en").login_title })).toBeVisible();
      await p.evaluate((lang) => {
        document.documentElement.lang = lang;
      }, rewritten);
      // A client-side navigation: React Router submits the login form without a page load and renders again (every message is called again)
      await p.getByLabel(messagesOf("en").login_email, { exact: true }).fill("nobody@example.com");
      await p.getByRole("button", { name: messagesOf("en").login_submit }).click();
      // The address is not registered, so the screen stays on the form and says so; the point here is that the client-side render after the rewrite works.
      await expect(p.getByRole("alert").filter({ hasText: messagesOf("en").login_not_registered }), rewritten).toBeVisible();
      expect(watch.pageErrors, `uncaught errors in the page after ${rewritten}`).toEqual([]);
      expectClean(watch);
    }
  } finally {
    await context.close();
  }
});

// --- Add to home screen (PWA): manifest, service worker, offline guidance and cache contents ---------------------------------------------------------------------
// Read every Cache Storage cache inside the page: stored URLs (path and query) and document content types.
type CacheDump = { names: string[]; entries: { url: string; type: string; text: string }[] };
async function readCaches(page: Page): Promise<CacheDump> {
  return page.evaluate(async () => {
    const names = await caches.keys();
    const entries: { url: string; type: string; text: string }[] = [];
    for (const name of names) {
      const cache = await caches.open(name);
      for (const req of await cache.keys()) {
        const res = (await cache.match(req))!;
        const url = new URL(req.url);
        const type = res.headers.get("content-type") ?? "";
        // Read bodies only for text-compatible types (HTML, JavaScript, CSS), checking for member-data strings.
        entries.push({ url: url.pathname + url.search, type, text: /^(text\/|application\/(javascript|json))/.test(type) ? await res.text() : "" });
      }
    }
    return { names, entries };
  });
}
// The same shape as `ASSET` in public/sw.js (written out again on purpose: a test that reads the pattern from the code under test cannot catch it being loosened).
const SHELL_ASSET = /^\/assets\/[^/]+-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/;
// Only hashed /assets/ files and /offline may be cached. No member data: HTML documents, .data, Markdown twins or API responses.
function expectOnlyShell(dump: CacheDump) {
  // The build gives each worker its own cache identity.
  expect(dump.names).toEqual([expect.stringMatching(/^tomola-shell-[a-f0-9-]{36}$/)]);
  const urls = dump.entries.map((e) => e.url);
  // The shape the service worker caches: a hashed file directly under /assets/, with no query string (a query string would be one more cache key each).
  expect(urls.filter((u) => u !== "/offline" && !SHELL_ASSET.test(u)), "cached URLs other than /offline and hashed /assets/ files").toEqual([]);
  expect(urls.filter((u) => /\.(data|md|txt|json)(\?|$)/.test(u))).toEqual([]);
  for (const e of dump.entries) {
    if (e.url !== "/offline") expect(e.type, `content-type of ${e.url}`).not.toMatch(/text\/html/);
    expect(e.text, e.url).not.toContain("boss@example.com");
    expect(e.text, e.url).not.toContain("共生と協力について");
  }
}
const MEMBER_PAGES = () => ["/", "/latest", "/following", `/t/${topicId}`, `/t/${topicId}?lang=ja`, "/notifications", "/settings", "/drafts", "/search?q=cooperation", "/admin/usage", "/glossary"];

test("the manifest is linked and valid, its icons are served, and /sw.js and /offline come with the right headers under the CSP", async ({ request }) => {
  await boss.goto("/");
  await expect(boss.locator('link[rel="manifest"]')).toHaveAttribute("href", "/manifest.webmanifest");
  const themes = boss.locator('meta[name="theme-color"]');
  await expect(themes).toHaveCount(2);
  await expect(themes.nth(0)).toHaveAttribute("media", "(prefers-color-scheme: light)");
  await expect(themes.nth(1)).toHaveAttribute("media", "(prefers-color-scheme: dark)");
  for (const theme of await themes.all()) {
    await boss.emulateMedia({ colorScheme: (await theme.getAttribute("media"))!.includes("dark") ? "dark" : "light" });
    const colour = await theme.getAttribute("content");
    expect(await boss.evaluate(value => {
      const probe = document.createElement("span"); probe.style.color = value!; document.body.append(probe);
      const matches = getComputedStyle(probe).color === getComputedStyle(document.body).backgroundColor;
      probe.remove(); return matches;
    }, colour)).toBe(true);
  }
  await boss.emulateMedia({ colorScheme: "light" });
  await expect(boss.locator('link[rel="apple-touch-icon"]')).toHaveAttribute("href", /^\/[a-f0-9]{8}\.png$/);
  const manifestRes = await request.get("/manifest.webmanifest");
  expect(manifestRes.status()).toBe(200);
  expect(manifestRes.headers()["content-type"]).toMatch(/^application\/manifest\+json/);
  expect(manifestRes.headers()["cache-control"]).toBe("no-cache");
  expect(manifestRes.headers()["x-content-type-options"]).toBe("nosniff");
  const manifest = (await manifestRes.json()) as { name: string; short_name: string; start_url: string; scope: string; display: string; icons: { src: string; sizes: string; type: string; purpose?: string }[] };
  expect(manifest).toMatchObject({ name: "tomola", short_name: "tomola", start_url: "/", scope: "/", display: "standalone" });
  expect(manifest.icons.map((i) => `${i.sizes}${i.purpose ? ` ${i.purpose}` : ""}`).sort()).toEqual(["192x192", "512x512", "512x512 maskable"]);
  for (const icon of manifest.icons) {
    const res = await request.get(icon.src);
    expect(res.status(), icon.src).toBe(200);
    expect(res.headers()["content-type"]).toBe("image/png");
    const png = await res.body();
    expect(`${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`, icon.src).toBe(icon.sizes);
  }
  // Distinct from the old /manifest.json endpoint, which lists Markdown hashes.
  expect((await request.get("/manifest.json")).headers()["content-type"]).not.toMatch(/manifest\+json/);
  // Service worker: JavaScript revalidated before use, without the one-hour static-cache delay.
  const sw = await request.get("/sw.js");
  expect(sw.status()).toBe(200);
  expect(sw.headers()["content-type"]).toMatch(/^(text|application)\/javascript/);
  expect(sw.headers()["cache-control"]).toBe("no-cache");
  expect(sw.headers()["x-content-type-options"]).toBe("nosniff");
  expect(sw.headers()["strict-transport-security"]).toBe("max-age=31536000");
  expect(sw.headers()["content-security-policy"]).toBe("default-src 'self'");
  expect(await sw.text()).toContain("tomola-shell-");
  // Offline guidance is public and identical for everyone, including requests with member cookies. Japanese and English text, with CSP.
  const offline = await request.get("/offline");
  expect(offline.status()).toBe(200);
  expect(offline.headers()["content-type"]).toBe("text/html; charset=utf-8");
  expect(offline.headers()["cache-control"]).toBe("no-cache");
  // Its own policy without a nonce (the cached copy lives long), not the per-request policy of the other pages; the middleware leaves it as it is.
  expect(offline.headers()["content-security-policy"]).toBe("default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
  expect(offline.headers()["referrer-policy"]).toBe("no-referrer");
  expect(offline.headers()["x-content-type-options"]).toBe("nosniff");
  expect(offline.headers()["strict-transport-security"]).toBe("max-age=31536000");
  const offlineHtml = await offline.text();
  expect(offlineHtml).toContain("オフラインです");
  expect(offlineHtml).toContain("You are offline");
  expect(offlineHtml).not.toMatch(/<script/i);
  expect(offlineHtml).not.toContain("boss");
  const asBoss = await bossContext.request.get("/offline");
  expect(asBoss.headers()["set-cookie"]).toBeUndefined();
  expect(await asBoss.text()).toBe(offlineHtml);
  expectClean(bossCsp);
});

test("the principles page is public and comes with the page headers, a nonce that runs its scripts, no CSP violation, a footer without a source link (SOURCE_URL is not set), and a public twin", async ({ browser, request }) => {
  // A visitor with no login and no cookie.
  const visitor = await browser.newContext();
  const page = await visitor.newPage();
  const watch = await watchCsp(page);
  const res = await page.goto("/principles");
  expect(res!.status()).toBe(200);
  const h = res!.headers();
  const nonce = /script-src 'self' 'nonce-([A-Za-z0-9+/]{22}==)'/.exec(h["content-security-policy"])?.[1];
  expect(nonce, "a nonce in the CSP").toBeDefined();
  expect(h["strict-transport-security"]).toBe("max-age=31536000");
  expect(h["x-content-type-options"]).toBe("nosniff");
  // The document holds the nonce, so a shared cache must not keep it; it also varies with the screen language.
  expect(h["cache-control"]).toBe("private, no-cache");
  expect(h["vary"]).toMatch(/Accept-Language/i);
  expect(h["set-cookie"]).toBeUndefined();
  // Public, but not indexable.
  expect(h["x-robots-tag"]).toBe("noindex");
  await waitForClientRoute(page);
  expect(await page.evaluate(() => "__reactRouterContext" in window)).toBe(true);
  expect(new Set(await page.evaluate(() => [...document.scripts].filter((s) => !s.src).map((s) => s.nonce)))).toEqual(new Set([nonce]));
  await expect(page.locator("article").getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.locator("#rules")).toHaveCount(1);
  await expect(page.locator("#objections")).toHaveCount(1);
  // The footer is there, and since SOURCE_URL is empty it has no source link.
  const footer = page.getByRole("contentinfo");
  await expect(footer.getByRole("link", { name: enMessages.footer_source })).toHaveCount(0);
  await expect(footer.getByRole("link", { name: enMessages.footer_why })).toHaveAttribute("href", "/why");
  await expect(footer.getByRole("link", { name: enMessages.footer_principles })).toHaveAttribute("href", "/principles");
  // A client-side navigation to the Japanese original works under the CSP.
  await page.getByRole("link", { name: enMessages.principles_original_link }).first().click();
  await expect(page).toHaveURL(/lang=ja$/);
  await expect(page.getByRole("heading", { level: 1, name: "tomola の原則" })).toBeVisible();
  expectClean(watch);
  await visitor.close();
  // The Markdown twin: public, cacheable like the guides, with the transport headers.
  const twin = await request.get("/principles.md");
  expect(twin.status()).toBe(200);
  expect(twin.headers()["content-type"]).toBe("text/plain; charset=utf-8");
  expect(twin.headers()["cache-control"]).toBe("public, max-age=300");
  expect(twin.headers()["x-robots-tag"]).toBe("noindex");
  expect(twin.headers()["x-content-type-options"]).toBe("nosniff");
  expect(twin.headers()["strict-transport-security"]).toBe("max-age=31536000");
  expect(await twin.text()).toMatch(/^---\n[\s\S]*type: page\nid: principles\nlang: ja\nstatus: original\n/);
});

test("every file the build puts under /assets/ has a hashed name that the service worker caches", async () => {
  // If Vite's naming ever changed, the service worker would silently stop caching the shell (it caches only files of this shape).
  const dir = path.join(process.cwd(), "build/client/assets");
  const files = fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile());
  expect(files.length).toBeGreaterThan(20);
  const unmatched = files.map((e) => `/assets/${path.relative(dir, path.join(e.parentPath, e.name)).split(path.sep).join("/")}`).filter((url) => !SHELL_ASSET.test(url));
  expect(unmatched, "built files the service worker would not cache").toEqual([]);
});

test("the service worker registers, and after the member pages the Cache Storage holds only /assets/ files and the offline page", async () => {
  await boss.goto("/");
  const registration = await boss.evaluate(async () => {
    const r = await navigator.serviceWorker.ready;
    return { scope: r.scope, script: r.active?.scriptURL, state: r.active?.state };
  });
  expect(registration.scope).toBe(`${state().baseURL}/`);
  expect(registration.script).toBe(`${state().baseURL}/sw.js`);
  expect(registration.state).toBe("activated");
  // Take control of already-open pages too (clients.claim during activate).
  await expect.poll(() => boss.evaluate(() => navigator.serviceWorker.controller?.scriptURL ?? null)).toBe(`${state().baseURL}/sw.js`);
  // Visit member screens: both navigation and subresources pass through the service worker. Fetch .data and Markdown twins from a controlled page too.
  for (const url of MEMBER_PAGES()) {
    const res = await boss.goto(url);
    expect(res!.status(), url).toBe(200);
    await waitForClientRoute(boss);
  }
  const fetched = await boss.evaluate(async ({ id, question }) => {
    const statuses: Record<string, number> = {};
    for (const url of [`/t/${id}.data`, `/t/${id}.md`, `/t/${id}/original`, `/t/${question}/stances.md`, "/home.md", "/latest.md", "/following.md", "/following.data", "/mentions/suggest?q=mi", "/glossary.yaml", "/settings/export", "/_root.data", "/api/drafts"]) statuses[url] = (await fetch(url)).status;
    return statuses;
  }, { id: topicId, question: questionId });
  expect(fetched[`/t/${topicId}.md`]).toBe(200);
  expect(fetched["/home.md"]).toBe(200);
  expect(fetched[`/t/${topicId}/original`]).toBe(404);
  for (const url of [`/t/${questionId}/stances.md`, "/following.md", "/following.data", "/mentions/suggest?q=mi", "/glossary.yaml", "/settings/export"]) expect(fetched[url], url).toBe(200);
  // Shell files are cached; wait until storage finishes.
  await expect.poll(async () => (await readCaches(boss)).entries.filter((e) => e.url.startsWith("/assets/")).length).toBeGreaterThan(0);
  const dump = await readCaches(boss);
  expect(dump.entries.map((e) => e.url)).toContain("/offline");
  expect(dump.entries.some((e) => e.url.endsWith(".js"))).toBe(true);
  expectOnlyShell(dump);
  // The cached /offline contains no member data.
  const offlineEntry = dump.entries.find((e) => e.url === "/offline")!;
  expect(offlineEntry.text).toContain("You are offline");
  expect(offlineEntry.text).not.toContain("boss");
  expectClean(bossCsp);
});

test("when the network is lost, a navigation shows the offline page in the languages of the site, and coming back online opens pages normally", async () => {
  await boss.goto(`/t/${topicId}`);
  await waitForClientRoute(boss);
  await bossContext.setOffline(true);
  try {
    for (const url of [`/t/${topicId}`, "/", "/notifications", "/following"]) {
      const res = await boss.goto(url);
      expect(res!.status(), url).toBe(200);
      await expect(boss.locator("html")).toHaveAttribute("lang", "mul");
      await expect(boss.locator('section[lang="ja"] h1')).toHaveText("オフラインです");
      await expect(boss.locator('section[lang="en"] h1')).toHaveText(enMessages.offline_title);
      // No member data is shown; the cached document is identical for everyone.
      const text = await boss.locator("body").innerText();
      expect(text).not.toContain("共生と協力について");
      expect(text).not.toContain("boss");
    }
  } finally {
    await bossContext.setOffline(false);
  }
  // Back online: the "ホームへ" link opens the normal page.
  await boss.getByRole("link", { name: enMessages.offline_home }).click();
  await expect(boss.locator("header").getByRole("link", { name: enMessages.site_name, exact: true })).toBeVisible();
  await expect(boss.locator('[data-member-menu-trigger][title="@boss"]')).toBeVisible();
  await boss.goto(`/t/${topicId}`);
  await expect(boss.getByRole("heading", { level: 1, name: "共生と協力について" })).toBeVisible();
  expectClean(bossCsp);
});

test("after logging out, the caches still hold nothing of the member, and the next navigation is the login page", async () => {
  await boss.goto("/");
  await openUserMenu(boss);
  await boss.getByRole("menuitem", { name: enMessages.nav_logout }).click();
  await expect(boss).toHaveURL(/\/login$/);
  await waitForClientRoute(boss);
  const dump = await readCaches(boss);
  expectOnlyShell(dump);
  expect(dump.entries.map((e) => e.url)).toContain("/offline");
  // Page documents are not cached, so logging out cannot reveal the previous member's screen.
  const res = await boss.goto(`/t/${topicId}`);
  expect(res!.status()).not.toBe(500);
  await expect(boss.getByText("共生と協力について")).toHaveCount(0);
  await expect(boss).toHaveURL(`/login?next=${encodeURIComponent(`/t/${topicId}`)}`);
  await boss.goto("/following");
  await expect(boss).toHaveURL(`/login?next=${encodeURIComponent("/following")}`);
  await expect(boss.locator('[data-member-menu-trigger][title="@boss"]')).toHaveCount(0);
  expectClean(bossCsp);
});

test("the access log of the server hides query strings and invitation tokens", async () => {
  const log = fs.readFileSync(state().serverLog, "utf8");
  expect(log).toContain("[http] GET /login 200");
  expect(log).toMatch(/\[http\] GET \/search(\.data)?\?\[redacted\] 200/);
  expect(log).toContain("/invite/[redacted]");
  expect(log).toMatch(/\[http\] GET \/auth\/confirm\?\[redacted\]/);
  expect(log).not.toMatch(/[?&](q|k|token|cursor)=/);
  expect(log).not.toContain("cooperation");
  // Neither invitation nor login tokens appear anywhere in the logs.
  for (const url of Object.values(state().invites)) expect(log).not.toContain(new URL(url).pathname.split("/").at(-1)!);
  // No server errors or worker failures. The deliberately nonexistent URL in the first test produces only a 404 access-log entry, not a handleError error.
  const problems = log.split("\n").filter((l) => /Error:|\[error\]|\[worker\] run failed|\[jobs\] job \d+ .* failed/.test(l));
  expect(problems).toEqual([]);
  expect(log).toContain("[http] GET /no-such-page 404");
  expect(log).not.toContain("No route matches");
  // Mail reaches fake SMTP, not development stdout.
  expect(log).not.toContain("[mail]");
});
