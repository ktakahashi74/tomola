import { Badge } from "~/components/ui/badge";
import { Tooltip, TooltipTrigger, TooltipContent } from "~/components/ui/tooltip";
import type { ShownKind } from "~/lib/display";
import { m } from "~/paraglide/messages.js";

// Engine display names (proper names; fake is for development).
export function engineName(engine: string | null): string {
  if (engine === "gemini") return "Gemini";
  if (engine === "claude") return "Claude";
  if (engine === "fake") return m.engine_fake();
  return engine ?? "?";
}

// The one phrase that says what a reader is reading when it is a translation: "AI-translated from English (Gemini)", "Translated from English, edited by a person". An article's byline shows it.
export function translationFromText(kind: ShownKind, engine: string | null, fromLang: string): string {
  return kind === "human" ? m.label_from_lang_human({ lang: fromLang }) : m.label_from_lang_machine_engine({ lang: fromLang, engine: engineName(engine) });
}

export function translationLabelText(kind: ShownKind, engine: string | null): string {
  if (kind === "human") return m.label_human();
  return m.label_machine({ engine: engineName(engine) });
}

// Small translation-status label: machine translation with its engine name, or human-corrected. Also note a secondary-engine fallback or an updated original.
export function TranslationLabel({
  kind,
  engine,
  model,
  fallback,
  stale,
  concise = false,
  fromLang,
  plain = false,
  structureMismatch,
  notesOnly = false,
}: {
  kind: ShownKind;
  engine: string | null;
  model?: string | null;
  // A secondary engine translated this because the primary engine refused or failed.
  fallback?: boolean;
  stale?: boolean;
  concise?: boolean;
  // A list row: one short phrase with no ground ("AI-translated from English"). It says the text is a machine translation by itself; the engine and model are for the page of the post.
  fromLang?: string;
  // The same without the language (a list of one language names it already) and without a ground.
  plain?: boolean;
  structureMismatch?: boolean;
  // Only the notes (a fallback engine, an updated original, a changed structure), without the label itself: the byline already says what is read.
  notesOnly?: boolean;
}) {
  const label = fromLang ? <span>{kind === "human" ? m.label_from_lang_human({ lang: fromLang }) : m.label_from_lang_machine({ lang: fromLang })}</span> : plain ? <span>{kind === "human" ? m.label_human() : m.label_machine_plain()}</span> : <Badge variant="secondary" className="text-muted-foreground">{concise && kind !== "human" ? m.label_machine_short() : translationLabelText(kind, engine)}</Badge>;
  return (
    <>
      {notesOnly ? null : model ? <><Tooltip><TooltipTrigger render={label} /><TooltipContent role="tooltip">{model}</TooltipContent></Tooltip><span className="sr-only"> {model}</span></> : label}
      {fallback && (
        <Tooltip><TooltipTrigger render={<Badge variant="secondary" className="bg-notice text-notice-foreground" />}>
          {m.label_fallback()}
        </TooltipTrigger><TooltipContent role="tooltip">{m.label_fallback_title()}</TooltipContent><span className="sr-only"> {m.label_fallback_title()}</span></Tooltip>
      )}
      {stale && <span className="ui-meta text-notice-muted">{m.label_stale()}</span>}
      {structureMismatch && <span role="note" className="ui-meta text-notice-muted">{m.translation_structure_note()}</span>}
    </>
  );
}
