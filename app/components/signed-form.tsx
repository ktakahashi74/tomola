import { languageLabel } from "~/lib/language-label";
import { UnsavedFormGuard, type UnsavedInitialValues } from "~/components/unsaved-form-guard";
import { PersistentDetails } from "~/components/persistent-details";
import { Button } from "~/components/ui/button";
import { createContext, lazy, Suspense, useContext, useEffect, useRef, useState, type ComponentProps } from "react";
import { FormLanguageChangeContext, FormVillageReviewContext, type VillageReview } from "~/components/form-contexts";
import { flushSync } from "react-dom";
import { Dialog, DialogContent, DialogTitle, DialogClose } from "~/components/ui/dialog";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "~/components/ui/select";
import { Form, useNavigation, useSubmit } from "react-router";
import { loadSigningAuthentication } from "~/lib/signing-authentication";
import { SIGNATURE_ASSERTION_FIELD, SIGNATURE_CHALLENGE_FIELD, type SigningContent, type SigningOperation, type SigningOptions, type SigningPreview } from "~/lib/signing";
import { useEnabledLangs } from "~/lib/use-enabled-langs";
import { postingVillageName } from "~/lib/village-name";
import { isLang, LANG_LABELS } from "~/lib/languages";
import { m } from "~/paraglide/messages.js";
import { readerLoginHref } from "~/lib/public-reading";

const SourceLanguageNotice = lazy(() => import("./source-language-notice"));

type Pending = { fields: [string, string][]; action: string; preview: SigningPreview };
// The intent ("" for the main button) of this form's submission that is in flight, or null. SendButton reads it.
export const FormSendingContext = createContext<string | null>(null);

// A submit button that says "Sending…" from the moment it is pressed and cannot be pressed twice. Give the `intent` value it submits (none for the main button).
export function SendButton({ intent, children, disabled, ...props }: Omit<ComponentProps<typeof Button>, "name" | "value" | "type"> & { intent?: string }) {
  const sending = useContext(FormSendingContext);
  const mine = sending !== null && sending === (intent ?? "");
  return <Button {...props} type="submit" {...(intent ? { name: "intent", value: intent } : {})} disabled={disabled || sending !== null}>{mine ? m.form_sending() : children}</Button>;
}
class SigningRequestError extends Error {
  constructor(code: string, readonly village?: string, readonly explanation?: string) { super(code); }
}
async function signingRequest(body: unknown) {
  const response = await fetch("/signing", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), redirect: "manual", cache: "no-store" });
  if (response.status === 401 || response.type === "opaqueredirect") throw new SigningRequestError("login_required");
  if (response.status >= 500 && !response.headers.get("Content-Type")?.includes("application/json")) throw new SigningRequestError("network_failed");
  let result;
  try { result = await response.json(); }
  catch { throw new SigningRequestError("network_failed"); }
  if (result?.error === "maintenance_readonly") throw new SigningRequestError("maintenance_readonly", undefined, typeof result.message === "string" ? result.message : undefined);
  if (response.status >= 500) throw new SigningRequestError("network_failed");
  if (!response.ok) throw new SigningRequestError(typeof result?.error === "string" ? result.error : "signature_failed", typeof result?.village === "string" ? result.village : undefined);
  return result;
}
function signingFailureMessage(error: unknown): string {
  if (error instanceof SigningRequestError && error.message === "maintenance_readonly") return error.explanation || m.maintenance_readonly();
  if (error instanceof SigningRequestError && error.message === "login_required") return m.signing_login_required();
  if (error instanceof Error && error.message === "body_too_complex") return m.error_body_too_complex();
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
  if (cause instanceof Error && cause.name === "NotAllowedError") return m.signing_cancelled();
  if (error instanceof TypeError || error instanceof SigningRequestError && error.message === "network_failed") return m.signing_network_failed();
  if (typeof window.PublicKeyCredential === "undefined" || cause instanceof Error && cause.name === "NotSupportedError") return m.signing_unsupported();
  return m.signing_failed();
}
function SigningFailure({ message }: { message: string }) {
  return <><p role="alert" className="text-destructive">{message}</p>{message === m.signing_login_required() && <a className="underline" href={readerLoginHref(`${window.location.pathname}${window.location.search}${window.location.hash}`, "")} target="_blank" rel="noreferrer noopener">{m.login_title()}</a>}</>;
}
const pairsOf = (form: FormData) => [...form.entries()].map(([name, value]) => [name, String(value)] as [string, string]);

// Keep the accepted snapshot immutable. Ordinary writes and draft saves retain native form submission.
export function SignedForm({ children, signatureRequired, protectUnsaved, unsavedInitialValues, preserveUnsavedOnSamePath, confirmAiDraft = false, signIntent, onSubmit, onClickCapture, ...props }: ComponentProps<typeof Form> & { signatureRequired: boolean; protectUnsaved?: "new" | "edit"; unsavedInitialValues?: UnsavedInitialValues; preserveUnsavedOnSamePath?: boolean; confirmAiDraft?: boolean; signIntent?: string }) {
  const [ready, setReady] = useState(false);
  useEffect(() => { setReady(true); }, []);
  const routerSubmit = useSubmit();
  const bypass = useRef(false);
  function allowSubmission() {
    bypass.current = true;
    setTimeout(() => { bypass.current = false; }, 0);
  }
  const submit: typeof routerSubmit = (target, options) => {
    allowSubmission();
    return routerSubmit(target, options).catch(error => { bypass.current = false; throw error; });
  };
  const enabled = useEnabledLangs();
  const element = useRef<HTMLFormElement>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const navigation = useNavigation();
  useEffect(() => {
    if (!pending && !busy && navigation.state === "idle") element.current?.dispatchEvent(new Event("tomola:autosave-resume"));
  }, [pending, busy, navigation.state]);
  const sending = navigation.state !== "idle" && navigation.formData?.has("body") && navigation.formAction
    && element.current && new URL(navigation.formAction, window.location.href).pathname === new URL(element.current.action).pathname
    ? String(navigation.formData.get("intent") ?? "") : null;
  const [error, setError] = useState<string | null>(null);
  const [authenticate, setAuthenticate] = useState<Awaited<ReturnType<typeof loadSigningAuthentication>> | null>(null);
  useEffect(() => {
    if (!pending?.preview.signatureRequired) return;
    let active = true;
    // Finish loading before the confirmation button can request a passkey.
    // A failed load returns to the unchanged form and its existing retry path.
    void loadSigningAuthentication().then(start => {
      if (active) setAuthenticate(() => start);
    }).catch(failure => {
      if (active) { setPending(null); setError(signingFailureMessage(failure)); }
    });
    return () => { active = false; };
  }, [pending]);
  const submission = useRef<HTMLButtonElement | HTMLInputElement | null>(null);
  const changeFormLanguage = useRef<((lang: string) => void) | null>(null);
  const reviewFormVillage = useRef<VillageReview | null>(null);
  function recoverVillage(failure: unknown, fields: [string, string][]): boolean {
    if (!(failure instanceof SigningRequestError)) return false;
    const code = failure.message;
    if (code !== "village_required" && (code !== "village_changed" || !failure.village)) return false;
    setPending(null);
    if (!unchanged({ fields })) { setError(m.signing_changed()); return true; }
    reviewFormVillage.current?.(failure.village, fields.find(([name]) => name === "body")?.[1] ?? "", code);
    setError(reviewFormVillage.current ? null : code === "village_required" ? m.village_required() : m.village_changed());
    return true;
  }
  async function review(event: Parameters<NonNullable<ComponentProps<typeof Form>["onSubmit"]>>[0]) {
    onSubmit?.(event);
    if (event.defaultPrevented) return;
    if (!signatureRequired && !confirmAiDraft) { allowSubmission(); return; }
    const button = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | HTMLInputElement | null;
    const form = new FormData(event.currentTarget, button);
    const intent = String(form.get("intent") ?? "");
    if (signIntent !== undefined ? intent !== signIntent : ["draft", "save", "remove_alt"].includes(intent)) { allowSubmission(); return; }
    event.preventDefault();
    if (busy) return;
    submission.current = button;
    const fields = pairsOf(form);
    const action = new URL(typeof props.action === "string" ? props.action : window.location.href, window.location.href).pathname + (typeof props.action === "string" ? new URL(props.action, window.location.href).search : window.location.search);
    setBusy(true); setError(null);
    element.current?.dispatchEvent(new Event("tomola:village-review-reset"));
    try {
      const preview = await signingRequest({ intent: "preview", pathname: new URL(action, window.location.href).pathname, fields }) as SigningPreview;
      if (!preview.signatureRequired && !preview.lastEditor?.id) {
        await submit(form, { method: "post", action });
      } else setPending({ fields, action, preview });
    } catch (error) {
      if (!recoverVillage(error, fields)) setError(signingFailureMessage(error));
    }
    finally { setBusy(false); }
  }
  function unchanged(snapshot: Pick<Pending, "fields">): boolean {
    return element.current !== null && JSON.stringify(pairsOf(new FormData(element.current, submission.current))) === JSON.stringify(snapshot.fields);
  }
  async function accept() {
    if (!pending || busy) return;
    const snapshot = pending;
    if (!unchanged(snapshot)) { setPending(null); setError(m.signing_changed()); return; }
    setBusy(true); setError(null);
    try {
      const form = new FormData();
      for (const [name, value] of snapshot.fields) {
        if (name !== SIGNATURE_CHALLENGE_FIELD && name !== SIGNATURE_ASSERTION_FIELD) form.append(name, value);
      }
      if (snapshot.preview.signatureRequired) {
        if (!authenticate) return;
        if (typeof window.PublicKeyCredential === "undefined" || !navigator.credentials?.get) throw new DOMException("Passkeys unavailable", "NotSupportedError");
        const options = await signingRequest({ intent: "challenge", pathname: new URL(snapshot.action, window.location.href).pathname, fields: snapshot.fields, previewHash: snapshot.preview.payloadHash }) as SigningOptions;
        const assertion = await authenticate({ optionsJSON: options.options });
        if (!unchanged(snapshot)) { setPending(null); setError(m.signing_changed()); return; }
        form.set(SIGNATURE_CHALLENGE_FIELD, options.challenge);
        form.set(SIGNATURE_ASSERTION_FIELD, JSON.stringify(assertion));
      }
      setPending(null);
      await submit(form, { method: "post", action: snapshot.action });
    } catch (failure) {
      if (recoverVillage(failure, snapshot.fields)) return;
      if (failure instanceof Error && failure.message === "approval_changed") {
        try { const preview = await signingRequest({ intent: "preview", pathname: new URL(snapshot.action, window.location.href).pathname, fields: snapshot.fields }) as SigningPreview; setPending({ ...snapshot, preview }); } catch (error) { if (recoverVillage(error, snapshot.fields)) return; setPending(null); setError(signingFailureMessage(error)); return; }
        setError(m.signing_changed());
      } else setError(signingFailureMessage(failure));
    } finally { setBusy(false); }
  }
  async function changeLanguage(lang: string) {
    if (!pending || busy || !element.current) return;
    const snapshot = pending;
    if (!unchanged(snapshot)) { setPending(null); setError(m.signing_changed()); return; }
    if (!changeFormLanguage.current) return;
    flushSync(() => changeFormLanguage.current?.(lang));
    const fields = snapshot.fields.map(([name, value]) => [name, name === "lang" ? lang : value] as [string, string]);
    setBusy(true); setError(null);
    try {
      const preview = await signingRequest({ intent: "preview", pathname: new URL(snapshot.action, window.location.href).pathname, fields }) as SigningPreview;
      setPending({ ...snapshot, fields, preview });
    } catch (error) { if (!recoverVillage(error, fields)) { setPending(null); setError(signingFailureMessage(error)); } }
    finally { setBusy(false); }
  }
  return <>
    <FormSendingContext.Provider value={sending}>
    <FormLanguageChangeContext.Provider value={changeFormLanguage}>
    <FormVillageReviewContext.Provider value={reviewFormVillage}>
    <Form {...props} data-ready={ready ? "true" : undefined} ref={element} onClickCapture={event => {
      onClickCapture?.(event);
      if (!event.defaultPrevented && (event.target as Element).closest("[data-discard-unsaved]")) {
        bypass.current = true;
        setTimeout(() => { bypass.current = false; }, 0);
      }
    }} onSubmit={event => void review(event)}>
      {protectUnsaved && <UnsavedFormGuard form={element} mode={protectUnsaved} bypass={bypass} initial={unsavedInitialValues} retainOnSamePath={preserveUnsavedOnSamePath} />}
      {children}
      {signatureRequired && <noscript><p role="note">{m.signing_no_js()}</p></noscript>}
    </Form>
    </FormVillageReviewContext.Provider>
    </FormLanguageChangeContext.Provider>
    </FormSendingContext.Provider>
    {!pending && error && <SigningFailure message={error} />}
    <Dialog open={pending !== null} disablePointerDismissal onOpenChange={(open, details) => {
      if (open) return;
      if (busy) { details.cancel(); return; }
      setPending(null); setError(null);
    }}>
    {pending && <DialogContent showCloseButton={false} aria-label={m.signing_heading()} className="top-4 bottom-4 start-4 end-4 ms-auto me-auto flex h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-3xl translate-x-0 rtl:translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded border p-0 sm:max-w-3xl">
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
          <DialogTitle className="text-xl font-semibold">{m.signing_heading()}</DialogTitle>
          <p>{pending.preview.signatureRequired ? m.signing_intro() : m.confirm_ai_draft_intro()}</p>
          {pending.preview.village && <div className="space-y-1" data-signing-village><p>{postingVillageName(pending.preview.village, pending.preview.village.slug?.slice(1) ?? null)}</p><p>{m.village_public_reach()}</p></div>}
          {pending.preview.lastEditor?.id && <p>{m.signing_last_ai({ name: pending.preview.lastEditor.name ?? pending.preview.lastEditor.id, id: pending.preview.lastEditor.id, at: pending.preview.lastEditor.at ?? "" })}</p>}
          {pending.preview.lastEditor?.id && <p className="ui-help text-notice-emphasis">{m.signing_client_warning()}</p>}
          {pending.preview.content.lang && <div className="flex min-w-0 flex-wrap items-center gap-2">
            <p>{(pending.preview.language?.source === "detected" ? m.original_lang_detected : pending.preview.language?.source === "default" ? m.original_lang_default : m.original_lang)({ lang: pending.preview.content.lang === "other" ? languageLabel("other", pending.preview.language?.langCode) : isLang(pending.preview.content.lang) ? LANG_LABELS[pending.preview.content.lang] : pending.preview.content.lang })}</p>
            {["create-topic", "create-reply", "publish-draft"].includes(pending.preview.operation) && <Select value={enabled.some(lang => lang === pending.preview.content.lang) ? pending.preview.content.lang : "other"} items={[...enabled.map(lang => ({ value: lang, label: <span lang={lang}>{LANG_LABELS[lang]}</span> })), { value: "other", label: m.source_language_other() }]} disabled={busy} onValueChange={lang => { if (lang !== null) void changeLanguage(lang); }}>
              <SelectTrigger aria-label={m.field_lang()} className="max-w-full"><SelectValue /></SelectTrigger>
              <SelectContent>{enabled.map(lang => <SelectItem key={lang} value={lang}><span lang={lang}>{LANG_LABELS[lang]}</span></SelectItem>)}<SelectItem value="other">{m.source_language_other()}</SelectItem></SelectContent>
            </Select>}
          </div>}
          {pending.preview.content.lang && !enabled.some(lang => lang === pending.preview.content.lang) && <Suspense fallback={null}><SourceLanguageNotice lang={pending.preview.content.lang} langCode={pending.preview.language?.langCode} /></Suspense>}
          {pending.preview.language?.source === "explicit" && pending.preview.language.detected && pending.preview.language.detected !== pending.preview.content.lang && ["create-topic", "create-reply", "publish-draft"].includes(pending.preview.operation) && <div>
            <p>{m.original_lang_mismatch({ detected: languageLabel(pending.preview.language.detected, pending.preview.language.langCode) })}</p>
            <Button variant="outline" type="button" disabled={busy} onClick={() => void changeLanguage(pending.preview.language!.detected!)}>{m.original_lang_change({ detected: languageLabel(pending.preview.language.detected, pending.preview.language.langCode) })}</Button>
          </div>}
          {pending.preview.content.title && <h3 dir="auto" className="whitespace-pre-wrap font-semibold">{pending.preview.content.title}</h3>}
          <pre dir="auto" className="whitespace-pre-wrap break-words rounded border p-3 font-sans">{pending.preview.content.body}</pre>
          <SigningChanges preview={pending.preview} />
          {pending.preview.targetContext.thread && <SigningTarget content={pending.preview.targetContext.thread} label={pending.preview.target.threadId === null && pending.preview.target.altOf !== null ? m.signing_target_alt() : m.signing_target_thread()} href={`/t/${pending.preview.target.threadId ?? pending.preview.target.altOf}`} />}
          {pending.preview.targetContext.parent && <SigningTarget content={pending.preview.targetContext.parent} label={m.signing_target_parent()} href={`/t/${pending.preview.target.threadId}#c-${pending.preview.target.parentId}`} />}
        </div>
        <div className="sticky bottom-0 shrink-0 space-y-2 border-t bg-popover p-4">
          {error && <SigningFailure message={error} />}
          <div className="flex flex-wrap gap-3">
            <Button type="button" variant={["remove-passkey", "delete-account"].includes(pending.preview.operation) ? "destructive" : "default"} onClick={() => void accept()} disabled={busy || pending.preview.signatureRequired && !authenticate}>{pending.preview.signatureRequired ? signingAcceptLabel(pending.preview.operation) : m.confirm_publish()}</Button>
            <DialogClose render={<Button variant="outline" type="button" disabled={busy} />}>{m.cancel()}</DialogClose>
          </div>
        </div>
    </DialogContent>}
    </Dialog>
  </>;
}
export function signingAcceptLabel(operation: SigningOperation): string {
  if (operation === "create-topic") return m.signing_accept_post();
  if (operation === "create-reply") return m.signing_accept_reply();
  if (operation === "publish-draft") return m.signing_accept_publish();
  if (operation === "remove-passkey" || operation === "delete-account") return m.signing_accept_remove();
  return m.signing_accept_save();
}

function SigningTarget({ content, label, href }: { content: SigningContent; label: string; href: string }) {
  const line = (content.title || content.body).split("\n").find((part) => part.trim()) ?? "";
  return <details className="rounded border p-3">
    <summary className="min-w-0 cursor-pointer">
      <span className="inline-flex max-w-full gap-2 align-middle">
      <span className="shrink-0 font-semibold">{label}</span><span dir="auto" className="truncate">{line}</span></span>
    </summary>
    <div className="mt-2 space-y-2">
      {content.title && <p dir="auto" className="whitespace-pre-wrap font-semibold">{content.title}</p>}
      <pre dir="auto" className="whitespace-pre-wrap break-words font-sans">{content.body}</pre>
      <a href={href} target="_blank" rel="noreferrer" className="underline">{m.signing_target_open()}</a>
    </div>
  </details>;
}

export function SigningChanges({ preview }: { preview: Pick<SigningPreview, "viewed" | "current" | "content"> }) {
  const { viewed, current, content } = preview;
  const latest = current ?? content;
  return <>
    {viewed && <PersistentDetails open={latest.body !== viewed.body || latest.title !== viewed.title}>
      <summary>{m.signing_changes()}</summary>
      <Comparison before={viewed.body} after={latest.body} />
      {viewed.title !== latest.title && <p>{m.signing_title_change({ before: viewed.title ?? "", after: latest.title ?? "" })}</p>}
    </PersistentDetails>}
    {current && (current.body !== content.body || current.title !== content.title) && <PersistentDetails open>
      <summary>{m.signing_edit_changes()}</summary>
      <Comparison before={current.body} after={content.body} />
      {current.title !== content.title && <p>{m.signing_title_change({ before: current.title ?? "", after: content.title ?? "" })}</p>}
    </PersistentDetails>}
  </>;
}
function Comparison({ before, after }: { before: string; after: string }) {
  const original = before.split("\n"); const latest = after.split("\n");
  let start = 0; while (start < original.length && start < latest.length && original[start] === latest[start]) start++;
  let end = 0; while (end < original.length - start && end < latest.length - start && original[original.length - end - 1] === latest[latest.length - end - 1]) end++;
  if (start === original.length && start === latest.length) return <p>{m.signing_unchanged()}</p>;
  return <div className="space-y-2"><pre dir="auto" className="whitespace-pre-wrap break-words border-s-4 border-destructive p-2">{original.slice(start, original.length - end).map(line => `− ${line}`).join("\n")}</pre><pre dir="auto" className="whitespace-pre-wrap break-words border-s-4 border-success p-2">{latest.slice(start, latest.length - end).map(line => `+ ${line}`).join("\n")}</pre></div>;
}
