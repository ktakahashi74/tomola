import { expect, type Page } from "@playwright/test";
import { test } from "./editor-fixture";
import { enMessages as en, useMember, waitForFormReady } from "./helpers";
import { routeModule } from "./support/module-route";
import { acceptSignedWrite, enableSigningAuthenticator } from "./signing-helper";

const body = (page: Page) => page.locator('textarea[name="body"]').first();
const form = (page: Page) => page.locator("form", { has: body(page) }).first();
const saved = (page: Page) => expect(page.locator("[data-draft-autosave]")).toHaveAttribute("data-draft-autosave", "saved");

for (const screen of ["new", "draft"]) test(`input and departure protection survive a delayed autosave module on the ${screen} screen`, async ({ page }) => {
  await useMember(page, `lazy_autosave_${screen}@example.com`, "/t/new");
  let id: string | undefined;
  if (screen === "draft") {
    await expect(form(page)).toHaveAttribute("data-autosave", "ready");
    await body(page).fill("The server's starting text");
    await saved(page);
    id = await page.locator('input[name="fromDraft"]').inputValue();
  }
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const requests: Promise<void>[] = [];
  const moduleRoute = await routeModule(page, "app/components/draft-autosave-content.tsx", route => {
    const request = held.then(() => route.continue());
    requests.push(request);
    return request;
  });
  const path = id ? `/drafts/${id}` : "/t/new";
  try {
    await page.goto(path, { waitUntil: "domcontentloaded" });
    await waitForFormReady(form(page));
    await moduleRoute.assertHit();
    await expect(form(page)).not.toHaveAttribute("data-autosave", "ready");
    await body(page).fill("Writing before autosave is ready");
    expect(await page.evaluate(() => {
      const event = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    })).toBe(true);
    const dialog = page.waitForEvent("dialog");
    await page.evaluate(() => {
      void (window as unknown as { __reactRouterDataRouter: { navigate(path: string): Promise<void> } }).__reactRouterDataRouter.navigate("/drafts");
    });
    const shown = await dialog;
    expect(shown.message()).toBe(en.leave_unsaved_confirm);
    await shown.dismiss();
    await expect(page).toHaveURL(new RegExp(`${path}$`));
    release();
    await expect(form(page)).toHaveAttribute("data-autosave", "ready");
    await saved(page);
    await expect(body(page)).toHaveValue("Writing before autosave is ready");
    const linked = id ?? await page.locator('input[name="fromDraft"]').inputValue();
    expect(await (await page.request.get(`/drafts/${linked}`)).text()).toContain("Writing before autosave is ready");
    await page.reload();
    await expect(body(page)).toHaveValue("Writing before autosave is ready");
  } finally {
    release();
    await Promise.all(requests);
    await moduleRoute.dispose();
  }
});

test("a reply draft stays clean on opening and saves writing entered before autosave loads", async ({ page }) => {
  await useMember(page, "lazy_autosave_reply@example.com", "/t/new");
  await expect(form(page)).toHaveAttribute("data-autosave", "ready");
  const ownerId = await page.evaluate(() => sessionStorage.getItem("tomola:draft-owner"));
  const headers = { Origin: new URL(page.url()).origin };
  const topic = await page.request.post("/t/new", { headers, form: { body: "A thread for a reply draft", lang: "en" } });
  expect(topic.ok()).toBe(true);
  const threadId = new URL(topic.url()).pathname.split("/").at(-1)!;
  const response = await page.request.post("/drafts/ai-write", { headers, form: { ownerId: ownerId!, kind: "reply", threadId, body: "The saved reply", lang: "en" } });
  expect(response.ok()).toBe(true);
  const { id } = await response.json() as { id: number };
  let writes = 0;
  page.on("request", request => { if (request.method() === "POST" && new URL(request.url()).pathname === "/drafts/autosave") writes++; });
  await page.goto(`/drafts/${id}`);
  await waitForFormReady(form(page));
  await saved(page);
  await page.waitForTimeout(3000);
  expect(writes).toBe(0);
  expect(await (await page.request.get(`/drafts/autosave?draftId=${id}`)).json()).toEqual({ id, version: 1 });
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const requests: Promise<void>[] = [];
  const moduleRoute = await routeModule(page, "app/components/draft-autosave-content.tsx", route => {
    const request = held.then(() => route.continue());
    requests.push(request);
    return request;
  });
  try {
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitForFormReady(form(page));
    await moduleRoute.assertHit();
    await body(page).fill("A reply entered before autosave loads");
    release();
    await expect(form(page)).toHaveAttribute("data-autosave", "ready");
    await saved(page);
    expect(await (await page.request.get(`/drafts/${id}`)).text()).toContain("A reply entered before autosave loads");
  } finally {
    release();
    await Promise.all(requests);
    await moduleRoute.dispose();
  }
});

test("signing waits for an in-flight autosave and reviews the latest saved fields", async ({ page }) => {
  await useMember(page, "lazy_autosave_signing@example.com", "/settings");
  await enableSigningAuthenticator(page);
  await page.getByRole("button", { name: en.settings_passkeys_add, exact: true }).click();
  await expect(page.getByText(en.settings_passkeys_added, { exact: true })).toBeVisible();
  await page.locator("#settings-advanced").evaluate(element => { (element as HTMLDetailsElement).open = true; });
  await page.getByRole("checkbox", { name: en.settings_sign_posts_label, exact: true }).check();
  await page.locator('form:has(input[name="intent"][value="sign-posts"])').getByRole("button", { name: en.save_changes, exact: true }).click();
  await acceptSignedWrite(page);
  await expect(page).toHaveURL(url => url.searchParams.get("saved") === "sign-posts");
  await page.goto("/t/new");
  await waitForFormReady(form(page));
  await expect(form(page)).toHaveAttribute("data-autosave", "ready");
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let stored = false;
  let signing = 0;
  page.on("request", request => { if (new URL(request.url()).pathname === "/signing") signing++; });
  await page.route("**/drafts/autosave", async route => {
    const response = await route.fetch();
    stored = true;
    await held;
    await route.fulfill({ response });
  }, { times: 1 });
  try {
    await body(page).fill("The first saved text");
    await expect.poll(() => stored).toBe(true);
    await body(page).fill("The latest text before signing");
    await page.getByRole("button", { name: en.submit_post, exact: true }).click();
    expect(signing).toBe(0);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    const preview = page.waitForRequest(request => new URL(request.url()).pathname === "/signing");
    release();
    const fields = (await preview).postDataJSON().fields as [string, string][];
    const submitted = new Map(fields);
    expect(submitted.get("body")).toBe("The latest text before signing");
    expect(submitted.get("fromDraft")).toMatch(/^\d+$/);
    expect(await (await page.request.get(`/drafts/${submitted.get("fromDraft")}`)).text()).toContain("The latest text before signing");
    await acceptSignedWrite(page);
    await expect(page).toHaveURL(/\/t\/\d+\?posted=/);
    await expect(page.locator(".longread").first()).toContainText("The latest text before signing");
  } finally { release(); }
});

for (const kind of ["topic", "reply"]) test(`API ${kind} approval survives autosave connecting during review`, async ({ page }) => {
  await useMember(page, `lazy_autosave_review_${kind}@example.com`, "/settings/tokens");
  await page.getByLabel(en.tokens_name).fill("Delayed autosave approval");
  await page.getByRole("radio", { name: en.tokens_kind_draft }).check();
  await page.getByRole("button", { name: en.tokens_create }).click();
  const token = page.locator("[role=status] code");
  await expect(token).toHaveText(/^tml_draft_[A-Za-z0-9_-]{43}$/);
  let target = "";
  if (kind === "reply") {
    const topic = await page.request.post("/t/new", { headers: { Origin: new URL(page.url()).origin }, form: { body: "A thread for delayed API approval", lang: "en" } });
    expect(topic.ok()).toBe(true);
    target = `reply_to: p-${new URL(topic.url()).pathname.split("/").at(-1)}\n`;
  }
  const text = `Reviewed API ${kind} writing`;
  const created = await page.request.post("/api/drafts", {
    headers: { Authorization: `Bearer ${(await token.innerText()).trim()}`, "Content-Type": "text/markdown" },
    data: `---\ntype: ${kind}\n${target}lang: en\n---\n${text}\n`,
  });
  expect(created.status()).toBe(201);
  const { approve_url } = await created.json() as { approve_url: string };
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const requests: Promise<void>[] = [];
  const moduleRoute = await routeModule(page, "app/components/draft-autosave-content.tsx", route => {
    const request = held.then(() => route.continue());
    requests.push(request);
    return request;
  });
  try {
    await page.goto(approve_url, { waitUntil: "domcontentloaded" });
    await waitForFormReady(form(page));
    await moduleRoute.assertHit();
    await expect(form(page)).not.toHaveAttribute("data-autosave", "ready");
    const preview = page.waitForRequest(request => new URL(request.url()).pathname === "/signing");
    await page.getByRole("button", { name: en.draft_publish, exact: true }).click();
    const checked = (await preview).postDataJSON().fields as [string, string][];
    const confirmation = page.getByRole("dialog", { name: en.signing_heading });
    await expect(confirmation.getByText(text, { exact: true })).toBeVisible();
    expect(new Map(checked).get("version")).toBe("1");
    release();
    await expect(form(page)).toHaveAttribute("data-autosave", "ready");
    expect(await form(page).evaluate(element => [...new FormData(element as HTMLFormElement)])).toEqual(checked.filter(([name]) => name !== "intent"));
    await confirmation.getByRole("button", { name: en.confirm_publish, exact: true }).click();
    await expect(page).toHaveURL(/\/t\/\d+(?:[?#].*)?$/);
    await expect(page.locator(".longread").getByText(text, { exact: true })).toBeVisible();
  } finally {
    release();
    await Promise.all(requests);
    await moduleRoute.dispose();
  }
});
