import { expect } from "@playwright/test";
import { test } from "./editor-fixture";
import { clientHeaders, enMessages as en, state, uiMessages, useMember, waitForClientRoute } from "./helpers";
import { createQuestionTopic, postAskFlow } from "./post-ask-ai-flow";

test("member questions stay private and create a reviewed reply draft", async ({ page, browser }) => {
  test.setTimeout(240_000);
  await page.context().setExtraHTTPHeaders(clientHeaders("192.0.2.210"));
  await useMember(page, "zask_flow@example.com");
  await postAskFlow(page, { logFile: state().logFile, afterAnswer: async data => {
    const context = await browser.newContext({ baseURL: state().baseURL, ignoreHTTPSErrors: true, extraHTTPHeaders: clientHeaders("192.0.2.211"), serviceWorkers: "block" });
    try {
      const peer = await context.newPage();
      await context.addCookies([{ name: "PARAGLIDE_LOCALE", value: "en", url: state().baseURL }]);
      await useMember(peer, "zask_peer@example.com", `${data.topicPath}/ask?lang=en`);
      await waitForClientRoute(peer);
      await expect(peer.getByLabel(en.post_ask_question, { exact: true })).toHaveValue("");
      await expect(peer.locator("[data-ai-question-answer]")).toHaveCount(0);
      expect(await peer.content()).not.toContain(data.question);
      const denied = await peer.request.post(`${data.topicPath}/ask/action`, { headers: { origin: state().baseURL }, data: { intent: "report", question: data.question, response: data.response, consent: true } });
      expect(denied.status()).toBe(403);
    } finally { await context.close(); }
  } });
});

test("member questions show Japanese readings with paired source quotations", async ({ page }) => {
  test.setTimeout(240_000);
  await page.context().setExtraHTTPHeaders(clientHeaders("192.0.2.212"));
  await useMember(page, "zask_ja_flow@example.com");
  await postAskFlow(page, { locale: "ja", logFile: state().logFile });
});

test("unverified answers leave no answer card and retain the private question", async ({ page }) => {
  await page.context().setExtraHTTPHeaders(clientHeaders("192.0.2.213"));
  await useMember(page, "zask_error@example.com");
  const topic = await createQuestionTopic(page, "Verification failure flow");
  await page.goto(`${topic}/ask?lang=en`);
  await waitForClientRoute(page);
  await page.route(`**${topic}/ask/action?*`, route => route.fulfill({ status: 502, contentType: "application/json", body: JSON.stringify({ error: "unverified" }) }));
  const messages = await uiMessages(page);
  await page.getByLabel(messages.post_ask_question, { exact: true }).fill("A question whose answer was rejected");
  await page.getByRole("button", { name: messages.post_ask_submit, exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText(messages.post_ask_error_unverified);
  await expect(page.locator("[data-ai-question-answer]")).toHaveCount(0);
  await expect(page.getByLabel(messages.post_ask_question, { exact: true })).toHaveValue("A question whose answer was rejected");
});

test("anonymous readers get no entry and cannot use either question route", async ({ page, browser }) => {
  await page.context().setExtraHTTPHeaders(clientHeaders("192.0.2.214"));
  await useMember(page, "zask_guest_owner@example.com");
  const topic = await createQuestionTopic(page, "Anonymous question boundary");
  const context = await browser.newContext({ baseURL: state().baseURL, ignoreHTTPSErrors: true, extraHTTPHeaders: clientHeaders("192.0.2.215"), serviceWorkers: "block" });
  try {
    const guest = await context.newPage();
    await context.addCookies([{ name: "PARAGLIDE_LOCALE", value: "en", url: state().baseURL }]);
    await guest.goto(topic);
    await expect(guest.getByRole("link", { name: en.post_ask_entry, exact: true })).toHaveCount(0);
    await guest.goto(`${topic}/ask`);
    await expect(guest).toHaveURL(url => url.pathname === "/login");
    const response = await guest.request.post(`${topic}/ask/action`, { maxRedirects: 0, headers: { origin: state().baseURL }, data: { intent: "ask", question: "An anonymous question" } });
    expect(response.status()).toBe(302);
    expect(response.headers().location).toContain("/login");
  } finally { await context.close(); }
});
