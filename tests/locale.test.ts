import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultMainLang, negotiateUiLocale, parseAcceptLanguage, pickEnabledLang, setRequestUiLocale, shouldSuppressBrowserTranslation, withLocaleHeaders } from "~/lib/http/locale.server";
import { defineHtmlLangStrategy } from "~/lib/http/locale-strategy";
import { LANGS, type Lang } from "~/lib/languages";
import { customClientStrategies, customServerStrategies } from "~/paraglide/runtime.js";

// The server decides from the cookie, lang query, Accept-Language (Chinese by script), then the default; the browser reads <html lang>.
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const JA_EN: readonly Lang[] = ["ja", "en"];
const TRIAL: readonly Lang[] = ["ja", "en", "fr", "zh-Hant", "zh-Hans"];

describe("parseAcceptLanguage", () => {
  it("orders by q (highest first), keeping the written order for equal q, and defaults q to 1", () => {
    expect(parseAcceptLanguage("en;q=0.5, ja, fr;q=0.9, de")).toEqual([
      { tag: "ja", q: 1 },
      { tag: "de", q: 1 },
      { tag: "fr", q: 0.9 },
      { tag: "en", q: 0.5 },
    ]);
  });

  it("maps Chinese tags to the two scripts, keeping q and the order", () => {
    expect(parseAcceptLanguage("zh-TW,zh;q=0.9,en;q=0.8")).toEqual([
      { tag: "zh-Hant", q: 1 },
      { tag: "zh-Hans", q: 0.9 },
      { tag: "en", q: 0.8 },
    ]);
    expect(parseAcceptLanguage("zh-CN, zh-Hans-CN;q=0.9").map((t) => t.tag)).toEqual(["zh-Hans", "zh-Hans"]);
    expect(parseAcceptLanguage("zh-HK;q=0.9, zh-MO;q=0.5, zh-Hant-TW").map((t) => t.tag)).toEqual(["zh-Hant", "zh-Hant", "zh-Hant"]);
    expect(parseAcceptLanguage("ZH-tw").map((t) => t.tag)).toEqual(["zh-Hant"]);
    expect(parseAcceptLanguage("zh-SG").map((t) => t.tag)).toEqual(["zh-Hans"]);
  });

  it("leaves other tags, an empty header and a null alone; drops * and q=0; does not take zha or zhx for Chinese", () => {
    expect(parseAcceptLanguage("ja,en-US;q=0.9,fr;q=0.8,th").map((t) => t.tag)).toEqual(["ja", "th", "en-US", "fr"]);
    expect(parseAcceptLanguage("*")).toEqual([]);
    expect(parseAcceptLanguage("")).toEqual([]);
    expect(parseAcceptLanguage(null)).toEqual([]);
    expect(parseAcceptLanguage("fr;q=0, en").map((t) => t.tag)).toEqual(["en"]);
    expect(parseAcceptLanguage("zha,zhx-foo").map((t) => t.tag)).toEqual(["zha", "zhx-foo"]);
    expect(parseAcceptLanguage("en;q=abc, ja;q=2")).toEqual([]);
  });

  it("bounds hostile headers and accepts only RFC qvalues without numeric backtracking", () => {
    expect(parseAcceptLanguage("en;q=" + "1".repeat(8000) + "x,ja")).toEqual([{ tag: "ja", q: 1 }]);
    expect(parseAcceptLanguage("en;q=" + "1".repeat(16000) + "x")).toEqual([]);
    expect(parseAcceptLanguage("fr;q=0.001,ja;q=1.000,en;q=0.,de;q=0.1234,th;q=1.001")).toEqual([{ tag: "ja", q: 1 }, { tag: "fr", q: 0.001 }]);
    expect(parseAcceptLanguage("en; Q = 0.5 , ja;q=0.5")).toEqual([{ tag: "en", q: 0.5 }, { tag: "ja", q: 0.5 }]);
  });
});

describe("pickEnabledLang", () => {
  it("takes the first enabled language in order of q, matching the whole tag or the part before the first hyphen", () => {
    expect(pickEnabledLang("ja-JP,en;q=0.5", JA_EN)).toBe("ja");
    expect(pickEnabledLang("en-US,ja;q=0.5", JA_EN)).toBe("en");
    expect(pickEnabledLang("en;q=0.5,ja;q=0.9", JA_EN)).toBe("ja");
    // a language that is not enabled is skipped, the next tag decides
    expect(pickEnabledLang("de,fr;q=0.9,en;q=0.8", JA_EN)).toBe("en");
    expect(pickEnabledLang("de,sv", JA_EN)).toBeNull();
    expect(pickEnabledLang(null, JA_EN)).toBeNull();
    expect(pickEnabledLang("*", JA_EN)).toBeNull();
  });

  it("maps Chinese by script and only returns the script that is enabled", () => {
    expect(pickEnabledLang("zh-TW", TRIAL)).toBe("zh-Hant");
    expect(pickEnabledLang("zh-HK", TRIAL)).toBe("zh-Hant");
    expect(pickEnabledLang("zh-CN", TRIAL)).toBe("zh-Hans");
    expect(pickEnabledLang("zh", TRIAL)).toBe("zh-Hans");
    expect(pickEnabledLang("zh-Hant-TW", TRIAL)).toBe("zh-Hant");
    // only Simplified is enabled: a Traditional browser falls through to the next tag, not to the other script
    expect(pickEnabledLang("zh-TW,en;q=0.5", ["ja", "en", "zh-Hans"])).toBe("en");
    expect(pickEnabledLang("zh-TW", ["ja", "en", "zh-Hans"])).toBeNull();
    // a Chinese tag does not match when no Chinese is enabled
    expect(pickEnabledLang("zh-CN,ja;q=0.5", JA_EN)).toBe("ja");
  });
});

describe("defaultMainLang", () => {
  it("is the language the browser prefers most when it is enabled", () => {
    expect(defaultMainLang("ja-JP", JA_EN)).toBe("ja");
    expect(defaultMainLang("en-US,fr;q=0.5", JA_EN)).toBe("en");
    expect(defaultMainLang("fr-CA", TRIAL)).toBe("fr");
    expect(defaultMainLang("en;q=0.5,ja;q=0.9", JA_EN)).toBe("ja");
  });

  it('is "other" when the most preferred language is not enabled, even if a later tag is', () => {
    expect(defaultMainLang("de,en;q=0.8", JA_EN)).toBe("other");
    expect(defaultMainLang("ko,ja;q=0.9", JA_EN)).toBe("other");
    expect(defaultMainLang("fr", JA_EN)).toBe("other");
  });

  it('is "other" when no language is named: no header, an empty header, or only *', () => {
    expect(defaultMainLang(null, JA_EN)).toBe("other");
    expect(defaultMainLang("", JA_EN)).toBe("other");
    expect(defaultMainLang("*", JA_EN)).toBe("other");
    expect(defaultMainLang("sv-SE", JA_EN)).toBe("other");
  });

  it("maps Chinese to the script, and is other when that script is not enabled", () => {
    expect(defaultMainLang("zh-TW", TRIAL)).toBe("zh-Hant");
    expect(defaultMainLang("zh-CN", TRIAL)).toBe("zh-Hans");
    expect(defaultMainLang("zh-TW", ["ja", "en", "zh-Hans"])).toBe("other");
    expect(defaultMainLang("zh-TW", JA_EN)).toBe("other");
  });
});

describe("negotiateUiLocale", () => {
  const req = (headers: Record<string, string> = {}, query = "") => new Request(`https://forum.example.org/${query}`, { headers });

  it("uses only an explicitly supplied saved locale even when middleware cached another account", () => {
    const request = req({ "accept-language": "en" });
    setRequestUiLocale(request, "ja");
    expect(negotiateUiLocale(request, JA_EN)).toEqual({ locale: "en", source: "accept-language" });
    expect(negotiateUiLocale(request, JA_EN, undefined)).toEqual({ locale: "en", source: "accept-language" });
    expect(negotiateUiLocale(request, JA_EN, null)).toEqual({ locale: "en", source: "accept-language" });
    expect(negotiateUiLocale(request, JA_EN, "ja")).toEqual({ locale: "ja", source: "profile" });
    expect(customServerStrategies.get("custom-htmlLang")!.getLocale(request)).toBe("ja");
  });

  it("uses the cookie when it names an enabled language, before the query and Accept-Language", () => {
    expect(negotiateUiLocale(req({ cookie: "PARAGLIDE_LOCALE=ja", "accept-language": "en" }, "?lang=en"), JA_EN)).toEqual({ locale: "ja", source: "cookie" });
    expect(negotiateUiLocale(req({ cookie: "a=b; PARAGLIDE_LOCALE=zh-Hant; c=d" }), TRIAL)).toEqual({ locale: "zh-Hant", source: "cookie" });
  });

  it("ignores a cookie that names a language that is not enabled, or nothing known, and falls back to Accept-Language", () => {
    expect(negotiateUiLocale(req({ cookie: "PARAGLIDE_LOCALE=de", "accept-language": "ja" }), JA_EN)).toEqual({ locale: "ja", source: "accept-language" });
    expect(negotiateUiLocale(req({ cookie: "PARAGLIDE_LOCALE=klingon", "accept-language": "ja" }), JA_EN)).toEqual({ locale: "ja", source: "accept-language" });
    expect(negotiateUiLocale(req({ cookie: "PARAGLIDE_LOCALE=", "accept-language": "ja" }), JA_EN)).toEqual({ locale: "ja", source: "accept-language" });
  });

  it("uses an enabled query language before Accept-Language when there is no valid cookie", () => {
    expect(negotiateUiLocale(req({ "accept-language": "ja" }, "?lang=fr"), TRIAL)).toEqual({ locale: "fr", source: "query" });
    for (const cookie of ["de", "klingon", ""]) {
      expect(negotiateUiLocale(req({ cookie: `PARAGLIDE_LOCALE=${cookie}`, "accept-language": "ja" }, "?lang=fr"), TRIAL)).toEqual({ locale: "fr", source: "query" });
    }
    expect(negotiateUiLocale(req({}, "?lang=zh-Hant"), TRIAL)).toEqual({ locale: "zh-Hant", source: "query" });
  });

  it("ignores disabled, unknown, empty and noncanonical query languages", () => {
    for (const query of ["de", "xx", "", "fr-FR", "FR"]) {
      expect(negotiateUiLocale(req({ "accept-language": "ja" }, `?lang=${query}`), TRIAL)).toEqual({ locale: "ja", source: "accept-language" });
    }
    expect(negotiateUiLocale(req({}, "?lang=de"), JA_EN)).toEqual({ locale: "en", source: "default" });
  });

  it("uses Accept-Language without a cookie, with the Chinese script mapping", () => {
    expect(negotiateUiLocale(req({ "accept-language": "zh-TW,en;q=0.5" }), TRIAL)).toEqual({ locale: "zh-Hant", source: "accept-language" });
    expect(negotiateUiLocale(req({ "accept-language": "fr-FR" }), TRIAL)).toEqual({ locale: "fr", source: "accept-language" });
  });

  it("falls to the default when nothing matches: en if enabled, otherwise the first enabled language", () => {
    expect(negotiateUiLocale(req({ "accept-language": "de" }), JA_EN)).toEqual({ locale: "en", source: "default" });
    expect(negotiateUiLocale(req(), JA_EN)).toEqual({ locale: "en", source: "default" });
    expect(negotiateUiLocale(req({ "accept-language": "de" }), ["ja", "fr"])).toEqual({ locale: "ja", source: "default" });
    // a German browser on a site that has not opened German gets English, with no hydration trouble (the browser reads <html lang>)
    expect(negotiateUiLocale(req({ "accept-language": "de-DE,de;q=0.9" }), JA_EN).locale).toBe("en");
  });

  it("is limited to the enabled languages whatever the input", () => {
    for (const lang of LANGS) {
      const { locale } = negotiateUiLocale(req({ cookie: `PARAGLIDE_LOCALE=${lang}`, "accept-language": lang }), JA_EN);
      expect(JA_EN).toContain(locale);
    }
  });
});

describe("browser translation suppression", () => {
  const req = (header: string | null, query = "", cookie?: string) => new Request(`https://forum.example.org/${query}`, {
    headers: { ...(header === null ? {} : { "accept-language": header }), ...(cookie ? { cookie: `PARAGLIDE_LOCALE=${cookie}` } : {}) },
  });

  it.each([null, "sv-SE,en;q=0.8", "en-US"])("honors an explicit enabled cookie with browser preference %s", header => {
    expect(shouldSuppressBrowserTranslation(req(header, "?lang=en", "ja"), JA_EN)).toBe(true);
  });

  it.each(["ja", "ja-JP", "JA-jp", "en;q=0.5,ja;q=0.9", "ja,en;q=1"])("matches the first browser language using existing normalization: %s", header => {
    expect(shouldSuppressBrowserTranslation(req(header), JA_EN)).toBe(true);
  });

  it.each(["zh-TW", "ZH-hk", "zh-Hant-TW", "zh-CN", "zh-SG", "zh"])("matches the selected Chinese script: %s", header => {
    expect(shouldSuppressBrowserTranslation(req(header), TRIAL)).toBe(true);
  });

  it.each(["sv-SE,en;q=0.8", "de-DE,ja;q=0.8", "sv-SE", "en;q=0.9,sv-SE;q=1", "sv-SE,en;q=1"])("leaves translation available when the first language is unavailable: %s", header => {
    expect(shouldSuppressBrowserTranslation(req(header), JA_EN)).toBe(false);
  });

  it("does not treat the other Chinese script as a match", () => {
    expect(shouldSuppressBrowserTranslation(req("zh-TW,zh-CN;q=0.8"), ["en", "zh-Hans"])).toBe(false);
    expect(shouldSuppressBrowserTranslation(req("zh-CN", "?lang=zh-Hant"), TRIAL)).toBe(false);
  });

  it.each([null, "", "*", "ja;q=0", "ja;q=invalid"])("leaves translation available without an acceptable browser preference: %s", header => {
    expect(shouldSuppressBrowserTranslation(req(header), JA_EN)).toBe(false);
    expect(shouldSuppressBrowserTranslation(req(header, "?lang=ja"), JA_EN)).toBe(false);
  });

  it("compares query-selected and reading-pinned screens with the first language", () => {
    expect(shouldSuppressBrowserTranslation(req("ja-JP", "?lang=en"), JA_EN)).toBe(false);
    expect(shouldSuppressBrowserTranslation(req("ja-JP", "?lang=ja"), JA_EN)).toBe(true);
    expect(shouldSuppressBrowserTranslation(req("ja-JP", "?lang=en&rl=1"), JA_EN)).toBe(true);
    expect(shouldSuppressBrowserTranslation(req("ja-JP", "?lang=ja&rl=en"), JA_EN)).toBe(false);
  });

  it("ignores cookies that do not select an enabled language", () => {
    for (const cookie of ["fr", "unknown", "JA"]) {
      expect(shouldSuppressBrowserTranslation(req("sv-SE,en;q=0.8", "", cookie), JA_EN)).toBe(false);
      expect(shouldSuppressBrowserTranslation(req("ja", "", cookie), JA_EN)).toBe(true);
    }
  });
});

describe("the custom strategy of Paraglide (custom-htmlLang)", () => {
  it("the server half returns the decision of negotiateUiLocale for the request, with the enabled languages of the environment", () => {
    const server = customServerStrategies.get("custom-htmlLang");
    expect(server).toBeDefined();
    vi.stubEnv("ENABLED_LANGS", "ja,en");
    expect(server!.getLocale(new Request("https://forum.example.org/", { headers: { "accept-language": "de,ja;q=0.5" } }))).toBe("ja");
    expect(server!.getLocale(new Request("https://forum.example.org/", { headers: { "accept-language": "fr" } }))).toBe("en");
    vi.stubEnv("ENABLED_LANGS", "ja,en,fr");
    expect(server!.getLocale(new Request("https://forum.example.org/", { headers: { "accept-language": "fr" } }))).toBe("fr");
    expect(server!.getLocale(new Request("https://forum.example.org/t/123?lang=fr", { headers: { "accept-language": "ja" } }))).toBe("fr");
    // no request, no decision (Paraglide then falls to the next strategy)
    expect(server!.getLocale()).toBeUndefined();
  });

  it("the browser half reads <html lang> once, when it is defined, and does nothing on setLocale (the switcher writes the cookie)", () => {
    for (const [rendered, expected] of [["fr", "fr"], ["zh-Hant", "zh-Hant"], ["ZH-HANS", "zh-Hans"], ["", undefined], ["mul", undefined], ["es", undefined]] as const) {
      const html = { lang: rendered as string };
      vi.stubGlobal("document", { documentElement: html });
      defineHtmlLangStrategy();
      const client = customClientStrategies.get("custom-htmlLang");
      expect(client, rendered).toBeDefined();
      expect(client!.getLocale(), rendered).toBe(expected);
      expect(() => client!.setLocale("ja")).not.toThrow();
      expect(html.lang).toBe(rendered);
    }
  });

  it("a browser's page translation (or an extension) that rewrites <html lang> after hydration does not change the language or make getLocale() return a value Paraglide would throw on", () => {
    const html = { lang: "ja" as string };
    vi.stubGlobal("document", { documentElement: html });
    defineHtmlLangStrategy();
    const client = customClientStrategies.get("custom-htmlLang")!;
    expect(client.getLocale()).toBe("ja");
    // translated to Spanish, to a script variant the site does not have, and to a language the site has (th: it would silently show unchecked strings)
    for (const rewritten of ["es", "zh-CN", "th", "", "x-translated"]) {
      html.lang = rewritten;
      expect(client.getLocale(), rewritten).toBe("ja");
    }
  });

  it("uses the same custom and base strategies in the build and typecheck, without automatic persistence or browser negotiation", async () => {
    const { readFileSync } = await import("node:fs");
    const config = readFileSync("vite.config.ts", "utf8");
    expect(config).toContain('strategy: ["custom-htmlLang", "baseLocale"]');
    expect(config).not.toContain("preferredLanguage");
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    expect(pkg.scripts.typecheck).toContain("--strategy custom-htmlLang baseLocale");
  });
});

describe("withLocaleHeaders", () => {
  it("adds Vary: Accept-Language, Cookie to HTML responses, merging with what is there, and not to others", () => {
    const html = (headers: Record<string, string> = {}) => new Response("<html></html>", { headers: { "Content-Type": "text/html", ...headers } });
    expect((withLocaleHeaders(html()) as Response).headers.get("vary")).toBe("Accept-Language, Cookie");
    expect((withLocaleHeaders(html({ Vary: "Accept-Encoding" })) as Response).headers.get("vary")).toBe("Accept-Encoding, Accept-Language, Cookie");
    expect((withLocaleHeaders(html({ Vary: "cookie, Origin" })) as Response).headers.get("vary")).toBe("cookie, Origin, Accept-Language");
    expect((withLocaleHeaders(html({ Vary: "*" })) as Response).headers.get("vary")).toBe("*");
    const text = new Response("# md", { headers: { "Content-Type": "text/plain" } });
    expect((withLocaleHeaders(text) as Response).headers.get("vary")).toBeNull();
  });

  it("never sets a cookie (the server decides, the browser reads <html lang>; the login confirm page stays free of cookies), whatever the browser asks for", () => {
    const html = new Response("<html></html>", { headers: { "Content-Type": "text/html; charset=utf-8" } });
    expect((withLocaleHeaders(html) as Response).headers.get("set-cookie")).toBeNull();
  });

  it("passes through something that is not a response, and works on headers that cannot be changed", () => {
    const data = { not: "a response" };
    expect(withLocaleHeaders(data)).toBe(data);
    const frozen = Response.json({}, { headers: { "Content-Type": "text/html" } });
    Object.defineProperty(frozen.headers, "set", {
      value: () => {
        throw new TypeError("immutable");
      },
    });
    const res = withLocaleHeaders(frozen) as Response;
    expect(res.headers.get("vary")).toBe("Accept-Language, Cookie");
    expect(res.status).toBe(200);
  });
});
