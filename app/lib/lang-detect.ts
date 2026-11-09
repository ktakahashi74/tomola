import type * as core from "./lang-detect.core.server";
import { markdownTask, canFallbackMarkdown } from "./markdown-budget.server";
import { isEnabledLang } from "./enabled-langs.server";
export { type LanguageDecision } from "./lang-detect.core.server";

export async function detectLang(...args: Parameters<typeof core.detectLang>): Promise<ReturnType<typeof core.detectLang>> {
  try { return await markdownTask("detectLang", args); }
  catch (error) { if (!canFallbackMarkdown(error)) throw error; return null; }
}

// Browser forms and AI drafts use identical detection and enabled-language fallback rules.
export async function resolvePostLanguage(body: string, explicit: string | undefined, defaultLang: string) {
  const detected = await detectLang(body);
  const source = explicit ? "explicit" : detected && isEnabledLang(detected) ? "detected" : "default";
  return { lang: explicit || (source === "detected" ? detected! : defaultLang), language: { source, detected } as core.LanguageDecision };
}
