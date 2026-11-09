import { saveEditorDraft } from "./draft-autosave-helper";
import fs from "node:fs";
import { expect } from "@playwright/test";
import { test } from "./editor-fixture";
import { waitForClientRoute, useMember, formatMessage, clientHeaders, enMessages, state, messageTitleField as titleField, waitForFormReady } from "./helpers";
import { acceptSignedWrite, enableSigningAuthenticator } from "./signing-helper";

test("opted-in writes and both preference changes use real UV assertions; unsigned entrances are refused", async ({ browser }, info) => {
  const context = await browser.newContext({ extraHTTPHeaders: clientHeaders("10.17.0.1") });
  const page = await context.newPage();
  const navigations: { at: number; path: string }[] = [];
  const draftInput: Record<string, unknown> = {};
  page.on("framenavigated", frame => { if (frame === page.mainFrame()) navigations.push({ at: Date.now(), path: new URL(frame.url()).pathname }); });
  try {
    await useMember(page, "signer@example.com");
    const authenticator = await enableSigningAuthenticator(page);
    await page.goto("/settings");
    await page.getByRole("button", { name: enMessages.settings_passkeys_add, exact: true }).click();
    await expect(page.getByText(enMessages.settings_passkeys_added, { exact: true })).toBeVisible();
    if (!(await page.locator("#settings-advanced").evaluate(element => (element as HTMLDetailsElement).open))) await page.locator("summary").filter({ hasText: enMessages.settings_advanced_heading }).click();
    await page.getByRole("checkbox", { name: enMessages.settings_sign_posts_label, exact: true }).check();
    await page.locator("form", { has: page.locator('input[name="intent"][value="sign-posts"]') }).getByRole("button", { name: enMessages.save_changes, exact: true }).click();
    await acceptSignedWrite(page);
    await expect(page).toHaveURL(url => url.pathname === "/settings" && url.searchParams.get("saved") === "sign-posts" && url.hash === "#settings-signing");
    await expect(page.getByRole("checkbox", { name: enMessages.settings_sign_posts_label, exact: true })).toBeChecked();
    // Saving a private draft does not request approval or a WebAuthn signature.
    let signingRequests = 0;
    const countSigning = (request: import("@playwright/test").Request) => { if (new URL(request.url()).pathname === "/signing") signingRequests++; };
    page.on("request", countSigning);
    await page.goto("/t/new");
    await waitForFormReady(page.locator("form", { has: titleField(page) }));
    await page.getByLabel(enMessages.field_body, { exact: true }).fill("Unsigned draft");
    await saveEditorDraft(page);
    await expect(page).toHaveURL(/\/drafts/);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(signingRequests).toBe(0);
    page.off("request", countSigning);
    await page.goto("/t/new");
    await waitForFormReady(page.locator("form", { has: titleField(page) }));
    await titleField(page).fill("Signed topic");
    const parentBody = Array.from({ length: 50 }, (_, i) => `Parent line ${i + 1}`).join("\n");
    await page.getByLabel(enMessages.field_body).fill(parentBody);
    await page.getByRole("button", { name: enMessages.submit_post, exact: true }).click();
    const approval = page.getByRole("dialog", { name: enMessages.signing_heading });
    await expect(approval).toBeVisible();
    await expect(approval.getByText(parentBody, { exact: true })).toBeVisible();
    await page.mouse.click(2, 2);
    await expect(approval).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(approval).toBeHidden();
    await expect(page.getByLabel(enMessages.field_body)).toHaveValue(parentBody);
    await expect(page.locator('[data-draft-autosave]')).toHaveAttribute("data-draft-autosave", "saved");
    await page.getByRole("button", { name: enMessages.submit_post, exact: true }).click();
    await expect(approval).toBeVisible();
    const credentials = await authenticator.client.send("WebAuthn.getCredentials", { authenticatorId: authenticator.authenticatorId });
    expect(credentials.credentials).toHaveLength(1);
    let releaseChallenge!: () => void;
    const challengeGate = new Promise<void>(resolve => { releaseChallenge = resolve; });
    const pauseChallenge = async (route: import("@playwright/test").Route) => {
      if (route.request().postDataJSON()?.intent === "challenge") await challengeGate;
      await route.continue();
    };
    await page.route("**/signing", pauseChallenge);
    const accepted = acceptSignedWrite(page);
    try {
      await expect(approval.getByRole("button", { name: enMessages.cancel, exact: true })).toBeDisabled();
      await page.keyboard.press("Escape");
      await page.mouse.click(2, 2);
      await expect(approval).toBeVisible();
    } finally { releaseChallenge(); }
    await accepted;
    await expect(page).toHaveURL(/\/t\/(\d+)\?posted=\1$/);
    await page.unroute("**/signing", pauseChallenge);
    const topicPath = new URL(page.url()).pathname;

    const longReply = Array.from({ length: 50 }, (_, i) => `Own reply line ${i + 1}`).join("\n");
    for (const viewport of [{ width: 390, height: 844 }, { width: 1280, height: 900 }]) {
      await page.setViewportSize(viewport);
      await page.getByLabel(enMessages.field_body).fill(longReply);
      await page.getByRole("button", { name: enMessages.submit_reply, exact: true }).click();
      await expect(approval).toBeVisible();
      const primary = approval.getByRole("button", { name: enMessages.signing_accept_reply, exact: true });
      await expect(primary).toBeVisible();
      const box = await primary.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.y).toBeGreaterThanOrEqual(0);
      expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height);
      await expect(approval.getByText(formatMessage(enMessages.original_lang_default, { lang: "English" }), { exact: true })).toHaveCount(1);
      await expect(approval.getByRole("link", { name: /^#\d+$/ })).toHaveCount(0);
      const destination = approval.locator("details").filter({ has: page.locator("summary").filter({ hasText: enMessages.signing_target_thread }) });
      await expect(destination).not.toHaveAttribute("open");
      await destination.locator("summary").click();
      await expect(destination.getByText(parentBody, { exact: true })).toBeVisible();
      await expect(destination.getByRole("link", { name: enMessages.signing_target_open, exact: true })).toHaveAttribute("target", "_blank");
      await approval.getByRole("button", { name: enMessages.cancel, exact: true }).click();
    }
    await page.getByLabel(enMessages.field_body).fill("My signed reply");
    await page.getByRole("button", { name: enMessages.submit_reply, exact: true }).click();
    await acceptSignedWrite(page);
    await expect(page).toHaveURL(/#c-\d+$/);
    const replyId = new URL(page.url()).hash.slice(3);
    await expect(page.locator(`#c-${replyId}`).getByText("My signed reply", { exact: true })).toBeVisible();

    await page.goto("/t/new");
    await waitForFormReady(page.locator("form", { has: titleField(page) }));
    await titleField(page).fill("Unsigned saved draft");
    await page.getByLabel(enMessages.field_body).fill("This draft is private until signed.");
    await saveEditorDraft(page);
    await expect(page).toHaveURL(/\/drafts\/\d+(?:\?saved=1)?$/);
    const draftPath = new URL(page.url()).pathname;
    const requests: { path: string; form: Record<string, string> }[] = [
      { path: "/t/new", form: { title: "unsigned new", body: "Unsigned", lang: "en" } },
      { path: topicPath, form: { body: "Unsigned reply", lang: "en" } },
      { path: `${topicPath}/edit`, form: { title: "Unsigned edit", body: "Unsigned edited body", note: "Unsigned note" } },
      { path: `/c/${replyId}/edit`, form: { body: "Unsigned edited reply", note: "Unsigned note" } },
      { path: draftPath, form: { intent: "publish", title: "Unsigned draft mutation", body: "Unsigned draft change", lang: "en" } },
      { path: "/settings", form: { intent: "handle", handle: "unsigned_handle" } },
    ];
    for (const attempt of requests) {
      const response = await context.request.post(attempt.path, { form: attempt.form, headers: { Origin: state().baseURL }, maxRedirects: 0 });
      expect(response.status(), attempt.path).toBe(403);
      expect(await response.text(), attempt.path).toContain("signature_required");
    }
    await page.goto(draftPath);
    await expect(titleField(page)).toHaveValue("Unsigned saved draft");
    await expect(page.getByLabel(enMessages.field_body)).toHaveValue("This draft is private until signed.");
    await page.goto(topicPath);
    await expect(page.getByRole("heading", { level: 1, name: "Signed topic", exact: true })).toBeVisible();
    await expect(page.getByText("My signed reply", { exact: true })).toBeVisible();
    await expect(page.locator('[data-member-menu-trigger][title="@signer"]').first()).toBeVisible();

    const registrationBypass = await context.request.get("/api/auth/passkey/generate-register-options");
    expect(registrationBypass.status()).toBe(404);
    const pluginVerifyBypass = await context.request.post("/api/auth/passkey/verify-registration", { data: {}, headers: { Origin: state().baseURL } });
    expect(pluginVerifyBypass.status()).toBe(404);
    await page.goto("/settings");
    await waitForClientRoute(page);
    await expect(page.getByRole("button", { name: enMessages.settings_passkeys_remove, exact: true })).toBeDisabled();
    await expect(page.getByText(enMessages.passkey_last_required, { exact: true })).toBeVisible();

    await page.goto("/t/new");
    await waitForFormReady(page.locator("form", { has: titleField(page) }));
    await page.getByRole("textbox", { name: enMessages.field_body, exact: true }).fill("Signed titleless post");
    await page.getByRole("button", { name: enMessages.submit_post, exact: true }).click();
    await acceptSignedWrite(page);
    await expect(page).toHaveURL(/\/t\/(\d+)\?posted=\1$/);
    await expect(page.locator(".longread").first().getByText("Signed titleless post", { exact: true })).toBeVisible();
    await page.goto(`${topicPath}/edit`);
    await page.getByLabel(enMessages.field_body).fill("Accepted topic edit");
    await titleField(page).fill("Accepted topic title");
    await page.getByRole("button", { name: enMessages.save_changes, exact: true }).click();
    await expect(approval.getByText(formatMessage(enMessages.signing_title_change, { before: "Signed topic", after: "Accepted topic title" }), { exact: true })).toBeVisible();
    await acceptSignedWrite(page);
    await expect(page).toHaveURL(new RegExp(`${topicPath}(?:\\?sl=[\\w-]+)?$`));
    await page.goto(`/c/${replyId}/edit`);
    await page.getByLabel(enMessages.field_body).fill("Accepted reply edit");
    await page.getByRole("button", { name: enMessages.save_changes, exact: true }).click();
    await acceptSignedWrite(page);
    await expect(page).toHaveURL(new RegExp(`#c-${replyId}$`));
    await page.goto(draftPath);
    await waitForFormReady(page.locator("form", { has: page.getByLabel(enMessages.field_body) }));
    const editStart = navigations.length;
    await page.getByLabel(enMessages.field_body).fill("Reviewed saved draft edit");
    draftInput.afterFill = await page.getByLabel(enMessages.field_body).inputValue();
    draftInput.beforePublish = await page.getByLabel(enMessages.field_body).inputValue();
    draftInput.navigations = navigations.slice(editStart);
    await page.getByRole("button", { name: enMessages.draft_publish, exact: true }).click();
    await expect(approval.getByRole("button", { name: enMessages.save_draft, exact: true })).toHaveCount(0);
    await page.locator('textarea[name="body"]').evaluate(element => { (element as HTMLTextAreaElement).value = "Unreviewed draft mutation"; });
    await acceptSignedWrite(page);
    await expect(approval).toBeHidden();
    await expect(page.getByText(enMessages.signing_changed, { exact: true })).toBeVisible();
    // Inspect before any later save can overwrite evidence of an unreviewed write.
    const refusedHtml = await (await context.request.get(draftPath)).text();
    expect(refusedHtml).not.toContain("Unreviewed draft mutation");
    await page.getByLabel(enMessages.field_body).fill("Reviewed saved draft edit");
    await saveEditorDraft(page);
    const savedDraft = await context.request.get(draftPath);
    expect(savedDraft.status()).toBe(200);
    const savedHtml = await savedDraft.text();
    expect(savedHtml).toContain("Reviewed saved draft edit");
    expect(savedHtml).not.toContain("Unreviewed draft mutation");
    await page.reload();
    await waitForFormReady(page.locator("form", { has: page.getByLabel(enMessages.field_body) }));
    await expect(page.locator("[data-draft-keeper]")).toBeAttached();
    await waitForClientRoute(page);
    // The acknowledged snapshot reopens directly, without restoring stale edits.
    const discardRestored = page.locator("[data-draft-keeper] > p").first().getByRole("button", { name: enMessages.local_draft_discard, exact: true });
    await expect(discardRestored).toHaveCount(0);
    await expect(page.getByLabel(enMessages.field_body)).toHaveValue("Reviewed saved draft edit");
    await page.getByRole("button", { name: enMessages.draft_publish, exact: true }).click();
    await acceptSignedWrite(page);
    await expect(page).toHaveURL(/\/t\/(\d+)\?posted=\1$/);
    await page.goto("/settings");
    await waitForClientRoute(page);
    await page.locator("#settings-handle summary").click();
    await page.getByLabel(enMessages.onboarding_handle, { exact: true }).fill("signed_name");
    await page.getByRole("button", { name: enMessages.settings_handle_heading, exact: true }).click();
    await acceptSignedWrite(page);
    await expect(page).toHaveURL(url => url.pathname === "/settings" && url.searchParams.get("saved") === "handle" && url.hash === "#settings-handle");
    await expect(page.locator('[data-member-menu-trigger][title="@signed_name"]').first()).toBeVisible();

    const exported = await context.request.get("/settings/export");
    expect(exported.status()).toBe(200);
    const text = await exported.text();
    expect(text).toContain('"signatures":');
    expect(text).toContain('"authenticator_data":');
    expect(text).toContain("create-topic");
    expect(text).toContain("create-reply");
    const records = JSON.parse(text).signatures as { challenge: string; payload_hash: string }[];
    expect(records).toHaveLength(8);
    expect(JSON.parse(text).profile.sign_posts).toBe(true);
    for (const record of records) expect(Buffer.from(record.challenge, "base64url").toString("utf8")).toMatch(new RegExp(`^tomola:v1:[a-f0-9]{64}:${record.payload_hash}$`));
    if (!(await page.locator("#settings-advanced").evaluate(element => (element as HTMLDetailsElement).open))) await page.locator("summary").filter({ hasText: enMessages.settings_advanced_heading }).click();
    await page.getByRole("checkbox", { name: enMessages.settings_sign_posts_label, exact: true }).uncheck();
    await page.locator("form", { has: page.locator('input[name="intent"][value="sign-posts"]') }).getByRole("button", { name: enMessages.save_changes, exact: true }).click();
    await acceptSignedWrite(page);
    await expect(page).toHaveURL(url => url.pathname === "/settings" && url.searchParams.get("saved") === "sign-posts" && url.hash === "#settings-signing");
    await expect(page.getByRole("checkbox", { name: enMessages.settings_sign_posts_label, exact: true })).not.toBeChecked();
    const disabledExport = await (await context.request.get("/settings/export")).json();
    expect(disabledExport.profile.sign_posts).toBe(false);
    expect(disabledExport.signatures).toHaveLength(9);
    expect(disabledExport.signatures.filter((r: { operation: string }) => r.operation === "change-signing-preference")).toHaveLength(2);
  } catch (error) {
    await info.attach("draft-server-log", { body: fs.readFileSync(state().logFile), contentType: "text/plain" });
    throw error;
  } finally {
    await info.attach("draft-input-values", { body: JSON.stringify({ ...draftInput, allNavigations: navigations }, null, 2), contentType: "application/json" });
    await context.close().catch(() => undefined);
  }
});
