import { afterEach, describe, expect, it, vi } from "vitest";
import { selectUiLocale } from "~/lib/http/locale-selection";
import { defineHtmlLangStrategy } from "~/lib/http/locale-strategy";
import { customClientStrategies } from "~/paraglide/runtime.js";

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

function browser(search = "") {
  vi.stubGlobal("document", { documentElement: { lang: "en" } });
  const events = new EventTarget();
  vi.stubGlobal("window", {
    location: { href: `https://example.com/${search}`, replace: vi.fn(), reload: vi.fn() },
    addEventListener: events.addEventListener.bind(events), dispatchEvent: events.dispatchEvent.bind(events),
  });
  const save = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
  vi.stubGlobal("fetch", save);
  return save;
}

describe("explicit display language selection", () => {
  it("does not save the automatically resolved language", () => {
    const save = browser();
    defineHtmlLangStrategy();
    const strategy = customClientStrategies.get("custom-htmlLang")!;
    expect(strategy.getLocale()).toBe("en");
    strategy.setLocale("en");
    expect(save).not.toHaveBeenCalled();
  });

  it("waits for account and cookie persistence before reloading", async () => {
    const save = browser();
    let finish!: (value: Response) => void;
    save.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const pending = selectUiLocale("ja", ["ja", "en"]);
    expect(save).toHaveBeenCalledWith("/settings/locale", { method: "POST", body: new URLSearchParams({ locale: "ja" }) });
    expect(window.location.reload).not.toHaveBeenCalled();
    finish(new Response(null, { status: 204 }));
    expect(await pending).toBe(true);
    expect(window.location.reload).toHaveBeenCalledOnce();
  });

  it("clears reading overrides while preserving other queries and fragments", async () => {
    browser("?order=activity&page=2&long=1&lang=fr&lang=ja&rl=fr&rl=1&tag=a&tag=b#posts");
    expect(await selectUiLocale("ja", ["ja", "en"], { clearReadingLanguage: true })).toBe(true);
    expect(window.location.replace).toHaveBeenCalledWith("https://example.com/?order=activity&page=2&long=1&tag=a&tag=b#posts");
    expect(window.location.reload).not.toHaveBeenCalled();
  });

  it.each(["?lang=fr&rl=1", "?rl=fr&page=2#posts"])("also clears an override when reselecting the current locale: %s", async search => {
    browser(search);
    expect(await selectUiLocale("en", ["ja", "en"], { clearReadingLanguage: true })).toBe(true);
    expect(window.location.replace).toHaveBeenCalledWith(search.startsWith("?lang") ? "https://example.com/" : "https://example.com/?page=2#posts");
  });

  it("keeps overrides when clearing is not requested", async () => {
    browser("?lang=fr&rl=1&page=2");
    expect(await selectUiLocale("ja", ["ja", "en"])).toBe(true);
    expect(window.location.replace).not.toHaveBeenCalled();
    expect(window.location.reload).toHaveBeenCalledOnce();
  });

  it.each(["en", "ja"])("asks before saving or discarding unsaved writing when choosing %s", async value => {
    const save = browser("?lang=fr&rl=1");
    window.addEventListener("tomola:confirm-unsaved", event => event.preventDefault());
    expect(await selectUiLocale(value, ["ja", "en"], { clearReadingLanguage: true })).toBe(false);
    expect(save).not.toHaveBeenCalled();
    expect(window.location.replace).not.toHaveBeenCalled();
  });

  it("rejects invalid or disabled values before saving", async () => {
    const save = browser();
    for (const value of ["fr", "JA", "ja; injected=value", ""]) expect(await selectUiLocale(value, ["ja", "en"])).toBe(false);
    expect(save).not.toHaveBeenCalled();
  });

  it.each(["rejected", "offline"])("does not navigate after a failed save: %s", async failure => {
    const save = browser();
    if (failure === "offline") save.mockRejectedValue(new Error("offline"));
    else save.mockResolvedValue(new Response(null, { status: 403 }));
    expect(await selectUiLocale("ja", ["ja", "en"])).toBe(false);
    expect(window.location.reload).not.toHaveBeenCalled();
  });

  it("does not save during server rendering", async () => {
    expect(await selectUiLocale("en", ["ja", "en"])).toBe(false);
  });
});
