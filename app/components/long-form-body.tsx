import { useEffect, useRef, useState, type ComponentType } from "react";
import { Button } from "~/components/ui/button";
import { FieldLabel } from "~/components/ui/field";
import type { BodyEditorProps } from "~/components/entry-fields";
import type { RichTextEditorProps } from "./rich-text-editor.client";
import { BODY_MAX_LENGTH, EDITOR_MODE_STORAGE_KEY, prefersRichEditor, requiresMarkdownEditor } from "~/lib/rich-editor";
import { m } from "~/paraglide/messages.js";
import { afterInitialActivation } from "~/lib/initial-activation";

// Only the long-form routes import this controller. Keep the original
// textarea mounted for native input history, no-JS use, preview and submission.
// The mode switch stays beside the body, available without opening the post settings.
export function LongFormBody({ children, id, lang, pasteFrontmatter, placeholder, tall, onActiveChange, invalid, describedBy }: BodyEditorProps) {
  const container = useRef<HTMLDivElement>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const activeRef = useRef(false);
  const [hydrated, setHydrated] = useState(false);
  const [wanted, setWanted] = useState(false);
  const [active, setActive] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [Editor, setEditor] = useState<ComponentType<RichTextEditorProps> | null>(null);
  const textarea = () => container.current!.querySelector<HTMLTextAreaElement>("textarea")!;
  const sync = useRef<(() => void) | null>(null);
  const composing = useRef(false);
  useEffect(() => { onActiveChange(active); activeRef.current = active; }, [active, onActiveChange]);

  function choose(rich: boolean, remember = true) {
    sync.current?.();
    const refused = rich && requiresMarkdownEditor(textarea().value);
    setBlocked(refused);
    setWanted(rich && !refused);
    if (!rich || refused) setActive(false);
    if (remember) {
      try { localStorage.setItem(EDITOR_MODE_STORAGE_KEY, rich ? "rich" : "markdown"); } catch { /* Storage is optional. */ }
    }
  }
  useEffect(() => {
    const body = textarea();
    const cancelActivation = afterInitialActivation(() => {
      setHydrated(true);
      if (requiresMarkdownEditor(body.value)) setBlocked(true);
      let preference: string | null = null;
      try { preference = localStorage.getItem(EDITOR_MODE_STORAGE_KEY); } catch { /* Storage is optional. */ }
      if (prefersRichEditor(preference)) choose(true, false);
    });
    const compositionStart = () => { composing.current = true; };
    const compositionEnd = () => { composing.current = false; };
    const input = () => {
      setBlocked(requiresMarkdownEditor(body.value));
      setProblem(null);
      if (body.validity.customError && body.value.length <= BODY_MAX_LENGTH) body.setCustomValidity("");
    };
    const invalid = (event: Event) => {
      // The textarea is hidden while the visual editor is in use, so the browser cannot point at it. Say what is wrong below the editor and put the cursor there;
      // the editor stays as it is (the member's writing is not turned into symbols). With the Markdown field in use, the browser's own message applies.
      if (!activeRef.current) return;
      event.preventDefault();
      setProblem(body.validity.valueMissing ? m.error_body() : body.validationMessage);
      document.getElementById(`${id}-rich`)?.focus();
    };
    const form = body.form;
    const synchronize = () => sync.current?.();
    body.addEventListener("input", input);
    body.addEventListener("compositionstart", compositionStart);
    body.addEventListener("compositionend", compositionEnd);
    body.addEventListener("invalid", invalid);
    form?.addEventListener("submit", synchronize, true);
    form?.addEventListener("click", synchronize, true);
    return () => {
      cancelActivation();
      body.removeEventListener("input", input);
      body.removeEventListener("compositionstart", compositionStart);
      body.removeEventListener("compositionend", compositionEnd);
      body.removeEventListener("invalid", invalid);
      form?.removeEventListener("submit", synchronize, true);
      form?.removeEventListener("click", synchronize, true);
    };
  }, []);
  useEffect(() => {
    if (!wanted || Editor) return;
    let cancelled = false;
    import("./rich-text-editor.client").then(module => {
      if (!cancelled) setEditor(() => module.RichTextEditor);
    }).catch(() => { if (!cancelled) { setWanted(false); setActive(false); } });
    return () => { cancelled = true; };
  }, [wanted, Editor]);

  const toggle = <div role="group" aria-label={m.editor_mode_label()} className="flex flex-wrap items-center gap-1.5">
    <Button type="button" size="xs" variant="outline" pressed={!active} disabled={!hydrated} onClick={() => choose(false)}>{m.editor_mode_markdown()}</Button>
    <Button type="button" size="xs" variant="outline" pressed={active} disabled={!hydrated} onClick={() => choose(true)}>{m.editor_mode_rich()}</Button>
  </div>;
  return <div ref={container} data-rich-editor-active={active} data-rich-editor-pending={wanted && !active} className="min-w-0 space-y-2">
    {/* The label is kept for the accessible name and for assistive tools; it is not drawn. A click on it puts the cursor in the editor. */}
    <FieldLabel htmlFor={active ? `${id}-rich` : id} className="sr-only" onClick={() => { if (active) document.getElementById(`${id}-rich`)?.focus(); }}>{m.field_body()}</FieldLabel>
    {hydrated && toggle}
    {blocked && <p role="status" className="ui-help text-muted-foreground">{m.editor_mode_markdown_only()}</p>}
    <div hidden={active}>{children}</div>
    {wanted && Editor && <Editor invalid={invalid || problem !== null} describedBy={problem ? `${id}-problem` : describedBy} placeholder={placeholder} tall={tall} id={`${id}-rich`} lang={lang} textarea={textarea} pasteFrontmatter={pasteFrontmatter === "topic"}
      onReady={() => setActive(true)} isComposing={() => composing.current} sync={sync}
      onFallback={() => { setWanted(false); setActive(false); }} />}
    {problem && <p id={`${id}-problem`} role="alert" className="text-destructive">{problem}</p>}
  </div>;
}
