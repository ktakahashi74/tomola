import path from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import { TARGET_LOCALES } from "~/lib/i18n/messages";

const fixtures = vi.hoisted(() => ({
  en: { plain: "source", parameter: "source {name}" },
  ja: { plain: "日本語" },
  translated: { plain: "translated" },
}));

vi.mock("node:fs", () => ({
  default: {
    readFileSync: (file: string) => {
      const locale = path.basename(file, ".json");
      return JSON.stringify(locale === "en" ? fixtures.en : locale === "ja" ? fixtures.ja : fixtures.translated);
    },
  },
}));

beforeEach(() => vi.resetModules());

it("keeps existing translations and substitutes English for missing target messages, including inputs", async () => {
  const m = (await import("./helpers/messages-json")).jsonMessages();
  const inputs = { name: "fixture-name" };
  for (const locale of TARGET_LOCALES) {
    expect(m.plain({}, { locale })).toBe(fixtures.translated.plain);
    expect(m.parameter(inputs, { locale })).toBe(fixtures.en.parameter.replace("{name}", inputs.name));
    expect(() => m.parameter({}, { locale })).toThrow(/input.*missing/);
    expect(() => m.absent({}, { locale })).toThrow(/missing/);
  }
});

it("rejects missing source and handwritten reference messages", async () => {
  const m = (await import("./helpers/messages-json")).jsonMessages();
  expect(m.plain({}, { locale: "ja" })).toBe(fixtures.ja.plain);
  expect(() => m.parameter({ name: "fixture-name" }, { locale: "ja" })).toThrow(/missing/);
  expect(() => m.absent({}, { locale: "en" })).toThrow(/missing/);
});
