import { expect, test } from "@playwright/test";
import { enMessages as m, formatMessage, useMember, waitForClientRoute, waitForHydration, captureScreenshot } from "./helpers";

test("chat suggestions stay inside the village, Enter selects, and author-named notices group and open the surrounding messages", async ({ page, browser }) => {
  await useMember(page, "vcm_author@example.com");
  const context = await browser.newContext({ locale: "en-US" }); const reader = await context.newPage();
  try {
    await useMember(reader, "vcm_reader@example.com", "/notifications");
    await page.goto("/v/chat-mentions/chat"); await waitForClientRoute(page);
    const body = page.getByLabel(m.village_chat_body, { exact: true });
    const suggestions = page.getByRole("listbox", { name: m.mention_suggestions_label });
    await body.click();
    await body.pressSequentially("Sensitive chat marker @vcm_");
    await expect(suggestions.getByRole("option")).toHaveText(["@vcm_reader"]);
    await body.dispatchEvent("keydown", { key: "Enter", code: "Enter", keyCode: 229, isComposing: true });
    await expect(body).toHaveValue("Sensitive chat marker @vcm_");
    await expect(page.locator("[data-chat-message]")).toHaveCount(50);
    await body.press("Enter");
    await expect(body).toHaveValue("Sensitive chat marker @vcm_reader ");
    await expect(suggestions).toBeHidden();
    await expect(page.locator("[data-chat-message]")).toHaveCount(50);
    await body.press("Enter");
    await expect(body).toHaveValue("");
    const article = page.locator("[data-chat-message]").filter({ hasText: "Sensitive chat marker" });
    await expect(article.locator("a.mention")).toHaveText("@vcm_reader");
    const id = await article.getAttribute("data-chat-message");
    await article.hover();
    await article.locator("summary").filter({ hasText: m.village_chat_edit }).click();
    const edit = article.locator('textarea[name="body"]');
    await edit.fill("Edited sensitive marker @vcm_");
    await expect(article.getByRole("option")).toHaveText(["@vcm_reader"]);
    await edit.press("Enter");
    await expect(edit).toHaveValue("Edited sensitive marker @vcm_reader ");
    await article.getByRole("button", { name: m.save_changes, exact: true }).click();
    const edited = page.locator(`[data-chat-message="${id}"]`);
    await expect(edited.locator("details").first()).not.toHaveAttribute("open", "");
    await body.fill("Another private mention @vcm_reader");
    await page.getByRole("button", { name: m.village_chat_send, exact: true }).click();
    await expect(body).toHaveValue("");
    await reader.reload(); await waitForClientRoute(reader);
    const notice = reader.getByRole("link", { name: formatMessage(m.notification_chat_authors, { name: "chat-mentions", handles: "@vcm_author" }) + " " + formatMessage(m.notification_chat_count, { count: 2 }), exact: true });
    await expect(notice).toHaveCount(1);
    await expect(reader.locator("main")).not.toContainText("Edited sensitive marker");
    await expect(reader.locator("main")).toContainText("vcm_author");
    await expect(notice).toHaveAttribute("href", /^\/notifications\/\d+\/open$/);
    await captureScreenshot(reader, { path: "chat-mention-notice.png", fullPage: true }, "village-chat-mentions");
    await notice.click();
    await expect(reader).toHaveURL(new RegExp(`/v/chat-mentions/chat\\?at=${id}#chat-${id}$`));
    // The notice opens a new document; history must use its hydrated handlers.
    await waitForHydration(reader);
    await expect(reader.locator(`[data-chat-message="${id}"]`)).toContainText("Edited sensitive marker");
    await expect(reader.locator(`[data-chat-message="${id}"]`)).toBeInViewport();
    await expect(reader.locator(`[data-chat-message="${id}"]`)).toHaveCSS("animation-name", "destination-highlight");
    // Opening one notice does not read the other mention across unloaded history.
    await expect.poll(async () => (await (await reader.request.get("/navigation-header")).json()).unreadNotifications).toBe(1);
    await expect(reader.locator("[data-chat-message]")).toHaveCount(27);
    await expect(reader.getByRole("log")).toContainText("Mention history 36");
    // A visible link may not scroll, so request history explicitly.
    await reader.getByRole("link", { name: m.village_chat_previous, exact: true }).click();
    await expect(reader.getByRole("log")).toContainText("Mention history 1");
    await expect(reader).toHaveURL(new RegExp(`/v/chat-mentions/chat\\?at=${id}#chat-${id}$`));
    await expect(reader.locator("[data-chat-message]")).toHaveCount(62);
    await reader.locator("[data-chat-message]").last().scrollIntoViewIfNeeded();
    await expect.poll(async () => (await (await reader.request.get("/navigation-header")).json()).unreadNotifications).toBe(0);
    await expect(reader.locator('header a[href="/notifications"] [role="img"]')).toHaveCount(0);
  } finally { await context.close(); }
});
