import { expect, type Page } from "@playwright/test";
import { test } from "./editor-fixture";
import { baseOf, localDraftKey, olderLocalDraftKey, type LocalDraft } from "../app/lib/local-draft";
import { enMessages as en, useMember, waitForFormReady } from "./helpers";
import { routeModule } from "./support/module-route";

const body = (page: Page) => page.locator('textarea[name="body"]').first();
const form = (page: Page) => page.locator("form", { has: body(page) }).first();
const keeper = (page: Page) => page.locator("[data-draft-keeper]");
const offered = (page: Page) => keeper(page).locator("p").filter({ has: page.getByRole("button", { name: en.local_draft_open, exact: true }) });
const record = (text: string, base = "earlier-base"): LocalDraft => ({ body: text, base, savedAt: 1000 });
const read = (page: Page, key: string): Promise<LocalDraft | null> => page.evaluate(key => JSON.parse(localStorage.getItem(key) ?? "null"), key);
const ready = async (page: Page) => {
  await waitForFormReady(form(page));
  await expect(form(page)).toHaveAttribute("data-draft-recovery", "ready");
};
const put = (page: Page, records: Record<string, LocalDraft>) => page.evaluate(records => {
  for (const [key, value] of Object.entries(records)) localStorage.setItem(key, JSON.stringify(value));
}, records);
const saved = (page: Page) => expect(page.locator("[data-draft-autosave]")).toHaveAttribute("data-draft-autosave", "saved");

async function fullArchive(page: Page) {
  await page.addInitScript(() => {
    const set = Storage.prototype.setItem;
    (window as unknown as { archiveFull: boolean }).archiveFull = true;
    Storage.prototype.setItem = function(key, value) {
      if (key.includes("~older:") && (window as unknown as { archiveFull: boolean }).archiveFull) throw new DOMException("Full", "QuotaExceededError");
      return set.call(this, key, value);
    };
  });
}

type Screen = "new" | "topic" | "reply" | "draft";
async function screen(page: Page, name: string, kind: Screen) {
  await useMember(page, `older_fix1_${name}@example.com`, "/t/new");
  await ready(page);
  const owner = await page.evaluate(() => sessionStorage.getItem("tomola:draft-owner"));
  expect(owner).toBeTruthy();
  const headers = { Origin: new URL(page.url()).origin };
  if (kind === "new") return { key: localDraftKey(owner!, "topic-new:::"), path: "/t/new" };
  if (kind === "draft") {
    const response = await page.request.post("/drafts/autosave", { headers, form: { ownerId: owner!, newTopic: "1", title: "", body: "Server starting text", lang: "en" } });
    expect(response.ok()).toBe(true);
    const { id } = await response.json() as { id: number };
    return { key: localDraftKey(owner!, `draft:${id}`), path: `/drafts/${id}` };
  }
  const topic = await page.request.post("/t/new", { headers, form: { body: "A topic for draft cleanup", lang: "en" }, maxRedirects: 0 });
  expect(topic.status()).toBe(302);
  const path = new URL(topic.headers().location, page.url()).pathname;
  if (kind === "topic") return { path: `${path}/edit`, key: localDraftKey(owner!, `edit:topic:${path.split("/").at(-1)}`) };
  const reply = await page.request.post(path, { headers, form: { body: "A reply for draft cleanup", lang: "en" }, maxRedirects: 0 });
  expect(reply.status()).toBe(302);
  const id = /#c-(\d+)/.exec(reply.headers().location)![1];
  return { path: `/c/${id}/edit`, key: localDraftKey(owner!, `edit:reply:${id}`) };
}

async function leave(page: Page) {
  const dialog = page.waitForEvent("dialog");
  await page.evaluate(() => { void (window as unknown as { __reactRouterDataRouter: { navigate(path: string): Promise<void> } }).__reactRouterDataRouter.navigate("/drafts"); });
  await (await dialog).accept();
  await expect(page).toHaveURL(/\/drafts$/);
}
async function send(page: Page, kind: Screen) {
  await page.getByRole("button", { name: kind === "new" ? en.submit_post : kind === "draft" ? en.draft_publish : en.save_changes, exact: true }).click();
  await expect(page).toHaveURL(/\/t\/\d+(?:[?#].*)?$/);
}

for (const kind of ["new", "topic", "draft"] as const) for (const action of ["send", "discard"] as const) {
  test(`blocked preservation retains its source after ${action} on ${kind}`, async ({ page }) => {
    const { path, key } = await screen(page, `blocked_${kind}_${action}`, kind);
    const source = record("Unsent source that must survive");
    await put(page, { [key]: source });
    await fullArchive(page);
    if (action === "discard") await page.route("**/drafts/autosave**", route => route.abort());
    await page.goto(path); await ready(page);
    await expect(form(page)).toHaveAttribute("data-draft-preserve", "blocked");
    await body(page).fill("Current writing being sent or discarded");
    if (action === "send") await send(page, kind);
    else await leave(page);
    expect(await read(page, key)).toMatchObject(source);
  });
}

test("a missing autosave link cannot unlink a blocked source", async ({ page }) => {
  const { key } = await screen(page, "blocked_unlink", "new");
  await expect(form(page)).toHaveAttribute("data-autosave", "ready");
  await body(page).fill("Writing saved before detachment"); await saved(page);
  await page.route("**/drafts/autosave**", route => route.abort());
  await body(page).fill("Unsent source before detachment");
  await put(page, { [olderLocalDraftKey(key)]: record("Offered older writing") });
  await page.evaluate(() => {
    const set = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      if (key.includes("~older:")) throw new DOMException("Full", "QuotaExceededError");
      return set.call(this, key, value);
    };
    window.dispatchEvent(new Event("tomola:draft-set-aside"));
  });
  await offered(page).getByRole("button", { name: en.local_draft_open, exact: true }).click();
  await expect(form(page)).toHaveAttribute("data-draft-preserve", "blocked");
  const source = await read(page, key);
  expect(source?.body).toBe("Unsent source before detachment");
  await page.route("**/drafts/autosave**", route => route.abort());
  await page.route("**/drafts/autosave", route => route.fulfill({ status: 404, json: { error: "not_found" } }), { times: 1 });
  await body(page).fill("Newer live writing while the archive is full");
  const response = page.waitForResponse(r => r.url().endsWith("/drafts/autosave") && r.status() === 404);
  await response;
  await expect(page.locator('[name="fromDraft"]')).toHaveCount(0);
  expect(await read(page, key)).toEqual(source);
});

test("a failed navigation chunk leaves local saving and single-record actions working", async ({ page }) => {
  const { path, key } = await screen(page, "navigation_failure", "topic");
  await put(page, { [olderLocalDraftKey(key)]: record("First offered writing") });
  const fault = await routeModule(page, "app/components/older-draft-navigation.tsx", route => route.abort());
  try {
    await page.goto(path); await ready(page);
    await expect(offered(page)).toBeVisible();
    await put(page, { [`${olderLocalDraftKey(key)}:second`]: { ...record("Second offered writing"), savedAt: 2000 } });
    await page.evaluate(() => window.dispatchEvent(new Event("tomola:draft-set-aside")));
    await fault.assertHit();
    await expect(offered(page)).toBeVisible();
    await body(page).fill("Writing after the chunk failed");
    await expect.poll(async () => (await read(page, key))?.body).toBe("Writing after the chunk failed");
    await offered(page).getByRole("button", { name: en.local_draft_discard, exact: true }).click();
    expect(await read(page, olderLocalDraftKey(key))).toBeNull();
    await offered(page).getByRole("button", { name: en.local_draft_open, exact: true }).click();
    await expect(body(page)).toHaveValue("Second offered writing");
  } finally { await fault.dispose(); }
});

for (const action of ["open", "discard"] as const) test(`draft ${action} uses the base acknowledged by autosave`, async ({ page }) => {
  const { path, key } = await screen(page, `base_${action}`, "draft");
  await put(page, { [olderLocalDraftKey(key)]: record("Older writing to open") });
  await page.goto(path); await ready(page);
  await expect(form(page)).toHaveAttribute("data-autosave", "ready");
  await body(page).fill("Current acknowledged writing"); await saved(page);
  await offered(page).getByRole("button", { name: en.local_draft_open, exact: true }).click();
  if (action === "discard") {
    await saved(page);
    await keeper(page).locator("p").filter({ hasText: /Restored/ }).getByRole("button", { name: en.local_draft_discard, exact: true }).click();
  }
  const currentBase = await form(page).getAttribute("data-draft-base");
  expect((await read(page, key))?.base).toBe(currentBase);
  await page.waitForTimeout(1200);
  const copies = await page.evaluate(prefix => Object.keys(localStorage).filter(key => key.startsWith(prefix)).map(key => JSON.parse(localStorage.getItem(key)!)), `${olderLocalDraftKey(key)}:`) as LocalDraft[];
  expect(copies.filter(item => item.body === "Older writing to open")).toHaveLength(0);
});

for (const kind of ["topic", "reply", "draft"] as const) for (const action of ["send", "discard"] as const) {
  test(`${kind} clears legacy and independent set-asides after ${action}`, async ({ page }) => {
    const { path, key } = await screen(page, `cleanup_${kind}_${action}`, kind);
    await put(page, { [olderLocalDraftKey(key)]: record("Legacy set-aside"), [`${olderLocalDraftKey(key)}:independent`]: record("Independent set-aside") });
    if (action === "discard") await page.route("**/drafts/autosave**", route => route.abort());
    await page.goto(path); await ready(page);
    await expect(offered(page)).toBeVisible();
    await body(page).fill("Current writing for cleanup");
    if (action === "send") await send(page, kind);
    else await leave(page);
    expect(await read(page, key)).toBeNull();
    expect(await page.evaluate(prefix => Object.keys(localStorage).filter(key => key.startsWith(prefix)), olderLocalDraftKey(key))).toEqual([]);
  });
}

test("opening a set-aside needs one durable write and leaves autosave running", async ({ page }) => {
  const { path, key } = await screen(page, "detach_write", "new");
  await put(page, { [olderLocalDraftKey(key)]: record("Writing opened without a second durable write") });
  await page.goto(path); await ready(page);
  await expect(form(page)).toHaveAttribute("data-autosave", "ready");
  await page.evaluate(key => {
    let writes = 0;
    const set = Storage.prototype.setItem;
    Storage.prototype.setItem = function(name, value) {
      if (this === localStorage && name === key && ++writes > 1) throw new DOMException("Full", "QuotaExceededError");
      return set.call(this, name, value);
    };
  }, key);
  await offered(page).getByRole("button", { name: en.local_draft_open, exact: true }).click();
  await expect(body(page)).toHaveValue("Writing opened without a second durable write");
  await saved(page);
  expect(await read(page, olderLocalDraftKey(key))).toBeNull();
  const id = await page.locator('[name="fromDraft"]').inputValue();
  expect(await (await page.request.get(`/drafts/${id}`)).text()).toContain("Writing opened without a second durable write");
});

test("successful preservation survives autosave-first discard cleanup", async ({ page }) => {
  const { path, key } = await screen(page, "retained_source", "draft");
  const source = record("Source protected when storage becomes available");
  await put(page, { [key]: source });
  await fullArchive(page);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const requests: Promise<void>[] = [];
  const delayed = await routeModule(page, "app/components/draft-keeper-content.tsx", route => {
    const request = held.then(() => route.continue());
    requests.push(request);
    return request;
  });
  try {
    await page.goto(path, { waitUntil: "domcontentloaded" });
    await waitForFormReady(form(page));
    await delayed.assertHit();
    await expect(form(page)).toHaveAttribute("data-autosave", "ready");
    await expect(form(page)).not.toHaveAttribute("data-draft-recovery", "ready");
    release();
    await ready(page);
    await expect(form(page)).toHaveAttribute("data-draft-preserve", "blocked");
    await form(page).evaluate(element => {
      (window as unknown as { archiveFull: boolean }).archiveFull = false;
      element.dispatchEvent(new Event("tomola:form-discarded"));
    });
    const copies = await page.evaluate(prefix => Object.keys(localStorage).filter(key => key.startsWith(prefix)).map(key => JSON.parse(localStorage.getItem(key)!)), `${olderLocalDraftKey(key)}:`) as LocalDraft[];
    expect(copies).toContainEqual(source);
    expect(await read(page, key)).toBeNull();
  } finally {
    release();
    await Promise.all(requests);
    await delayed.dispose();
  }
});


test("a recovered archive quota leaves no preservation obligation after a missing link is detached", async ({ page }) => {
  const { key } = await screen(page, "unlink_recover", "new");
  await expect(form(page)).toHaveAttribute("data-autosave", "ready");
  await body(page).fill("Writing saved before detachment"); await saved(page);
  await page.route("**/drafts/autosave**", route => route.abort());
  await body(page).fill("Unsent source before detachment");
  await fullArchive(page);
  // Install the fault in this document as well as future visits.
  await page.evaluate(() => {
    const set = Storage.prototype.setItem;
    (window as unknown as { archiveFull: boolean }).archiveFull = true;
    Storage.prototype.setItem = function(key, value) {
      if (key.includes("~older:") && (window as unknown as { archiveFull: boolean }).archiveFull) throw new DOMException("Full", "QuotaExceededError");
      return set.call(this, key, value);
    };
  });
  await put(page, { [olderLocalDraftKey(key)]: record("Offered older writing") });
  await page.evaluate(() => window.dispatchEvent(new Event("tomola:draft-set-aside")));
  await offered(page).getByRole("button", { name: en.local_draft_open, exact: true }).click();
  await expect(form(page)).toHaveAttribute("data-draft-preserve", "blocked");
  const source = await read(page, key);
  expect(source?.body).toBe("Unsent source before detachment");
  await page.route("**/drafts/autosave", async route => {
    await page.evaluate(() => { (window as unknown as { archiveFull: boolean }).archiveFull = false; });
    await route.fulfill({ status: 404, json: { error: "not_found" } });
  }, { times: 1 });
  await body(page).fill("Live writing during unlink");
  await expect(page.locator('[name="fromDraft"]')).toHaveCount(0);
  await expect(form(page)).not.toHaveAttribute("data-draft-preserve");
  await body(page).fill("Continued writing after unlink");
  await expect.poll(async () => (await read(page, key))?.body).toBe("Continued writing after unlink");
  const archived = await page.evaluate(key => Object.keys(localStorage).filter(name => name.startsWith(`${key}~older:`)).map(name => JSON.parse(localStorage.getItem(name)!)), key);
  expect(archived).toEqual([source]);
  expect((await read(page, olderLocalDraftKey(key)))?.body).toBe("Offered older writing");
});

for (const action of ["send", "discard"] as const) {
  test(`reply-family cleanup continues through blocked preservation after ${action}`, async ({ page }) => {
    const setup = await screen(page, `family_${action}`, "topic");
    const path = setup.path.replace(/\/edit$/, "");
    const owner = await page.evaluate(() => sessionStorage.getItem("tomola:draft-owner"));
    const family = localDraftKey(owner!, `reply:${path.split("/").at(-1)}:`);
    const other = localDraftKey(owner!, "reply:999999:");
    await put(page, {
      [family]: record("Unsent reply on an earlier base"),
      [`${family}42`]: record("Another reply target"),
      [olderLocalDraftKey(family)]: record("Older reply in this family"),
      [other]: record("Writing in another thread"),
    });
    await fullArchive(page);
    await page.goto(path); await ready(page);
    await expect(form(page)).toHaveAttribute("data-draft-preserve", "blocked");
    await body(page).fill("Reply being sent or discarded");
    if (action === "send") {
      await page.getByRole("button", { name: en.submit_reply, exact: true }).click();
      await expect(page).toHaveURL(/posted=\d+#c-\d+/);
    } else await leave(page);
    expect(await page.evaluate(key => Object.keys(localStorage).filter(name => name.startsWith(key)), family)).toEqual([]);
    expect((await read(page, other))?.body).toBe("Writing in another thread");
    await page.goto(path); await ready(page);
    await expect(body(page)).toHaveValue("");
  });
}
