import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { isValidTemplate, PROMPT_PLACEHOLDER, type AiChoice } from "~/lib/open-in-ai";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Field, FieldLabel, FieldDescription, FieldError, FieldSet, FieldLegend } from "~/components/ui/field";
import { RadioGroup, RadioGroupItem } from "~/components/ui/radio-group";
import { m } from "~/paraglide/messages.js";

// AI-selection form, shared by the dialog and settings.
export default function AiChoiceForm({
  initial,
  submitLabel,
  onSubmit,
  onCancel,
  autoSave = false,
  onEdit,
}: {
  initial: AiChoice | null;
  submitLabel: string;
  onSubmit: (choice: AiChoice) => boolean | void;
  autoSave?: boolean;
  onEdit?: () => void;
  onCancel?: () => void;
}) {
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => { if (onCancel) form.current?.querySelector<HTMLElement>('[role="radio"][tabindex="0"]')?.focus(); }, []);
  const [provider, setProvider] = useState<AiChoice["provider"] | null>(initial?.provider ?? (autoSave ? null : "chatgpt"));
  const [template, setTemplate] = useState(initial?.provider === "custom" ? initial.template : "");
  const [error, setError] = useState(false);
  const templateId = useId();

  function commit(nextProvider = provider, nextTemplate = template, reportInvalid = true) {
    if (!nextProvider) return;
    if (nextProvider === "custom" && !isValidTemplate(nextTemplate.trim())) {
      if (reportInvalid) setError(true);
      return;
    }
    const next: AiChoice = nextProvider === "custom" ? { provider: nextProvider, template: nextTemplate.trim() } : { provider: nextProvider };
    if (onSubmit(next) === false) {
      setProvider(initial?.provider ?? (autoSave ? null : "chatgpt"));
      setTemplate(initial?.provider === "custom" ? initial.template : "");
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    commit();
  }

  return (
    <form ref={form} onSubmit={submit} className="space-y-3">
      <FieldSet className="gap-1">
        <FieldLegend className="sr-only">{m.open_in_ai_dialog_title()}</FieldLegend>
        <RadioGroup name="provider" aria-label={m.open_in_ai_dialog_title()} value={provider} onValueChange={value => {
          setProvider(value);
          setError(false);
          onEdit?.();
          if (autoSave) commit(value, template, false);
        }}>
          {(["chatgpt", "claude", "custom"] as const).map((p) => (
            <Field key={p} orientation="horizontal" className="gap-2">
              <RadioGroupItem id={`${templateId}-${p}`} value={p} />
              <FieldLabel htmlFor={`${templateId}-${p}`} className="min-w-0 flex-wrap">
                  {p === "chatgpt" ? m.open_in_ai_chatgpt() : p === "claude" ? m.open_in_ai_claude() : m.open_in_ai_custom()}
                  {p !== "custom" && <span className="ms-2 ui-meta font-normal text-muted-foreground">{m.open_in_ai_provider_login({ name: p === "chatgpt" ? m.open_in_ai_chatgpt() : m.open_in_ai_claude() })}</span>}
              </FieldLabel>
            </Field>
          ))}
        </RadioGroup>
      </FieldSet>
      {provider === "custom" && (
        <Field>
          <FieldLabel htmlFor={`${templateId}-input`}>
            {m.open_in_ai_template()}
          </FieldLabel>
          <Input
            id={`${templateId}-input`}
            type="url"
            name="template"
            value={template}
            onChange={(e) => {
              setTemplate(e.target.value);
              setError(false);
              onEdit?.();
              if (autoSave) commit(provider, e.target.value, false);
            }}
            onBlur={() => { if (autoSave) setError(!isValidTemplate(template.trim())); }}
            placeholder={`https://example.com/chat?q=${PROMPT_PLACEHOLDER}`}
            className="w-full font-mono text-sm"
            aria-describedby={`${templateId}-help`}
            aria-invalid={error}
          />
          <FieldDescription id={`${templateId}-help`}>
            {m.open_in_ai_template_help({ placeholder: PROMPT_PLACEHOLDER })}
          </FieldDescription>
        </Field>
      )}
      {error && <FieldError>{m.open_in_ai_template_error({ placeholder: PROMPT_PLACEHOLDER })}</FieldError>}
      <div className="flex gap-3">
        {!autoSave && <Button type="submit">
          {submitLabel}
        </Button>}
        {onCancel && (
          <Button type="button" variant="outline" onClick={onCancel}>
            {m.cancel()}
          </Button>
        )}
      </div>
    </form>
  );
}
