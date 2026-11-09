import { ChevronDown } from "lucide-react";
import { PendingText } from "~/components/pending-text";
import { useEffect, useRef } from "react";
import { Link, useLocation } from "react-router";
import { LANG_LABELS, type Lang } from "~/lib/languages";
import { entryReadingLangSearch, readingLangSearch, type ReadingLanguageChoice } from "~/lib/reading-lang";
import { m } from "~/paraglide/messages.js";

// Native language links also work without scripts. Article headers use a plain text
// entrance; a loaded translation can be selected without navigating away from the text.
export function ReadingLangMenu({ choice, text, title, originalLang, entryId, translating, align = "end", className, plain = false, onSelectLanguage }: {
  choice: ReadingLanguageChoice;
  // The visible name of what is read now, and the main part of the accessible name. Default: the name of the reading language.
  text?: string;
  // A tooltip for the visible name (the model that made a translation).
  title?: string;
  // The language of the original, when the menu belongs to one article: its entry reads "(original)".
  originalLang?: Lang;
  // Article menus clear this entry's previous source/translation toggle.
  // Translation choices can override saved original-reading preferences.
  entryId?: number;
  translating?: ReadonlySet<Lang>;
  align?: "start" | "end";
  className?: string;
  plain?: boolean;
  onSelectLanguage?: (lang: Lang) => boolean;
}) {
  const location = useLocation();
  const control = useRef<HTMLDetailsElement>(null);
  // With JavaScript, an open list closes on a press outside it and on Escape (focus returns to the name). Without JavaScript it is a plain details: the name toggles it.
  useEffect(() => {
    const close = (event: Event) => {
      const element = control.current;
      if (!element?.open) return;
      if (event.type === "pointerdown" && element.contains(event.target as Node)) return;
      if (event instanceof KeyboardEvent && event.key !== "Escape") return;
      // Focus goes back to the name only when it was inside the list: an Escape that belongs to something else (a mention list in a reply field) leaves the focus where it is.
      const focusInside = element.contains(document.activeElement);
      element.open = false;
      if (event.type === "keydown" && focusInside) element.querySelector("summary")?.focus();
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", close); };
  }, []);
  const shown = text ?? LANG_LABELS[choice.current];
  if (choice.enabled.length < 2) return <span className={className}>{shown}</span>;
  return <details ref={control} key={location.key} className={`reading-lang-menu relative ui-meta text-muted-foreground${className ? ` ${className}` : ""}`}>
    <summary aria-label={`${m.reading_lang_label()}: ${shown}`} title={title} className={`link-ui inline-flex min-h-6 cursor-pointer list-none items-center gap-0.5 whitespace-nowrap [&::-webkit-details-marker]:hidden${plain ? " underline" : ""}`}>
      {shown}{!plain && <ChevronDown aria-hidden="true" className="size-3 shrink-0" />}
    </summary>
    <nav aria-label={m.reading_lang_label()} className={`absolute z-20 mt-1 min-w-40 max-w-[calc(100vw-2rem)] rounded-lg border bg-popover p-1 shadow-md ${align === "end" ? "end-0" : "start-0"}`}>
      <ul>
        {choice.enabled.map(lang => {
          const waiting = translating?.has(lang) ?? false;
          const selected = entryId === undefined
            ? readingLangSearch(location.search, lang, choice.usual, choice.ui ?? null)
            : entryReadingLangSearch(location.search, lang, choice, originalLang, entryId);
          return <li key={lang}>
            <Link reloadDocument to={`${location.pathname}${selected}`} lang={lang} hrefLang={lang}
              onClick={event => {
                if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || !onSelectLanguage?.(lang)) return;
                event.preventDefault();
                if (control.current) control.current.open = false;
              }}
              aria-current={choice.current === lang ? "page" : undefined} data-translation-pending={waiting || undefined}
              className={`ui-help block rounded px-2 py-1.5 hover:bg-muted focus-visible:bg-muted ${waiting ? "text-muted-foreground" : "text-foreground"}${choice.current === lang ? " font-medium" : ""}`}>
              {lang === originalLang ? m.reading_lang_original({ name: LANG_LABELS[lang] }) : LANG_LABELS[lang]}
              {waiting && <span className="sr-only"> <PendingText short /></span>}
            </Link>
          </li>;
        })}
      </ul>
    </nav>
  </details>;
}

