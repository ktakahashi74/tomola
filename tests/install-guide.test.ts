import { describe, expect, it, vi } from "vitest";
import { guideDismissed, INSTALL_GUIDE_DISMISSED, installGuideMode, isIosDevice, isIosSafari, rememberGuideDismissed, standaloneDisplay } from "../app/lib/install-guide";

const iphone = { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1", platform: "iPhone", maxTouchPoints: 5 };
const safari = { member: true, coarsePointer: true, standalone: false, iosSafari: true, canPrompt: false, dismissed: false, installed: false };

describe("home-screen guidance eligibility", () => {
  it("offers steps in iOS Safari and a native action only with a retained install event", () => {
    expect(installGuideMode(safari)).toBe("ios");
    expect(installGuideMode({ ...safari, iosSafari: false, canPrompt: true })).toBe("prompt");
    expect(installGuideMode({ ...safari, iosSafari: false })).toBeNull();
  });
  it.each([
    { standalone: true }, { coarsePointer: false }, { member: false }, { dismissed: true }, { installed: true },
  ])("suppresses guidance at each boundary: %j", boundary => {
    expect(installGuideMode({ ...safari, canPrompt: true, ...boundary })).toBeNull();
  });
  it("recognizes iPhone and desktop-style iPad Safari, while excluding other iOS browsers and Macs", () => {
    expect(isIosDevice(iphone)).toBe(true);
    expect(isIosSafari(iphone)).toBe(true);
    const ipad = { ...iphone, userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15", platform: "MacIntel" };
    expect(isIosSafari(ipad)).toBe(true);
    expect(isIosDevice({ ...ipad, maxTouchPoints: 0 })).toBe(false);
    expect(isIosSafari({ ...iphone, userAgent: iphone.userAgent.replace("Version/18.0", "CriOS/130.0") })).toBe(false);
    expect(isIosDevice({ userAgent: "Android", platform: "Linux", maxTouchPoints: 5 })).toBe(false);
  });
  it.each([[true, false, true], [false, true, true], [false, false, false]])("recognizes either standalone signal (%s, %s)", (display, ios, expected) => {
    try {
      vi.stubGlobal("window", { matchMedia: () => ({ matches: display }) });
      vi.stubGlobal("navigator", { standalone: ios });
      expect(standaloneDisplay()).toBe(expected);
    } finally { vi.unstubAllGlobals(); }
  });
});

describe("browser-local dismissal", () => {
  it("persists a single flag and shares it across member accounts in this browser", () => {
    const data = new Map<string, string>();
    const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
    expect(guideDismissed(storage)).toBe(false);
    rememberGuideDismissed(storage);
    expect(data).toEqual(new Map([[INSTALL_GUIDE_DISMISSED, "1"]]));
    expect(guideDismissed(storage)).toBe(true);
    expect(installGuideMode({ ...safari, dismissed: guideDismissed(storage) })).toBeNull();
  });
  it("tolerates unavailable or denied storage", () => {
    const storage = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } };
    expect(guideDismissed(storage)).toBe(false);
    expect(guideDismissed(null)).toBe(false);
    expect(() => rememberGuideDismissed(storage)).not.toThrow();
    expect(() => rememberGuideDismissed(null)).not.toThrow();
  });
});
