// Test replacement through the vitest.config.ts alias. Provide only what server code uses so it runs without generated app/paraglide/runtime.js;
// change the UI language with setTestLocale, defaulting to en, and reset it after each test.
// The same nine languages as actual Paraglide locales in project.inlang/settings.json; tests/i18n.test.ts checks consistency with LANGS and message files.
export const locales = ["en", "ja", "fr", "de", "zh-Hant", "zh-Hans", "ko", "th", "vi"] as const;
export type Locale = (typeof locales)[number];
export const baseLocale: Locale = "en";
// The Paraglide cookie name and expiry match generated app/paraglide/runtime.js.
export const cookieName = "PARAGLIDE_LOCALE";
export const cookieMaxAge = 34560000;
let current: Locale = baseLocale;
export function getLocale(): Locale {
  return current;
}
export function setTestLocale(locale: Locale): void {
  current = locale;
}
// Case-insensitive match against the locales, like the generated runtime (undefined when it is not one of them).
export function toLocale(value: unknown): Locale | undefined {
  if (typeof value !== "string") return undefined;
  return locales.find((l) => l.toLowerCase() === value.toLowerCase());
}
export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (locales as readonly string[]).includes(value);
}

// The custom strategies that the app registers (app/lib/http/locale.server.ts defines the server one when it is imported); tests read them from here.
export const customServerStrategies = new Map<string, { getLocale: (request?: Request) => Promise<string | undefined> | (string | undefined) }>();
export const customClientStrategies = new Map<string, { getLocale: () => Promise<string | undefined> | (string | undefined); setLocale: (locale: string) => Promise<void> | void }>();
export function defineCustomServerStrategy(strategy: string, handler: { getLocale: (request?: Request) => Promise<string | undefined> | (string | undefined) }): void {
  customServerStrategies.set(strategy, handler);
}
export function defineCustomClientStrategy(strategy: string, handler: { getLocale: () => Promise<string | undefined> | (string | undefined); setLocale: (locale: string) => Promise<void> | void }): void {
  customClientStrategies.set(strategy, handler);
}
