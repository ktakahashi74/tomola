import { useId, useRef, useState } from "react";
import { Button } from "~/components/ui/button";
import { Field, FieldLabel } from "~/components/ui/field";
import { Textarea } from "~/components/ui/textarea";
import { appendAiText, replaceEditorBody } from "~/lib/ai-draft";
import { m } from "~/paraglide/messages.js";

// `embedded`: drawn inside the AI help panel, open, under a heading, instead of behind a button of its own.
export function AiImport({ candidate, onCandidateChange, embedded = false }: { candidate: string; onCandidateChange: (text: string) => void; embedded?: boolean }) {
  const anchor = useRef<HTMLDivElement>(null);
  const id = useId();
  const [open, setOpen] = useState(false);
  const [lastApplied, setLastApplied] = useState<string | null>(null);
  const applyButton = useRef<HTMLButtonElement>(null);
  const applied = useRef<string | null>(null);
  const [history, setHistory] = useState<{ before: string; after: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const editor = () => anchor.current?.closest("form")?.querySelector<HTMLTextAreaElement>('textarea[name="body"]');
  function apply() {
    const body = editor();
    if (!body || !candidate.trim() || applied.current === candidate) return;
    const result = appendAiText(body.value, candidate);
    if (!result.ok) { setError(result.error === "body_too_long" ? m.error_body_too_long() : m.ai_write_empty()); return; }
    applied.current = candidate;
    setHistory({ before: body.value, after: result.body });
    replaceEditorBody(body, result.body);
    setLastApplied(candidate); setError(null);
  }
  return <div ref={anchor} className="space-y-3">
    {!embedded && <Button type="button" variant="outline" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>{m.ai_write_import()}</Button>}
    <div hidden={!embedded && !open} id={id} data-ai-paste={embedded ? "" : undefined} className={embedded ? "space-y-3 border-t pt-3" : "space-y-3 rounded border p-3"}>
      {embedded && <p className="font-semibold">{m.ai_help_paste()}</p>}
      <p>{m.ai_write_not_posted()}</p>
      <p className="ui-help">{m.ai_write_append()}</p>
      <Field>
        <FieldLabel htmlFor={`${id}-candidate`}>{m.ai_write_candidate()}</FieldLabel>
        <Textarea dir="auto" id={`${id}-candidate`} value={candidate} onChange={e => { onCandidateChange(e.target.value); setError(null); }} rows={8} />
      </Field>
      <p className="ui-help text-muted-foreground">{m.ai_write_import_help()}</p>
      <div className="flex flex-wrap gap-3">
        <Button type="button" className="aria-disabled:opacity-50" ref={applyButton} aria-disabled={!candidate.trim() || lastApplied === candidate} onClick={apply}>{m.ai_write_apply()}</Button>
        {history && <Button type="button" variant="outline" onClick={() => {
          const body = editor();
          if (!body) return;
          if (body.value !== history.after) { setError(m.ai_write_undo_changed()); return; }
          replaceEditorBody(body, history.before);
          applied.current = null;
          setHistory(null); setError(null); setLastApplied(null);
          applyButton.current?.focus();
        }}>{m.ai_write_undo()}</Button>}
      </div>
      <p role="status" className="ui-help empty:sr-only">{lastApplied === candidate ? m.ai_write_applied() : null}</p>
      {error && <p role="alert" className="ui-help text-destructive">{error}</p>}
      {history && <details>
        <summary className="cursor-pointer ui-meta underline">{m.ai_write_before_import()}</summary>
        <Textarea aria-label={m.ai_write_before_import()} readOnly value={history.before} rows={5} onFocus={e => e.currentTarget.select()} />
      </details>}
    </div>
  </div>;
}
