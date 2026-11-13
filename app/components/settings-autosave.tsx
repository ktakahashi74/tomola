import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { m } from "~/paraglide/messages.js";

type Value = string | string[];
type SaveResult<T> = { ok: true; value: T } | { ok: false; error: string };

// Keep one request per field in flight. A later choice waits for that write,
// so neither a delayed response nor a delayed database write can win over it.
export function useSettingsAutosave<T extends Value>(initial: T, field: "readLangs" | "displayLang" | "village" | "emailPref" | "colorScheme", control: RefObject<HTMLElement | null>) {
  const [value, setValue] = useState(initial);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const state = useRef({ saved: initial, pending: null as { value: T; revision: number } | null, revision: 0, running: false });
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const save = useCallback(async () => {
    const current = state.current;
    current.running = true;
    while (current.pending) {
      const request = current.pending;
      current.pending = null;
      const body = new FormData();
      body.set("intent", field === "emailPref" ? "email-pref" : "preferences");
      body.set("autosave", "1");
      if (field !== "emailPref") body.set("field", field);
      for (const item of typeof request.value === "string" ? [request.value] : request.value) body.append(field, item);
      let result: SaveResult<T>;
      try {
        const response = await fetch("/settings/save", { method: "POST", body, credentials: "same-origin", cache: "no-store" });
        result = await response.json() as SaveResult<T>;
        if (!response.ok || result.ok !== true || !(typeof result.value === "string" || Array.isArray(result.value))) {
          result = { ok: false, error: "error" in result ? result.error : "unexpected" };
        }
      } catch {
        result = { ok: false, error: "unexpected" };
      }
      if (result.ok) current.saved = result.value;
      if (active.current && request.revision === current.revision) {
        setValue(current.saved);
        setStatus(result.ok ? "saved" : "error");
        setError(result.ok ? null : result.error);
      }
    }
    current.running = false;
  }, [field]);

  const change = useCallback((next: T) => {
    setValue(next);
    setStatus("saving");
    setError(null);
    state.current.pending = { value: next, revision: ++state.current.revision };
    if (!state.current.running) void save();
  }, [save]);

  const adopted = useRef(false);
  useLayoutEffect(() => {
    if (adopted.current) return;
    adopted.current = true;
    const element = control.current;
    if (!element) return;
    // Read native edits before the first hydrated render can restore controlled
    // values. Untouched fields (including closed languages) need no write.
    if (element instanceof HTMLSelectElement) {
      const original = [...element.options].find(option => option.defaultSelected)?.value ?? element.options[0]?.value;
      if (element.value === original) return;
      const next = element.value as T;
      queueMicrotask(() => change(next));
    } else {
      const inputs = [...element.querySelectorAll<HTMLInputElement>("input")];
      if (!inputs.some(input => input.checked !== input.defaultChecked)) return;
      const checked = inputs.filter(input => input.checked).map(input => input.value);
      const next = (field === "readLangs" ? checked : checked[0]) as T;
      queueMicrotask(() => change(next));
    }
  }, [change, control, field]);

  return { value, change, status, error };
}

export function SettingsSaveStatus({ status, error, email = false }: { status: string; error: string | null; email?: boolean }) {
  return <>
    <p role="status" aria-live="polite" className="ui-meta text-muted-foreground empty:sr-only">{status === "saved" ? m.settings_saved() : null}</p>
    {status === "error" && <p role="alert" className="ui-meta text-destructive">{email ? m.settings_email_error() : error === "village_required" ? m.village_required() : m.error_generic()}</p>}
  </>;
}
