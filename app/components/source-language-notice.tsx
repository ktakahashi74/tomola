import { Link } from "react-router";
import { languageLabel } from "~/lib/language-label";
import { isSourceLang } from "~/lib/languages";
import { m } from "~/paraglide/messages.js";

// The explanation belongs to submission review, outside the initial reading bundle.
export default function SourceLanguageNotice({ lang, langCode }: { lang: string; langCode?: string | null }) {
  if (!isSourceLang(lang)) return null;
  return <p role="note">{lang === "other" && !langCode ? m.original_lang_other() : m.original_lang_other_named({ lang: languageLabel(lang, langCode) })} <Link to="/languages" className="underline">{m.languages_about()}</Link></p>;
}
