import { entryFieldError } from "~/lib/entry-field-error";
import { FieldLabel } from "~/components/ui/field";
import { Textarea } from "~/components/ui/textarea";
import { Link } from "react-router";
import { lazy, Suspense, useId, useState, type ComponentType, type ReactNode } from "react";
import { QuietBoundary, usePageReady } from "~/components/quiet-boundary";
import { EntryFields, EntryLanguage, entryErrorMessage, type BodyEditorProps } from "~/components/entry-fields";
import { DraftKeeper } from "~/components/draft-keeper";
import { orBlank } from "~/lib/local-draft";
import { PostSettings } from "~/components/post-settings";
import { StanceTagSelect } from "~/components/stance-tag";
import { TitleField } from "~/components/title-field";
import type { EditableEntry } from "~/lib/entries.server";
import { languageLabel } from "~/lib/language-label";
import { LANG_LABELS, isLang } from "~/lib/languages";
import type { StanceTag } from "~/lib/stances";
import { m } from "~/paraglide/messages.js";
import { SignedForm, SendButton } from "~/components/signed-form";

const AiImport = lazy(() => import("~/components/edit-ai-import"));
const RefusedEditKeeper = lazy(() => import("~/components/refused-edit-keeper"));

// Shared author editor; moderator typo corrections keep the source language fixed.
// warning: the notice below the title (a question becomes uneditable once a stance is recorded; the typo-correction notice). stanceTag: reply-tag choices, only when editing a reply to a question; current is its existing tag.
// values: input returned after a validation error, preserving it even when JavaScript is disabled and the page reloads.
export function EntryEditForm({
  entry,
  error,
  values,
  heading,
  cancelTo,
  warning,
  stanceTag,
  fixNote,
  baseSourceHash,
  editVersion,
  conflict,
  errorText,
  signingView,
  signPosts,
  BodyEditor,
  bodyAccessory,
  writingHelp,
  keeper,
  destination,
}: {
  // asksStance: a question keeps its title, so the field is required for it.
  entry: Pick<EditableEntry, "kind" | "lang" | "title" | "body"> & { asksStance?: boolean };
  error?: string;
  values?: { title: string; body: string; lang?: string; note?: string; stanceTag?: StanceTag | null; editVersion?: string };
  heading: string;
  cancelTo: string;
  warning?: string;
  stanceTag?: { current: StanceTag | null };
  // Moderator typo corrections to a locked question: show a required explanation of what was corrected.
  fixNote?: boolean;
  // The base of a moderator's fix: the hash of the text the form was opened on. It is sent back, and a changed text makes the fix stale (fixEntry). The form is keyed by it,
  // so that when the text changed (a reload after a stale fix) the fields start again from the current text instead of keeping what was typed over the old one.
  baseSourceHash?: string;
  editVersion?: string;
  conflict?: { message: string; label: string; href: string };
  // The screen may supply the error wording: a typo-correction error can concern either the moderation action or the post. Otherwise use entryErrorMessage.
  errorText?: string;
  signingView?: string;
  signPosts: boolean;
  BodyEditor?: ComponentType<BodyEditorProps>;
  bodyAccessory?: ReactNode;
  writingHelp?: ReactNode;
  // Names the local copy of the unsent edit (the owner and the entry); the screen starts from the saved text.
  keeper?: { owner: string; scope: string };
  destination?: ReactNode;
}) {
  const errorId = useId();
  const ready = usePageReady();
  const [candidate, setCandidate] = useState("");
  const [lang, setLang] = useState(values?.lang ?? entry.lang);
  // Loader revalidation must not advance the base under the member's unsent text.
  const [opened] = useState({ ...entry, editVersion: values?.editVersion ?? editVersion });
  const base = fixNote ? entry : opened;
  const long = entry.kind === "topic";
  return (
    <main className="space-y-4">
      <h1 className="text-2xl font-bold">{heading}</h1>
      {fixNote && <p className="ui-meta text-muted-foreground">{m.original_lang({ lang: languageLabel(entry.lang) })}</p>}
      <SignedForm protectUnsaved="edit" unsavedInitialValues={{ title: base.title, body: base.body, lang: base.lang, stanceTag: stanceTag?.current ?? "" }} signatureRequired={signPosts} method="post" className="space-y-3" key={baseSourceHash}>
        {signingView && <input type="hidden" name="signingView" value={signingView} />}
        {baseSourceHash !== undefined && <input type="hidden" name="sourceHash" value={baseSourceHash} />}
        {opened.editVersion !== undefined && <input type="hidden" name="editVersion" value={opened.editVersion} />}
        {keeper && <DraftKeeper {...keeper} startTitle={entry.kind === "topic" ? orBlank(base.title) : undefined} startBody={base.body} />}
        {keeper && ready && <QuietBoundary><Suspense fallback={null}><RefusedEditKeeper {...keeper} startTitle={entry.kind === "topic" ? orBlank(base.title) : undefined} startBody={base.body} refused={error ? values : undefined} /></Suspense></QuietBoundary>}
        {destination}
        {entry.kind === "topic" && <TitleField error={error} errorId={errorId} required={entry.asksStance === true} defaultValue={values?.title ?? entry.title ?? undefined} />}
        {warning && <p className="ui-help text-muted-foreground">{warning}</p>}
        <EntryFields previewKind={entry.kind} error={error} errorId={errorId} fixedLang={fixNote ? entry.lang : undefined} defaultLang={entry.lang} selectedLang={values?.lang} defaultBody={values?.body ?? entry.body} BodyEditor={BodyEditor} bodyAccessory={bodyAccessory} writingHelp={writingHelp} showLanguage={false} tall={long} previewLanguage={lang} />
        {!fixNote && <PostSettings summary={(long ? m.post_summary_lang : m.reply_summary_lang)({ lang: lang === "other" ? m.source_language_other() : isLang(lang) ? LANG_LABELS[lang] : lang })} open={error === "invalid_lang"}>
          <EntryLanguage error={error} errorId={errorId} defaultLang={entry.lang} value={lang} onChange={setLang} />
        </PostSettings>}
        {!fixNote && ready && <QuietBoundary><Suspense fallback={null}><AiImport candidate={candidate} onCandidateChange={setCandidate} /></Suspense></QuietBoundary>}
        {stanceTag && <StanceTagSelect error={error} errorId={errorId} defaultValue={values?.stanceTag === undefined ? stanceTag.current : values.stanceTag} />}
        {fixNote && (
          <FieldLabel className="w-full flex-col items-start">
            {m.mod_fix_note()}
            <Textarea {...entryFieldError(error, "note", errorId)} dir="auto" name="note" required rows={2} maxLength={500} defaultValue={values?.note ?? ""} />
          </FieldLabel>
        )}
        {error && <p id={errorId} role="alert" className="text-destructive">{conflict?.message ?? errorText ?? entryErrorMessage(error)}{conflict && <> <a className="underline" href={conflict.href} target="_blank" rel="noreferrer noopener">{conflict.label}</a></>}</p>}
        <div className="flex items-center gap-4">
          <SendButton>{m.save_changes()}</SendButton>
          {/* A plain link: leaving with unsaved changes asks first (the form's guard), like every other way of leaving. */}
          <Link to={cancelTo} className="ui-meta underline">
            {m.cancel()}
          </Link>
        </div>
      </SignedForm>
    </main>
  );
}
