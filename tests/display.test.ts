import { describe, expect, it } from "vitest";
import {
  clearToggleSearch,
  decideShown,
  isStale,
  parseIdSet,
  pickOlderTranslation,
  pickTranslation,
  resolveDisplayLang,
  toggleSearch,
  wantsTranslation,
} from "~/lib/display";

const row = (kind: string, sourceHash: string | null, extra: Record<string, unknown> = {}) => ({ kind, sourceHash, ...extra });

describe("pickTranslation: current human > current primary > stale human", () => {
  const h = "hash-now";
  it("prefers a human-edited translation over a primary one (there is no author translation)", () => {
    const rows = [row("primary", h, { text: "P" }), row("human", h, { text: "H" })];
    expect(pickTranslation(rows, h)).toMatchObject({ kind: "human", text: "H" });
    expect(pickTranslation(rows.slice(0, 1), h)).toMatchObject({ kind: "primary", text: "P" });
    // Independent of ordering.
    expect(pickTranslation([...rows].reverse(), h)).toMatchObject({ kind: "human" });
  });

  it("never shows the secondary translation", () => {
    expect(pickTranslation([row("secondary", h)], h)).toBeNull();
    expect(pickTranslation([row("secondary", h), row("primary", h)], h)).toMatchObject({ kind: "primary" });
  });

  it("ignores a primary translation made from an older source, but keeps the human one (flagged stale elsewhere)", () => {
    expect(pickTranslation([row("primary", "hash-old")], h)).toBeNull();
    expect(pickTranslation([row("primary", null)], h)).toBeNull();
    expect(pickTranslation([row("primary", h)], null)).toBeNull();
    expect(pickTranslation([row("primary", "hash-old"), row("human", "hash-old", { flags: ["stale"] })], h)).toMatchObject({ kind: "human" });
  });

  it("returns null without rows", () => {
    expect(pickTranslation([], h)).toBeNull();
  });
});

describe("a stale human translation versus a current primary", () => {
  const h = "hash-now";
  const stale = { flags: ["stale"] };

  it("shows the current primary by default instead of a stale human translation, and offers the human one as the older version", () => {
    const rows = [row("human", "hash-old", { ...stale, text: "H" }), row("primary", h, { text: "P" })];
    expect(pickTranslation(rows, h)).toMatchObject({ kind: "primary", text: "P" });
    expect(pickOlderTranslation(rows, h)).toMatchObject({ kind: "human", text: "H" });
  });

  it("still shows a stale human translation while there is no current primary, and then offers no older one", () => {
    const rows = [row("human", "hash-old", { ...stale }), row("primary", "hash-old")];
    expect(pickTranslation(rows, h)).toMatchObject({ kind: "human" });
    expect(pickOlderTranslation(rows, h)).toBeNull();
    expect(pickTranslation(rows.slice(0, 1), h)).toMatchObject({ kind: "human" });
  });

  it("prefers a current human translation over a current primary, and offers no older one", () => {
    const rows = [row("primary", h), row("human", h)];
    expect(pickTranslation(rows, h)).toMatchObject({ kind: "human" });
    expect(pickOlderTranslation(rows, h)).toBeNull();
  });

  it("offers no older translation when there is nothing stale, or when nothing can be shown", () => {
    expect(pickOlderTranslation([row("primary", h), row("human", h)], h)).toBeNull();
    expect(pickOlderTranslation([row("primary", "hash-old")], h)).toBeNull();
    expect(pickOlderTranslation([], h)).toBeNull();
    // If the current primary has a do-not-show flag, default to the old human translation with no older alternative.
    const hidden = [row("primary", h, { flags: ["untranslated"] }), row("human", "hash-old", stale)];
    expect(pickTranslation(hidden, h)).toMatchObject({ kind: "human" });
    expect(pickOlderTranslation(hidden, h)).toBeNull();
  });
});

describe("display rules", () => {
  it("wants a translation only when the original language is neither readable nor the display language", () => {
    expect(wantsTranslation("ja", ["ja"], "ja")).toBe(false);
    expect(wantsTranslation("ja", ["th"], "th")).toBe(true);
    expect(wantsTranslation("ja", ["ja", "en"], "en")).toBe(false); // Show the original for posts in a readable language.
    expect(wantsTranslation("en", ["ja"], "en")).toBe(false); // No translation is needed when the original matches the display language.
    expect(wantsTranslation("ja", ["th"], "en")).toBe(true);
  });

  it("shows the translation by default only when one is wanted and available", () => {
    expect(decideShown({ wants: true, hasTranslation: true })).toBe("translation");
    expect(decideShown({ wants: true, hasTranslation: false })).toBe("original");
    expect(decideShown({ wants: false, hasTranslation: true })).toBe("original");
    expect(decideShown({ wants: false, hasTranslation: false })).toBe("original");
  });

  it("lets ?old show the older translation only when there is one", () => {
    expect(decideShown({ wants: true, hasTranslation: true, hasOlder: true, force: "older" })).toBe("older");
    expect(decideShown({ wants: false, hasTranslation: true, hasOlder: true, force: "older" })).toBe("older");
    expect(decideShown({ wants: true, hasTranslation: true, hasOlder: false, force: "older" })).toBe("translation");
    expect(decideShown({ wants: true, hasTranslation: false, force: "older" })).toBe("original");
    expect(decideShown({ wants: true, hasTranslation: true, hasOlder: true })).toBe("translation");
  });

  it("lets ?orig and ?tr override the default (a translation that does not exist cannot be forced)", () => {
    expect(decideShown({ wants: true, hasTranslation: true, force: "original" })).toBe("original");
    expect(decideShown({ wants: false, hasTranslation: true, force: "translation" })).toBe("translation");
    expect(decideShown({ wants: true, hasTranslation: false, force: "translation" })).toBe("original");
  });

  it("detects the stale flag", () => {
    expect(isStale(["stale"])).toBe(true);
    expect(isStale(["structure_mismatch"])).toBe(false);
    expect(isStale([])).toBe(false);
  });
});

describe("resolveDisplayLang", () => {
  const profile = { displayLang: null, readLangs: ["th", "en"] as const };
  it("uses the interface language before original-reading languages, below explicit choices", () => {
    expect(resolveDisplayLang({ profile, uiLocale: "ja" })).toBe("ja");
    expect(resolveDisplayLang({ profile: { ...profile, displayLang: "fr" }, uiLocale: "ja" })).toBe("fr");
    expect(resolveDisplayLang({ query: "en", profile: { ...profile, displayLang: "fr" }, uiLocale: "ja" })).toBe("en");
    expect(resolveDisplayLang({ profile, uiLocale: null })).toBe("th");
    expect(resolveDisplayLang({ profile, uiLocale: "xx" })).toBe("th");
    expect(resolveDisplayLang({ profile, uiLocale: "ja", enabled: ["en", "th"] })).toBe("th");
    expect(resolveDisplayLang({ profile: { displayLang: null, readLangs: [] }, uiLocale: "ja", enabled: ["en"] })).toBe("en");
  });
  it("prefers ?lang=, then the saved display language, then the first readable language", () => {
    expect(resolveDisplayLang({ query: "ja", profile: { ...profile, displayLang: "fr" } })).toBe("ja");
    expect(resolveDisplayLang({ query: null, profile: { ...profile, displayLang: "fr" } })).toBe("fr");
    expect(resolveDisplayLang({ query: null, profile })).toBe("th");
    expect(resolveDisplayLang({ query: "xx", profile })).toBe("th");
    expect(resolveDisplayLang({ profile: { displayLang: null, readLangs: [] } })).toBe("en");
  });
});

describe("the no-JavaScript toggle links", () => {
  it("clears all post display overrides and leaves untouched searches unchanged", () => {
    expect(clearToggleSearch("?orig=5&tr=5&old=5")).toBe("");
    const search = clearToggleSearch("?lang=th&orig=5&orig=7&tr=8&old=5&old=9&q=a%20b&page=2&page=3");
    const params = new URLSearchParams(search);
    for (const name of ["orig", "tr", "old"]) expect(params.has(name)).toBe(false);
    expect(params.get("lang")).toBe("th");
    expect(params.get("q")).toBe("a b");
    expect(params.getAll("page")).toEqual(["2", "3"]);
    expect(clearToggleSearch("?orig=&tr=invalid&old=007")).toBe("");
    expect(clearToggleSearch("?lang=th&q=a%20b")).toBe("?lang=th&q=a%20b");
    expect(clearToggleSearch("")).toBe("");
  });
  it("parses id lists and drops junk", () => {
    expect([...parseIdSet(["1", "22", "x", "0", "-3", "1.5", "007"])]).toEqual([1, 22]);
  });

  it("sets orig or tr for the entry, keeping other parameters and other entries", () => {
    expect(toggleSearch("", 5, "original")).toBe("?orig=5");
    expect(toggleSearch("", 5, "translation")).toBe("?tr=5");
    expect(toggleSearch("?lang=th&orig=7", 5, "original")).toBe("?lang=th&orig=7&orig=5");
    expect(toggleSearch("?lang=th&orig=5", 5, "translation")).toBe("?lang=th&tr=5");
    expect(toggleSearch("?tr=5&orig=6", 5, "original")).toBe("?orig=6&orig=5");
    expect(toggleSearch("", 5, "older")).toBe("?old=5");
    expect(toggleSearch("?old=5&lang=th", 5, "translation")).toBe("?lang=th&tr=5");
  });
});
