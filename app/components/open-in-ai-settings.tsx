import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { AiChoiceForm, choiceName } from "~/components/ai-choice";
import { Button } from "~/components/ui/button";
import { afterInitialActivation } from "~/lib/initial-activation";
import { readChoice, saveChoice, type AiChoice } from "~/lib/open-in-ai";
import { m } from "~/paraglide/messages.js";

// AI selection on the settings page, reading and writing this browser's localStorage.
export function OpenInAiSettings() {
  const [mounted, setMounted] = useState(false);
  const [choice, setChoice] = useState<AiChoice | null>(null);
  const [saved, setSaved] = useState(false);
  const [failed, setFailed] = useState(false);
  const [formVersion, setFormVersion] = useState(0);
  const status = useRef<HTMLParagraphElement>(null), heading = useRef<HTMLHeadingElement>(null);
  const focus = useRef<"saved" | "heading" | null>(null);
  useLayoutEffect(() => {
    if (focus.current) { (focus.current === "saved" ? status : heading).current?.focus({ preventScroll: true }); focus.current = null; }
  });
  useEffect(() => afterInitialActivation(() => {
    setChoice(readChoice());
    setMounted(true);
  }), []);
  if (!mounted) return null;
  return (
    <section id="settings-ai-choice" aria-labelledby="settings-ai-heading" className="space-y-3">
      <h3 ref={heading} tabIndex={-1} id="settings-ai-heading" className="text-lg font-semibold">{m.settings_ai_heading()}</h3>
      <p className="ui-help text-muted-foreground">{m.settings_ai_help()}</p>
      <p>{choice ? m.settings_ai_current({ name: choiceName(choice) }) : m.settings_ai_none()}</p>
      {/* Keep the control mounted so saving never takes focus from a choice. */}
      <AiChoiceForm
        key={formVersion}
        initial={choice}
        submitLabel={m.open_in_ai_save()}
        autoSave
        onEdit={() => { setSaved(false); setFailed(false); }}
        onSubmit={(next) => {
          if (!saveChoice(next)) { setFailed(true); return false; }
          setChoice(next);
          setSaved(true);
          return true;
        }}
      />
      {failed && <p role="alert" className="ui-meta text-destructive">{m.error_generic()}</p>}
      <p ref={status} tabIndex={-1} role="status" aria-live="polite" className="ui-meta text-muted-foreground empty:sr-only">{saved ? m.settings_ai_saved() : null}</p>
      {choice && (
        <Button
          type="button"
          variant="link"
          onClick={() => {
            setSaved(false);
            if (!saveChoice(null)) { setFailed(true); return; }
            setFailed(false);
            setFormVersion(version => version + 1);
            setChoice(null);
            focus.current = "heading";
          }}
        >
          {m.settings_ai_forget()}
        </Button>
      )}
    </section>
  );
}
