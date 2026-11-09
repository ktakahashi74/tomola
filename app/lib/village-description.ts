import { isLang } from "~/lib/languages";
import { localizedLanguageLabel } from "~/lib/language-label";
import { m } from "~/paraglide/messages.js";
import { getLocale, type Locale } from "~/paraglide/runtime.js";

// A language village has no description of its own; one fixed sentence (from the message list, not stored) says what it is.
export function villageDescription(village: { language: string | null; description?: string }, locale: Locale = getLocale()): string {
  if (village.description) return village.description;
  return isLang(village.language) ? m.village_language_description({ language: localizedLanguageLabel(village.language, locale) }, { locale }) : "";
}

// A long description is cut for the head: [shown, rest]. The rest opens under "More".
export function splitDescription(text: string, limit = 160): [string, string] {
  if (text.length <= limit) return [text, ""];
  const cut = text.slice(0, limit);
  const at = Math.max(cut.lastIndexOf("\n"), cut.lastIndexOf("。"), cut.lastIndexOf(". "), cut.lastIndexOf(" "));
  const end = at > limit / 2 ? at + 1 : limit;
  return [text.slice(0, end).trimEnd(), text.slice(end).trimStart()];
}
