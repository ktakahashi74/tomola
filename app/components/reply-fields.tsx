import { lazy, Suspense, useId } from "react";
import { BodyCounter } from "~/components/body-counter";
import { DraftKeeper } from "~/components/draft-keeper";
import { MentionTextarea } from "~/components/mention-autocomplete";
import { QuietBoundary, usePageReady } from "~/components/quiet-boundary";
import { SendButton } from "~/components/signed-form";
import { Field, FieldLabel } from "~/components/ui/field";
import { entryFieldError } from "~/lib/entry-field-error";
import { m } from "~/paraglide/messages.js";
import type { ReactNode } from "react";
import type { ReplyExtrasProps } from "~/components/reply-extras-content";

const Extras = lazy(() => import("./reply-extras-content"));

// The reply field: a light field that starts as one line and opens up when it is used, with one button. The language (a line under the field) and "…" (preview, writing help, writing
// with an AI) come after the page is ready, from a part loaded then. What is typed is kept on this device (DraftKeeper), so a reply has no draft button of its own.
// `above` holds what belongs above the field (the reply target, the tag of a reply to a question); `aiTools` the writing-with-AI entry (inside "…").
// `actions` replaces the reply button (the draft screen has its own); `keeper` names the local copy and the text the screen starts from (a reply form starts empty); `autoLang` false
// is for a saved draft, whose language is already chosen.
export function ReplyFields({ owner, threadId, error, errorId, errorText, defaultLang, defaultBody = "", selectedLang, above, aiTools, actions, keeper, nushiAvailable, autoLang = true, invalidatePreviewOnEdit = false }: {
  owner: string; threadId: number; error?: string; errorId?: string; errorText?: string; defaultBody?: string; above?: ReactNode; actions?: ReactNode; keeper?: { scope: string; startBody: string; family?: string };
} & Omit<ReplyExtrasProps, "autoLang" | "invalidatePreviewOnEdit"> & { autoLang?: boolean; invalidatePreviewOnEdit?: boolean }) {
  const bodyId = useId();
  const bodyError = entryFieldError(error, "body", errorId);
  const ready = usePageReady();
  // Until the language control is there, the form still carries the language it starts with (automatic, or the draft's own).
  const language = <input type="hidden" name="lang" value={autoLang ? (selectedLang ?? "") : (selectedLang || defaultLang)} />;
  return <>
    {above}
    <DraftKeeper owner={owner} scope={keeper?.scope ?? `reply:${threadId}`} family={keeper?.family} startBody={keeper?.startBody ?? ""} />
    <Field>
      <FieldLabel htmlFor={bodyId} className="sr-only">{m.field_body()}</FieldLabel>
      <MentionTextarea id={bodyId} name="body" dir="auto" {...bodyError} required rows={1} placeholder={m.field_body_placeholder_reply()} defaultValue={defaultBody}
        className="flex field-sizing-content min-h-10 w-full rounded-lg border border-input bg-transparent px-2.5 py-2 text-base transition-colors outline-none placeholder:text-muted-foreground focus:min-h-28 not-placeholder-shown:min-h-28 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm" />
    </Field>
    <BodyCounter />
    {errorText && <p id={errorId} role="alert" className="text-destructive">{errorText}</p>}
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      {actions ?? <SendButton>{m.submit_reply()}</SendButton>}
      {ready
        ? <QuietBoundary fallback={language}><Suspense fallback={language}><Extras nushiAvailable={nushiAvailable} error={error} errorId={errorId} defaultLang={defaultLang} selectedLang={selectedLang} autoLang={autoLang} invalidatePreviewOnEdit={invalidatePreviewOnEdit} aiTools={aiTools} /></Suspense></QuietBoundary>
        : language}
    </div>
  </>;
}
