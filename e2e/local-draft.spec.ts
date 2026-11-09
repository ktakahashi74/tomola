import { expect } from "@playwright/test";
import { test } from "./editor-fixture";
import { enMessages as en, messagePattern, openUserMenu, useMember, waitForClientRoute, waitForFormReady } from "./helpers";

// What a member typed and did not send is kept on the device, for that member and that screen only.
const kept = (page: import("@playwright/test").Page) => page.evaluate(() => Object.keys(localStorage).filter(key => {
  if (!key.startsWith("tomola:draft:")) return false;
  const record = JSON.parse(localStorage.getItem(key)!);
  return Boolean(record.body?.trim() || record.title?.trim());
}));
const body = (page: import("@playwright/test").Page, scope = "main") => page.locator(`${scope} textarea[name="body"]`);
async function typeAndWait(page: import("@playwright/test").Page, text: string, scope = "main") {
  await waitForFormReady(page.locator("form", { has: page.locator('textarea[name="body"]') }).first());
  await body(page, scope).fill(text);
  await expect.poll(() => kept(page)).not.toEqual([]);
}

test("unsent writing is kept, restored and discarded, goes when the post is accepted, stays when it is refused, and belongs to one member and one screen", async ({ page }) => {
  await useMember(page, "zlds_writer@example.com", "/t/new");
  await waitForClientRoute(page);
  await page.route("**/drafts/autosave", route => route.abort());
  await typeAndWait(page, "A thought that was not sent");

  // A reload brings it back; it can be discarded.
  await page.reload();
  await expect(body(page)).toHaveValue("A thought that was not sent");
  await expect(page.getByText(messagePattern(en.local_draft_restored, { time: /.+/ }))).toBeVisible();
  // A different writing context has its own record; a fresh visit restores this screen's copy.
  await page.goto("/t/new?intro=1");
  await expect(body(page)).toHaveValue("");
  await page.goto("/t/new");
  await expect(body(page)).toHaveValue("A thought that was not sent");

  // Another member on the same device sees nothing of it.
  await useMember(page, "zlds_other@example.com", "/t/new");
  await waitForFormReady(page.locator("form", { has: page.locator('textarea[name="body"]') }).first());
  await expect(body(page)).toHaveValue("");
  await expect(page.getByText(messagePattern(en.local_draft_restored, { time: /.+/ }))).toHaveCount(0);
  await useMember(page, "zlds_writer@example.com", "/t/new");
  await expect(body(page)).toHaveValue("A thought that was not sent");
  await page.getByRole("button", { name: en.local_draft_discard, exact: true }).click();
  await expect(body(page)).toHaveValue("");
  expect(await kept(page)).toEqual([]);

  // A post that did not get through (the connection failed) keeps what was typed, and the error screen says so; a post that is accepted removes it.
  await typeAndWait(page, "A post the connection dropped");
  const drop = (route: import("@playwright/test").Route) => route.request().method() === "POST" ? route.abort() : route.continue();
  await page.route("**/t/new*", drop);
  await page.getByRole("button", { name: en.submit_post, exact: true }).click();
  await expect(page.getByText(en.write_error_kept, { exact: false })).toBeVisible();
  expect(await kept(page)).not.toEqual([]);
  await page.unroute("**/t/new*", drop);
  await page.goto("/t/new");
  await expect(body(page)).toHaveValue("A post the connection dropped");
  await page.getByRole("button", { name: en.submit_post, exact: true }).click();
  await expect(page).toHaveURL(/\/t\/\d+\?posted=\d+/);
  expect(await kept(page)).toEqual([]);

  // The reply field has its own record, removed when the reply is accepted.
  await typeAndWait(page, "A reply that was not sent", "#reply");
  await page.reload();
  await expect(body(page, "#reply")).toHaveValue("A reply that was not sent");
  await page.getByRole("button", { name: en.submit_reply, exact: true }).click();
  await expect(page).toHaveURL(/posted=\d+#c-\d+/);
  expect(await kept(page)).toEqual([]);

  // Logging out leaves nothing of it on the device for the next person.
  await page.goto("/t/new");
  await typeAndWait(page, "Typed, then logged out");
  // Leave by loading another address (the unsaved-writing question is not the subject here): the record stays until the member logs out.
  await page.goto("/");
  expect(await kept(page)).not.toEqual([]);
  await (await openUserMenu(page)).getByRole("menuitem", { name: en.nav_logout }).click();
  await expect(page.locator("[data-member-menu-trigger]")).toHaveCount(0);
  expect(await kept(page)).toEqual([]);
});

test("choosing to leave a screen and discard what was typed removes the copy on the device", async ({ page }) => {
  await useMember(page, "zlds_other@example.com", "/t/new");
  await waitForClientRoute(page);
  await page.route("**/drafts/autosave", route => route.abort());
  await typeAndWait(page, "Typed, then abandoned");
  page.on("dialog", dialog => void dialog.accept());
  await page.getByRole("link", { name: en.site_name, exact: true }).first().click();
  await expect(page).toHaveURL(/\/$/);
  expect(await kept(page)).toEqual([]);
  await page.goto("/t/new");
  await expect(body(page)).toHaveValue("");
});

test("writing made on an earlier text of an edit screen is set aside and offered, not dropped", async ({ page, browser }) => {
  await useMember(page, "zlds_other@example.com", "/t/new");
  await waitForClientRoute(page);
  await typeAndWait(page, "The first text of the post");
  await page.getByRole("button", { name: en.submit_post, exact: true }).click();
  await expect(page).toHaveURL(/\/t\/\d+\?posted=\d+/);
  const editPath = `${new URL(page.url()).pathname}/edit`;
  // Typed into the edit screen, not sent.
  await page.goto(editPath);
  await typeAndWait(page, "The first text of the post, and more that was not sent");
  await page.goto("/");
  // The text changes meanwhile (an edit made on another device).
  const elsewhere = await browser.newContext();
  const other = await elsewhere.newPage();
  await useMember(other, "zlds_other@example.com", editPath);
  await waitForFormReady(other.locator("form", { has: other.locator('textarea[name="body"]') }).first());
  await other.locator('textarea[name="body"]').fill("The text changed elsewhere");
  await other.getByRole("button", { name: en.save_changes, exact: true }).click();
  await expect(other).not.toHaveURL(/\/edit$/);
  await elsewhere.close();
  // Reopened: the screen shows the current text, and the earlier writing is offered.
  await page.goto(editPath);
  await expect(body(page)).toHaveValue("The text changed elsewhere");
  await expect(page.getByText(messagePattern(en.local_draft_older, { time: /.+/ }))).toBeVisible();
  await page.getByRole("button", { name: en.local_draft_open, exact: true }).click();
  await expect(body(page)).toHaveValue("The first text of the post, and more that was not sent");
});

test("text typed in the reply field goes with the member to another reply target, and not to the one left", async ({ page }) => {
  await useMember(page, "zlds_third@example.com", "/t/new");
  await waitForClientRoute(page);
  await typeAndWait(page, "A post with two replies");
  await page.getByRole("button", { name: en.submit_post, exact: true }).click();
  await expect(page).toHaveURL(/\/t\/\d+\?posted=\d+/);
  const thread = new URL(page.url()).pathname;
  for (const text of ["First reply", "Second reply"]) {
    await waitForFormReady(page.locator("form", { has: page.locator('textarea[name="body"]') }).first());
    await body(page, "#reply").fill(text);
    await page.getByRole("button", { name: en.submit_reply, exact: true }).click();
    await expect(page).toHaveURL(/posted=\d+#c-\d+/);
    // The field is emptied once the reply is in; the next one starts from there.
    await expect(body(page, "#reply")).toBeEmpty();
  }
  expect(await kept(page)).toEqual([]);
  await page.goto(thread);
  await waitForFormReady(page.locator("form", { has: page.locator('textarea[name="body"]') }).first());
  // Typed, and the target changed before the one-second wait is over: the text must be in the new target's record and not in the record of the target left.
  await body(page, "#reply").fill("Typed for the first reply");
  await page.getByRole("link", { name: en.reply_to_button, exact: true }).first().click();
  await expect(page).toHaveURL(/reply_to=c-\d+#reply$/);
  const target = new URL(page.url()).searchParams.get("reply_to")!.slice(2);
  await expect.poll(() => kept(page)).toEqual([expect.stringContaining(`:reply:${thread.split("/").at(-1)}:${target}`)]);
  await page.waitForTimeout(1500);
  expect(await kept(page)).toEqual([expect.stringContaining(`:reply:${thread.split("/").at(-1)}:${target}`)]);
  // Reloaded, the text comes back; the field of the target left has nothing.
  await page.reload();
  await expect(body(page, "#reply")).toHaveValue("Typed for the first reply");
  await page.goto(`${thread}?reply_to=`);
  await expect(body(page, "#reply")).toHaveValue("");
  // Discarding the restored text of one target clears the records of the whole thread's reply field.
  await page.goto(`${thread}?reply_to=c-${target}`);
  await expect(body(page, "#reply")).toHaveValue("Typed for the first reply");
  await page.getByRole("button", { name: en.local_draft_discard, exact: true }).click();
  expect(await kept(page)).toEqual([]);
});


test("an account switch in another tab replaces the reply editor without migrating the previous member's writing", async ({ page, context }) => {
  await useMember(page, "draft_owner_switch_a@example.com", "/t/new");
  await typeAndWait(page, "Account switch topic");
  await page.getByRole("button", { name: en.submit_post, exact: true }).click();
  await expect(page).toHaveURL(/\/t\/\d+\?posted=\d+/);
  const thread = new URL(page.url()).pathname;
  await waitForFormReady(page.locator("#reply form"));
  await body(page, "#reply").fill("Published reply target");
  await page.getByRole("button", { name: en.submit_reply, exact: true }).click();
  await expect(body(page, "#reply")).toBeEmpty();
  await typeAndWait(page, "Unsent private reply from the first member", "#reply");
  const [firstKey] = await kept(page);
  const other = await context.newPage();
  await useMember(other, "draft_owner_switch_b@example.com", thread);
  await page.bringToFront();
  // A same-path client navigation revalidates the member without reloading the document.
  await page.getByRole("link", { name: en.reply_to_button, exact: true }).first().click();
  await expect(page.locator("[data-member-menu-trigger]")).toHaveAttribute("title", "@draft_owner_switch_b");
  await expect(body(page, "#reply")).toBeEmpty();
  expect(await kept(page)).toEqual([firstKey]);
  await body(page, "#reply").fill("The second member's own reply");
  await expect.poll(() => page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith("tomola:draft:")).map(key => JSON.parse(localStorage.getItem(key)!).body))).toContain("The second member's own reply");
  await page.reload();
  await expect(body(page, "#reply")).toHaveValue("The second member's own reply");
  await other.close();
});

test("logout in another tab invalidates pending reply saves and pagehide callbacks", async ({ page, context }) => {
  await useMember(page, "draft_owner_logout@example.com", "/t/new");
  await typeAndWait(page, "Logout topic");
  await page.getByRole("button", { name: en.submit_post, exact: true }).click();
  await expect(page).toHaveURL(/\/t\/\d+\?posted=\d+/);
  const other = await context.newPage();
  await other.goto("/");
  await waitForFormReady(page.locator("#reply form"));
  await body(page, "#reply").fill("Pending before logout");
  await (await openUserMenu(other)).getByRole("menuitem", { name: en.nav_logout }).click();
  await expect(other.locator("[data-member-menu-trigger]")).toHaveCount(0);
  await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
  await page.waitForTimeout(1500);
  expect(await kept(page)).toEqual([]);
  await body(page, "#reply").fill("Typed into the stale logged-out tab");
  await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
  await page.waitForTimeout(1500);
  expect(await kept(page)).toEqual([]);
  await other.close();
});

test("revalidating the new-topic screen after an account switch isolates device and server drafts", async ({ page, context }) => {
  await useMember(page, "draft_new_owner_a@example.com", "/t/new");
  await waitForClientRoute(page);
  await page.route("**/drafts/autosave**", route => route.abort());
  await page.locator('input[name="title"]').fill("First member's private title");
  await typeAndWait(page, "First member's private new topic");
  await expect(page.locator("[data-draft-autosave]")).toHaveAttribute("data-draft-autosave", "failed");
  const [firstKey] = await kept(page);
  const firstRecord = await page.evaluate(key => localStorage.getItem(key), firstKey);
  const other = await context.newPage();
  await useMember(other, "draft_new_owner_b@example.com", "/");
  await page.unroute("**/drafts/autosave**");
  const writes: string[] = [];
  page.on("request", request => { if (request.method() === "POST" && new URL(request.url()).pathname === "/drafts/autosave") writes.push(request.postData() ?? ""); });
  await page.evaluate(() => { void (window as unknown as { __reactRouterDataRouter: { revalidate(): Promise<void> } }).__reactRouterDataRouter.revalidate(); });
  await expect(page.locator("[data-member-menu-trigger]")).toHaveAttribute("title", "@draft_new_owner_b");
  await waitForFormReady(page.locator('form[data-autosave="ready"]'));
  await expect(body(page)).toBeEmpty();
  await expect(page.locator('input[name="title"]')).toBeEmpty();
  await page.waitForTimeout(1500);
  expect(writes).toEqual([]);
  expect(await page.evaluate(() => {
    const prefix = `tomola:draft:${sessionStorage.getItem("tomola:draft-owner")}:`;
    return [localStorage, sessionStorage].flatMap(storage => Object.keys(storage).filter(key => key.startsWith(prefix)));
  })).toEqual([]);
  expect(await page.evaluate(key => localStorage.getItem(key), firstKey)).toBe(firstRecord);
  expect((await (await page.request.get("/drafts")).text()).match(/href="\/drafts\/\d+"/g)).toBeNull();
  await body(page).fill("Second member's own new topic");
  await expect(page.locator("[data-draft-autosave]")).toHaveAttribute("data-draft-autosave", "saved");
  const id = await page.locator('input[name="fromDraft"]').inputValue();
  expect(await (await page.request.get(`/drafts/${id}`)).text()).toContain("Second member's own new topic");
  expect(writes.every(write => !new URLSearchParams(write).get("body")?.includes("First member") && !new URLSearchParams(write).get("title")?.includes("First member"))).toBe(true);
  await page.reload();
  await expect(body(page)).toHaveValue("Second member's own new topic");
  await other.close();
});
