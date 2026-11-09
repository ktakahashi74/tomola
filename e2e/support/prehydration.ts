import { expect, type Page, type Route, type TestInfo } from "@playwright/test";
import { enMessages as en, titleField, waitForClientRoute, waitForFormReady } from "../helpers";

export async function beforeHydration(page: Page, path: string, input: () => Promise<void>, settled: () => Promise<void> = () => waitForClientRoute(page)) {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let paused = true;
  const block = async (route: Route) => {
    if (route.request().resourceType() === "script") {
      if (paused) await gate;
      await route.continue();
    } else await route.fallback();
  };
  await page.route("**/*", block);
  try {
    await page.goto(path, { waitUntil: "commit" });
    await input();
    paused = false;
    release();
    await settled();
  } finally {
    paused = false;
    release();
    await page.unroute("**/*", block);
  }
}

async function beforeScripts(page: Page, path: string, input: () => Promise<void>) {
  await beforeHydration(page, path, async () => {
    await input();
    await expect(page.locator('form', { has: page.locator('textarea[name="body"]') })).not.toHaveAttribute("data-ready", "true");
  });
  await waitForFormReady(page.locator('form', { has: page.locator('textarea[name="body"]') }));
}

// Use the same delayed-script scenarios against development and production SSR.
export async function exercisePrehydration(page: Page, info: TestInfo) {
  const warnings: string[] = [];
  page.on("console", message => {
    if (/hydrat|did not match|server rendered HTML|controlled.*uncontrolled|uncontrolled.*controlled|both value and defaultValue|Minified React error #(?:418|423|425)/i.test(message.text())) warnings.push(message.text());
  });
  page.on("pageerror", error => warnings.push(error.message));
  const published: string[] = [];
  const controls: unknown[] = [];
  const form = () => page.locator('form', { has: page.locator('textarea[name="body"]') });
  const values = () => form().evaluate(element => [...new FormData(element as HTMLFormElement)].filter(([name]) => ["lang", "asksStance", "intro"].includes(name)));
  try {
    for (const scenario of [
      { title: "Typed before scripts", body: "A body typed before scripts.", expected: "Typed before scripts", earlyKind: "asksStance" },
      { title: "Typed title wins", body: "---\ntitle: Pasted title\nlang: en\n---\nPasted body with a separate title.", expected: "Typed title wins", earlyKind: "intro" },
      { title: "", body: "---\ntitle: Title from frontmatter\nlang: en\n---\nPasted body without a separate title.", expected: "Title from frontmatter", earlyKind: null },
      { title: "An ordinary post", body: "The preselected question was unchecked before scripts.", expected: "An ordinary post", earlyKind: "ordinary" },
    ]) {
      const introductionEntry = scenario.earlyKind === "intro";
      await beforeScripts(page, introductionEntry ? "/t/new?intro=1" : scenario.earlyKind === "ordinary" ? "/t/new?asks_stance=1" : "/t/new", async () => {
        await expect(form()).not.toHaveAttribute("data-ready", "true");
        await titleField(page).fill(scenario.title);
        await form().locator('textarea[name="body"]').fill(scenario.body);
        // Native inputs work before client handlers, including taking off a preselected question.
        if (controls.length === 0) {
          const before = await values();
          await form().locator('input[name="asksStance"]').check({ force: true });
          const question = await values();
          await form().locator('input[name="asksStance"]').uncheck({ force: true });
          const post = await values();
          controls.push({ name: en.asks_stance_checkbox, before, afterQuestion: question, afterPost: post });
          await form().locator("[data-post-settings] summary").click();
          await form().getByRole("combobox", { name: en.field_lang, exact: true }).click();
          controls.push({ language: await values(), popupCount: await page.getByRole("listbox").count() });
        }
        if (scenario.earlyKind === "asksStance") {
          await form().locator('input[name="asksStance"]').check({ force: true });
          expect((await values()).some(([name, value]) => name === "asksStance" && value === "1")).toBe(true);
        } else if (scenario.earlyKind === "intro") {
          // The introduction entry starts with its box checked; take it off and put it back before scripts run.
          const checkbox = form().locator('input[name="intro"]');
          await checkbox.uncheck({ force: true });
          await checkbox.check({ force: true });
          expect((await values()).some(([name, value]) => name === "intro" && value === "1")).toBe(true);
        } else if (scenario.earlyKind === "ordinary") {
          await form().locator('input[name="asksStance"]').uncheck({ force: true });
          expect((await values()).some(([name]) => name === "asksStance")).toBe(false);
        }
      });
      if (scenario.earlyKind === "asksStance") await expect(form().getByRole("checkbox", { name: en.asks_stance_checkbox, exact: true })).toBeChecked();
      if (scenario.earlyKind === "ordinary") await expect(form().getByRole("checkbox", { name: en.asks_stance_checkbox, exact: true })).not.toBeChecked();
      if (scenario.earlyKind === "intro") await expect(form().getByRole("checkbox", { name: en.intro_checkbox, exact: true })).toBeChecked();
      await expect(titleField(page)).toHaveValue(scenario.title);
      await form().locator("[data-post-settings]").evaluate(element => { (element as HTMLDetailsElement).open = true; });
      await form().getByRole("combobox", { name: en.field_lang, exact: true }).click();
      await page.getByRole("listbox").getByRole("option", { name: "English", exact: true }).click();
      await expect(titleField(page)).toHaveValue(scenario.title);
      for (const name of [en.asks_stance_checkbox, ...(introductionEntry ? [en.intro_checkbox] : [])]) {
        const control = form().getByRole("checkbox", { name, exact: true });
        await control.check();
        await expect(titleField(page)).toHaveValue(scenario.title);
        if (name === en.asks_stance_checkbox) await expect(titleField(page)).toHaveJSProperty("required", !scenario.body.startsWith("---"));
        await control.uncheck();
        await expect(titleField(page)).toHaveValue(scenario.title);
      }
      // Body edits can change the derived frontmatter state and rerender the heading.
      const body = form().locator('textarea[name="body"]');
      await body.fill(scenario.body.startsWith("---") ? "Changed plain body." : "---\ntitle: Temporary pasted title\n---\nChanged pasted body.");
      await expect(titleField(page)).toHaveValue(scenario.title);
      await body.fill(scenario.body);
      await expect(titleField(page)).toHaveValue(scenario.title);
      await form().getByRole("button", { name: en.submit_post, exact: true }).click();
      await expect(page.getByRole("heading", { level: 1, name: scenario.expected, exact: true })).toBeVisible();
      published.push(new URL(page.url()).pathname.split("/").at(-1)!);
    }
    expect(warnings, "React warnings and page errors").toEqual([]);
  } finally {
    await info.attach("prehydration-controls", { body: JSON.stringify(controls, null, 2), contentType: "application/json" });
    for (const id of published) await page.request.post(`/t/${id}`, { form: { intent: "delete", entryId: id, confirm: "1" }, headers: { Origin: new URL(page.url()).origin }, maxRedirects: 0 });
  }
}
