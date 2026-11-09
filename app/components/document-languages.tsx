import { Link } from "react-router";
import { PRINCIPLES_LANG_LABELS, type PrinciplesLang } from "~/lib/principles-languages";
import { m } from "~/paraglide/messages.js";

export function DocumentLanguages({ path, shown, languages }: {
  path: string; shown: PrinciplesLang; languages: { open: PrinciplesLang[]; readOnly: PrinciplesLang[] };
}) {
  const item = (lang: PrinciplesLang) => {
    const name = lang === "ja" ? m.principles_lang_original({ name: PRINCIPLES_LANG_LABELS[lang] }) : PRINCIPLES_LANG_LABELS[lang];
    return <li key={lang}>{lang === shown
      ? <span lang={lang} aria-current="page" className="font-bold">{name}</span>
      : <Link to={`${path}?lang=${lang}`} lang={lang} hrefLang={lang} className="underline">{name}</Link>}</li>;
  };
  return <nav aria-label={m.principles_langs_label()} className="space-y-2 ui-meta">
    <ul className="flex flex-wrap gap-x-3 gap-y-1">{languages.open.map(item)}</ul>
    {languages.readOnly.length > 0 && <details open={languages.readOnly.includes(shown)}>
      <summary className="cursor-pointer">{m.principles_langs_more({ count: languages.readOnly.length })}</summary>
      <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1">{languages.readOnly.map(item)}</ul>
    </details>}
  </nav>;
}
