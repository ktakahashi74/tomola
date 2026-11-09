import { expect, type Page, type Route, type TestInfo } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { test } from "./editor-fixture";
import { baseOf, localDraftKey, olderLocalDraftKey, type LocalDraft } from "../app/lib/local-draft";
import { enMessages as en, messagePattern, openUserMenu, useMember, waitForFormReady } from "./helpers";
import { beforeHydration } from "./support/prehydration";

const body = (page: Page) => page.locator('textarea[name="body"]').first();
const form = (page: Page) => page.locator("form", { has: body(page) }).first();
const record = (body: string, savedAt = 1000): LocalDraft => ({ body, base: baseOf("", ""), savedAt });

async function ready(page: Page) {
  await waitForFormReady(form(page));
  await expect(form(page)).toHaveAttribute("data-draft-recovery", "ready");
}

async function owner(page: Page) {
  const value = await page.evaluate(() => sessionStorage.getItem("tomola:draft-owner"));
  if (!value) throw new Error("Missing writing owner");
  return value;
}

async function put(page: Page, records: Record<string, LocalDraft>) {
  await page.evaluate(records => {
    for (const [key, value] of Object.entries(records)) localStorage.setItem(key, JSON.stringify(value));
  }, records);
}

async function read(page: Page, key: string): Promise<LocalDraft | null> {
  return page.evaluate(key => JSON.parse(localStorage.getItem(key) ?? "null"), key);
}

async function evidence(page: Page, key: string, info: TestInfo) {
  const archived = await page.evaluate(prefix => Object.keys(localStorage).filter(name => name.startsWith(prefix)).map(name => JSON.parse(localStorage.getItem(name)!)), `${olderLocalDraftKey(key)}:`) as LocalDraft[];
  const snapshot = { archived, current: await read(page, key), older: await read(page, olderLocalDraftKey(key)), body: await body(page).inputValue() };
  await info.attach("draft-records", { body: JSON.stringify(snapshot, null, 2), contentType: "application/json" });
  return snapshot;
}

async function thread(page: Page, scenario: string) {
  await useMember(page, `older_keep_${scenario}@example.com`, "/t/new");
  await ready(page);
  const response = await page.request.post("/t/new", {
    form: { body: `Topic for ${scenario} draft preservation`, lang: "en" },
    headers: { Origin: new URL(page.url()).origin },
  });
  expect(response.ok()).toBe(true);
  const path = new URL(response.url()).pathname;
  expect(path).toMatch(/^\/t\/\d+$/);
  await page.goto(path);
  await ready(page);
  return { path, key: localDraftKey(await owner(page), `reply:${path.split("/").at(-1)}:`) };
}

test("a base mismatch preserves both the existing older writing and the newly displaced record", async ({ page }, info) => {
  const { key } = await thread(page, "base");
  const older = record("O: previous unsent writing");
  const pending = { ...record("P: unsent writing on an earlier base", 2000), base: baseOf("", "Earlier starting text") };
  await put(page, { [key]: pending, [olderLocalDraftKey(key)]: older });
  await page.reload();
  await ready(page);
  const snapshot = await evidence(page, key, info);
  expect.soft(snapshot.older).toEqual(older);
  expect.soft([snapshot.current?.body, snapshot.older?.body, snapshot.body, ...snapshot.archived.map(item => item.body)]).toContain(pending.body);
});

test("changing reply target preserves its existing older writing as well as both unsent replies", async ({ page }, info) => {
  const { path } = await thread(page, "target");
  const response = await page.request.post(path, {
    form: { body: "Published reply target", lang: "en" },
    headers: { Origin: new URL(page.url()).origin },
    maxRedirects: 0,
  });
  expect(response.status()).toBe(302);
  const target = new URL(response.headers().location, page.url()).hash.slice(3);
  expect(target).toMatch(/^\d+$/);
  await page.reload();
  await ready(page);
  const key = localDraftKey(await owner(page), `reply:${path.split("/").at(-1)}:${target}`);
  const older = record("O: previous writing for the target");
  const pending = record("P: unsent reply already at the target", 2000);
  await put(page, { [key]: pending, [olderLocalDraftKey(key)]: older });
  await body(page).fill("C: reply carried to the target");
  await page.locator(`#c-${target}`).getByRole("link", { name: en.reply_to_button, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`reply_to=c-${target}#reply$`));
  await expect.poll(async () => (await read(page, key))?.body).toBe("C: reply carried to the target");
  const snapshot = await evidence(page, key, info);
  expect.soft(snapshot.older).toEqual(older);
  expect.soft([snapshot.current?.body, snapshot.older?.body, snapshot.body, ...snapshot.archived.map(item => item.body)]).toContain(pending.body);
});

test("discarding the screen before recovery decides preserves the earlier older record", async ({ page }, info) => {
  await page.route("**/drafts/autosave**", route => route.abort());
  await useMember(page, "older_keep_forget@example.com", "/t/new");
  await ready(page);
  const key = localDraftKey(await owner(page), "topic-new:::");
  const older = record("O: previous writing not discarded");
  const pending = record("P: recovery not yet decided", 2000);
  await put(page, { [key]: pending, [olderLocalDraftKey(key)]: older });
  // A new document adopts both device records before the keeper decides.
  // Hold initial activation, then exercise the real discard event handler.
  try {
    await beforeHydration(page, "/t/new", async () => {
      await body(page).fill("C: native writing being discarded");
      const box = await body(page).boundingBox();
      await page.mouse.move(box!.x + 10, box!.y + 10);
      await page.mouse.down();
    }, async () => {
      await waitForFormReady(form(page));
      await expect(page.locator("[data-draft-keeper]")).toBeAttached();
      await expect(form(page)).not.toHaveAttribute("data-draft-recovery", "ready");
      await form(page).evaluate(element => element.dispatchEvent(new Event("tomola:form-discarded")));
      const snapshot = await evidence(page, key, info);
      expect.soft(snapshot.older?.body).toBe(older.body);
      expect.soft([snapshot.current?.body, snapshot.older?.body, ...snapshot.archived.map(item => item.body)]).toContain(pending.body);
    });
  } finally { await page.mouse.up(); }
});

test("opening the displayed older writing swaps it with the current unsent writing", async ({ page }, info) => {
  const { key } = await thread(page, "swap");
  const older = record("O: writing explicitly opened");
  await put(page, { [olderLocalDraftKey(key)]: older });
  await page.reload();
  await ready(page);
  await body(page).fill("C: last unsent keystrokes");
  await page.getByRole("button", { name: en.local_draft_open, exact: true }).click();
  await expect(body(page)).toHaveValue(older.body);
  const snapshot = await evidence(page, key, info);
  expect(snapshot.current?.body).toBe(older.body);
  expect(snapshot.archived.map(item => item.body)).toContain("C: last unsent keystrokes");
});

test("opening older writing after native edits also preserves the distinct pending record", async ({ page }, info) => {
  const { path, key } = await thread(page, "open_conflict");
  const older = record("O: writing explicitly opened");
  const pending = record("P: pending writing not yet restored", 2000);
  await put(page, { [key]: pending, [olderLocalDraftKey(key)]: older });
  await beforeHydration(page, path, async () => {
    await body(page).fill("C: native edits before recovery");
  });
  await ready(page);
  await expect(body(page)).toHaveValue("C: native edits before recovery");
  expect((await read(page, key))?.body).toBe(pending.body);
  await page.getByRole("button", { name: en.local_draft_open, exact: true }).click();
  await expect(body(page)).toHaveValue(older.body);
  const snapshot = await evidence(page, key, info);
  expect.soft(snapshot.archived.map(item => item.body)).toContain("C: native edits before recovery");
  expect.soft([snapshot.current?.body, snapshot.older?.body, snapshot.body, ...snapshot.archived.map(item => item.body)]).toContain(pending.body);
});

for (const action of ["open", "drop"] as const) {
  test(`${action} acts on the displayed older record when another tab changes storage`, async ({ page, context }, info) => {
    const { key } = await thread(page, action);
    const olderKey = olderLocalDraftKey(key);
    const shown = record("O: writing offered by this tab");
    const replacement = record("P: newer writing from another tab", 3_600_000);
    await put(page, { [olderKey]: shown });
    await page.reload();
    await ready(page);
    const notice = page.locator("[data-draft-keeper] > p").filter({ has: page.getByRole("button", { name: en.local_draft_open, exact: true }) });
    await expect(notice).toBeVisible();
    const shownText = await notice.innerText();
    const other = await context.newPage();
    try {
      await other.goto("/");
      await put(other, { [olderKey]: replacement });
      await page.bringToFront();
      await expect(notice).toHaveText(shownText);
      await notice.getByRole("button", { name: action === "open" ? en.local_draft_open : en.local_draft_discard, exact: true }).click();
      const snapshot = await evidence(page, key, info);
      if (action === "open") expect(snapshot.body).toBe(shown.body);
      else expect(snapshot.older).toEqual(replacement);
    } finally { await other.close(); }
  });
}

test("multiple set-asides are offered one at a time and actions preserve all other writing and metadata", async ({ page }, info) => {
  const { key } = await thread(page, "multiple");
  const first = record("First set-aside"), second = { ...record("Second set-aside", 2000), title: "Second title", fields: '[["lang","ja"]]', pending: true, server: { id: 123, version: 4, snapshot: "saved", attempted: "attempt" } };
  await put(page, { [olderLocalDraftKey(key)]: first, [`${olderLocalDraftKey(key)}:second`]: second });
  await page.reload(); await ready(page);
  const next = page.getByRole("button", { name: en.local_draft_next, exact: true });
  await expect(page.getByText(messagePattern(en.local_draft_count, { count: 2 }))).toBeVisible();
  await body(page).fill("Live keystrokes");
  await page.getByRole("button", { name: en.local_draft_open, exact: true }).click();
  await expect(body(page)).toHaveValue(second.body);
  expect(await read(page, key)).toMatchObject({ ...second, base: baseOf("", "") });
  const snapshot = await evidence(page, key, info);
  expect(snapshot.older).toEqual(first);
  expect(snapshot.archived.map(item => item.body)).toEqual(["Live keystrokes"]);
  const notice = page.locator("[data-draft-keeper] > p").filter({ has: page.getByRole("button", { name: en.local_draft_open, exact: true }) });
  await next.click();
  await notice.getByRole("button", { name: en.local_draft_discard, exact: true }).click();
  expect(await read(page, olderLocalDraftKey(key))).toBeNull();
  await expect(next).toHaveCount(0);
  expect((await evidence(page, key, info)).archived.map(item => item.body)).toEqual(["Live keystrokes"]);
});

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

test("legacy history-entry set-asides are offered alongside the old local slot and open durably", async ({ page }) => {
  await page.route("**/drafts/autosave**", route => route.abort());
  await useMember(page, "older_keep_legacy_tab@example.com", "/t/new"); await ready(page);
  const key = localDraftKey(await owner(page), "topic-new:::"), legacy = olderLocalDraftKey(key);
  await put(page, { [legacy]: record("Legacy local slot") });
  await page.evaluate(({ legacy, value }) => sessionStorage.setItem(`${legacy}:previous-editor`, JSON.stringify(value)), { legacy, value: record("Legacy history writing", 2000) });
  await page.reload(); await ready(page);
  await expect(page.getByText(messagePattern(en.local_draft_count, { count: 2 }))).toBeVisible();
  await page.getByRole("button", { name: en.local_draft_open, exact: true }).click();
  await expect(body(page)).toHaveValue("Legacy history writing");
  expect((await read(page, key))?.body).toBe("Legacy history writing");
  expect(await page.evaluate(name => sessionStorage.getItem(`${name}:previous-editor`), legacy)).toBeNull();
  expect((await read(page, legacy))?.body).toBe("Legacy local slot");
  await page.reload(); await ready(page);
  await expect(body(page)).toHaveValue("Legacy history writing");
});

test("quota failure while opening leaves both stored records and the live editor usable", async ({ page }, info) => {
  const { key } = await thread(page, "quota_open");
  const older = record("Offered writing"), pending = record("Distinct pending writing", 2000);
  await put(page, { [key]: pending, [olderLocalDraftKey(key)]: older });
  await fullArchive(page);
  await beforeHydration(page, new URL(page.url()).pathname, async () => { await body(page).fill("Live edits before recovery"); });
  await ready(page);
  await page.getByRole("button", { name: en.local_draft_open, exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(en.local_draft_failed);
  await expect(body(page)).toHaveValue("Live edits before recovery");
  expect(await read(page, key)).toEqual(pending);
  expect(await read(page, olderLocalDraftKey(key))).toEqual(older);
  await body(page).fill("Continued typing while storage is full");
  await page.waitForTimeout(1200);
  expect(await read(page, key)).toEqual(pending);
  await page.evaluate(() => { (window as unknown as { archiveFull: boolean }).archiveFull = false; });
  await page.getByRole("button", { name: en.local_draft_open, exact: true }).click();
  await expect(body(page)).toHaveValue(older.body);
  const snapshot = await evidence(page, key, info);
  expect(snapshot.archived.map(item => item.body)).toEqual(expect.arrayContaining([pending.body, "Continued typing while storage is full"]));
});

test("quota failure during recovery retains its source and retries on subsequent input", async ({ page }, info) => {
  const { key } = await thread(page, "quota_recovery");
  const older = record("Older writing"), pending = { ...record("Earlier base writing", 2000), base: "earlier-base" };
  await put(page, { [key]: pending, [olderLocalDraftKey(key)]: older });
  await fullArchive(page); await page.reload(); await ready(page);
  await expect(page.getByRole("alert")).toContainText(en.local_draft_failed);
  await body(page).fill("New writing while full");
  await page.waitForTimeout(1200);
  expect(await read(page, key)).toEqual(pending);
  expect(await read(page, olderLocalDraftKey(key))).toEqual(older);
  await page.evaluate(() => { (window as unknown as { archiveFull: boolean }).archiveFull = false; });
  await body(page).fill("New writing after space is freed");
  await expect.poll(async () => (await read(page, key))?.body).toBe("New writing after space is freed");
  expect((await evidence(page, key, info)).archived.map(item => item.body)).toContain(pending.body);
});

test("set-asides remain private to their member and logout clears them in every tab", async ({ page, context }) => {
  await useMember(page, "older_keep_identity@example.com", "/t/new"); await ready(page);
  const key = localDraftKey(await owner(page), "topic-new:::");
  await put(page, { [olderLocalDraftKey(key)]: record("Legacy private writing"), [`${olderLocalDraftKey(key)}:one`]: record("Independent private writing") });
  await page.reload(); await ready(page);
  await expect(page.getByRole("button", { name: en.local_draft_next, exact: true })).toBeVisible();
  const other = await context.newPage();
  try {
    await useMember(other, "older_keep_identity_other@example.com", "/t/new"); await ready(other);
    await expect(other.getByRole("button", { name: en.local_draft_open, exact: true })).toHaveCount(0);
    expect(await read(other, olderLocalDraftKey(key))).not.toBeNull();
    await (await openUserMenu(other)).getByRole("menuitem", { name: en.nav_logout }).click();
    await expect(other.locator("[data-member-menu-trigger]")).toHaveCount(0);
    await expect(page.getByRole("button", { name: en.local_draft_open, exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith("tomola:draft:")))).toEqual([]);
  } finally { await other.close(); }
});

for (const early of [false, true]) test(`autosave preserves existing and pending writing during ${early ? "early native input" : "a server-link mismatch"}`, async ({ page }, info) => {
  await useMember(page, `older_keep_autosave_${early ? "early" : "link"}@example.com`, "/t/new"); await ready(page);
  const response = await page.request.post("/drafts/autosave", { headers: { Origin: new URL(page.url()).origin }, form: { ownerId: await owner(page), newTopic: "1", title: "Server draft", body: "Saved server writing", lang: "en" } });
  expect(response.ok()).toBe(true);
  const saved = await response.json() as { id: number; version: number };
  const key = localDraftKey(await owner(page), `draft:${saved.id}`);
  const older = record("Existing set-aside"), pending = { ...record("Pending autosave writing", 2000), title: "Pending title", base: baseOf("Server draft", "Saved server writing"), fields: '[["lang","ja"]]', pending: true, server: { id: early ? saved.id : saved.id + 1000, version: saved.version } };
  await put(page, { [key]: pending, [olderLocalDraftKey(key)]: older });
  if (early) await beforeHydration(page, `/drafts/${saved.id}`, async () => { await body(page).fill("Early native autosave writing"); });
  else await page.goto(`/drafts/${saved.id}`);
  await ready(page);
  await expect(form(page)).toHaveAttribute("data-autosave", "ready");
  if (early) await expect(body(page)).toHaveValue("Early native autosave writing");
  await expect.poll(async () => (await evidence(page, key, info)).archived.map(item => item.body)).toContain(pending.body);
  const snapshot = await evidence(page, key, info);
  expect(snapshot.older).toEqual(older);
  expect(snapshot.archived.find(item => item.body === pending.body)).toEqual(pending);
  await body(page).fill("Continuing autosave after preservation");
  await expect(page.locator("[data-draft-autosave]")).toHaveAttribute("data-draft-autosave", "saved");
});

for (const navigation of ["reload", "back_forward"] as const) test(`document ${navigation} keeps newer server writing instead of restored native text`, async ({ page }, info) => {
  // An unload listener excludes the back/forward cache: this case must load a
  // new document and hydrate the newer server text, rather than resume a page.
  await page.addInitScript(() => window.addEventListener("unload", () => {}));
  await useMember(page, `older_keep_${navigation}@example.com`, "/t/new");
  await ready(page);
  const ownerId = await owner(page), title = "Server draft";
  const stale = "Writing saved before the other screen changed it";
  const latest = "Newer server writing from the other screen";
  const headers = { Origin: new URL(page.url()).origin };
  const created = await page.request.post("/drafts/autosave", { headers, form: { ownerId, newTopic: "1", title, body: stale, lang: "en" } });
  expect(created.ok()).toBe(true);
  const saved = await created.json() as { id: number; version: number };
  const path = `/drafts/${saved.id}`, key = localDraftKey(ownerId, `draft:${saved.id}`);
  await page.goto(path);
  await ready(page);
  await expect(form(page)).toHaveAttribute("data-autosave", "ready");
  await expect(body(page)).toHaveValue(stale);
  const previous = { ...record(stale), title, base: baseOf(title, stale), pending: false, server: saved };
  await put(page, { [key]: previous });
  const changed = await page.request.post("/drafts/autosave", { headers, form: { ownerId, draftId: String(saved.id), version: String(saved.version), title, body: latest, lang: "en" } });
  expect(changed.ok()).toBe(true);
  const newer = await changed.json() as { id: number; version: number };
  expect(newer.version).toBeGreaterThan(saved.version);
  if (navigation === "back_forward") await page.goto("/drafts");

  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const block = async (route: Route) => {
    if (route.request().resourceType() === "script") { await gate; await route.continue(); }
    else await route.fallback();
  };
  await page.route("**/*", block);
  const writes: string[] = [];
  page.on("request", request => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/drafts/autosave") writes.push(request.postData() ?? "");
  });
  try {
    if (navigation === "reload") await page.reload({ waitUntil: "commit" });
    else await page.goBack({ waitUntil: "commit" });
    await page.waitForFunction(() => document.readyState !== "loading");
    await expect(body(page)).toHaveJSProperty("defaultValue", latest);
    await expect(form(page)).not.toHaveAttribute("data-ready", "true");
    const observed = await body(page).evaluate((element, stale) => {
      const field = element as HTMLTextAreaElement;
      const observation = { navigation: (performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming)?.type, nativeValue: field.value, defaultValue: field.defaultValue, injected: field.value !== stale };
      // Chromium need not restore values on reload. Reproduce that browser
      // behavior before hydration without dispatching a member input event.
      field.value = stale;
      return observation;
    }, stale);
    const observationFile = info.outputPath("document-restoration.json");
    await writeFile(observationFile, JSON.stringify(observed));
    await info.attach("document-restoration", { path: observationFile, contentType: "application/json" });
    expect(observed.navigation).toBe(navigation);
    release();
    await ready(page);
    await expect(form(page)).toHaveAttribute("data-autosave", "ready");
    await expect(body(page)).toHaveValue(latest);
    await expect.poll(async () => (await evidence(page, key, info)).archived.map(item => item.body)).toContain(stale);
    // Cover the debounce window: an old value must not silently save later.
    await page.waitForTimeout(3000);
    expect(writes).toEqual([]);
    const server = await page.request.get(`/drafts/autosave?draftId=${saved.id}`);
    expect(await server.json()).toEqual({ id: saved.id, version: newer.version });
    expect(await (await page.request.get(path)).text()).toContain(latest);
  } finally {
    release();
    await page.unroute("**/*", block);
  }
});
