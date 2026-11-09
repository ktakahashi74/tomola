import { afterEach, describe, expect, it, vi } from "vitest";
import { selectUiLocale } from "~/lib/http/locale-selection";
import { defineHtmlLangStrategy } from "~/lib/http/locale-strategy";
import { customClientStrategies, setLocale } from "~/paraglide/runtime.js";

vi.mock("~/paraglide/runtime.js", async (importOriginal) => ({ ...(await importOriginal<object>()), setLocale: vi.fn() }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function browser(protocol: string, search = "") {
  const writes: string[] = [];
  const doc = { documentElement: { lang: "en" } };
  Object.defineProperty(doc, "cookie", { get: () => "", set: (value: string) => writes.push(value) });
  vi.stubGlobal("document", doc);
  const events = new EventTarget();
  vi.stubGlobal("window", { location: { protocol, href: `${protocol}//example.com/${search}`, replace: vi.fn() }, addEventListener: events.addEventListener.bind(events), dispatchEvent: events.dispatchEvent.bind(events) });
  return writes;
}

describe("explicit interface language selection", () => {
  it("never persists the automatically resolved language or the initial custom-strategy setLocale call", () => {
    const writes = browser("https:");
    defineHtmlLangStrategy();
    const strategy = customClientStrategies.get("custom-htmlLang")!;
    expect(strategy.getLocale()).toBe("en");
    strategy.setLocale("en");
    expect(writes).toEqual([]);
    expect(setLocale).not.toHaveBeenCalled();
  });

  it("persists an explicit enabled choice with SameSite and HTTPS security before requesting the reload", () => {
    const writes = browser("https:");
    vi.mocked(setLocale).mockImplementation(() => {
      expect(writes).toEqual(["PARAGLIDE_LOCALE=ja; Path=/; Max-Age=34560000; SameSite=Lax; Secure"]);
    });
    expect(selectUiLocale("ja", ["ja", "en"])).toBe(true);
    expect(setLocale).toHaveBeenCalledWith("ja");
  });

  it("supports the HTTP development server without a Secure cookie", () => {
    const writes = browser("http:");
    vi.mocked(setLocale).mockImplementation(() => {});
    expect(selectUiLocale("zh-Hant", ["en", "zh-Hant"])).toBe(true);
    expect(writes).toEqual(["PARAGLIDE_LOCALE=zh-Hant; Path=/; Max-Age=34560000; SameSite=Lax"]);
  });

  it("a header choice clears every reading override and mark, preserving other query values and the fragment", () => {
    const writes = browser("https:", "?order=activity&page=2&long=1&lang=fr&lang=ja&rl=fr&rl=1&tag=a&tag=b#posts");
    vi.mocked(window.location.replace).mockImplementation(() => {
      expect(writes).toEqual(["PARAGLIDE_LOCALE=ja; Path=/; Max-Age=34560000; SameSite=Lax; Secure"]);
    });
    expect(selectUiLocale("ja", ["ja", "en"], { clearReadingLanguage: true })).toBe(true);
    expect(window.location.replace).toHaveBeenCalledWith("https://example.com/?order=activity&page=2&long=1&tag=a&tag=b#posts");
    expect(setLocale).not.toHaveBeenCalled();
  });

  it("a header choice without an override uses the usual locale reload", () => {
    browser("https:", "?order=activity#posts");
    expect(selectUiLocale("ja", ["ja", "en"], { clearReadingLanguage: true })).toBe(true);
    expect(setLocale).toHaveBeenCalledWith("ja");
    expect(window.location.replace).not.toHaveBeenCalled();
  });

  it("a switch without clearing requested leaves the reading override and mark in place", () => {
    browser("https:", "?lang=fr&rl=1&page=2");
    expect(selectUiLocale("ja", ["ja", "en"])).toBe(true);
    expect(setLocale).toHaveBeenCalledWith("ja");
    expect(window.location.replace).not.toHaveBeenCalled();
  });

  it.each(["en", "ja"])("clearing an override asks before navigating when choosing %s", value => {
    const writes = browser("https:", "?lang=fr&rl=1");
    window.addEventListener("tomola:confirm-unsaved", event => event.preventDefault());
    expect(selectUiLocale(value, ["ja", "en"], { clearReadingLanguage: true })).toBe(false);
    expect(writes).toEqual([]);
    expect(window.location.replace).not.toHaveBeenCalled();
    expect(setLocale).not.toHaveBeenCalled();
  });

  it("clearing an override reloads even when the interface language stays the same", () => {
    browser("https:", "?lang=fr&rl=1");
    expect(selectUiLocale("en", ["ja", "en"], { clearReadingLanguage: true })).toBe(true);
    expect(window.location.replace).toHaveBeenCalledWith("https://example.com/");
  });

  it("also removes an orphan reading mark", () => {
    browser("https:", "?rl=fr&page=2#posts");
    expect(selectUiLocale("en", ["ja", "en"], { clearReadingLanguage: true })).toBe(true);
    expect(window.location.replace).toHaveBeenCalledWith("https://example.com/?page=2#posts");
    expect(setLocale).not.toHaveBeenCalled();
  });

  it("rejects disabled and malformed values without saving or reloading", () => {
    const writes = browser("https:");
    for (const value of ["fr", "JA", "ja; injected=value", ""]) expect(selectUiLocale(value, ["ja", "en"])).toBe(false);
    expect(writes).toEqual([]);
    expect(setLocale).not.toHaveBeenCalled();
  });

  it("asks before persisting the locale and keeps the cookie when navigation is refused", () => {
    const writes = browser("https:");
    window.addEventListener("tomola:confirm-unsaved", event => {
      expect(writes).toEqual([]);
      event.preventDefault();
    });
    expect(selectUiLocale("ja", ["ja", "en"])).toBe(false);
    expect(writes).toEqual([]);
    expect(setLocale).not.toHaveBeenCalled();
  });

  it("does not save or reload during server rendering", () => {
    expect(selectUiLocale("en", ["ja", "en"])).toBe(false);
    expect(setLocale).not.toHaveBeenCalled();
  });
});
