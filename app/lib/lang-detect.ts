import type * as core from "./lang-detect.core.server";
import { markdownTask, canFallbackMarkdown } from "./markdown-budget.server";
import { isEnabledLang } from "./enabled-langs.server";
export { type LanguageDecision } from "./lang-detect.core.server";

export async function detectLang(...args: Parameters<typeof core.detectLang>): Promise<ReturnType<typeof core.detectLang>> {
  try { return await markdownTask("detectLang", args); }
  catch (error) { if (!canFallbackMarkdown(error)) throw error; return null; }
}

export async function detectSourceLanguage(...args: Parameters<typeof core.detectSourceLanguage>): Promise<ReturnType<typeof core.detectSourceLanguage>> {
  try { return await markdownTask("detectSourceLanguage", args); }
  catch (error) { if (!canFallbackMarkdown(error)) throw error; return null; }
}

// Keep the author's explicit choice; unknown prose falls back to their default.
export async function resolvePostLanguage(body: string, explicit: string | undefined, defaultLang: string) {
  const detected = await detectSourceLanguage(body, defaultLang);
  const useDetected = !explicit || (explicit === "other" && detected && !isEnabledLang(detected.lang));
  const lang = useDetected ? detected?.lang ?? (explicit || defaultLang) : explicit;
  const langCode = lang === "other" && useDetected ? detected?.langCode ?? null : null;
  const source = explicit ? "explicit" : detected ? "detected" : "default";
  return { lang, langCode, langSource: source, language: { source, detected: detected?.lang ?? null, ...(detected?.lang === "other" ? { langCode: detected.langCode } : {}) } as core.LanguageDecision };
}
