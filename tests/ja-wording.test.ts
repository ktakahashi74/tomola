import { describe, expect, it } from "vitest";
import { LANGS } from "~/lib/languages";
import { SOURCE_LANG_SPECS, TARGET_LANG_SPECS, sourceLangSpec } from "~/lib/llm/lang-specs";
import { buildTranslationPrompt, CHAT_PROMPT_VERSION, PROMPT_VERSION, VILLAGE_PROMPT_VERSION } from "~/lib/llm/prompt.server";
import type { TranslationRequest } from "~/lib/llm/types";

// The four ways a text reaches the engine: a post or title (Markdown), a chat message, and the name and the description of a village.
const WAYS: Array<[string, Partial<TranslationRequest>]> = [
  ["post or title", {}],
  ["chat message", { chat: { context: [] } }],
  ["village name", { village: "name" }],
  ["village description", { village: "description" }],
];
const system = (way: Partial<TranslationRequest>, from: TranslationRequest["from"], to: TranslationRequest["to"]) => buildTranslationPrompt({ text: "x", from, to, ...way }, "fixed").system;

describe("wording for Japanese readers", () => {
  it.each(WAYS)("is given to the engine on every way a text is translated: %s", (_, way) => {
    expect(system(way, "en", "ja")).toContain(`Target language: ${TARGET_LANG_SPECS.ja}`);
  });
  it("is given only when the target is Japanese", () => {
    for (const [, way] of WAYS) for (const to of LANGS.filter(lang => lang !== "ja")) {
      expect(system(way, "ja", to)).not.toContain(TARGET_LANG_SPECS.ja!);
    }
  });
});

describe("reading Japanese sources", () => {
  it.each(WAYS)("is given to the engine on every way a text is translated: %s", (_, way) => {
    expect(system(way, "ja", "en")).toContain(`Source language: ${SOURCE_LANG_SPECS.ja}`);
  });
  it("is given only when the source is Japanese", () => {
    expect(Object.keys(SOURCE_LANG_SPECS)).toEqual(["ja"]);
    for (const [, way] of WAYS) for (const from of LANGS.filter(lang => lang !== "ja")) {
      const text = system(way, from, from === "en" ? "fr" : "en");
      expect(text).not.toContain("Source language:");
      expect(text).not.toContain(SOURCE_LANG_SPECS.ja!);
    }
    expect(sourceLangSpec("en")).toBeUndefined();
  });
});

describe("names, precedence and what counts as the first occurrence", () => {
  it.each(WAYS)("the rule on names and the order of the rules are in every prompt, for every language: %s", (_, way) => {
    for (const to of LANGS) {
      const text = system(way, to === "en" ? "fr" : "en", to);
      expect(text).toContain("4. Names (");
      expect(text).toContain("When rules conflict, follow this order:");
    }
  });
  it("the name of a village is chosen by the rule on names", () => {
    expect(system({ village: "name" }, "en", "fr")).toContain("Choose the name by rule 4.");
    expect(system({ village: "description" }, "en", "fr")).not.toContain("Choose the name by rule 4.");
  });
  it("counts the first occurrence within one translation request", () => {
    expect(system({}, "en", "fr")).toContain("within this source text");
  });
});

describe("versions", () => {
  it("are raised for the three kinds of request", () => {
    expect([PROMPT_VERSION, CHAT_PROMPT_VERSION, VILLAGE_PROMPT_VERSION]).toEqual(["translate-v13", "chat-v4", "village-v2"]);
  });
});
