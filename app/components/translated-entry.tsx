import { toggleFigure } from "~/lib/figure";
import { Badge } from "~/components/ui/badge";
import { PendingText } from "~/components/pending-text";
import { buttonVariants } from "~/components/ui/button";
import { Fragment, lazy, Suspense, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useLocation } from "react-router";
import { TranslationLabel, translationFromText } from "~/components/translation-label";
import { ReadingLangMenu } from "~/components/reading-lang-menu";
import type { ReadingLanguageChoice } from "~/lib/reading-lang";
import { ReadingToc } from "~/components/reading-toc";
import { toggleSearch, type Shown } from "~/lib/display";
import type { EntryDisplay } from "~/lib/entry-display.server";
import { LANG_LABELS, type Lang } from "~/lib/languages";
import type { ReadingInfo, ReadingVersions } from "~/lib/reading";
import { languageLabel } from "~/lib/language-label";
import { m } from "~/paraglide/messages.js";

const BodyTranslationWait = lazy(() => import("~/components/body-translation-wait"));

// The translation that a report of "wrong translation" is about, for the version shown first: the shown translation, or the translation an older human version is based on. null when the original is shown.
export function initialReportedTranslation(display: EntryDisplay): EntryDisplay["translation"] {
  const tr = display.translation;
  if (display.shown === "translation" && tr !== null) return tr;
  if (display.shown === "older" && tr?.older?.html != null) return tr;
  return null;
}

// Hold original and current translation HTML for instant toggling; older versions navigate to load their HTML.
// Without JavaScript, switch links navigate to ?orig=<id> (original), ?tr=<id> (translation), or ?old=<id> (a human translation based on an older source version),
// producing the same result.
// Set title/body lang attributes to the displayed text's language: the original language for the original, or the translation language.
// A topic without a title (a short remark): the heading (h1) is the one line at the start of the body (headline, of the version shown). The heading element is there for screen readers and the structure of the page.
export function TranslatedEntry({
  id,
  kind,
  lang,
  title,
  headline,
  html,
  display,
  meta,
  footer,
  showHeading = true,
  reading,
  toolsBefore,
  toolsAfter,
  readingActions,
  readingLanguage,
  quotable = false,
  onReportedChange,
  quoteHandle,
}: {
  id: number;
  kind: "topic" | "reply";
  lang: Lang;
  // The title of the original (topics only). null for a topic means a topic without a title.
  title: string | null;
  // For a topic without a title: the one line at the start of the body of the original (headlineFromBody).
  headline?: string;
  // HTML of the original body.
  html: string;
  display: EntryDisplay;
  // Content between the title and body, such as the author line. A function gets the reading info and, for a reply, the one-line translation status and switch (null when the reply has none), so that
  // the reply can draw it alongside the author and time. A reading header receives its translation switches and notes in the same slot, and its language menu separately.
  // `view` (the reading layout only) says what the reader is reading, in one phrase for the byline: the language of the original, or "AI-translated from English (Gemini)", with the model for a tooltip.
  meta: ReactNode | ((info: ReadingInfo | null, controls: ReactNode, view: { text: string; title?: string; lang: Lang }, languageMenu: ReactNode) => ReactNode);
  // Content below the body, such as a mistranslation report while a translation is shown; receives whether a translation is being displayed.
  footer?: (shownTranslation: EntryDisplay["translation"]) => ReactNode;
  showHeading?: boolean;
  // Only the topic page opts into the reading layout; introductions and replies retain their layout.
  reading?: ReadingVersions;
  readingLanguage?: { choice: ReadingLanguageChoice; translating?: ReadonlySet<Lang> };
  toolsBefore?: ReactNode;
  toolsAfter?: ReactNode;
  readingActions?: (lang: Lang) => { actions: ReactNode; actionMenu: ReactNode };
  quotable?: boolean;
  // Tells the page which translation is shown now (the one a report of a wrong translation is about), for a control that the page draws outside this component. Called after every change of the version shown.
  onReportedChange?: (translation: EntryDisplay["translation"]) => void;
  // The author's handle, carried with the quotable body so that a quotation can say where it comes from.
  quoteHandle?: string;
}) {
  const location = useLocation();
  const bodyRef = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState<Shown>(display.shown);
  const switchRef = useRef<HTMLAnchorElement>(null);
  const restoreSwitch = useRef(false);
  const toggledOriginal = useRef(false);
  useLayoutEffect(() => {
    if (restoreSwitch.current) {
      restoreSwitch.current = false;
      const languageMenu = bodyRef.current?.closest("article")?.querySelector<HTMLElement>(".reading-lang-menu summary");
      const target = reading && shown === "original" ? languageMenu : switchRef.current;
      target?.focus({ preventScroll: true });
    }
  });
  const tr = display.translation;
  const older = tr?.older ?? null;
  const showing = shown === "translation" && tr !== null ? tr : null;
  const showingOlder = shown === "older" && older?.html != null ? older : null;
  const current: Shown = showing ? "translation" : showingOlder ? "older" : "original";

  const anchor = `${kind === "topic" ? "p" : "c"}-${id}`;
  // Switches to versions that are not currently shown, limited to versions available to this viewer.
  const options: Array<{ target: Shown; label: string; title?: string }> = [];
  if (tr && current !== "translation" && (!reading || current !== "original")) options.push({ target: "translation", label: m.show_translation() });
  if (current !== "original") options.push({ target: "original", label: m.show_original() });
  if (older && current !== "older" && (!reading || current !== "original")) {
    options.push({ target: "older", label: reading ? m.reading_show_older() : m.show_older_human(), title: reading ? m.show_older_human() : undefined });
  }

  const reported = showing ?? (showingOlder ? tr : null);
  useEffect(() => { onReportedChange?.(reported); }, [reported, onReportedChange]);
  useEffect(() => {
    const ids = (showing ?? showingOlder)?.unseenIds;
    let active = true;
    if (ids?.length && /^\/t\/\d+$/.test(location.pathname)) void import("~/lib/translation-seen").then(module => { if (active) module.markTranslationSeen(ids); });
    return () => { active = false; };
  }, [showing, showingOlder, location.pathname, location.search]);
  const shownTitle = showing?.title ?? showingOlder?.title ?? null;
  const shownHeadline = showing?.headline ?? showingOlder?.headline ?? null;
  const heading =
    kind !== "topic"
      ? null
      : title === null
        ? { text: (showing || showingOlder ? shownHeadline : headline) || m.headline_empty(), lang: showing || showingOlder ? (tr as NonNullable<typeof tr>).lang : lang, fromBody: true }
        : shownTitle
          ? { text: shownTitle.text, lang: (showing ?? tr)!.lang, fromBody: false }
          : { text: title, lang, fromBody: false };
  const bodyLang = showing || showingOlder ? (tr as NonNullable<typeof tr>).lang : lang;
  const bodyHtml = showing?.html ?? showingOlder?.html ?? html;
  useEffect(() => {
    const body = bodyRef.current;
    body?.addEventListener("click", toggleFigure);
    return () => body?.removeEventListener("click", toggleFigure);
  }, [bodyHtml]);
  const info = reading ? (reading[current] ?? reading.original) : null;
  const switchLinks = options.map((option, index) => (
    <a
      key={option.target}
      ref={index === 0 ? switchRef : undefined}
      href={`${toggleSearch(location.search, id, option.target)}#${anchor}`}
      rel="nofollow"
      title={option.title}
      className={reading ? "link-ui underline" : buttonVariants({ variant: "link", className: "h-auto px-0 ui-meta" })}
      onClick={(e) => {
        // Leave modified clicks and middle clicks to the browser's default behavior, such as opening a new tab.
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        if (option.target === "older" && older?.html == null) return;
        e.preventDefault();
        restoreSwitch.current = true;
        toggledOriginal.current = option.target === "original";
        setShown(option.target);
      }}
    >
      {option.label}
    </a>
  ));

  // A reply's status and switch sit after its name and time: the source language when the original is
  // shown, or translation provenance, with pending/failure notes beside the original. The model is in the label tooltip.
  const replyControls = kind === "reply" && (tr || display.pending || display.unavailable) ? (() => {
    const label = languageLabel(lang);
    const parts: ReactNode[] = [];
    if (showing) parts.push(<TranslationLabel key="label" fromLang={label} kind={showing.kind} engine={showing.engine} model={showing.model} fallback={showing.fallback} stale={showing.stale} structureMismatch={showing.structureMismatch} />);
    else if (showingOlder) parts.push(<Fragment key="label"><TranslationLabel fromLang={label} kind={showingOlder.kind} engine={showingOlder.engine} model={showingOlder.model} /> <span className="text-notice-muted">{m.label_older()}</span></Fragment>);
    else {
      parts.push(<span key="label">{m.reading_lang_original({ name: label })}</span>);
      if (display.pending && !display.needsCurrent) parts.push(<span key="pending"><PendingText short /></span>);
      if (display.unavailable) parts.push(<span key="unavailable" role="status">{m.translation_unavailable()}</span>);
    }
    if (showing?.reportNotice) parts.push(<span key="notice" role="note" className="text-notice-emphasis">{showing.reportNotice === "open" ? m.report_notice_open() : m.report_notice_retried()}</span>);
    for (const link of switchLinks) parts.push(link);
    return <span className="inline-flex flex-wrap items-center gap-x-4 gap-y-1">{parts.map((part, index) => <span key={index}>{part}{index < parts.length - 1 && <span className="sr-only"> </span>}</span>)}</span>;
  })() : null;
  // The reading layout: what is read is said once, in the byline (view). This row holds only what is left: the switch between the translation and the original, and the notes.
  const view = showing
    ? { text: translationFromText(showing.kind, showing.engine, languageLabel(lang)), title: showing.model ?? undefined }
    : showingOlder
      ? { text: translationFromText(showingOlder.kind, showingOlder.engine, languageLabel(lang)), title: showingOlder.model ?? undefined }
      : { text: LANG_LABELS[lang] };
  const languageMenu = reading && readingLanguage && <ReadingLangMenu {...readingLanguage} text={m.reading_other_languages_read()} originalLang={lang} entryId={id} align="start" plain className="inline-block align-baseline"
    onSelectLanguage={target => {
      // Ordinary language choices navigate; only returning from the source switch stays in place.
      if (!tr || current !== "original" || !toggledOriginal.current || target !== tr.lang) return false;
      restoreSwitch.current = true;
      toggledOriginal.current = false;
      setShown("translation");
      return true;
    }} />;
  const readingControls = reading && (current !== "original" || (display.pending && !display.needsCurrent) || display.unavailable) ? (
    <div className="contents">
      {showing && <TranslationLabel notesOnly kind={showing.kind} engine={showing.engine} fallback={showing.fallback} stale={showing.stale} structureMismatch={showing.structureMismatch} />}
      {showingOlder && <span className="ui-meta text-notice-muted">{m.label_older()}</span>}
      {!showing && !showingOlder && display.pending && !display.needsCurrent && <span className="ui-meta text-muted-foreground"><PendingText /></span>}
      {!showing && !showingOlder && display.unavailable && <span role="status" className="ui-meta text-muted-foreground">{m.translation_unavailable()}</span>}
      {showing?.reportNotice && (
        <span role="note" className="ui-meta text-notice-emphasis">
          {showing.reportNotice === "open" ? m.report_notice_open() : m.report_notice_retried()}
        </span>
      )}
      {switchLinks}
    </div>
  ) : null;
  const translationControls = reading ? readingControls : (tr || display.pending || display.unavailable) && (
    <div className={reading ? "contents" : "flex flex-wrap items-center gap-2 ui-meta"}>
      {showing ? (
        <TranslationLabel kind={showing.kind} engine={showing.engine} model={showing.model} fallback={showing.fallback} stale={showing.stale} structureMismatch={showing.structureMismatch} />
      ) : showingOlder ? (
        <>
          <TranslationLabel kind={showingOlder.kind} engine={showingOlder.engine} model={showingOlder.model} />
          <span className="ui-meta text-notice-muted">{m.label_older()}</span>
        </>
      ) : (
        <>
          <Badge variant="secondary" className="text-muted-foreground">{m.label_original()}</Badge>
          {display.pending && !display.needsCurrent && <span className="ui-meta text-muted-foreground"><PendingText /></span>}
          {display.unavailable && <span role="status" className="ui-meta text-muted-foreground">{m.translation_unavailable()}</span>}
        </>
      )}
      {showing?.reportNotice && (
        <span role="note" className="ui-meta text-notice-emphasis">
          {showing.reportNotice === "open" ? m.report_notice_open() : m.report_notice_retried()}
        </span>
      )}
      {switchLinks}
    </div>
  );
  return (
    <>
      {showHeading && heading && (
        // Keep a structural heading without repeating the start of a titleless post on screen.
        <h1 dir="auto" lang={heading.lang} className={heading.fromBody ? "sr-only" : reading ? "reading-title" : "text-2xl font-bold"}>
          {heading.text}
        </h1>
      )}
      {typeof meta === "function" ? meta(info, reading ? readingControls : replyControls, { ...view, lang: showing || showingOlder ? tr!.lang : lang }, languageMenu) : meta}
      {kind === "reply" && typeof meta === "function" ? null : reading ? (toolsBefore || (typeof meta !== "function" && translationControls) || toolsAfter) && (
        <div data-reading-tools="" className="flex flex-wrap items-center gap-x-3 gap-y-2 ui-meta text-muted-foreground">
          {toolsBefore}
          {typeof meta !== "function" && translationControls}
          {toolsAfter}
        </div>
      ) : translationControls}
      {display.needsCurrent && <Suspense fallback={<PendingText short />}><BodyTranslationWait entryId={id} /></Suspense>}
      {(info || readingActions) && <ReadingToc headings={info?.headings ?? []} lang={bodyLang} bodyRef={bodyRef} {...readingActions?.(bodyLang)} />}
      <div ref={bodyRef} dir="auto" lang={bodyLang} className={reading ? "longread" : "longread longread-compact"} data-reading-body={reading ? "" : undefined} data-quote-entry={quotable ? id : undefined} data-quote-kind={quotable ? kind : undefined} data-quote-handle={quotable ? quoteHandle : undefined} data-quote-translated={quotable && (showing || showingOlder) ? "1" : undefined} dangerouslySetInnerHTML={{ __html: bodyHtml }} />
      {footer?.(showing ?? (showingOlder ? (tr as NonNullable<typeof tr>) : null))}
    </>
  );
}
