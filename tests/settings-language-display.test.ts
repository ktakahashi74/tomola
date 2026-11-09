import { createElement } from "react";
import { expect, it, vi } from "vitest";
import Settings from "~/routes/settings";
import { renderInRouter } from "./helpers/render-in-router";
vi.mock("~/paraglide/messages.js", async () => ({ m: (await import("./helpers/messages-json")).jsonMessages() }));
it("shows the saved main language when a cooldown rejects an attempted change", async () => {
  const loaderData = { homeArea: "ja", handle: "language_display", displayLang: null, readLangs: ["ja"], nextAreaChange: "2027-01-01", nextHandleChange: null, saved: null, passkeys: [], emailPref: "auto", signPosts: false, shareBookmarklet: "" };
  const actionData = { intent: "preferences", error: "too_soon", date: "2027-01-01", values: { homeArea: "en", displayLang: "", readLangs: ["ja"], village: "" } };
  const html = await renderInRouter(() => createElement(Settings, { loaderData, actionData } as never), "/settings");
  const select = html.match(/<select[^>]*name="homeArea"[^>]*>[\s\S]*?<\/select>/)![0];
  expect(select).toContain("disabled");
  expect(select).toMatch(/<option(?=[^>]*value="ja")(?=[^>]*selected=)[^>]*>/);
  expect(select).not.toMatch(/<option(?=[^>]*value="en")(?=[^>]*selected=)[^>]*>/);
  expect(html).not.toContain('name="confirmHomeArea"');
});


it.each(["en", "ended", ""])("only offers an empty destination when the saved default %j is unavailable", async selected => {
  const posting = { choices: [{ slug: "en", language: "en", kind: "language" }], selected, error: selected === "ended" ? "village_required" : null };
  const loaderData = { homeArea: "ja", handle: "destination_display", displayLang: null, readLangs: ["ja"], nextAreaChange: null, nextHandleChange: null, saved: null, passkeys: [], emailPref: "auto", signPosts: false, shareBookmarklet: "", posting };
  const html = await renderInRouter(() => createElement(Settings, { loaderData } as never), "/settings");
  const select = html.match(/<select[^>]*name="village"[^>]*>[\s\S]*?<\/select>/)![0];
  expect(select.includes('value=""')).toBe(selected !== "en");
  expect(select).toMatch(new RegExp(`<option(?=[^>]*value="${selected === "en" ? "en" : ""}")(?=[^>]*selected=)[^>]*>`));
});
