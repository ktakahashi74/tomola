import fs from "node:fs";
import path from "node:path";
import { expect, type BrowserContext, type Page } from "@playwright/test";
import { test } from "./editor-fixture";
import { waitForClientRoute, useMember, clientHeaders, jaMessages as ja, state  } from "./helpers";

test.describe.configure({ mode: "serial" });
let member: BrowserContext;
const topics: string[] = [];
test.beforeAll(async ({ browser }) => {
  member = await browser.newContext({ locale: "ja-JP", extraHTTPHeaders: clientHeaders("203.0.113.183") });
  const page = await member.newPage();
  const fixture = JSON.parse(fs.readFileSync(path.join(state().dir, "deleted-replies.json"), "utf8"));
  await useMember(page, "deleted_replies@example.com");
  await page.close();
});
test.afterAll(async () => {
  if (!member) return;
  for (const url of topics) await member.request.post(url, { headers: { Origin: state().baseURL }, form: { intent: "delete", entryId: url.split("/").at(-1)!, confirm: "1" }, maxRedirects: 0 });
  await member.close();
});
async function post(url: string, form: Record<string, string>) {
  const response = await member.request.post(url, { headers: { Origin: state().baseURL }, form, maxRedirects: 0 });
  expect(response.status(), await response.text()).toBe(302);
  return response.headers().location;
}
async function remove(page: Page, id: string) {
  const article = page.locator(`#c-${id}`);
  await article.locator("summary").filter({ hasText: ja.delete_summary }).click();
  await article.getByRole("button", { name: ja.delete_confirm, exact: true }).press("Enter");
  await expect(page).toHaveURL(new RegExp(`#c-${id}$`));
}

for (const javaScriptEnabled of [true]) {
  test(`deletion omits unused replies and retains referenced parents with JavaScript ${javaScriptEnabled ? "enabled" : "disabled"}`, async ({ browser }) => {
    const context = await browser.newContext({ javaScriptEnabled, locale: "ja-JP", storageState: await member.storageState(), extraHTTPHeaders: clientHeaders("203.0.113.184") });
    try {
      // When villages are enabled, the new-post form names the destination it shows; submit the same field.
      const displayed = /name="villageDisplayed" value="([^"]*)"/.exec(await (await member.request.get("/t/new")).text())?.[1];
      const url = (await post("/t/new", { lang: "ja", title: "返信の跡の試験", body: "本文の試験", ...(displayed === undefined ? {} : { villageDisplayed: displayed }) })).split(/[?#]/)[0];
      topics.push(url);
      const makeReply = async (body: string, parentId?: string) => {
        const location = await post(url, { lang: "ja", body, ...(parentId ? { parentId } : {}) });
        return location.split("#c-")[1];
      };
      const unused = await makeReply("だれも返信していない文"), parent = await makeReply("返信先の秘密の文"), child = await makeReply("残る返信の文", parent);
      const page = await context.newPage();
      await page.goto(`${url}?lang=ja`);
      if (javaScriptEnabled) await waitForClientRoute(page);
      await expect(page.locator(`#c-${child}`).getByRole("link", { name: /^@deleted_replies/ })).toHaveCount(1);
      await expect(page.locator(`#c-${child}`).locator(`a[href$="#c-${parent}"]`)).toHaveCount(0);
      await remove(page, unused);
      await expect(page.locator(`#c-${unused}`)).toHaveCount(0);
      await expect(page.getByText(ja.entry_deleted_placeholder, { exact: true })).toHaveCount(0);
      await expect(page.locator("#replies")).not.toContainText("だれも返信していない文");
      await remove(page, parent);
      const placeholder = page.locator(`#c-${parent}`);
      await expect(placeholder).toHaveText(ja.entry_deleted_placeholder);
      await expect(placeholder.locator("time, a, form, button")).toHaveCount(0);
      await expect(page.locator(`[data-reply-branch="${parent}"] #c-${child}`)).toBeVisible();
      await expect(page.locator("#replies")).not.toContainText("返信先の秘密の文");
      if (process.env.E2E_PUBLIC_READING === "1") {
        const guest = await browser.newContext({ javaScriptEnabled, locale: "ja-JP", extraHTTPHeaders: clientHeaders("203.0.113.185") });
        try {
          const reading = await guest.newPage();
          await reading.goto(`${url}?lang=ja`);
          await expect(reading.locator(`#c-${unused}`)).toHaveCount(0);
          await expect(reading.locator(`#c-${parent}`)).toHaveText(ja.entry_deleted_placeholder);
          await expect(reading.locator(`[data-reply-branch="${parent}"] #c-${child}`)).toBeVisible();
        } finally { await guest.close(); }
      }
      const markdown = await (await member.request.get(`${url}.md?lang=all`)).text();
      expect(markdown).not.toContain(`id: c-${unused}\n`);
      expect(markdown).toContain(`id: c-${parent}\n`);
      expect(markdown).toContain(`reply_to: c-${parent}\n`);
      expect(markdown).not.toContain("返信先の秘密の文");
      await remove(page, child);
      await expect(page.locator("#replies article")).toHaveCount(0);
      await expect(page.getByText(ja.entry_deleted_placeholder, { exact: true })).toHaveCount(0);
      await page.reload();
      await expect(page.locator("#replies article")).toHaveCount(0);
    } finally { await context.close(); }
  });
}
