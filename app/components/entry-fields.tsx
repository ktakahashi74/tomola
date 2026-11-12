import { entryFieldError } from "~/lib/entry-field-error";
import { Field, FieldLabel, FieldDescription } from "~/components/ui/field";
import { useId, useState, type ComponentType, type ReactNode } from "react";
import { EntryLanguage } from "~/components/entry-language";
import { entryErrorMessage } from "~/lib/entry-error-message";
import { EntryPreview } from "~/components/entry-preview";
import { BodyCounter } from "~/components/body-counter";
import { MentionTextarea } from "~/components/mention-autocomplete";
import type { Lang, SourceLang } from "~/lib/languages";
import { m } from "~/paraglide/messages.js";

// Shared post-form fields (body and language). No field asks how AI was used; only pasted frontmatter or the API carries ai_assistance.
// With fixedLang, omit the language control (moderator typo corrections).
// pasteFrontmatter (new-topic and reply forms): prepend and default to the "自動" option with an empty value. Submitting it unchanged
// uses the frontmatter pasted at the start of the body, or the default language when absent. An explicit selection overrides frontmatter.
export type BodyEditorProps = {
  children: ReactNode;
  id: string;
  lang?: string;
  pasteFrontmatter?: "topic" | "reply";
  onActiveChange: (active: boolean) => void;
  invalid?: boolean;
  describedBy?: string;
  placeholder?: string;
  tall?: boolean;
};

export function EntryFields({
  defaultLang,
  previewKind,
  fixedLang,
  selectedLang,
  defaultBody = "",
  pasteFrontmatter,
  onBodyInput,
  showLanguage = true,
  rows = 10,
  invalidatePreviewOnEdit = false,
  BodyEditor,
  editorLang,
  writingHelp,
  bodyAccessory,
  disabledClosed,
  error,
  errorId,
  bodyPlaceholder,
  tall = false,
  previewLanguage,
}: {
  previewKind?: "topic" | "reply";
  defaultLang?: SourceLang;
  fixedLang?: SourceLang;
  // The values chosen in the form that is drawn again after a refusal (the value of the select; "" is "automatic"). Without them the selects start at their defaults.
  selectedLang?: string;
  defaultBody?: string;
  // The form kind that reads pasted frontmatter: "topic" for a new topic or "reply" for a reply.
  pasteFrontmatter?: "topic" | "reply";
  // Called with the text of the body whenever it is typed or pasted (the new-post form uses it to know that a frontmatter was pasted).
  onBodyInput?: (value: string) => void;
  showLanguage?: boolean;
  rows?: number;
  invalidatePreviewOnEdit?: boolean;
  BodyEditor?: ComponentType<BodyEditorProps>;
  editorLang?: string;
  writingHelp?: ReactNode;
  bodyAccessory?: ReactNode;
  disabledClosed?: boolean;
  error?: string;
  errorId?: string;
  // Shown inside the empty field and gone once something is typed.
  bodyPlaceholder?: string;
  // A tall field for long-form writing (a new post, an edit), half the screen at least.
  tall?: boolean;
  // The language the preview is drawn in, when the language control is not part of these fields (the post settings): a change of it clears a preview that was drawn.
  previewLanguage?: string;
}) {
  const bodyId = useId();
  const bodyError = entryFieldError(error, "body", errorId);
  const [richActive, setRichActive] = useState(false);
  const [previewLang, setPreviewLang] = useState(selectedLang ?? defaultLang);
  const input = <MentionTextarea
    id={bodyId}
    name="body"
    dir="auto"
    {...bodyError}
    required
    placeholder={bodyPlaceholder}
    rows={rows}
    defaultValue={defaultBody}
    onInput={onBodyInput ? (e) => onBodyInput(e.currentTarget.value) : undefined}
    className={`flex field-sizing-content ${tall ? "min-h-[40vh]" : "min-h-16"} w-full rounded-lg border border-input bg-transparent px-2.5 py-2 text-base transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm`}
    />;
  return (
    <>
      {/* The label is not around the textarea: the suggestion list that comes with it must not become part of the field's name. */}
      <Field>
        {!BodyEditor && <FieldLabel htmlFor={bodyId} className="block">
          {m.field_body()}
        </FieldLabel>}
        {BodyEditor ? <BodyEditor id={bodyId} lang={editorLang ?? fixedLang ?? defaultLang} pasteFrontmatter={pasteFrontmatter} placeholder={bodyPlaceholder} tall={tall} onActiveChange={setRichActive} invalid={bodyError["aria-invalid"]} describedBy={bodyError["aria-describedby"]}>{input}</BodyEditor> : input}
      </Field>
      <BodyCounter />
      {bodyAccessory}
      <details data-writing-tips hidden={richActive} className="space-y-2 ui-help text-muted-foreground">
        <summary className="cursor-pointer ui-meta">{m.writing_tips()}</summary>
        <FieldDescription>{m.writing_math_help()}</FieldDescription>
        <FieldDescription>{m.related_link_help()}</FieldDescription>
        {writingHelp}
        <FieldDescription><a href="/connect" target="_blank" rel="noreferrer" className="underline">{m.footer_connect()}</a></FieldDescription>
      </details>
      <div hidden={richActive}><EntryPreview kind={previewKind} fixedLang={fixedLang} pasteFrontmatter={pasteFrontmatter} invalidateOnEdit={invalidatePreviewOnEdit} selectedLang={previewLanguage ?? previewLang} /></div>
      {showLanguage && !fixedLang && <EntryLanguage error={error} errorId={errorId} defaultLang={defaultLang} selectedLang={selectedLang} disabledClosed={disabledClosed} pasteFrontmatter={Boolean(pasteFrontmatter)} onChange={invalidatePreviewOnEdit ? setPreviewLang : undefined} />}
    </>
  );
}

// These live in modules of their own, so that a screen that needs only the error words or the language control (the reply field) does not carry the whole body field.
export { EntryLanguage, entryErrorMessage };
