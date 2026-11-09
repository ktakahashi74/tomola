import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { enMessages as m, useMember, waitForClientRoute, state } from "./helpers";

test("chat delivers original text before translating, toggles each message, and discards old unseen translation changes", async ({ page, browser }) => {
  const original = "村のチャットを訳す試験。";
  await useMember(page, "ctxlive_writer@example.com");
  await page.goto("/v/chat-translation-live/chat"); await waitForClientRoute(page);
  await page.getByRole("button", { name: m.village_chat_consent_accept, exact: true }).click();
  const context = await browser.newContext({ locale: "en-US" });
  const held = path.join(state().dir, "fake-chat-translation-hold");
  try {
    const reader = await context.newPage(); await useMember(reader, "ctxlive_reader@example.com");
    await reader.goto("/v/chat-translation-live/chat"); await waitForClientRoute(reader);
    expect((await reader.request.get("/v/chat-translation-live/chat/changes?since=0")).status()).toBe(404);
    await reader.getByRole("button", { name: m.village_chat_consent_accept, exact: true }).click();
    await expect(reader.getByRole("log", { name: m.village_chat_title, exact: true })).toBeVisible();
    await reader.locator('a[href$="?latest=1#chat-bottom"]').click();
    await waitForClientRoute(reader);
    // Keep translation pending until the real client observes the original,
    // including the signal's coalescing window and the client's refresh jitter.
    let receivedOriginal = false;
    reader.on("response", async response => {
      if (!response.url().includes("/chat/changes?") || !response.ok()) return;
      const body = await response.json().catch(() => null);
      if (body?.messages.some((message: { parts?: Array<{ text: string }>; translation?: { state: string } }) => message.parts?.map(p => p.text).join("") === original && message.translation?.state === "pending")) receivedOriginal = true;
    });
    fs.writeFileSync(held, original);
    await page.getByLabel(m.village_chat_body, { exact: true }).fill(original);
    await page.getByRole("button", { name: m.village_chat_send, exact: true }).click();
    await expect.poll(() => receivedOriginal).toBe(true);
    await expect(reader.getByRole("log").getByRole("paragraph").filter({ hasText: original }).first()).toHaveText(original);
    fs.rmSync(held, { force: true });
    const article = reader.getByRole("article").filter({ hasText: `[en] ${original}` });
    await expect(article).toBeVisible();
    await expect(article).toHaveAttribute("lang", "en");
    const id = await article.getAttribute("data-chat-message");
    const message = reader.locator(`[data-chat-message="${id}"]`);
    // The message actions take pointer events only while the message is hovered or pressed.
    await message.hover();
    await message.getByRole("button", { name: m.village_chat_translation_original, exact: true }).click();
    await expect(message.getByRole("paragraph").filter({ hasText: original }).first()).toHaveText(original);
    await expect(message).toHaveAttribute("lang", "ja");
    await message.hover();
    await message.getByRole("button", { name: m.village_chat_translation_show, exact: true }).click();
    await expect(message).toHaveAttribute("lang", "en");
    await expect(message.getByText(m.village_chat_translation_machine, { exact: true })).toBeVisible();
    const operatorContext = await browser.newContext({ locale: "en-US" });
    try {
      const operator = await operatorContext.newPage(); await useMember(operator, "olga@example.com");
      await operator.goto("/mod/chat-translations"); await waitForClientRoute(operator);
      const cases = operator.locator('a[href^="/mod/chat-translations?id="]');
      const before = await cases.evaluateAll(links => links.map(link => link.getAttribute("href")));
      await message.hover();
      let reportBody: string | undefined;
      // Buffer the real response before handing it to the page: reporting can
      // revalidate the route and invalidate Chromium's response-body handle.
      await reader.route("**/v/chat-translation-live/chat*", async route => {
        if (route.request().method() !== "POST") return route.fallback();
        const response = await route.fetch({ maxRedirects: 0 });
        reportBody = await response.text();
        await route.fulfill({ response, body: reportBody });
      });
      const reportResponse = reader.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname.includes("/v/chat-translation-live/chat"));
      await message.getByRole("button", { name: m.report_button, exact: true }).click();
      const submitted = await reportResponse;
      expect(submitted.status()).toBe(200);
      expect(submitted.headers()["x-chat-translation-report"]).toBeUndefined();
      expect(reportBody).toBeDefined();
      expect(reportBody).not.toContain("reportId");
      await expect(message.getByRole("button", { name: m.report_reported, exact: true })).toBeDisabled();
      let caseHref: string | null = null;
      await expect.poll(async () => {
        await operator.reload(); await waitForClientRoute(operator);
        caseHref = await cases.evaluateAll((links, previous) => links.map(link => link.getAttribute("href")).find(href => href && !previous.includes(href)) ?? null, before);
        return caseHref;
      }).not.toBeNull();
      const caseLink = operator.locator(`a[href="${caseHref}"]`);
      await expect(caseLink).toBeVisible();
      const metadata = await operator.request.get(`/mod/chat-translations.data${new URL(caseHref!, operator.url()).search}`);
      expect(metadata.headers()["cache-control"]).toBe("private, no-store");
      expect(await metadata.text()).not.toContain(original);
      await caseLink.click(); await waitForClientRoute(operator);
      await operator.getByRole("button", { name: m.chat_reports_open, exact: true }).click();
      await expect(operator.getByText(original, { exact: true })).toBeVisible();
      await expect(operator.getByText(`[en] ${original}`, { exact: true })).toBeVisible();
      await operator.getByRole("button", { name: m.chat_translation_hide, exact: true }).click();
      await expect(message.getByText(m.village_chat_translation_failed, { exact: true })).toBeVisible();
    } finally { await operatorContext.close(); }
    const oldId = JSON.parse(fs.readFileSync(path.join(state().dir, "chat-translation.json"), "utf8")).oldId;
    await reader.request.get("/v/chat-translation-live/chat/changes?since=0");
    await expect.poll(async () => {
      const response = await reader.request.get("/v/chat-translation-live/chat/changes?since=55");
      return (await response.json()).messages.some((m: { id: string; translation?: { state: string } }) => m.id === oldId && m.translation?.state === "ready");
    }).toBe(true);
    await expect(reader.locator(`[data-chat-message="${oldId}"]`)).toHaveCount(0);
    const outsider = await context.newPage(); await useMember(outsider, "ctxlive_noagree@example.com");
    await outsider.goto("/v/chat-translation-live/chat"); await expect(outsider.getByRole("log")).toHaveCount(0);
    expect((await outsider.request.get("/v/chat-translation-live/chat/changes?since=0")).status()).toBe(404);
  } finally { fs.rmSync(held, { force: true }); await context.close(); }
});
