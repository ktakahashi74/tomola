import { readFileSync, readdirSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { villageError } from "~/lib/village-errors";
import { setTestLocale } from "./stubs/paraglide-runtime";

vi.mock("~/paraglide/messages.js", async () => ({ m: (await import("./helpers/messages-json")).jsonMessages() }));
// A different limit catches hardcoded catalog text and call inputs.
vi.mock("~/lib/villages", () => ({ VILLAGE_INVITE_DAILY_LIMIT: 7 }));
afterEach(() => setTestLocale("en"));

it.each(["en", "ja"] as const)("uses the configured invitation count in the %s message", locale => {
  setTestLocale(locale);
  const limit = villageError("invite_limit");
  expect(limit).toContain("7");
  expect(limit).not.toContain("20");
  expect(limit).not.toMatch(/\{count\}/);
});

it.each(["en", "ja"] as const)("does not disclose refusals in the %s invitation pause message", locale => {
  setTestLocale(locale);
  expect(villageError("paused")).not.toMatch(/declin|refus|twice|30|断|2回/);
});

it.each(["en", "ja"] as const)("uses the same %s message for invitation pauses and reinvitation cooldowns", locale => {
  setTestLocale(locale);
  expect(villageError("invite_wait")).toBe(villageError("paused"));
  expect(villageError("invite_wait")).not.toMatch(/declin|refus|twice|30|48|hours|時間|断|2回/);
});

it("removes unused reinvitation copy and fingerprints from every language", () => {
  for (const file of readdirSync("messages").filter(file => file.endsWith(".json"))) {
    expect(readFileSync(`messages/${file}`, "utf8").includes('"village_error_invite_wait"'), file).toBe(false);
  }
});
