import { autosavePage, autosaveQuiet, autosaveState } from "./autosave-clock";
import { routeModule } from "./support/module-route";
import { expect, type Page } from "@playwright/test";
import { test } from "./editor-fixture";
import { captureScreenshot, chooseEditorMode, clientHeaders, enMessages as en, formatMessage, messagePattern, openPostSettings, state, useMember as restoreAutosaveMember, waitForClientRoute, waitForFormReady } from "./helpers";
import { baseOf } from "../app/lib/local-draft";
import { LANG_LABELS } from "../app/lib/languages";
import { acceptSignedWrite, enableSigningAuthenticator } from "./signing-helper";
import { beforeHydration } from "./support/prehydration";

// Clock mocks remove Navigation Timing; explicit fresh visits need the native entries.
test.beforeEach(async ({ page }, info) => {
  if (!info.tags.includes("@native-navigation")) await page.clock.install();
});

const body = (page: Page) => page.locator('textarea[name="body"]').first();
const status = (page: Page) => page.locator('[data-draft-autosave]');
const draftId = async (page: Page) => Number(await page.locator('input[name="fromDraft"]').inputValue());
const ownDraftIds = async (page: Page) => [...(await (await page.request.get("/drafts")).text()).matchAll(/href="\/drafts\/(\d+)"/g)].map(match => Number(match[1]));
const navigate = (page: Page, path: string) => page.evaluate(path => {
  void (window as unknown as { __reactRouterDataRouter: { navigate(path: string): Promise<void> } }).__reactRouterDataRouter.navigate(path);
}, path);
async function open(page: Page, scenario: string) {
  await restoreAutosaveMember(page, `draft_autosave_${scenario}@example.com`, "/t/new");
  await waitForFormReady(page.locator("form", { has: body(page) }).first());
  await expect(page.locator('form[data-autosave="ready"]')).toHaveCount(1);
}
async function saved(page: Page) {
  if (test.info().tags.includes("@native-navigation")) await expect(status(page)).toHaveAttribute("data-draft-autosave", "saved");
  else await autosaveState(page, "saved");
}
async function evidence(page: Page, name: string) {
  if (!process.env.E2E_EVIDENCE_DIR) return;
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await captureScreenshot(page, { path: `${name}-${width}.png`, fullPage: true }, "after");
  }
}

test("writing creates one draft, resumes across reload and back, preserves the saved copy when cleared and removes it when posted", async ({ page }) => {
  await open(page, "basic");
  await expect(page.locator("form[data-draft-recovery=ready]")).toHaveCount(1);
  await autosaveQuiet(page);
  expect(await ownDraftIds(page)).toEqual([]);
  await page.locator('input[name="title"]').fill("A thought in progress");
  await saved(page);
  const id = await draftId(page);
  await expect(page.getByRole("button", { name: en.save_draft, exact: true })).toHaveCount(0);
  await body(page).fill("A longer thought after the first save.");
  await saved(page);
  expect(await ownDraftIds(page)).toEqual([id]);
  await navigate(page, "#draft-note");
  await expect(page).toHaveURL(/#draft-note$/);
  await expect(body(page)).toHaveValue("A longer thought after the first save.");
  expect(await draftId(page)).toBe(id);
  await page.reload();
  await expect(body(page)).toHaveValue("A longer thought after the first save.");
  await saved(page);
  expect(await draftId(page)).toBe(id);
  await expect(page.locator('main > p.ui-meta a[href="/drafts"]')).toHaveCount(0);
  const dialogs: string[] = [];
  page.on("dialog", async dialog => { dialogs.push(dialog.message()); await dialog.dismiss(); });
  await navigate(page, "/drafts");
  await expect(page).toHaveURL(/\/drafts$/);
  await page.goBack();
  await expect(body(page)).toHaveValue("A longer thought after the first save.");
  await saved(page);
  await body(page).fill("Continued after returning.");
  await saved(page);
  expect(await ownDraftIds(page)).toEqual([id]);
  expect(dialogs).toEqual([]);
  await page.locator('input[name="title"]').fill("");
  await body(page).fill("");
  await expect(page.locator("form[data-draft-recovery=ready]")).toHaveCount(1);
  await autosaveQuiet(page);
  expect(await (await page.request.get(`/drafts/${id}`)).text()).toContain("Continued after returning.");
  await body(page).fill("Ready to post.");
  await saved(page);
  await page.getByRole("button", { name: en.submit_post, exact: true }).click();
  await expect(page).toHaveURL(/\/t\/\d+\?posted=/);
  expect(await ownDraftIds(page)).toEqual([]);
});

test("a real conflict makes one copy and subsequent edits keep using the copy", async ({ page, context }) => {
  await open(page, "conflict");
  await body(page).fill("The first version.");
  await saved(page);
  const original = await draftId(page);
  const other = await autosavePage(context);
  await other.goto(`/drafts/${original}`);
  await waitForFormReady(other.locator("form", { has: body(other) }).first());
  await body(other).fill("The other screen saved this.");
  await saved(other);
  await body(page).fill("This screen keeps its own text.");
  await saved(page);
  const copy = await draftId(page);
  expect(copy).not.toBe(original);
  await expect(status(page)).toContainText(en.draft_autosave_copied);
  expect(await (await page.request.get(`/drafts/${original}`)).text()).toContain("The other screen saved this.");
  await body(page).fill("The copied draft continues.");
  await saved(page);
  expect(await draftId(page)).toBe(copy);
  expect((await ownDraftIds(page)).sort()).toEqual([original, copy].sort());
});

test("failed responses retain writing, recover online, and adopt a lost update without creating a conflict copy", async ({ page }) => {
  await open(page, "offline");
  await body(page).fill("A saved starting point.");
  await saved(page);
  const id = await draftId(page);
  await page.route("**/drafts/autosave", route => route.abort());
  await body(page).fill("Keep this while offline.");
  await autosaveState(page, "failed");
  await expect(body(page)).toHaveValue("Keep this while offline.");
  await page.unroute("**/drafts/autosave");
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await saved(page);
  const beforeLost = Number(await page.locator('input[name="fromDraftVersion"]').inputValue());
  let lose = true;
  await page.route("**/drafts/autosave", async route => {
    if (!lose) return route.continue();
    lose = false;
    await route.fetch();
    await route.abort();
  });
  await body(page).fill("Stored, but the response was lost.");
  await autosaveState(page, "failed");
  await page.route("**/drafts/autosave", route => new URLSearchParams(route.request().postData() ?? "").get("version") === String(beforeLost + 1)
    ? route.fulfill({ status: 429, contentType: "application/json", body: JSON.stringify({ error: "rate_limited" }) })
    : route.continue());
  await body(page).fill("A newer local change after the lost response.");
  await autosaveState(page, "failed");
  await page.unroute("**/drafts/autosave");
  await body(page).fill("Keep this while offline.");
  await saved(page);
  expect(await (await page.request.get(`/drafts/${id}`)).text()).toContain("Keep this while offline.");
  expect(await draftId(page)).toBe(id);
  expect(await ownDraftIds(page)).toEqual([id]);
  await expect(status(page)).not.toContainText(en.draft_autosave_copied);
});

test("an unsaved departure tries a save and asks when the response cannot arrive in time", async ({ page }) => {
  await open(page, "leaving");
  await page.route("**/drafts/autosave", route => route.abort());
  await body(page).fill("Unsaved writing on departure.");
  const dialog = page.waitForEvent("dialog");
  const clicking = navigate(page, "/drafts");
  const shown = await dialog;
  expect(shown.message()).toBe(en.leave_unsaved_confirm);
  await shown.dismiss();
  await clicking;
  await expect(page).toHaveURL(/\/t\/new$/);
  await expect(body(page)).toHaveValue("Unsaved writing on departure.");
});

test("separate fresh tabs own separate drafts and missing links recover as new drafts", async ({ page, context }) => {
  await open(page, "tabs");
  await body(page).fill("The first tab."); await saved(page);
  const first = await draftId(page);
  const second = await autosavePage(context);
  await second.goto("/t/new");
  await waitForFormReady(second.locator("form", { has: body(second) }).first());
  await expect(second.locator('form[data-autosave="ready"]')).toHaveCount(1);
  await expect(body(second)).toHaveValue("");
  await body(second).fill("The second tab."); await saved(second);
  const secondId = await draftId(second);
  expect(secondId).not.toBe(first);
  await page.reload(); await saved(page); expect(await draftId(page)).toBe(first);
  await second.reload(); await saved(second); expect(await draftId(second)).toBe(secondId);
  await page.request.post(`/drafts/${first}`, { form: { intent: "delete" }, headers: { Origin: state().baseURL } });
  await body(page).fill("An update after deletion.");
  await saved(page);
  const replacement = await draftId(page); expect(replacement).not.toBe(first);
  expect((await ownDraftIds(page)).sort()).toEqual([secondId, replacement].sort());
  await page.goto("/drafts");
  await page.goBack();
  await saved(page); expect(await draftId(page)).toBe(replacement);
  await page.request.post(`/drafts/${replacement}`, { form: { intent: "delete" }, headers: { Origin: state().baseURL } });
  await page.reload(); await saved(page);
  expect(await draftId(page)).not.toBe(replacement);
  await expect(body(page)).toHaveValue("An update after deletion.");
  expect((await ownDraftIds(page)).sort()).toEqual([secondId, await draftId(page)].sort());
});

for (const early of [false, true]) test(`a recovered draft stays untouched when its writing is ${early ? "superseded before hydration" : "discarded"}`, async ({ page, context }) => {
  await open(page, early ? "early" : "discard");
  if (!early) {
    await openPostSettings(page);
    await page.getByRole("combobox", { name: en.field_lang, exact: true }).click();
    await page.getByRole("option", { name: LANG_LABELS.ja, exact: true }).click();
    await expect(page.locator('input[name="lang"]')).toHaveValue("ja");
  }
  await body(page).fill("The original saved writing"); await saved(page);
  const original = await draftId(page);
  await context.route("**/drafts/autosave**", route => route.abort());
  await body(page).fill("The undelivered recovered writing");
  await autosaveState(page, "failed");
  expect(await (await page.request.get(`/drafts/${original}`)).text()).toContain("The original saved writing");
  // A closing renderer can bypass route interception for keepalive requests.
  // Pause its retry so the simulated outage also covers departure.
  await page.evaluate(() => window.dispatchEvent(new Event("tomola:discard-unsaved")));
  await page.close();
  expect(await (await context.request.get(`/drafts/${original}`)).text()).toContain("The original saved writing");
  const fresh = await autosavePage(context);
  if (early) {
    await context.unroute("**/drafts/autosave**");
    await beforeHydration(fresh, "/t/new", async () => { await body(fresh).fill("New writing entered before scripts"); });
    await expect(fresh.getByText(messagePattern(en.local_draft_older, { time: /.+/ }))).toBeVisible();
  } else {
    await fresh.goto("/t/new"); await waitForFormReady(fresh.locator("form", { has: body(fresh) }));
    await expect(body(fresh)).toHaveValue("The undelivered recovered writing");
    expect(await draftId(fresh)).toBe(original);
    await expect(fresh.locator('input[name="lang"]')).toHaveValue("ja");
    await fresh.getByRole("button", { name: en.local_draft_discard, exact: true }).click();
    await expect(body(fresh)).toHaveValue("");
    await expect(fresh.locator('input[name="lang"]')).toHaveValue("");
    await expect(fresh.locator('input[name="fromDraft"], input[name="fromDraftVersion"]')).toHaveCount(0);
    expect(await fresh.evaluate(() => {
      const suffix = `:${history.state.draftEditorId}`;
      return Object.keys(sessionStorage).filter(k => k.includes(":topic-new:") && k.endsWith(suffix)).some(k => JSON.parse(sessionStorage.getItem(k)!).server);
    })).toBe(false);
    await context.unroute("**/drafts/autosave**");
    await body(fresh).fill("New writing after discarding recovery");
  }
  await saved(fresh); expect(await draftId(fresh)).not.toBe(original);
  expect(await (await fresh.request.get(`/drafts/${original}`)).text()).toContain("The original saved writing");
  if (early) expect(await fresh.evaluate(() => {
    return Object.keys(localStorage).filter(k => k.includes(":topic-new:") && k.includes("~older:"))
      .map(k => JSON.parse(localStorage.getItem(k)!)).find(record => record.body === "The undelivered recovered writing");
  })).toMatchObject({ body: "The undelivered recovered writing", server: { id: original } });
  await fresh.getByRole("button", { name: en.submit_post, exact: true }).click();
  await expect(fresh).toHaveURL(/\/t\/\d+\?posted=/);
  expect(await ownDraftIds(fresh)).toEqual([original]);
  expect(await (await fresh.request.get(`/drafts/${original}`)).text()).toContain("The original saved writing");
  if (early) {
    await fresh.goto("/t/new"); await waitForFormReady(fresh.locator("form", { has: body(fresh) }));
    await fresh.getByRole("button", { name: en.local_draft_open, exact: true }).click();
    await expect(body(fresh)).toHaveValue("The undelivered recovered writing");
    await saved(fresh); expect(await draftId(fresh)).toBe(original);
  }
});

for (const departure of ["pagehide", "visibility"] as const) test(`a draft keeps unsent device writing when ${departure} happens before recovery loads`, async ({ page }) => {
  await open(page, departure === "pagehide" ? "gate_page" : "gate_tab");
  await body(page).fill("The server's saved body"); await saved(page);
  const id = await draftId(page);
  const version = Number(await page.locator('input[name="fromDraftVersion"]').inputValue());
  const key = await page.evaluate(({ id, version, base }) => {
    const key = `tomola:draft:${sessionStorage.getItem("tomola:draft-owner")}:draft:${id}`;
    localStorage.setItem(key, JSON.stringify({ title: "", body: "Unsent writing on this device", base, savedAt: Date.now(), server: { id, version } }));
    return key;
  }, { id, version, base: baseOf("", "The server's saved body") });
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let requested = false;
  const requests: Promise<void>[] = [];
  const holdKeeper = (route: import("@playwright/test").Route) => {
    requested = true;
    const resumed = held.then(() => route.continue());
    requests.push(resumed);
    return resumed;
  };
  const moduleRoute = await routeModule(page, "app/components/draft-keeper-content.tsx", holdKeeper);
  try {
    await page.goto(`/drafts/${id}`, { waitUntil: "domcontentloaded" });
    await waitForFormReady(page.locator("form", { has: body(page) }));
    await expect(page.locator('form[data-autosave="ready"]')).toHaveCount(1);
    await expect.poll(() => requested).toBe(true);
    await moduleRoute.assertHit();
    await expect(body(page)).toHaveValue("The server's saved body");
    await page.evaluate(departure => {
      if (departure === "pagehide") window.dispatchEvent(new PageTransitionEvent("pagehide"));
      else {
        Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
        document.dispatchEvent(new Event("visibilitychange"));
        Reflect.deleteProperty(document, "visibilityState");
      }
    }, departure);
    expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)!).body, key)).toBe("Unsent writing on this device");
    release();
    await expect(body(page)).toHaveValue("Unsent writing on this device");
    await saved(page);
    expect(await (await page.request.get(`/drafts/${id}`)).text()).toContain("Unsent writing on this device");
    await page.reload();
    await expect(body(page)).toHaveValue("Unsent writing on this device");
  } finally {
    release(); await Promise.all(requests);
    await moduleRoute.dispose();
  }
});

for (const unavailable of [true, false]) test(`a draft keeps device copies when recovery is ${unavailable ? "unavailable" : "still pending"}`, async ({ page }) => {
  await open(page, unavailable ? "gate_abort" : "gate_edit");
  await body(page).fill("Saved before recovery failure"); await saved(page);
  const id = await draftId(page);
  const version = Number(await page.locator('input[name="fromDraftVersion"]').inputValue());
  const key = await page.evaluate(({ id, version, base }) => {
    const key = `tomola:draft:${sessionStorage.getItem("tomola:draft-owner")}:draft:${id}`;
    localStorage.setItem(key, JSON.stringify({ title: "", body: "Earlier unsent device writing", base, savedAt: Date.now(), server: { id, version } }));
    return key;
  }, { id, version, base: baseOf("", "Saved before recovery failure") });
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let requested = false;
  const requests: Promise<void>[] = [];
  const interceptKeeper = (route: import("@playwright/test").Route) => {
    requested = true;
    const request = unavailable ? route.abort() : held.then(() => route.continue());
    requests.push(request);
    return request;
  };
  const moduleRoute = await routeModule(page, "app/components/draft-keeper-content.tsx", interceptKeeper);
  await page.route("**/drafts/autosave**", route => route.abort());
  try {
    await page.goto(`/drafts/${id}`, { waitUntil: "domcontentloaded" });
    const form = page.locator("form", { has: body(page) });
    await waitForFormReady(form);
    await expect(form).toHaveAttribute("data-autosave", "ready");
    await expect.poll(() => requested).toBe(true);
    await moduleRoute.assertHit();
    await waitForClientRoute(page);
    for (const text of ["Writing during recovery failure", "More writing during recovery failure"]) {
      await body(page).fill(text);
      await page.evaluate(() => {
        Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
        document.dispatchEvent(new Event("visibilitychange"));
        Reflect.deleteProperty(document, "visibilityState");
      });
      await expect.poll(() => page.evaluate(key => JSON.parse(localStorage.getItem(key)!).body, key)).toBe(text);
      expect(await page.evaluate(key => Object.keys(localStorage).filter(k => k.startsWith(`${key}~older:`))
        .map(k => JSON.parse(localStorage.getItem(k)!)).find(record => record.body === "Earlier unsent device writing")?.body, key)).toBe("Earlier unsent device writing");
    }
    release();
    await expect(form).toHaveAttribute("data-draft-recovery", "ready");
    await expect(body(page)).toHaveValue("More writing during recovery failure");
  } finally {
    release(); await Promise.all(requests);
    await moduleRoute.dispose();
    await page.unroute("**/drafts/autosave**");
  }
});

test("an acknowledged draft reopens without a false older-writing notice, even after a fast flush", async ({ page }) => {
  await open(page, "saved_base"); await body(page).fill("First saved body"); await saved(page);
  const id = await draftId(page);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let requested = false;
  // The device keeper loads lazily. A fast server save can acknowledge new text
  // before that module initializes against the page's original loader data.
  const holdKeeper = async (route: import("@playwright/test").Route) => {
    requested = true;
    await held;
    await route.continue();
  };
  const moduleRoute = await routeModule(page, "app/components/draft-keeper-content.tsx", holdKeeper);
  try {
    await page.goto(`/drafts/${id}`, { waitUntil: "domcontentloaded" });
    await waitForFormReady(page.locator("form", { has: body(page) }));
    await expect(page.locator('form[data-autosave="ready"]')).toHaveCount(1);
    await expect.poll(() => requested).toBe(true);
    await moduleRoute.assertHit();
    await body(page).fill("The current acknowledged body");
    await page.evaluate(async () => {
      const detail: { leaving: boolean; pending?: Promise<unknown> } = { leaving: false };
      document.querySelector('form[data-autosave="ready"]')!.dispatchEvent(new CustomEvent("tomola:autosave-flush", { detail }));
      if (!detail.pending) throw new Error("Autosave flush did not start");
      await detail.pending;
    });
    await saved(page);
    expect(await page.evaluate(id => JSON.parse(localStorage.getItem(Object.keys(localStorage).find(k => k.endsWith(`:draft:${id}`))!)!).base, id)).toBe(baseOf("", "The current acknowledged body"));
    release();
    await expect(page.locator("[data-draft-keeper]")).toBeAttached();
    await waitForClientRoute(page);
    expect(await page.evaluate(id => JSON.parse(localStorage.getItem(Object.keys(localStorage).find(k => k.endsWith(`:draft:${id}`))!)!).base, id)).toBe(baseOf("", "The current acknowledged body"));
  } finally {
    release();
    await moduleRoute.dispose();
  }
  await page.reload(); await waitForFormReady(page.locator("form", { has: body(page) }));
  await expect(page.locator("[data-draft-keeper]")).toBeAttached();
  await expect(body(page)).toHaveValue("The current acknowledged body");
  await expect(page.getByText(messagePattern(en.local_draft_older, { time: /.+/ }))).toHaveCount(0);
});

test("shared initial writing creates no draft until the member changes it", async ({ page }) => {
  await open(page, "prefill");
  await page.goto(`/t/new?${new URLSearchParams({ text: "Read this https://example.org/initial" })}`);
  await waitForFormReady(page.locator("form", { has: body(page) }));
  await expect(page.locator('form[data-autosave="ready"]')).toHaveCount(1);
  const initial = await body(page).inputValue(); expect(initial).not.toBe("");
  await expect(page.locator("[data-draft-keeper]")).toBeAttached();
  await autosaveQuiet(page, 3500); expect(await ownDraftIds(page)).toEqual([]);
  const dialogs: string[] = []; page.on("dialog", async d => { dialogs.push(d.message()); await d.dismiss(); });
  await navigate(page, "/drafts"); await expect(page).toHaveURL(/\/drafts$/);
  expect(dialogs).toEqual([]); expect(await ownDraftIds(page)).toEqual([]);
  await page.goBack(); await expect(body(page)).toHaveValue(initial);
  await body(page).fill(`${initial}My own note.`); await saved(page);
  expect(await ownDraftIds(page)).toEqual([await draftId(page)]);
});

test("a fresh new-post visit leaves its acknowledged draft in the list and publishes a separate post", { tag: "@native-navigation" }, async ({ page }) => {
  await open(page, "fresh");
  await body(page).fill("An acknowledged draft stays private"); await saved(page);
  const id = await draftId(page);
  await expect.poll(() => page.evaluate(() => Object.keys(localStorage).filter(k => k.includes(":topic-new:")).length)).toBe(0);
  await page.waitForTimeout(1200); // A delayed device keeper must not put the acknowledged copy back.
  expect(await page.evaluate(() => Object.keys(localStorage).filter(k => k.includes(":topic-new:")).length)).toBe(0);
  await page.goto("/t/new"); await waitForFormReady(page.locator("form", { has: body(page) }));
  await expect(page.locator('form[data-autosave="ready"]')).toHaveCount(1);
  await expect(body(page)).toHaveValue("");
  await expect(page.locator('input[name="fromDraft"]')).toHaveCount(0);
  await page.waitForTimeout(3000); expect(await ownDraftIds(page)).toEqual([id]);
  await body(page).fill("A separate post from a fresh screen");
  await page.getByRole("button", { name: en.submit_post, exact: true }).click();
  await expect(page).toHaveURL(/\/t\/\d+\?posted=/);
  expect(await ownDraftIds(page)).toEqual([id]);
  expect(await (await page.request.get(`/drafts/${id}`)).text()).toContain("An acknowledged draft stays private");
});

test("an undelivered update survives a closed tab and reaches the same linked draft on a fresh visit", { tag: "@native-navigation" }, async ({ page, context }) => {
  await open(page, "linked_reopen");
  await body(page).fill("Saved before losing the connection"); await saved(page);
  const id = await draftId(page);
  await context.route("**/drafts/autosave**", route => route.abort());
  await body(page).fill("The update still on this device");
  await expect(status(page)).toHaveAttribute("data-draft-autosave", "failed");
  await page.close();
  const fresh = await context.newPage(); await fresh.goto("/t/new");
  await waitForFormReady(fresh.locator("form", { has: body(fresh) }));
  await expect(body(fresh)).toHaveValue("The update still on this device");
  expect(await draftId(fresh)).toBe(id);
  await context.unroute("**/drafts/autosave**");
  await fresh.evaluate(() => window.dispatchEvent(new Event("online"))); await saved(fresh);
  expect(await draftId(fresh)).toBe(id); expect(await ownDraftIds(fresh)).toEqual([id]);
  expect(await (await fresh.request.get(`/drafts/${id}`)).text()).toContain("The update still on this device");
  await fresh.goto("/t/new"); await waitForFormReady(fresh.locator("form", { has: body(fresh) }));
  await expect(body(fresh)).toHaveValue("");
});

test("a conflict copy moves its device link and reopening the original cannot overwrite the copy", async ({ page, browser, context }) => {
  await open(page, "pointer"); await body(page).fill("Original draft"); await saved(page);
  const id = await draftId(page), path = `/drafts/${id}`;
  await page.goto(path); await waitForFormReady(page.locator("form", { has: body(page) }));
  await body(page).fill("First device version"); await saved(page);
  const cloud = await browser.newContext({ storageState: await context.storageState() });
  try {
    const other = await autosavePage(cloud); await other.goto(path); await waitForFormReady(other.locator("form", { has: body(other) }));
    await body(other).fill("Other device version"); await saved(other);
    await body(page).fill("Local conflict copy survives"); await saved(page);
    await expect(page).not.toHaveURL(new URL(path, state().baseURL).href);
    const copy = Number(new URL(page.url()).pathname.split("/").at(-1));
    await expect(status(page).locator('[aria-live="polite"]').filter({ hasText: en.draft_autosave_copied })).toBeVisible();
    const keys = await page.evaluate(({ id, copy }) => {
      const copyKey = Object.keys(localStorage).find(k => k.endsWith(`:draft:${copy}`))!;
      const oldKey = copyKey.replace(`:draft:${copy}`, `:draft:${id}`);
      const record = JSON.parse(localStorage.getItem(copyKey)!);
      const old = JSON.parse(localStorage.getItem(oldKey) ?? "null");
      localStorage.setItem(oldKey, JSON.stringify(record)); // A record left by an older client must be ignored too.
      return { copiedId: record.server.id, oldId: old?.server?.id };
    }, { id, copy });
    expect(keys.copiedId).toBe(copy); expect(keys.oldId).not.toBe(copy);
    await page.goto(path); await waitForFormReady(page.locator("form", { has: body(page) }));
    await expect(body(page)).toHaveValue("Other device version");
    await expect(page.locator("form[data-draft-recovery=ready]")).toHaveCount(1);
    await autosaveQuiet(page);
    expect(await (await page.request.get(`/drafts/${copy}`)).text()).toContain("Local conflict copy survives");
    expect(new URL(page.url()).pathname).toBe(path);
  } finally { await cloud.close(); }
});

test("stale device versions do not write on opening, fork another editor, or reject immediate publication", async ({ page, browser, context }) => {
  await open(page, "version"); await body(page).fill("Initial draft"); await saved(page);
  const id = await draftId(page), path = `/drafts/${id}`;
  await page.goto(path); await waitForFormReady(page.locator("form", { has: body(page) }));
  await body(page).fill("Saved on this device"); await saved(page);
  const cloud = await browser.newContext({ storageState: await context.storageState() });
  try {
    const other = await autosavePage(cloud); await other.goto(path); await waitForFormReady(other.locator("form", { has: body(other) }));
    await body(other).fill("Current cloud version"); await saved(other);
    let writes = 0;
    page.on("request", request => { if (request.method() === "POST" && new URL(request.url()).pathname === "/drafts/autosave") writes++; });
    await page.reload(); await waitForFormReady(page.locator("form", { has: body(page) }));
    await expect(page.locator('input[name="version"]')).toHaveValue("3");
    await expect(page.locator("form[data-draft-recovery=ready]")).toHaveCount(1);
    await autosaveQuiet(page); expect(writes).toBe(0);
    expect(await (await page.request.get(`/drafts/autosave?draftId=${id}`)).json()).toEqual({ id, version: 3 });
    const dialogs: string[] = [];
    page.on("dialog", async dialog => { dialogs.push(dialog.message()); await dialog.dismiss(); });
    await body(page).fill("A temporary unsaved change");
    await body(page).fill("Current cloud version");
    await navigate(page, "/drafts"); await expect(page).toHaveURL(/\/drafts$/);
    expect(dialogs).toEqual([]);
    await body(other).fill("Continued on the other device"); await saved(other);
    await expect(status(other)).not.toContainText(en.draft_autosave_copied);
    expect(new URL(other.url()).pathname).toBe(path);
    await page.goto(path); await waitForFormReady(page.locator("form", { has: body(page) }));
    await expect(page.locator('input[name="version"]')).toHaveValue("4");
    await page.getByRole("button", { name: en.draft_publish, exact: true }).click();
    await expect(page).toHaveURL(/\/t\/\d+\?posted=/);
  } finally { await cloud.close(); }
});

test("a closed offline tab and legacy fixed records restore writing on a fresh visit", async ({ page, context }) => {
  await context.route("**/drafts/autosave**", route => route.abort());
  await open(page, "reopen"); await body(page).fill("Writing kept while offline");
  await autosaveState(page, "failed");
  const key = await page.evaluate(() => Object.keys(localStorage).find(k => k.includes(":topic-new:") && !k.endsWith("~older") && !k.includes("~older:"))!);
  expect(key).toMatch(/topic-new:::$/);
  await page.close();
  const fresh = await autosavePage(context); await fresh.goto("/t/new");
  await waitForFormReady(fresh.locator("form", { has: body(fresh) }));
  await expect(body(fresh)).toHaveValue("Writing kept while offline");
  await expect(fresh.locator('form[data-autosave="ready"]')).toHaveCount(1);
  await fresh.evaluate(({ key, base }) => {
    document.querySelector('form[data-autosave="ready"]')!.dispatchEvent(new Event("tomola:form-discarded"));
    localStorage.setItem(key, JSON.stringify({ title: "", body: "Writing from an older release", base, savedAt: Date.now() }));
  }, { key, base: baseOf("", "") });
  await fresh.close();
  const legacy = await autosavePage(context); await legacy.goto("/t/new");
  await waitForFormReady(legacy.locator("form", { has: body(legacy) }));
  await expect(body(legacy)).toHaveValue("Writing from an older release");
  expect(await legacy.evaluate(() => Object.keys(localStorage).filter(k => k.includes(":topic-new:") && !k.endsWith("~older") && !k.includes("~older:")).length)).toBe(1);
});

test("the rich editor saves its serialized writing on both screens and posts the saved draft", async ({ page }) => {
  await open(page, "rich");
  await chooseEditorMode(page, en.editor_mode_rich);
  const rich = page.locator('[contenteditable="true"][role="textbox"]');
  await rich.fill("A thought written in the visual editor.");
  await saved(page);
  const id = await draftId(page);
  await page.goto(`/drafts/${id}`);
  await waitForFormReady(page.locator("form", { has: body(page) }).first());
  await rich.fill("Continued in the visual editor.");
  await saved(page);
  await page.getByRole("button", { name: en.draft_publish, exact: true }).click();
  await expect(page).toHaveURL(/\/t\/\d+\?posted=/);
  await expect(page.locator(".longread").first()).toContainText("Continued in the visual editor.");
  expect(await ownDraftIds(page)).toEqual([]);
});

test("a refused publication retains the linked draft and subsequent publication removes it", async ({ page }) => {
  await open(page, "failure");
  await page.getByRole("checkbox", { name: en.asks_stance_checkbox, exact: true }).check();
  await body(page).fill("A question without its title is still a draft.");
  await saved(page);
  const id = await draftId(page);
  await page.locator('form[data-autosave="ready"]').evaluate(form => { (form as HTMLFormElement).noValidate = true; });
  await page.getByRole("button", { name: en.submit_post, exact: true }).click();
  await expect(page.locator("#topic-new-error")).toBeVisible();
  expect(await ownDraftIds(page)).toEqual([id]);
  expect(await draftId(page)).toBe(id);
  await page.reload();
  await expect(page.getByRole("checkbox", { name: en.asks_stance_checkbox, exact: true })).toBeChecked();
  await expect(body(page)).toHaveValue("A question without its title is still a draft.");
  expect(await draftId(page)).toBe(id);
  await page.locator('input[name="title"]').fill("A complete question");
  await saved(page);
  await page.getByRole("button", { name: en.submit_post, exact: true }).click();
  await expect(page).toHaveURL(/\/t\/\d+\?posted=/);
  expect(await ownDraftIds(page)).toEqual([]);
});

test("a draft saved during refused publication can be left while autosave is unavailable", async ({ page }) => {
  await open(page, "draft_failure");
  await page.getByRole("checkbox", { name: en.asks_stance_checkbox, exact: true }).check();
  await body(page).fill("A question kept before publication.");
  await saved(page);
  const id = await draftId(page);
  await page.goto(`/drafts/${id}`);
  await waitForFormReady(page.locator("form", { has: body(page) }).first());
  await page.route("**/drafts/autosave", route => route.abort());
  await body(page).fill("Edited question kept by the refused publication.");
  await page.locator('form[data-autosave="ready"]').evaluate(form => { (form as HTMLFormElement).noValidate = true; });
  await page.getByRole("button", { name: en.draft_publish, exact: true }).click();
  await expect(page.locator("#draft-error")).toBeVisible();
  await saved(page);
  const dialogs: string[] = [];
  page.on("dialog", async dialog => { dialogs.push(dialog.message()); await dialog.dismiss(); });
  await navigate(page, "/drafts");
  await expect(page).toHaveURL(/\/drafts$/);
  expect(dialogs).toEqual([]);
  expect(await (await page.request.get(`/drafts/${id}`)).text()).toContain("Edited question kept by the refused publication.");
});

test("saved and failed states stay compact on both writing screens", async ({ page }) => {
  await open(page, "evidence");
  await body(page).fill("Notes for a conversation.\n\nA draft can grow at its own pace.");
  await saved(page);
  const id = await draftId(page);
  await evidence(page, "new-saved");
  await page.route("**/drafts/autosave", route => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "busy" }) }));
  await body(page).fill("Notes for a conversation.\n\nKept on this device while the connection is unavailable.");
  await autosaveState(page, "failed");
  await evidence(page, "new-failed");
  await page.unroute("**/drafts/autosave");
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await saved(page);
  await page.goto(`/drafts/${id}`);
  await waitForFormReady(page.locator("form", { has: body(page) }).first());
  await body(page).fill("The draft is ready to continue from another device.");
  await saved(page);
  await expect(page.getByRole("button", { name: en.save_draft, exact: true })).toHaveCount(0);
  await evidence(page, "draft-saved");
  await page.route("**/drafts/autosave", route => route.abort());
  await body(page).fill("This latest change stays on this device until saving succeeds.");
  await autosaveState(page, "failed");
  await evidence(page, "draft-failed");
});

for (const mode of ["markdown", "rich"] as const) test(`personal destinations stay implicit while ${mode} drafts save and publish with signing enabled`, async ({ page, context }) => {
  const scenario = mode === "rich" ? "personal_rich" : "personal_md";
  await context.setExtraHTTPHeaders(clientHeaders(mode === "rich" ? "10.45.80.1" : "10.45.80.2"));
  await open(page, scenario);
  await enableSigningAuthenticator(page);
  await page.goto("/settings");
  await page.getByRole("button", { name: en.settings_passkeys_add, exact: true }).click();
  await expect(page.getByText(en.settings_passkeys_added, { exact: true })).toBeVisible();
  const advanced = page.locator("#settings-advanced");
  if (!(await advanced.evaluate(element => (element as HTMLDetailsElement).open))) await advanced.locator("summary").first().click();
  await page.getByRole("checkbox", { name: en.settings_sign_posts_label, exact: true }).check();
  await page.locator('form:has(input[name="intent"][value="sign-posts"])').getByRole("button", { name: en.save_changes, exact: true }).click();
  await acceptSignedWrite(page);
  await expect(page).toHaveURL(url => url.searchParams.get("saved") === "sign-posts");
  await page.goto("/t/new");
  await waitForFormReady(page.locator("form", { has: body(page) }).first());
  if (mode === "rich") await chooseEditorMode(page, en.editor_mode_rich);
  const text = `A personal-village draft written in ${mode}.`;
  if (mode === "rich") await page.locator('[contenteditable="true"][role="textbox"]').fill(text);
  else await body(page).fill(text);
  await saved(page);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const id = await draftId(page);
  expect(await (await page.request.get(`/drafts/${id}.md`)).text()).toContain("village: null");
  await page.getByRole("button", { name: en.submit_post, exact: true }).click();
  await expect(page.getByRole("dialog").locator("[data-signing-village]")).toContainText(formatMessage(en.village_personal_destination, { handle: `draft_autosave_${scenario}` }));
  const version = await page.locator('input[name="fromDraftVersion"]').inputValue();
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(page.locator("form[data-draft-recovery=ready]")).toHaveCount(1);
  await autosaveQuiet(page);
  await expect(page.locator('input[name="fromDraftVersion"]')).toHaveValue(version);
  await acceptSignedWrite(page);
  await expect(page).toHaveURL(/\/t\/\d+\?posted=/);
  expect(await ownDraftIds(page)).toEqual([]);
  await expect(page.locator(".longread").first()).toContainText(text);
  expect(await (await page.request.get(`${new URL(page.url()).pathname}.md`)).text()).toMatch(new RegExp(`^village: ["']?@draft_autosave_${scenario}["']?$`, "m"));
});

test("personal destinations remain unsaved when only the explicit choice changes", async ({ page }) => {
  await open(page, "personal_guard");
  await body(page).fill("The displayed village stays the same when I choose it explicitly.");
  await saved(page);
  await page.route("**/drafts/autosave", route => route.abort());
  await openPostSettings(page);
  await page.locator("[data-village-target]").getByRole("button").click();
  await page.getByRole("menuitemradio", { name: formatMessage(en.village_personal_destination, { handle: "draft_autosave_personal_guard" }), exact: true }).click();
  await expect(page.locator('input[name="villageExplicit"]')).toHaveValue("1");
  const pending = page.waitForEvent("dialog");
  await navigate(page, "/drafts");
  const dialog = await pending;
  expect(dialog.message()).toBe(en.leave_unsaved_confirm);
  await dialog.dismiss();
  await expect(page).toHaveURL(/\/t\/new$/);
  await page.unroute("**/drafts/autosave");
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await saved(page);
  await navigate(page, "/drafts");
  await expect(page).toHaveURL(/\/drafts$/);
});
