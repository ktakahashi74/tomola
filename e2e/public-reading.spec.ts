import { readingActions } from "./helpers";
import { expect } from "@playwright/test";
import { test } from "./editor-fixture";
import fs from "node:fs";
import path from "node:path";
import { captureScreenshot, clientHeaders, enMessages, jaMessages, signUp, state, messageTitleField as titleField, waitForFormReady  } from "./helpers";


test("private reading keeps the home and Markdown behind authentication", async ({ page }) => {
  await page.setExtraHTTPHeaders(clientHeaders("192.0.2.90"));
  await page.goto("/");
  await expect(page).toHaveURL(/\/login$/);
  expect((await page.request.get("/home.md")).status()).toBe(401);
});

test("a public reader opens posts and originals and logs in with a return path", async ({ browser }) => {
  test.setTimeout(180_000);
  const memberContext = await browser.newContext({ extraHTTPHeaders: clientHeaders("192.0.2.91") });
  const guestContext = await browser.newContext({ extraHTTPHeaders: clientHeaders("192.0.2.92") });
  try {
    const member = await memberContext.newPage();
    member.setDefaultTimeout(20_000);
    await signUp(member, JSON.parse(fs.readFileSync(path.join(state().dir, "public-reading-invite.json"), "utf8")), "public_reading_writer@example.com", { handle: "publicwriter", mainLang: "ja" }, async page => {
      await expect(page.getByText(enMessages.public_reading_onboarding, { exact: true })).toBeVisible();
    });
    await memberContext.addCookies([{ name: "PARAGLIDE_LOCALE", value: "en", url: state().baseURL }]);
    await member.goto("/t/new");
    await waitForFormReady(member.locator("form", { has: titleField(member) }));
    await titleField(member).fill("Public reading question");
    await member.getByLabel(enMessages.field_body, { exact: true }).fill("公開閲覧の原文。");
    await member.getByRole("checkbox", { name: enMessages.asks_stance_checkbox, exact: true }).check();
    await member.getByRole("button", { name: enMessages.submit_post, exact: true }).click();
    await expect(member).toHaveURL(/\/t\/\d+/);
    const threadPath = new URL(member.url()).pathname;
    await expect(member.locator("header").locator('a[href="/why"], a[href="/principles"]')).toHaveCount(0);
    const guest = await guestContext.newPage();
    guest.setDefaultTimeout(20_000);
    const response = await guest.goto("/?lang=en");
    expect(response?.headers()["x-robots-tag"]).toBe("noindex");
    await expect(guest.locator('meta[name="robots"]')).toHaveAttribute("content", "noindex");
    // The head names a feed and, for a pasted link, a preview (the content of the tags is checked in the unit tests).
    await expect(guest.locator('link[rel="alternate"][type="application/rss+xml"]')).toHaveCount(1);
    await expect(guest.locator('meta[property="og:title"]')).toHaveCount(1);
    await expect(guest.locator("[data-member-menu], [data-admin-menu], [data-member-links], textarea")).toHaveCount(0);
    const card = guest.locator(`li#q-${threadPath.split("/").at(-1)}`);
    // Translation jobs finish asynchronously; revisit the stream until the fake translation is ready.
    await expect(async () => {
      await guest.goto("/?lang=en");
      await expect(card).toContainText("[en] Public reading question", { timeout: 2_000 });
    }).toPass({ timeout: 30_000 });
    // This control mounts only on the client, so its presence confirms hydration before inline interactions.
    await expect(guest.getByRole("button", { name: enMessages.open_in_ai, exact: true }).first()).toBeVisible();
    await expect(guest.getByText(enMessages.passkey_prompt, { exact: true })).toHaveCount(0);
    await expect(guest.getByRole("button", { name: enMessages.passkey_prompt_register, exact: true })).toHaveCount(0);
    await expect(card.getByRole("button", { name: enMessages.insightful_give, exact: true })).toHaveCount(0);
    await card.locator(":scope > a").click();
    await expect(guest).toHaveURL(new RegExp(`${threadPath}\\?lang=en$`));
    await expect(guest.locator('meta[property="og:title"]')).toHaveCount(1);
    await expect(guest.locator("#reply")).toContainText(enMessages.public_reading_reply);
    await expect(guest.getByRole("link", { name: enMessages.reply_to_button, exact: true })).toHaveCount(0);
    await expect(guest.locator("[data-reading-body]")).toBeVisible();
    await expect(guest.locator("#reasons").getByText(enMessages.reasons_empty_help)).toBeVisible();
    await expect(guest.locator("#reasons").getByRole("link")).toHaveCount(0);
    const objections = guest.locator("#objections");
    await expect(objections.getByText(enMessages.objections_help)).toBeHidden();
    await objections.locator("summary").click();
    await expect(objections.getByText(enMessages.objections_help)).toBeVisible();
    await expect(objections.getByRole("link")).toHaveCount(0);
    await expect(guest.locator("#replies").getByRole("heading", { level: 2 })).toHaveCount(0);
    const replyForm = member.locator("#reply form");
    await waitForFormReady(replyForm);
    await replyForm.getByLabel(enMessages.field_body, { exact: true }).fill("公開閲覧の返信。");
    await replyForm.getByRole("button", { name: enMessages.submit_reply, exact: true }).click();
    await expect(member).toHaveURL(/#c-\d+$/);
    for (const lang of ["en", "ja"]) {
      const messages = lang === "ja" ? jaMessages : enMessages;
      for (const width of [1280, 390, 320]) {
        await guest.setViewportSize({ width, height: 900 });
        await guest.goto(`/?lang=${lang}`);
        await expect(guest.locator('form[action="/follow"]')).toHaveCount(0);
        const countLabel = await card.locator('a[href*="#c-"]').innerText();
        for (const location of ["home", "topic"]) {
          if (location === "topic") await guest.goto(`${threadPath}?lang=${lang}`);
          await expect(guest.locator('main a[href="/why"]')).toHaveCount(0);
          const header = guest.locator("header");
          await expect(header.getByRole("link", { name: messages.footer_why, exact: true })).toHaveAttribute("href", "/why");
          await expect(header.getByRole("link", { name: messages.footer_principles, exact: true })).toHaveAttribute("href", "/principles");
          await expect(guest.getByRole("contentinfo").locator('a[href="/why"], a[href="/principles"]')).toHaveCount(2);
          if (location === "topic") await expect(guest.locator("#replies").getByRole("heading", { level: 2, name: countLabel, exact: true })).toBeVisible();
          await expect.poll(() => guest.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
          if (process.env.E2E_EVIDENCE_DIR && width !== 320) {
            fs.mkdirSync(process.env.E2E_EVIDENCE_DIR, { recursive: true });
            await captureScreenshot(guest, { path: path.join(process.env.E2E_EVIDENCE_DIR, `first-visit-${location}-${lang}-${width}.png`), fullPage: true, animations: "disabled" }, "e2e-public-reading");
          }
        }
      }
    }
    await guest.goto(`${threadPath}?lang=en`);
    await expect(guest.locator('form[action="/vote"], form[action="/stance"], form[action="/follow"], textarea')).toHaveCount(0);
    const memberLink = guest.locator('[data-topic-continuation] a[href="/u/publicwriter"]');
    await expect(memberLink).toBeVisible();
    await expect(guest.locator('a[href^="/u/"]')).toHaveCount(1);
    await memberLink.click();
    await expect(guest).toHaveURL(/\/login\?next=/);
    expect(new URL(guest.url()).searchParams.get("next")).toBe("/u/publicwriter");
    await guest.goto(`${threadPath}?lang=en`);
    await guest.locator(`#p-${threadPath.split("/").at(-1)}`).getByRole("link", { name: enMessages.show_original, exact: true }).click();
    await expect(guest.locator(`#p-${threadPath.split("/").at(-1)} .longread`)).toContainText("公開閲覧の原文。");
    const posts: string[] = [];
    guest.on("request", request => { if (request.method() === "POST") posts.push(new URL(request.url()).pathname); });
    const opened: string[] = [];
    await guestContext.route("https://ai.example/**", route => {
      opened.push(route.request().url());
      return route.fulfill({ contentType: "text/html", body: "AI preview" });
    });
    await guest.evaluate(() => localStorage.setItem("tomola.openInAi", JSON.stringify({ provider: "custom", template: "https://ai.example/?prompt={prompt}" })));
    await (await readingActions(guest)).getByRole("button", { name: enMessages.open_in_ai, exact: true }).click();
    await expect.poll(() => opened.length).toBe(1);
    const prompt = new URL(opened[0]).searchParams.get("prompt")!;
    expect(prompt).toContain(`${state().baseURL}${threadPath}.md?lang=en`);
    expect(prompt).not.toContain("k=");
    const md = await guest.request.get(`${threadPath}.md?lang=en`);
    expect(md.status()).toBe(200);
    expect(await md.text()).toContain("公開閲覧の原文。");
    await guest.locator("header").getByRole("link", { name: enMessages.login_title, exact: true }).click();
    await expect(guest).toHaveURL(/\/login\?next=/);
    expect(new URL(guest.url()).searchParams.get("next")).toBe(`${threadPath}?lang=en`);
    expect(posts).toContain("/open-in-ai/link");
    expect(prompt).toContain("o=");
    await guest.goto("/a/ja?lang=en");
    await expect(guest.locator("header").getByRole("combobox")).toBeVisible();
    await expect(guest.getByRole("button", { name: enMessages.open_in_ai, exact: true }).first()).toBeVisible();
    await guest.locator("header").getByRole("combobox").click();
    await guest.getByRole("option", { name: "日本語", exact: true }).click();
    await expect(guest.locator("html")).toHaveAttribute("lang", "ja");
  } finally {
    await guestContext.close().catch(() => {});
    await memberContext.close().catch(() => {});
  }
});
