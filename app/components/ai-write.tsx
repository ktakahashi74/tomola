import { useEffect, useId, useRef, useState } from "react";
import { afterInitialActivation } from "~/lib/initial-activation";
import { useLocation } from "react-router";
import { AiImport } from "~/components/ai-import";
import { readerLoginHref } from "~/lib/public-reading";
import { AiChoiceForm, choiceName, readChoice, saveChoice } from "~/components/open-in-ai";
import { Button } from "~/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "~/components/ui/dialog";
import { Field, FieldLabel } from "~/components/ui/field";
import { Textarea } from "~/components/ui/textarea";
import { entryErrorMessage } from "~/components/entry-fields";
import { aiWriteDestination, aiWritePrompt, AI_WRITE_TASKS, defaultAiWriteTask, type AiWriteTask } from "~/lib/ai-draft";
import type { AiChoice } from "~/lib/open-in-ai";
import { m } from "~/paraglide/messages.js";
import { flushDraft } from "~/lib/draft-autosave";

type Saved = { id: number; version: number; title: string | null; asksStance: boolean; lang: string; body: string; signingView: string };
// `task` is the task that was sent: what comes back, and so what the guidance says, depends on it, not on the task chosen since. `id` is the saved draft (none for the notes-only task, which saves nothing).
type Handoff = { ownerId: string; id: number | null; task: AiWriteTask; prompt: string; choice: AiChoice; blocked: boolean };
const fingerprint = (form: HTMLFormElement) => JSON.stringify([...new FormData(form)].filter(([key]) => !["signingView", "version", "fromDraft", "fromDraftVersion"].includes(key)));

// Navigate from an empty, detached tab with no draft URL in the Referer header.
function launch(popup: Window | null, url: string): boolean {
  if (!popup || popup.closed) return false;
  try {
    const meta = popup.document.createElement("meta");
    meta.name = "referrer"; meta.content = "no-referrer";
    popup.document.head.append(meta);
    const link = popup.document.createElement("a");
    link.href = url; link.rel = "noreferrer noopener"; link.referrerPolicy = "no-referrer";
    popup.document.body.append(link);
    link.click();
    return true;
  } catch { popup.close(); return false; }
}

function taskLabel(task: AiWriteTask) {
  return ({ introduce: m.ai_write_introduce, summarize: m.ai_write_summarize, translate: m.ai_write_translate, revise: m.ai_write_revise, question: m.ai_write_question })[task]();
}

// The one entry to writing with an AI. The button opens a small panel in the page (the writing is not left): ask an AI (the work is saved as a draft, the chosen AI is opened in
// another tab with the request and the draft's address), and paste what the AI wrote back into the body. Nothing is posted until the member has read it and pressed the post button.
// `draft`: the draft this screen is editing (the draft screen). Elsewhere the first request creates a draft, and its id travels with the form (fromDraft) so that posting removes it.
export function AiWrite({ ownerId, connectDraftLabel, draft, onSaved, kind = "topic", threadId, parentId, candidate, onCandidateChange }: { ownerId: string; connectDraftLabel: string; draft?: { id: number; version: number }; onSaved?: (saved: Saved) => void; kind?: "topic" | "reply"; threadId?: number; parentId?: number | null; candidate: string; onCandidateChange: (text: string) => void }) {
  const button = useRef<HTMLButtonElement>(null);
  const pending = useRef(false);
  const savedDraft = useRef<{ id: number; version: number } | undefined>(draft);
  const createdDefaults = useRef<{ form: FormData; saved: Saved } | null>(null);
  const location = useLocation();
  const id = useId();
  const panelId = useId();
  const [open, setOpen] = useState(false);
  // The draft this screen made, with the version it last saw: posting removes it only if it is still at that version (an AI may have changed it).
  const [created, setCreated] = useState<{ id: number; version: number } | null>(null);
  const [mounted, setMounted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [login, setLogin] = useState(false);
  const [task, setTask] = useState<AiWriteTask | null>(null);
  const [sendBody, setSendBody] = useState("");
  const [customBody, setCustomBody] = useState(false);
  const options = useRef({ task, sendBody, customBody });
  options.current = { task, sendBody, customBody };
  const [choice, setChoice] = useState<AiChoice | null>(null);
  const [choosing, setChoosing] = useState(false);
  const chooseAndRun = useRef(false);
  const [handoff, setHandoff] = useState<Handoff | null>(null);
  useEffect(() => afterInitialActivation(() => { setMounted(true); setChoice(readChoice() ?? handoff?.choice ?? null); }), []);
  useEffect(() => { if (draft) savedDraft.current = draft; }, [draft?.id, draft?.version]);
  useEffect(() => {
    const form = button.current?.form;
    const update = () => {
      const body = form?.elements.namedItem("body");
      if (body instanceof HTMLTextAreaElement && !options.current.customBody) setSendBody(body.value);
    };
    update();
    form?.addEventListener("input", update);
    return () => form?.removeEventListener("input", update);
  }, [mounted]);
  if (!mounted) return null;

  async function start(selected: AiChoice) {
    const form = button.current?.form;
    if (!form || pending.current) return;
    const selectedOptions = { ...options.current };
    // The notes-only task needs no draft: its request holds no draft address and nothing comes back to be imported. It is built from what is on the screen.
    const notesOnly = (selectedOptions.task ?? defaultAiWriteTask(selectedOptions.sendBody)) === "question";
    const bodyField = form.elements.namedItem("body");
    const notesText = selectedOptions.customBody ? selectedOptions.sendBody : bodyField instanceof HTMLTextAreaElement ? bodyField.value : selectedOptions.sendBody;
    // An empty text is refused before the AI's tab is opened, so that no empty tab appears for a moment.
    if (notesOnly && !notesText.trim()) { setNotice(entryErrorMessage("body_required")); setLogin(false); setHandoff(null); return; }
    pending.current = true;
    setBusy(true); setNotice(null); setLogin(false); setHandoff(null);
    let popup: Window | null = null;
    try { popup = window.open("about:blank", "_blank"); } catch { /* Offer a link after saving. */ }
    if (popup) popup.opener = null;
    const captured = fingerprint(form);
    if (notesOnly) {
      try {
        const lang = new FormData(form).get("lang");
        const prompt = aiWritePrompt({ task: "question", lang: typeof lang === "string" && lang ? lang : "unspecified", body: notesText, returnUrl: "" });
        const destination = aiWriteDestination(selected, prompt);
        const opened = destination.url ? launch(popup, destination.url) : false;
        if (!destination.url) popup?.close();
        setHandoff({ ownerId, id: null, task: "question", prompt, choice: selected, blocked: !opened });
      } finally { pending.current = false; setBusy(false); }
      return;
    }
    let edited = false;
    const changed = () => { edited = true; };
    form.addEventListener("input", changed);
    form.addEventListener("change", changed);
    const originalForm = new FormData(form);
    const body = new FormData(form);
    body.set("ownerId", ownerId);
    body.set("kind", kind);
    if (threadId !== undefined) body.set("threadId", String(threadId));
    if (kind === "reply" && parentId !== undefined) body.set("parentId", parentId === null ? "" : String(parentId));
    // A reply destination changed during the previous save: retain that copy and start a draft for this destination.
    const changedTarget = !draft && kind === "reply" && createdDefaults.current !== null
      && (originalForm.has("parentId") !== createdDefaults.current.form.has("parentId")
        || String(originalForm.get("parentId") ?? "").trim() !== String(createdDefaults.current.form.get("parentId") ?? "").trim());
    const current = changedTarget ? undefined : savedDraft.current;
    if (current) { body.set("draftId", String(current.id)); body.set("version", String(current.version)); }
    if (!draft && createdDefaults.current && !changedTarget) {
      const initial = createdDefaults.current;
      for (const [name, value] of [["title", initial.saved.title], ["lang", initial.saved.lang], ["asksStance", initial.saved.asksStance ? "1" : "0"]] as const) {
        if (body.get(name) === initial.form.get(name)) {
          if (value === null) body.delete(name);
          else body.set(name, value);
        }
      }
    }
    try {
      const managed = flushDraft(form);
      const automatic = managed ? await managed : null;
      const response = managed ? Response.json(automatic ?? { error: form.dataset.autosaveError ?? "busy" }, { status: automatic ? 200 : form.dataset.autosaveError === "login_required" ? 401 : 503 }) : await fetch("/drafts/ai-write", { method: "POST", body, credentials: "same-origin", redirect: "manual", cache: "no-store", referrerPolicy: "no-referrer" });
      if (response.status === 401 || response.type === "opaqueredirect") {
        popup?.close(); setLogin(true); setNotice(m.ai_write_login()); return;
      }
      const result = await response.json() as Saved & { error?: string };
      if (!response.ok) {
        if (result.error === "account_changed") setNotice(m.ai_write_account_changed());
        else if (result.error === "draft_conflict") setNotice(m.ai_write_conflict());
        else if (result.error === "not_found") setNotice(m.ai_write_gone());
        else setNotice(result.error ? entryErrorMessage(result.error) : m.ai_write_save_failed());
        popup?.close();
        return;
      }
      if (!Number.isSafeInteger(result.id) || !Number.isSafeInteger(result.version) || typeof result.lang !== "string" || typeof result.body !== "string" || typeof result.signingView !== "string") throw new Error("Invalid save response");
      savedDraft.current = { id: result.id, version: result.version };
      if (!draft && !current) createdDefaults.current = { form: originalForm, saved: result };
      if (!draft && !managed) setCreated({ id: result.id, version: result.version });
      onSaved?.(result);
      form.dispatchEvent(new CustomEvent("tomola:form-saved", { detail: originalForm }));
      if (edited || captured !== fingerprint(form) || JSON.stringify(selectedOptions) !== JSON.stringify(options.current)) {
        popup?.close(); setNotice(m.ai_write_edited()); return;
      }
      const path = `/drafts/${result.id}`;
      const task = selectedOptions.task ?? defaultAiWriteTask(result.body);
      const prompt = aiWritePrompt({ task, lang: result.lang, body: selectedOptions.customBody ? selectedOptions.sendBody : result.body, returnUrl: new URL(path, window.location.origin).href });
      const destination = aiWriteDestination(selected, prompt);
      const opened = destination.url ? launch(popup, destination.url) : false;
      if (!destination.url) popup?.close();
      setHandoff({ ownerId, id: result.id, task, prompt, choice: selected, blocked: !opened });
    } catch {
      popup?.close(); setNotice(m.ai_write_save_failed());
    } finally {
      form.removeEventListener("input", changed); form.removeEventListener("change", changed);
      pending.current = false; setBusy(false);
    }
  }

  const isQuestion = (task ?? defaultAiWriteTask(sendBody)) === "question";
  const knownPath = draft ? `/drafts/${draft.id}` : savedDraft.current ? `/drafts/${savedDraft.current.id}` : location.pathname;
  // The button sits in the row of the form's own buttons (the parent's flex row); the panel takes a row of its own below it.
  return <div className="contents">
    {created !== null && <><input type="hidden" name="fromDraft" value={created.id} /><input type="hidden" name="fromDraftVersion" value={created.version} /></>}
    <Button ref={button} type="button" variant="outline" aria-expanded={open} aria-controls={panelId} onClick={() => {
      if (!open) {
        const field = button.current?.form?.elements.namedItem("body");
        if (field instanceof HTMLTextAreaElement) setTask(current => current ?? defaultAiWriteTask(field.value));
      }
      setOpen(!open);
    }}>{m.ai_write_button()}</Button>
    <div id={panelId} hidden={!open} className="w-full basis-full space-y-4 rounded-lg border p-3">
      {!isQuestion && <p className="ui-help text-muted-foreground">{m.ai_help_intro()}</p>}
      <p className="ui-help"><a href="/connect" className="underline">{connectDraftLabel}</a></p>
      <div className="space-y-3">
        <Field>
          <FieldLabel htmlFor={`${id}-task`}>{m.ai_write_task()}</FieldLabel>
          <select id={`${id}-task`} value={task ?? defaultAiWriteTask(sendBody)} onChange={e => setTask(e.target.value as AiWriteTask)} className="h-9 max-w-full rounded border bg-background px-2">
            {AI_WRITE_TASKS.map(t => <option key={t} value={t}>{taskLabel(t)}</option>)}
          </select>
        </Field>
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" className="aria-disabled:opacity-50" aria-disabled={busy} onClick={() => {
            if (pending.current) return;
            const selected = choice ?? readChoice();
            if (selected) void start(selected);
            else { chooseAndRun.current = true; setChoosing(true); }
          }}>{m.ai_help_ask()}</Button>
          <span className="ui-meta">{choice ? choiceName(choice) : m.settings_ai_none()}</span>
          <Button type="button" variant="link" className="h-auto px-0" onClick={() => { chooseAndRun.current = false; setChoosing(true); }}>{m.open_in_ai_change()}</Button>
        </div>
        <details onToggle={e => {
          if (e.currentTarget.open && !options.current.customBody) {
            const field = button.current?.form?.elements.namedItem("body");
            if (field instanceof HTMLTextAreaElement) setSendBody(field.value);
          }
        }} className="min-w-0 max-w-full">
          <summary className="cursor-pointer ui-meta underline">{m.ai_write_send()}</summary>
          <div className="mt-2 space-y-3">
            <Field>
              <FieldLabel htmlFor={`${id}-body`}>{m.ai_write_text()}</FieldLabel>
              <Textarea dir="auto" id={`${id}-body`} value={sendBody} onChange={e => { setCustomBody(true); setSendBody(e.target.value); }} rows={5} />
            </Field>
            {customBody && <Button type="button" variant="link" onClick={() => { setCustomBody(false); button.current?.focus(); const field = button.current?.form?.elements.namedItem("body"); if (field instanceof HTMLTextAreaElement) setSendBody(field.value); }}>{m.ai_write_all_text()}</Button>}
          </div>
        </details>
        {notice && <p role="alert" className="ui-help text-destructive">{notice}</p>}
        {notice && savedDraft.current && <a href={knownPath} target="_blank" rel="noreferrer noopener" className="ui-meta underline">{m.ai_write_latest()}</a>}
        {login && <a href={readerLoginHref(knownPath, "")} target="_blank" rel="noreferrer noopener" className="underline">{m.ai_write_login_link()}</a>}
        {handoff && <AiWriteHandoff handoff={handoff} />}
      </div>
      {/* The "question" task returns notes, not text: there is nothing to paste or apply. The pasting part stays mounted (hidden), so what was pasted and the undo of an applied text survive a change of task. */}
      <div hidden={isQuestion}><AiImport embedded candidate={candidate} onCandidateChange={onCandidateChange} /></div>
    </div>
    <Dialog open={choosing} onOpenChange={setChoosing}>
      <DialogContent finalFocus={button} showCloseButton={false}>
        <DialogTitle>{m.open_in_ai_dialog_title()}</DialogTitle>
        <DialogDescription>{m.open_in_ai_dialog_help()}</DialogDescription>
        <AiChoiceForm initial={choice} submitLabel={chooseAndRun.current ? m.ai_help_ask() : m.open_in_ai_save()} onCancel={() => setChoosing(false)} onSubmit={selected => {
          saveChoice(selected); setChoice(selected); setChoosing(false);
          if (chooseAndRun.current) void start(selected);
        }} />
      </DialogContent>
    </Dialog>
  </div>;
}

function AiWriteHandoff({ handoff }: { handoff: Handoff }) {
  const { url, launchUrl } = aiWriteDestination(handoff.choice, handoff.prompt);
  const [manualCopy, setManualCopy] = useState(false);
  const [copied, setCopied] = useState(false);
  const id = useId();
  return <div className="space-y-2 rounded border p-3 ui-help">
    <p>{handoff.task === "question" ? m.ai_write_question_help() : url ? m.ai_write_return_help() : m.ai_write_long_help()}</p>
    {handoff.blocked && url && <a href={url} target="_blank" rel="noreferrer noopener" referrerPolicy="no-referrer" className="underline">{m.ai_write_open()}</a>}
    <Button type="button" variant="outline" onClick={async () => {
      try { await navigator.clipboard.writeText(handoff.prompt); setCopied(true); }
      catch { setManualCopy(true); }
    }}>{m.ai_write_copy()}</Button>
    <p role="status" className="empty:sr-only">{copied ? m.open_in_ai_copied() : null}</p>
    {!url && (launchUrl ? <a href={launchUrl} target="_blank" rel="noreferrer noopener" referrerPolicy="no-referrer" className="ms-3 underline">{m.ai_write_open()}</a> : <p>{m.ai_write_open_manually()}</p>)}
    {manualCopy && <Field>
      <FieldLabel htmlFor={id}>{m.ai_write_instructions()}</FieldLabel>
      <Textarea id={id} readOnly value={handoff.prompt} rows={8} onFocus={e => e.currentTarget.select()} />
      <p>{m.open_in_ai_copy_failed()}</p>
    </Field>}
  </div>;
}
