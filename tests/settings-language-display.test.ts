import { settingsData } from "./helpers/loader-fixtures";
import { expect, it, vi } from "vitest";
import Settings from "~/routes/settings";
import { renderInRouter } from "./helpers/render-in-router";
import { routeElement } from "./helpers/route-fixtures";
vi.mock("~/paraglide/messages.js", async () => ({ m: (await import("./helpers/messages-json")).jsonMessages() }));
it("shows the saved main language when a cooldown rejects an attempted change", async () => {
  const loaderData = settingsData({ handle: "language_display", nextAreaChange: "2027-01-01" });
  const actionData: Parameters<typeof Settings>[0]["actionData"] = { intent: "preferences", error: "too_soon", date: "2027-01-01", values: { homeArea: "en", displayLang: "", readLangs: ["ja"], village: "" } };
  const html = await renderInRouter(() => routeElement(Settings, { loaderData, actionData }), "/settings");
  const select = html.match(/<select[^>]*name="homeArea"[^>]*>[\s\S]*?<\/select>/)![0];
  expect(select).toContain("disabled");
  expect(select).toMatch(/<option(?=[^>]*value="ja")(?=[^>]*selected=)[^>]*>/);
  expect(select).not.toMatch(/<option(?=[^>]*value="en")(?=[^>]*selected=)[^>]*>/);
  expect(html).not.toContain('name="confirmHomeArea"');
});


it.each(["en", "ended", ""])("only offers an empty destination when the saved default %j is unavailable", async selected => {
  const posting = { choices: [{ slug: "en", language: "en", kind: "language", name: "English", description: "" }], selected, error: selected === "ended" ? "village_required" as const : null, ownHandle: null, explicit: false, changed: false };
  const loaderData = settingsData({ handle: "destination_display", posting });
  const html = await renderInRouter(() => routeElement(Settings, { loaderData }), "/settings");
  const select = html.match(/<select[^>]*name="village"[^>]*>[\s\S]*?<\/select>/)![0];
  expect(select.includes('value=""')).toBe(selected !== "en");
  expect(select).toMatch(new RegExp(`<option(?=[^>]*value="${selected === "en" ? "en" : ""}")(?=[^>]*selected=)[^>]*>`));
});
